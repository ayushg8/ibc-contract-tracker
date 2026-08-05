/**
 * The vocabulary of self-repair.
 *
 * Types and constants only. Nothing here imports node:, so the status shape can be
 * rendered by a client component without dragging child_process into the browser
 * bundle -- the same rule db/types.ts follows.
 *
 * The shape of RepairRequest is the contract with the updater. It is deliberately
 * self-describing: repair imports nothing from the update code, so the two can be
 * built, changed and tested independently, and a repair can be replayed from a
 * recorded request without an update having to happen first.
 */

/* ───────────────────────────── the request ──────────────────────────── */

/** What went wrong. This is what gets hashed into the failure signature. */
export interface FailureReport {
  /** Where in the update it broke: 'download' | 'build' | 'health-check' | ... */
  stage: string;
  /** An EngineErrorCode, or an updater code. Free text so repair never blocks a new one. */
  code: string;
  /** One line, plain English. */
  message: string;
  /** Technical detail. Redacted before it is stored or sent to the model. */
  detail?: string;
  /** The tail of whatever log explains it. Capped before use. */
  logExcerpt?: string;
}

/**
 * Proof that the tracker Bonnie will open in the morning is already working.
 *
 * Repair is background work on a healthy machine. If this says otherwise, repair
 * refuses: an AI thinking about a broken system while she waits in front of it is
 * the failure mode this whole design exists to avoid.
 */
export interface RollbackReport {
  /** Did the rollback actually run? */
  performed: boolean;
  /** Did the rolled-back version answer a health check afterwards? */
  healthy: boolean;
  /** The version now live. */
  version: string | null;
  /** When the health check passed. ISO. */
  at: string;
}

/** What the update tried to change, so the model can see the suspect. */
export interface UpdateReport {
  fromVersion: string | null;
  toVersion: string | null;
  /** Unified diff of the update itself. Capped before it reaches the prompt. */
  diff: string;
}

export interface RepairRequest {
  failure: FailureReport;
  rollback: RollbackReport;
  update: UpdateReport;
  /**
   * The full source tree of the version that failed -- the updater's staging
   * directory, tests and evals included.
   *
   * It cannot default to the live install: install.command deliberately excludes
   * tests/, evals/ and packaging/ from the .app, so a workspace cloned from the
   * bundle can never run the gates, and a repair that cannot be gated must not
   * happen at all. When this is absent the workspace precheck refuses.
   */
  sourceDir?: string;
}

/* ────────────────────────────── the state ───────────────────────────── */

export type RepairPhase =
  /** Nothing has ever run, or the last run finished and was cleared. */
  | 'idle'
  /** Cloning the source tree and checking it can be gated. */
  | 'preparing'
  /** Claude Code is running in the workspace. */
  | 'consulting'
  /** tsc / vitest / eval / build are running against the candidate. */
  | 'gating'
  /** The candidate passed and is being copied into the live install. */
  | 'promoting'
  /** Stopped on a subscription cap. resumeAt says when it will pick up again. */
  | 'waiting-limit'
  /** Fixed and live. */
  | 'succeeded'
  /** The attempt failed. Another one may follow if the cap allows. */
  | 'failed'
  /** Refused before anything ran: protected paths, or gates that cannot run. */
  | 'refused'
  /** The cap for this failure signature is spent. No further attempts, ever. */
  | 'exhausted'
  /** Rollback did not leave a healthy install. Repair will not touch this. */
  | 'emergency';

/** A phase from which nothing more will happen without a human. */
export const TERMINAL_PHASES: readonly RepairPhase[] = [
  'succeeded',
  'refused',
  'exhausted',
  'emergency',
];

export type GateId = 'typecheck' | 'tests' | 'evals' | 'build';

/**
 * One gate's verdict.
 *
 * `evidence` is the point of this type. An exit code is a claim: `vitest run`
 * exits 0 when it finds no test files at all, and `next build` can exit 0 from a
 * cache. Every gate therefore records what it actually observed -- counts, not
 * status -- and `ok` is derived from that, never from the exit code alone.
 */
export interface GateResult {
  id: GateId;
  ok: boolean;
  /** What was observed, in numbers. e.g. "412 passed, 0 failed, 21 files". */
  evidence: string;
  /** Why it failed, or '' when it passed. Redacted, capped. */
  detail: string;
  exitCode: number | null;
  durationMs: number;
}

/** What changed in the workspace, computed by diffing the tree. Never asked for. */
export interface ChangeSet {
  added: string[];
  modified: string[];
  removed: string[];
  /** Unified diff over every entry above. Capped. */
  diff: string;
  /** Absolute path of the full, uncapped diff on disk. */
  diffPath: string | null;
}

export interface ProtectedViolation {
  path: string;
  /** The rule that caught it, in her language. */
  reason: string;
}

export type AttemptOutcome =
  | 'applied'
  | 'gate-failed'
  | 'protected-path'
  | 'no-changes'
  | 'engine-failed'
  | 'promote-failed'
  | 'deferred'
  | 'refused';

export interface AttemptRecord {
  id: string;
  signature: string;
  /** 1-based, within this signature. */
  attempt: number;
  startedAt: string;
  finishedAt: string;
  outcome: AttemptOutcome;
  /** The failure this attempt was answering. */
  failure: FailureReport;
  changed: { added: number; modified: number; removed: number };
  violations: ProtectedViolation[];
  gates: GateResult[];
  /** EngineErrorCode when the CLI itself failed. */
  engineCode: string | null;
  detail: string;
  diffPath: string | null;
  workspace: string | null;
}

/** Everything needed to pick up an attempt that stopped on a usage limit. */
export interface SuspendedAttempt {
  attemptId: string;
  signature: string;
  attempt: number;
  workspace: string;
  request: RepairRequest;
  /** The CLI session to continue, when the installed build supports resuming. */
  sessionId: string | null;
  /** ISO. Nothing is tried before this. */
  resumeAt: string;
  /** How the reset time was learned: the CLI said so, or we assumed the default. */
  resumeSource: 'cli' | 'default';
  /** Gate output from the last attempt, fed back into the next prompt. */
  lastGateDetail: string;
}

/**
 * A promotion handed to the detached script and not yet accounted for.
 *
 * It exists because the promotion kills the process that started it: the server
 * is restarted as part of putting the fix live, so the verdict has to be picked
 * up afterwards by whatever asks next. Until it is reconciled, nothing claims
 * the repair was applied.
 */
export interface PendingPromotion {
  attemptId: string;
  signature: string;
  startedAt: string;
  diffPath: string | null;
  workspace: string;
  fromVersion: string | null;
  toVersion: string | null;
  changed: { added: number; modified: number; removed: number };
  gates: GateResult[];
  failure: FailureReport;
}

export interface RepairState {
  version: 1;
  phase: RepairPhase;
  /** The failure currently being worked, if any. */
  activeSignature: string | null;
  /** Attempts spent per failure signature. Never reset except on success. */
  attempts: Record<string, number>;
  suspended: SuspendedAttempt | null;
  pending: PendingPromotion | null;
  lastAttempt: AttemptRecord | null;
  /** Set only when rollback did not leave a healthy install. Needs a human. */
  emergency: { at: string; reason: string } | null;
  updatedAt: string;
}

/** What GET /api/repair answers with. Safe for the browser: no paths, no keys. */
export interface RepairStatus {
  phase: RepairPhase;
  signature: string | null;
  attemptsUsed: number;
  attemptCap: number;
  resumeAt: string | null;
  scheduled: boolean;
  emergency: { at: string; reason: string } | null;
  last: {
    at: string;
    outcome: AttemptOutcome;
    summary: string;
    changed: { added: number; modified: number; removed: number };
    gates: { id: GateId; ok: boolean; evidence: string }[];
  } | null;
}

/* ───────────────────────────── the numbers ──────────────────────────── */

/**
 * Attempts allowed against one failure signature before repair stops for good.
 *
 * Three, because the second attempt is the first one that has gate output to
 * learn from and the third is the last that plausibly adds information. Beyond
 * that it is spending her subscription to re-derive the same wrong answer.
 */
export const MAX_ATTEMPTS_PER_SIGNATURE = 3;

/** Wall clock for one Claude session. Long enough to read the repo, not to wander. */
export const CLAUDE_TIMEOUT_MS = 20 * 60_000;

/** Hard cap on the session, independent of the clock, when the build supports it. */
export const CLAUDE_MAX_TURNS = 40;

/** Per-gate wall clock. next build is the slow one. */
export const GATE_TIMEOUT_MS: Record<GateId, number> = {
  typecheck: 5 * 60_000,
  tests: 10 * 60_000,
  evals: 10 * 60_000,
  build: 15 * 60_000,
};

/** How long to wait for the live server to answer after a promote or a restore. */
export const HEALTH_TIMEOUT_MS = 90_000;

/** The audit row keeps the diff, but a diff is not a blob store. */
export const MAX_AUDIT_DIFF_BYTES = 64 * 1024;

/** What the model is shown of any one log. Enough to diagnose, not to drown in. */
export const MAX_PROMPT_LOG_BYTES = 16 * 1024;

/** What the model is shown of the update's own diff. */
export const MAX_PROMPT_DIFF_BYTES = 96 * 1024;

/** Default assumption when the CLI reports a cap without saying when it lifts. */
export const DEFAULT_LIMIT_WAIT_MS = 60 * 60_000;

/** Workspaces kept on disk for forensics. Older ones are removed. */
export const KEEP_WORKSPACES = 3;

/** Every repair action written to the audit table carries this actor. */
export const REPAIR_ACTOR = 'repair';
