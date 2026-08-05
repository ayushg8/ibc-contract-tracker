/**
 * The order the guardrails run in, which is the whole of the design.
 *
 *   0. Has rollback left a healthy install? If not, this is an emergency and
 *      repair does not run at all. She is never sitting in front of a broken
 *      tracker while an AI thinks about it.
 *   1. Has this exact failure had its three attempts? Then stop, permanently.
 *   2. Clone the source to a scratch directory. The live install is never edited.
 *   3. Prove the gates can run there BEFORE spending a subscription session, and
 *      measure what already fails, so a pre-existing failure cannot be blamed on
 *      the repair and cannot veto every future one.
 *   4. Spend the attempt, then invoke Claude Code inside the clone.
 *   5. A usage limit is not a failed attempt: refund it, record when the limit
 *      resets, schedule the resume, stop.
 *   6. Diff the tree. A protected path means reject, before any gate runs.
 *   7. Gate: typecheck, tests, evals, build. Any failure discards the candidate.
 *   8. Hand the promotion to a detached script, because promoting kills this
 *      process, and let it verify and undo itself if the fix will not come up.
 *   9. Every one of those outcomes is written to the audit trail.
 *
 * Nothing in here trusts what the model says it did.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '@/lib/logger';
import { toEngineError } from '@/lib/providers/errors';
import { newId } from '@/lib/util/ids';

import { recordRepairEvent, summariseAttempt } from './audit';
import { buildRepairPrompt, describeGrant, invokeRepair } from './claude';
import {
  buildUnifiedDiff,
  changedPaths,
  compareManifests,
  findWritesSince,
  scanTree,
  symlinkViolations,
  type Manifest,
} from './diff';
import {
  checkGateReadiness,
  defaultGateEnvironment,
  measureBaseline,
  runGate,
  runGates,
  type Baseline,
  type GateReport,
  type GateRunResult,
} from './gates';
import { describePath, hasControlCharacters, protectedViolations } from './protected';
import { REPAIR_AGENT_LABEL, scheduleResume, unscheduleResume } from './schedule';
import { failureSignature } from './signature';
import {
  attemptDir,
  attemptsUsed,
  capReached,
  dueForResume,
  ensureRepairDirs,
  journal,
  loadState,
  pruneWorkspaces,
  refundAttempt,
  spendAttempt,
  updateState,
} from './state';
import {
  cloneTree,
  listAttempts,
  materialisePromoter,
  newWorkspacePath,
  readPromotionResult,
  removeWorkspace,
  resolveLiveAppDir,
  resolveResourcesDir,
  spawnPromoter,
  stagePromotion,
} from './workspace';
import {
  DEFAULT_LIMIT_WAIT_MS,
  MAX_ATTEMPTS_PER_SIGNATURE,
  type AttemptOutcome,
  type AttemptRecord,
  type GateId,
  type RepairRequest,
  type RepairStatus,
} from './types';

/** typecheck first: after a type error nothing else tells you anything new. */
const GATE_ORDER: readonly GateId[] = ['typecheck', 'tests', 'evals', 'build'];

/**
 * How far tsc's own file count may fall before the typecheck gate is treated as
 * having been narrowed rather than satisfied.
 *
 * The gate asks "zero errors over more than zero files", which a repair can
 * satisfy by shrinking the program instead of fixing it -- deleting sources, or
 * pointing tsc at fewer of them. tsconfig.json is protected now, so the blatant
 * route is closed; this is the belt to that pair of braces, and it is the same
 * shape as the tests and evals baselines: measure the pristine tree, and refuse a
 * candidate that proves less than the tree it started from.
 *
 * Two per cent, not zero: a legitimate fix may delete a file or two, and a gate
 * that fires on an honest deletion is a gate that gets switched off.
 */
const TYPECHECK_SHRINK_TOLERANCE = 0.02;

/**
 * tsc's file count, read back out of the typecheck gate's evidence line.
 *
 * gates.ts reports `<n> files checked, <m> errors` and exposes no structured
 * verdict, so this is the seam. Null means the line did not have the shape this
 * depends on, which is treated as "no evidence" rather than as zero -- the
 * difference between the two decides whether a repair is refused.
 */
function typecheckFilesChecked(results: readonly GateRunResult[]): number | null {
  const typecheck = results.find((r) => r.id === 'typecheck');
  if (typecheck === undefined) return null;
  const match = /^(\d+) files checked\b/.exec(typecheck.evidence);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Why this candidate's typecheck proves less than the pristine tree's did, or
 * null when it does not.
 *
 * Exported for the tests: this is a rule about numbers, and a rule about numbers
 * should not need a Claude session and four gates to exercise.
 */
export function typecheckNarrowing(
  floor: number | null,
  results: readonly GateRunResult[],
): string | null {
  if (floor === null || floor <= 0) return null;
  const after = typecheckFilesChecked(results);
  if (after === null) {
    // We had a number before and cannot read one now. Refusing is the only safe
    // reading: the alternative is promoting a fix whose gate we cannot account for.
    return `the typecheck gate no longer reports how many files it checked, so it cannot be compared with the ${floor} the pristine tree checked`;
  }
  const least = Math.floor(floor * (1 - TYPECHECK_SHRINK_TOLERANCE));
  if (after >= least) return null;
  return `the typecheck gate checked ${after} files where the tree it started from checked ${floor}; a repair that narrows what is type-checked has moved the ruler rather than fixed the fault`;
}

/* ─────────────────────────── single flight ──────────────────────────── */

/**
 * One repair at a time, per process.
 *
 * Two concurrent repairs would clone the same source twice, spend two
 * subscription sessions on one problem and race each other to promote. The
 * second caller is told what the first is doing rather than being queued: repair
 * is not something to have a backlog of.
 */
let active: Promise<RepairStatus> | null = null;

export function isRepairRunning(): boolean {
  return active !== null;
}

/* ────────────────────────────── status ──────────────────────────────── */

export function repairStatus(): RepairStatus {
  const state = loadState();
  const signature = state.activeSignature;
  const last = state.lastAttempt;
  return {
    phase: state.phase,
    signature,
    attemptsUsed: attemptsUsed(state, signature),
    attemptCap: MAX_ATTEMPTS_PER_SIGNATURE,
    resumeAt: state.suspended?.resumeAt ?? null,
    scheduled: state.suspended !== null,
    emergency: state.emergency,
    last:
      last === null
        ? null
        : {
            at: last.finishedAt,
            outcome: last.outcome,
            summary: summariseAttempt(last),
            changed: last.changed,
            gates: last.gates.map((g) => ({ id: g.id, ok: g.ok, evidence: g.evidence })),
          },
  };
}

/* ──────────────────────── promotion reconciliation ──────────────────── */

/**
 * Account for a promotion that outlived the process which started it.
 *
 * Called before anything else reads or changes the state, because until the
 * verdict is in, nothing may claim the repair was applied -- and a second
 * attempt must not start on top of a promotion still in flight.
 */
export function reconcilePromotion(): void {
  const state = loadState();
  const pending = state.pending;
  if (pending === null) return;

  const result = readPromotionResult(pending.attemptId);
  if (result.status === 'pending') {
    // Still going, or the promoter died before writing anything. A promotion that
    // never reports is left pending on purpose: the next attempt is blocked, and
    // the state file says exactly what is unresolved.
    return;
  }

  const record: AttemptRecord = {
    id: pending.attemptId,
    signature: pending.signature,
    attempt: attemptsUsed(state, pending.signature),
    startedAt: pending.startedAt,
    finishedAt: new Date().toISOString(),
    outcome: result.status === 'applied' ? 'applied' : 'promote-failed',
    failure: pending.failure,
    changed: pending.changed,
    violations: [],
    gates: pending.gates,
    engineCode: null,
    detail: result.detail,
    diffPath: pending.diffPath,
    workspace: pending.workspace,
  };

  const diff = pending.diffPath === null ? undefined : readIfPresent(pending.diffPath);

  if (result.status === 'applied') {
    recordRepairEvent({
      action: 'repair_applied',
      signature: pending.signature,
      summary: summariseAttempt(record),
      detail: `${result.detail} | gates: ${pending.gates.map((g) => `${g.id}=${g.evidence}`).join('; ')}`,
      ...(diff === undefined ? {} : { diff }),
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
    });
    updateState((s) => ({
      ...s,
      phase: 'succeeded',
      pending: null,
      suspended: null,
      lastAttempt: record,
      // The problem is solved: its allowance goes back, so an unrelated failure
      // that happens to hash the same later is not born already exhausted.
      attempts: withoutKey(s.attempts, pending.signature),
    }));
    unscheduleResume();
    removeWorkspace(pending.workspace);
  } else {
    recordRepairEvent({
      action: 'repair_failed',
      signature: pending.signature,
      summary: summariseAttempt(record),
      detail: result.detail,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
    });
    updateState((s) => ({ ...s, phase: 'failed', pending: null, lastAttempt: record }));
  }

  journal('repair.promote.reconciled', { attemptId: pending.attemptId, status: result.status });
}

function withoutKey(map: Readonly<Record<string, number>>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== key) out[k] = v;
  }
  return out;
}

function readIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/* ────────────────────────────── entry points ────────────────────────── */

export interface RepairOptions {
  /** Test seam. Never set in production: the live tree is the thing being fixed. */
  liveAppDir?: string;
}

/**
 * Start a repair for a failed update, and return at once.
 *
 * Deliberately does NOT wait for the outcome. A session plus four gates is
 * twenty minutes, and an HTTP request held open that long is one that something
 * in between will kill at the nineteenth minute -- leaving a repair running with
 * nobody to record what it did. The work is started on the next tick so the
 * caller's response is written before the clone starts copying, and everything
 * afterwards is reported through the state file.
 */
export async function runRepair(
  request: RepairRequest,
  opts: RepairOptions = {},
): Promise<RepairStatus> {
  reconcilePromotion();
  if (active !== null) return repairStatus();
  start(() => attempt(request, null, opts));
  return repairStatus();
}

/**
 * Hand work to the next tick and make sure its failure can never be silent.
 *
 * `attempt` catches everything it can, so a rejection here means a bug rather
 * than an outcome; it is logged and journalled instead of becoming an unhandled
 * rejection that takes the server down with it.
 */
function start(work: () => Promise<RepairStatus>): void {
  const deferred = new Promise<RepairStatus>((resolve) => {
    setTimeout(() => resolve(work()), 0);
  });
  active = deferred.finally(() => {
    active = null;
  });
  active.catch((e: unknown) => {
    const err = toEngineError(e);
    log.error('repair.crashed', { code: err.code, detail: err.detail });
    journal('repair.crashed', { code: err.code, detail: err.detail ?? null });
    updateState((s) => ({ ...s, phase: 'failed' }));
  });
}

/**
 * Pick up a repair that stopped on the subscription limit.
 *
 * Called by the scheduled LaunchAgent, and also whenever anything asks for the
 * status after the reset time has passed -- because launchd is a trigger, not a
 * guarantee, and the state file is what actually knows a repair is owed.
 */
export async function resumeRepair(opts: RepairOptions = {}): Promise<RepairStatus> {
  reconcilePromotion();
  const state = loadState();
  if (state.suspended === null) return repairStatus();
  if (!dueForResume(state)) return repairStatus();
  if (active !== null) return repairStatus();

  const suspended = state.suspended;
  start(() => attempt(suspended.request, suspended, opts));
  return repairStatus();
}

/** Called by the status route: a due resume must not need anyone to remember it. */
export async function resumeIfDue(opts: RepairOptions = {}): Promise<void> {
  const state = loadState();
  if (dueForResume(state) && active === null) {
    void resumeRepair(opts);
  }
}

/* ─────────────────────────────── the run ────────────────────────────── */

interface Resumption {
  attemptId: string;
  workspace: string;
  sessionId: string | null;
  lastGateDetail: string;
}

async function attempt(
  request: RepairRequest,
  resuming: Resumption | null,
  opts: RepairOptions,
): Promise<RepairStatus> {
  ensureRepairDirs();
  const startedAt = new Date().toISOString();
  const signature = failureSignature(request.failure);
  const state = loadState();

  /* 0. Rollback first, always. */
  if (state.emergency !== null) {
    journal('repair.blocked.emergency', { signature });
    return repairStatus();
  }
  if (!request.rollback.performed || !request.rollback.healthy) {
    return emergency(
      signature,
      request,
      request.rollback.performed
        ? 'The rollback ran but the restored version did not answer a health check.'
        : 'No rollback was performed, so there is no known-good version running.',
    );
  }

  /* 1. The cap. */
  if (capReached(state, signature)) {
    recordRepairEvent({
      action: 'repair_exhausted',
      signature,
      summary: `Stopped: ${MAX_ATTEMPTS_PER_SIGNATURE} attempts have been spent on this failure and it is still not fixed.`,
      detail: `${request.failure.stage}/${request.failure.code}: ${request.failure.message}`,
      fromVersion: request.update.fromVersion,
      toVersion: request.update.toVersion,
    });
    updateState((s) => ({ ...s, phase: 'exhausted', activeSignature: signature, suspended: null }));
    unscheduleResume();
    return repairStatus();
  }

  const attemptId = resuming?.attemptId ?? newId();
  const dir = attemptDir(attemptId);
  // Created here, explicitly, rather than being left to appear as a side effect
  // of whichever gate happened to mkdir its report directory first. Everything
  // below writes into it -- the prompt, the baselines, the diff -- and an
  // unwrapped writeFileSync into a directory nobody owns is a crash waiting for
  // the day the order of the steps changes.
  mkdirSync(dir, { recursive: true });
  let workspace = resuming?.workspace ?? '';

  try {
    // Inside the try: a bundle we cannot locate is an outcome to record, not an
    // exception to leak out of a background task nobody is awaiting.
    const liveAppDir = opts.liveAppDir ?? resolveLiveAppDir();

    /* 2. The clone. */
    updateState((s) => ({ ...s, phase: 'preparing', activeSignature: signature }));

    const sourceDir = request.sourceDir ?? '';
    if (resuming === null) {
      if (sourceDir === '' || !existsSync(sourceDir)) {
        return refuse(
          signature,
          request,
          attemptId,
          startedAt,
          'The updater did not hand over the source tree that failed, so there is nothing complete enough to gate a fix against.',
        );
      }
      workspace = newWorkspacePath(attemptId);
      const clone = cloneTree(sourceDir, workspace);
      journal('repair.workspace', { attemptId, cloned: clone.cloned, ms: clone.durationMs });
    }

    /* 3. Can the gates even run here, and what already fails? */
    const readiness = checkGateReadiness(workspace);
    if (!readiness.ready) {
      return refuse(
        signature,
        request,
        attemptId,
        startedAt,
        `The candidate cannot be gated on this Mac: ${readiness.missing.join(', ')} is missing. Nothing was attempted.`,
        workspace,
      );
    }

    const gateEnv = defaultGateEnvironment(workspace, dir);
    const baseline = await loadOrMeasureBaseline(dir, gateEnv, resuming !== null);
    const typecheckFloor = await loadOrMeasureTypecheckFloor(dir, gateEnv, resuming !== null);

    /* 4. Spend the attempt, then ask Claude. */
    const attemptNumber = spendAttempt(signature);
    updateState((s) => ({ ...s, phase: 'consulting' }));

    const { manifest: before, sinceMs } = loadOrCaptureBefore(dir, workspace, resuming !== null);

    // What the last attempt at THIS failure was rejected for. Attempt two is the
    // first that has anything to learn from, and without this it would be handed
    // the same problem with the same information and produce the same answer.
    const previous = previousRejection(signature, resuming?.lastGateDetail ?? '');
    const prompt = buildRepairPrompt({
      request,
      attempt: attemptNumber,
      cap: MAX_ATTEMPTS_PER_SIGNATURE,
      ...(previous.gateDetail === '' ? {} : { previousGateDetail: previous.gateDetail }),
      ...(previous.diff === '' ? {} : { previousDiff: previous.diff }),
    });
    writeFileSync(join(dir, 'prompt.txt'), prompt, 'utf8');

    recordRepairEvent({
      action: 'repair_started',
      signature,
      summary: `Attempt ${attemptNumber} of ${MAX_ATTEMPTS_PER_SIGNATURE} on "${request.failure.message}".`,
      detail: `workspace=${workspace} | grant: ${describeGrant()}`,
      fromVersion: request.update.fromVersion,
      toVersion: request.update.toVersion,
    });

    const session = await invokeRepair({
      cwd: workspace,
      prompt,
      resumeSessionId: resuming?.sessionId ?? null,
    });
    writeFileSync(join(dir, 'session.txt'), session.text, 'utf8');

    /* 5. A usage limit is not a failed attempt. */
    if (session.classification.kind === 'error' && session.classification.code === 'CLI_USAGE_LIMIT') {
      refundAttempt(signature);
      return defer(signature, request, {
        attemptId,
        attempt: attemptNumber,
        workspace,
        sessionId: session.sessionId,
        limitResetsAt: session.classification.limitResetsAt ?? null,
        retryAfterMs: session.classification.retryAfterMs ?? null,
        lastGateDetail: resuming?.lastGateDetail ?? '',
        liveAppDir,
      });
    }

    if (!session.ok) {
      const code =
        session.classification.kind === 'error' ? session.classification.code : 'CLI_BAD_OUTPUT';
      const detail =
        session.classification.kind === 'error' ? session.classification.detail : 'no answer';
      return finish(
        makeRecord({
          attemptId,
          signature,
          attemptNumber,
          startedAt,
          request,
          outcome: 'engine-failed',
          engineCode: code,
          detail,
          workspace,
        }),
        'repair_failed',
        request,
      );
    }

    /* 6. What actually changed. */
    updateState((s) => ({ ...s, phase: 'gating' }));
    const after: Manifest = scanTree(workspace);
    const changes = compareManifests(before, after);
    const touched = changedPaths(changes);
    const heavyWrites = [
      ...findWritesSince(join(workspace, 'node_modules'), sinceMs, { cap: 10 }).map(
        (p) => `node_modules/${p}`,
      ),
      ...findWritesSince(join(workspace, '.next'), sinceMs, { cap: 10 }).map((p) => `.next/${p}`),
    ];

    if (touched.length === 0 && heavyWrites.length === 0) {
      return finish(
        makeRecord({
          attemptId,
          signature,
          attemptNumber,
          startedAt,
          request,
          outcome: 'no-changes',
          detail: session.text.slice(0, 1_000),
          workspace,
        }),
        'repair_failed',
        request,
      );
    }

    const diff = buildUnifiedDiff(request.sourceDir ?? workspace, workspace, changes);
    const diffPath = join(dir, 'changes.diff');
    writeFileSync(diffPath, diff, 'utf8');

    const violations = [
      ...protectedViolations([...touched, ...heavyWrites]),
      // A link is not a changed file, so it has to be asked about separately --
      // and it is asked about here, alongside the protected paths, because the
      // consequence is the same one: the candidate is thrown away untouched.
      ...symlinkViolations(workspace, before, after).map((v) => ({
        path: v.path,
        reason: `${v.reason} (-> ${v.target})`,
      })),
    ];
    if (violations.length > 0) {
      const record = makeRecord({
        attemptId,
        signature,
        attemptNumber,
        startedAt,
        request,
        outcome: 'protected-path',
        detail: violations.map((v) => `${v.path}: ${v.reason}`).join('\n'),
        workspace,
        violations,
        changes,
        diffPath,
      });
      recordRepairEvent({
        action: 'repair_rejected',
        signature,
        summary: summariseAttempt(record),
        detail: record.detail,
        diff,
        fromVersion: request.update.fromVersion,
        toVersion: request.update.toVersion,
      });
      removeWorkspace(workspace);
      return finish(record, null, request);
    }

    /* 7. The gates. */
    const gates: GateReport = await runGates(gateEnv, GATE_ORDER, baseline);
    const narrowed = typecheckNarrowing(typecheckFloor, gates.results);
    if (!gates.ok || narrowed !== null) {
      const detail = [gates.detail, narrowed ?? ''].filter((part) => part !== '').join('\n\n');
      const record = makeRecord({
        attemptId,
        signature,
        attemptNumber,
        startedAt,
        request,
        outcome: 'gate-failed',
        detail,
        workspace,
        changes,
        diffPath,
        gates: gates.results,
      });
      recordRepairEvent({
        action: 'repair_gate_failed',
        signature,
        summary: summariseAttempt(record),
        detail,
        diff,
        fromVersion: request.update.fromVersion,
        toVersion: request.update.toVersion,
      });
      // The workspace is kept: the next attempt is told what failed, and this is
      // the only copy of the code that produced it.
      return finish(record, null, request);
    }

    /* 8. Hand it to something that outlives the restart. */
    return await promote({
      attemptId,
      signature,
      request,
      workspace,
      liveAppDir,
      touched,
      changes,
      diffPath,
      gates: gates.results,
      startedAt,
      attemptNumber,
    });
  } catch (e) {
    const err = toEngineError(e);
    log.error('repair.attempt.failed', { signature, code: err.code, detail: err.detail });
    const record = makeRecord({
      attemptId,
      signature,
      attemptNumber: attemptsUsed(loadState(), signature),
      startedAt,
      request,
      outcome: 'engine-failed',
      engineCode: err.code,
      detail: err.detail ?? err.info.message,
      workspace,
    });
    return finish(record, 'repair_failed', request);
  }
}

/**
 * Why the previous attempt at this same failure was thrown away, and what it
 * changed. Empty on the first attempt, which is the honest answer then.
 */
function previousRejection(
  signature: string,
  fromSuspension: string,
): { gateDetail: string; diff: string } {
  const last = loadState().lastAttempt;
  if (last === null || last.signature !== signature) {
    return { gateDetail: fromSuspension, diff: '' };
  }
  const diff = last.diffPath === null ? undefined : readIfPresent(last.diffPath);
  return {
    gateDetail: fromSuspension !== '' ? fromSuspension : last.detail,
    diff: diff ?? '',
  };
}

/**
 * The state of the tree BEFORE any session touched it, captured once and kept.
 *
 * On a resume this must be the original capture, not a fresh scan: the workspace
 * already carries the first session's edits, and re-scanning would treat those
 * as the pristine baseline. A file the first session changed would then never
 * appear in the diff -- so it would never be protection-checked and never be
 * promoted, which is the quiet failure this exists to prevent.
 *
 * `sinceMs` is stored with it for the same reason: it is what the mtime sweep of
 * node_modules and .next is measured against, and it has to reach back to before
 * the first session too.
 */
function loadOrCaptureBefore(
  dir: string,
  workspaceDir: string,
  resuming: boolean,
): { manifest: Manifest; sinceMs: number } {
  const file = join(dir, 'manifest-before.json');
  if (resuming) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof saved === 'object' && saved !== null && 'manifest' in saved) {
        const record = saved as { manifest: Manifest; sinceMs?: number };
        return { manifest: record.manifest, sinceMs: record.sinceMs ?? 0 };
      }
    } catch {
      // Fall through and re-capture. A resumed attempt whose baseline is gone is
      // measured against the tree as it stands, which can only over-report a
      // change -- and over-reporting is refused, never applied.
    }
  }
  const captured = { manifest: scanTree(workspaceDir), sinceMs: Date.now() };
  try {
    writeFileSync(file, JSON.stringify(captured), 'utf8');
  } catch {
    // A baseline we cannot store is still usable for this run.
  }
  return captured;
}

/**
 * The baseline is measured on the pristine tree, once, and kept.
 *
 * On a resume the tree already carries the previous session's edits, so
 * re-measuring would bake those in as "already failing" -- which is exactly the
 * hole the baseline exists to close.
 */
async function loadOrMeasureBaseline(
  dir: string,
  env: ReturnType<typeof defaultGateEnvironment>,
  resuming: boolean,
): Promise<Baseline> {
  const file = join(dir, 'baseline.json');
  if (resuming || existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
    } catch {
      return { tests: null, evals: null };
    }
  }
  const baseline = await measureBaseline(env);
  try {
    writeFileSync(file, JSON.stringify(baseline), 'utf8');
  } catch {
    // A baseline we cannot store is still usable for this run.
  }
  return baseline;
}

/**
 * How many files tsc compiled on the PRISTINE tree, measured once and kept.
 *
 * Same rule as the other baselines, and for the same reason: on a resume the
 * workspace already carries the previous session's edits, so re-measuring here
 * would adopt a narrowed program as the thing to compare against -- which is the
 * hole this closes, reopened by the mechanism meant to close it.
 *
 * Errors in the pristine measurement are ignored on purpose. Only the count is
 * wanted; the gate itself still demands zero errors afterwards.
 */
async function loadOrMeasureTypecheckFloor(
  dir: string,
  env: ReturnType<typeof defaultGateEnvironment>,
  resuming: boolean,
): Promise<number | null> {
  const file = join(dir, 'typecheck-floor.json');
  if (resuming || existsSync(file)) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const value =
        typeof saved === 'object' && saved !== null ? Reflect.get(saved, 'filesChecked') : null;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      // No floor is not zero: an unreadable baseline disables the comparison
      // rather than failing every candidate against a number we never had.
      return null;
    }
  }
  const measured = typecheckFilesChecked([await runGate('typecheck', env)]);
  try {
    writeFileSync(file, JSON.stringify({ filesChecked: measured }), 'utf8');
  } catch {
    // A baseline we cannot store is still usable for this run.
  }
  return measured;
}

/* ───────────────────────────── outcomes ─────────────────────────────── */

interface RecordInput {
  attemptId: string;
  signature: string;
  attemptNumber: number;
  startedAt: string;
  request: RepairRequest;
  outcome: AttemptOutcome;
  detail: string;
  workspace: string;
  engineCode?: string;
  violations?: AttemptRecord['violations'];
  changes?: { added: string[]; modified: string[]; removed: string[] };
  diffPath?: string;
  gates?: AttemptRecord['gates'];
}

function makeRecord(input: RecordInput): AttemptRecord {
  return {
    id: input.attemptId,
    signature: input.signature,
    attempt: input.attemptNumber,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    outcome: input.outcome,
    failure: input.request.failure,
    changed: {
      added: input.changes?.added.length ?? 0,
      modified: input.changes?.modified.length ?? 0,
      removed: input.changes?.removed.length ?? 0,
    },
    violations: input.violations ?? [],
    gates: input.gates ?? [],
    engineCode: input.engineCode ?? null,
    detail: input.detail,
    diffPath: input.diffPath ?? null,
    workspace: input.workspace === '' ? null : input.workspace,
  };
}

function finish(
  record: AttemptRecord,
  action: 'repair_failed' | null,
  request: RepairRequest,
): RepairStatus {
  if (action !== null) {
    recordRepairEvent({
      action,
      signature: record.signature,
      summary: summariseAttempt(record),
      detail: record.detail,
      fromVersion: request.update.fromVersion,
      toVersion: request.update.toVersion,
    });
  }
  const state = updateState((s) => ({
    ...s,
    phase: capReached(s, record.signature) ? 'exhausted' : 'failed',
    suspended: null,
    lastAttempt: record,
  }));
  if (state.phase === 'exhausted') {
    recordRepairEvent({
      action: 'repair_exhausted',
      signature: record.signature,
      summary: `Stopped after ${MAX_ATTEMPTS_PER_SIGNATURE} attempts. The tracker is on the last version that worked; this needs a person.`,
      detail: record.detail,
    });
    unscheduleResume();
  }
  pruneWorkspaces(undefined, record.workspace ?? undefined);
  return repairStatus();
}

function refuse(
  signature: string,
  request: RepairRequest,
  attemptId: string,
  startedAt: string,
  reason: string,
  workspace = '',
): RepairStatus {
  const record = makeRecord({
    attemptId,
    signature,
    attemptNumber: 0,
    startedAt,
    request,
    outcome: 'refused',
    detail: reason,
    workspace,
  });
  recordRepairEvent({
    action: 'repair_refused',
    signature,
    summary: reason,
    detail: `${request.failure.stage}/${request.failure.code}`,
    fromVersion: request.update.fromVersion,
    toVersion: request.update.toVersion,
  });
  updateState((s) => ({ ...s, phase: 'refused', activeSignature: signature, lastAttempt: record }));
  return repairStatus();
}

/**
 * Rollback did not leave a healthy install.
 *
 * Nothing is attempted. This is the one case the design refuses to be clever
 * about: an AI editing source while the tracker is down is how a bad hour
 * becomes a bad week.
 */
function emergency(signature: string, request: RepairRequest, reason: string): RepairStatus {
  log.error('repair.emergency', { signature, reason, stage: request.failure.stage });
  journal('repair.emergency', { signature, reason });
  recordRepairEvent({
    action: 'repair_refused',
    signature,
    summary: `EMERGENCY: ${reason} No repair was attempted.`,
    detail: `${request.failure.stage}/${request.failure.code}: ${request.failure.message}`,
    fromVersion: request.update.fromVersion,
    toVersion: request.update.toVersion,
  });
  updateState((s) => ({
    ...s,
    phase: 'emergency',
    activeSignature: signature,
    suspended: null,
    emergency: { at: new Date().toISOString(), reason },
  }));
  unscheduleResume();
  return repairStatus();
}

interface DeferInput {
  attemptId: string;
  attempt: number;
  workspace: string;
  sessionId: string | null;
  limitResetsAt: string | null;
  retryAfterMs: number | null;
  lastGateDetail: string;
  liveAppDir: string;
}

/**
 * Stopped on the subscription cap.
 *
 * The reset time comes from the CLI's own message when it gave one -- the same
 * parse the extraction queue uses -- and from a conservative default when it did
 * not. Both are recorded, so a resume that fires at the wrong hour can be told
 * apart from a limit that had not really lifted.
 */
function defer(signature: string, request: RepairRequest, input: DeferInput): RepairStatus {
  const resumeAt = new Date(
    input.limitResetsAt !== null
      ? Date.parse(input.limitResetsAt)
      : Date.now() + (input.retryAfterMs ?? DEFAULT_LIMIT_WAIT_MS),
  );
  const at = Number.isFinite(resumeAt.getTime())
    ? resumeAt
    : new Date(Date.now() + DEFAULT_LIMIT_WAIT_MS);

  const script = materialisePromoter(input.liveAppDir, [input.workspace]);
  const outcome =
    script === null
      ? { scheduled: false, at: at.toISOString(), detail: 'repair.sh could not be found to schedule' }
      : scheduleResume(at, script);

  updateState((s) => ({
    ...s,
    phase: 'waiting-limit',
    activeSignature: signature,
    suspended: {
      attemptId: input.attemptId,
      signature,
      attempt: input.attempt,
      workspace: input.workspace,
      request,
      sessionId: input.sessionId,
      resumeAt: at.toISOString(),
      resumeSource: input.limitResetsAt !== null ? 'cli' : 'default',
      lastGateDetail: input.lastGateDetail,
    },
  }));

  recordRepairEvent({
    action: 'repair_deferred',
    signature,
    summary: `Paused on the Claude subscription limit. It will pick up where it left off at ${at.toISOString()}.`,
    detail: `${outcome.detail} | agent=${REPAIR_AGENT_LABEL} | source=${input.limitResetsAt !== null ? 'cli' : 'default'}`,
    fromVersion: request.update.fromVersion,
    toVersion: request.update.toVersion,
  });
  return repairStatus();
}

interface PromoteInput {
  attemptId: string;
  signature: string;
  request: RepairRequest;
  workspace: string;
  liveAppDir: string;
  touched: string[];
  changes: { added: string[]; modified: string[]; removed: string[] };
  diffPath: string;
  gates: AttemptRecord['gates'];
  startedAt: string;
  attemptNumber: number;
}

/**
 * Stage the promotion and hand it over.
 *
 * This function does NOT copy anything and does not restart anything. It writes
 * the plan, spawns the detached promoter, records that a promotion is in flight,
 * and returns -- because within seconds the server it is running in will be
 * stopped by that promoter. Everything after the handover is reconciled by
 * `reconcilePromotion()` from whichever process is next to ask.
 */
async function promote(input: PromoteInput): Promise<RepairStatus> {
  // The plan is a newline-delimited list read by a shell script, so a filename
  // containing a newline is two paths, and only the first of them was ever
  // checked against the protected list. The diff guard already refuses such a
  // name; this is the check that stands between it and the file being WRITTEN,
  // and repair.sh makes the same check again on the way in. Three, because the
  // thing on the other side of this list is her contracts.
  const unsafe = input.touched.filter(hasControlCharacters);
  if (unsafe.length > 0) {
    const record = makeRecord({
      attemptId: input.attemptId,
      signature: input.signature,
      attemptNumber: input.attemptNumber,
      startedAt: input.startedAt,
      request: input.request,
      outcome: 'protected-path',
      detail: `the promotion plan would have named a path containing a control character, which is how one path is made to look like two: ${unsafe
        .map(describePath)
        .join(', ')}`,
      workspace: input.workspace,
      diffPath: input.diffPath,
      gates: input.gates,
    });
    // Recorded as a rejection rather than a failure, the same as the diff guard:
    // this candidate did not fail, it was refused.
    recordRepairEvent({
      action: 'repair_rejected',
      signature: input.signature,
      summary: summariseAttempt(record),
      detail: record.detail,
      fromVersion: input.request.update.fromVersion,
      toVersion: input.request.update.toVersion,
    });
    removeWorkspace(input.workspace);
    return finish(record, null, input.request);
  }

  const script = materialisePromoter(input.liveAppDir, [input.workspace]);
  if (script === null) {
    const record = makeRecord({
      attemptId: input.attemptId,
      signature: input.signature,
      attemptNumber: input.attemptNumber,
      startedAt: input.startedAt,
      request: input.request,
      outcome: 'promote-failed',
      detail:
        'The fix passed every gate but repair.sh is not installed, so nothing could put it live safely.',
      workspace: input.workspace,
      diffPath: input.diffPath,
      gates: input.gates,
    });
    return finish(record, 'repair_failed', input.request);
  }

  const resources = resolveResourcesDir(input.liveAppDir);
  const { envFile } = stagePromotion({
    attemptId: input.attemptId,
    signature: input.signature,
    workspace: input.workspace,
    live: input.liveAppDir,
    files: input.touched,
    backup: join(attemptDir(input.attemptId), 'backup'),
    resultFile: join(attemptDir(input.attemptId), 'result.txt'),
    serverSh: resources === null ? null : join(resources, 'bin', 'server.sh'),
    createdAt: new Date().toISOString(),
  });

  updateState((s) => ({
    ...s,
    phase: 'promoting',
    activeSignature: input.signature,
    suspended: null,
    pending: {
      attemptId: input.attemptId,
      signature: input.signature,
      startedAt: input.startedAt,
      diffPath: input.diffPath,
      workspace: input.workspace,
      fromVersion: input.request.update.fromVersion,
      toVersion: input.request.update.toVersion,
      changed: {
        added: input.changes.added.length,
        modified: input.changes.modified.length,
        removed: input.changes.removed.length,
      },
      gates: input.gates,
      failure: input.request.failure,
    },
  }));

  const pid = spawnPromoter(script, envFile);
  journal('repair.promote.handover', {
    attemptId: input.attemptId,
    files: input.touched.length,
    pid,
  });

  // Give the detached child a moment to be scheduled before this process is
  // stopped by it. Not a synchronisation primitive -- the result file is.
  await new Promise((r) => setTimeout(r, 500));
  return repairStatus();
}

/** For support: what repair has on disk right now. */
export function repairArtifacts(): { attempts: string[]; agent: string } {
  return { attempts: listAttempts().slice(0, 10), agent: REPAIR_AGENT_LABEL };
}
