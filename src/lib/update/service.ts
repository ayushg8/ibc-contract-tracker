/**
 * The brain behind GET and POST /api/update.
 *
 * Everything the route answers is assembled here from four sources that can each
 * be missing: the bundle on disk, the state file, the progress file the applier
 * writes, and the result file it leaves behind. None of them is authoritative on
 * its own, and the reconciliation between them is the interesting part:
 *
 *   - the version that is RUNNING comes from the symlink, never from the state
 *     file, because the symlink is changed by the same operation that changes
 *     what runs and therefore cannot drift;
 *   - an update is "available" only if it is newer than that;
 *   - a progress file whose process is gone is not progress, it is an interrupted
 *     apply, and it is reported as a failure rather than as a spinner.
 *
 * Reconciliation is also where a failure gets handed to self-repair. It is the
 * only place that can be: the process that watched an update fail is the process
 * the update stopped, so the first thing capable of reporting the failure is
 * whatever asks for the status afterwards. See "handing over to repair" below.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '@/lib/logger';
import { dataDir } from '@/lib/paths';
import type { RepairRequest } from '@/lib/repair/types';

import type { ApplyPlan } from './apply';
import { applyBlocker, writePlanAndSpawn } from './apply';
import { UpdateError, failureInfo, isUpdateFailureCode } from './failures';
import { detectLayout, type Layout } from './install';
import { resolveManifest } from './manifest';
import { updateDir, updateLogPath } from './paths';
import { readSource } from './source';
import { patchState, readState, toAvailable, type StoredLatest, type UpdateState } from './state';
import { interruptedResult, readProgress, readResult } from './runtime';
import type {
  UpdateActionResponse,
  UpdateBusy,
  UpdateFailure,
  UpdateResult,
  UpdateSource,
  UpdateStatus,
} from './types';
import { isAtLeast, isNewer } from './version';

/**
 * One check at a time, per process. Not a lock on disk: a check writes nothing
 * destructive, so two of them racing costs a wasted request and nothing else.
 * The apply lock is the one that matters and it lives in the filesystem, because
 * it has to hold across the restart that ends this process.
 */
let inFlightCheck: Promise<UpdateState> | null = null;

/* ─────────────────────────── availability ─────────────────────────────── */

function applicability(
  latest: StoredLatest,
  currentVersion: string,
): { applicable: boolean; blockedReason: string | null } {
  const floor = latest.minimumSupportedVersion;
  if (floor !== null && !isAtLeast(currentVersion, floor)) {
    return {
      applicable: false,
      blockedReason: `This version is too old to update straight to ${latest.version}. Ask Ayush to run the installer once.`,
    };
  }
  return { applicable: true, blockedReason: null };
}

/* ────────────────────────────── status ────────────────────────────────── */

/**
 * The result of the last apply, reconciled against what is actually running.
 *
 * A result file saying "ok, 1.2.0" while the symlink points at 1.1.0 is not a
 * success, whatever the file says -- that is the shape a rollback that happened
 * after the file was written would take, and believing the file would hide it.
 */
function reconciledResult(layout: Layout): UpdateResult | null {
  const progress = readProgress();
  if (progress !== null && !progress.alive) return interruptedResult(progress);

  const result = readResult();
  if (result === null) return null;
  if (result.ok && result.version !== layout.currentVersion) {
    return {
      ...result,
      ok: false,
      failure: {
        code: 'UNKNOWN',
        phase: 'failed',
        message: failureInfo('UNKNOWN').message,
        detail: `the applier recorded ${result.version} but ${layout.currentVersion} is running`,
        rolledBackTo: layout.currentVersion,
        rollbackOk: true,
        logPath: result.failure?.logPath ?? '',
      },
    };
  }
  return result;
}

/* ────────────────────────── handing over to repair ────────────────────── */

/**
 * The other half of "an update fails and something happens next".
 *
 * Rolling back is only the first half. Until this existed, a failed update ended
 * with the old version serving and nobody told: `runRepair()` had exactly one
 * door, `POST /api/repair`, and nothing in the tree ever knocked on it. The
 * self-repair feature was reachable only by hand.
 *
 * This is the knock, and it is placed where the failure is first OBSERVED rather
 * than where it happens -- the process that watched the update fail is the
 * process the update stopped, so it is not there to report anything. Whoever
 * asks for the status next is.
 *
 * Two properties do all the work, and both are load-bearing:
 *
 *   Exactly once per failure. `reconciledResult()` runs on every
 *   GET /api/update, which the UI polls; a repair started per poll would be a
 *   Claude session per second. The claim is written to disk BEFORE the request
 *   goes out, so two overlapping polls cannot both fire and a restart cannot
 *   forget.
 *
 *   Never when the rollback did not complete. That is the case where she may be
 *   looking at a broken app right now, and the answer to it is a person reading
 *   a loud log line, not an AI quietly thinking for twenty minutes.
 */

/** How much of the update log the model is shown. Enough to diagnose. */
const LOG_EXCERPT_BYTES = 64 * 1024;

/**
 * Where we write down that a failure has been handed over.
 *
 * Beside the result file it is about, and for the same reason that file lives
 * there: it has to outlive the bundle. Remembering this in memory would fail on
 * exactly the failures that matter -- the ones where the server was restarted.
 */
function handoffPath(): string {
  return join(updateDir(), 'repair-handoff');
}

/**
 * The identity of one failure, from fields that do not move.
 *
 * `finishedAt` is deliberately not in here. `interruptedResult()` synthesises it
 * from the clock, so a key that included it would be a different key on every
 * poll, and "exactly once" would quietly mean "every time" on the one failure
 * shape that has no result file to pin it down.
 */
function failureKey(result: UpdateResult, failure: UpdateFailure): string {
  return [failure.code, failure.phase, result.version, result.fromVersion, result.startedAt].join(
    '|',
  );
}

function handedOverKey(): string | null {
  try {
    const text = readFileSync(handoffPath(), 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * Claim the handover before performing it.
 *
 * Returns false when the claim could not be written, and a failed claim means
 * nothing is sent: a repair we cannot record is a repair that would be started
 * again on the next poll, and the next, for as long as she has the tab open.
 * Both halves are synchronous, so within this process the read-then-write is
 * indivisible and two overlapping requests cannot both win.
 */
function claimHandover(key: string): boolean {
  try {
    mkdirSync(updateDir(), { recursive: true });
    writeFileSync(handoffPath(), `${key}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (e) {
    log.error('update.repair.unrecordable', { error: e });
    return false;
  }
}

/**
 * Give the claim back, but only when the request was never delivered.
 *
 * A response of any status means repair heard us and the claim stands, even if
 * the answer was "already running". No response at all is different: the failure
 * is still unreported, and a handover that can never be retried would recreate
 * the very silence this whole section exists to end. Guarded on the key so a
 * newer failure claimed in the meantime is never released by an older one.
 */
function releaseHandover(key: string): void {
  try {
    if (handedOverKey() !== key) return;
    rmSync(handoffPath(), { force: true });
  } catch (e) {
    log.warn('update.repair.release.failed', { error: e });
  }
}

/** The tail of the update log, or '' when there is none. */
function logExcerpt(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= LOG_EXCERPT_BYTES ? text : text.slice(text.length - LOG_EXCERPT_BYTES);
  } catch {
    return '';
  }
}

/**
 * The tree that failed, when it is still on disk.
 *
 * The applier removes `app-<broken>` once something else is confirmed serving,
 * so this is usually absent -- and absent is the honest answer. Repair refuses
 * without a source tree rather than cloning the live install, because the live
 * install ships without tests/ and evals/ and a candidate that cannot be gated
 * must never be promoted.
 */
function failedSourceDir(layout: Layout, version: string): string | null {
  const resources = layout.resourcesDir;
  if (resources === null) return null;
  const dir = join(resources, `app-${version}`);
  return existsSync(dir) ? dir : null;
}

function repairRequestFor(
  layout: Layout,
  result: UpdateResult,
  failure: UpdateFailure,
): RepairRequest {
  const detail = [failure.detail, `update log: ${failure.logPath}`]
    .filter((part): part is string => part !== null && part !== '')
    .join(' -- ');
  const sourceDir = failedSourceDir(layout, result.version);
  const excerpt = logExcerpt(failure.logPath === '' ? updateLogPath() : failure.logPath);

  return {
    failure: {
      stage: failure.phase,
      code: failure.code,
      message: failure.message === '' ? failureInfo(failure.code).message : failure.message,
      detail,
      ...(excerpt === '' ? {} : { logExcerpt: excerpt }),
    },
    rollback: {
      performed: true,
      // rollbackOk is not "the symlink moved back". The applier sets it only
      // after something answered the liveness endpoint, which is the same
      // standard repair holds itself to before it promotes anything.
      healthy: true,
      version: failure.rolledBackTo ?? layout.currentVersion,
      at: result.finishedAt,
    },
    update: {
      fromVersion: result.fromVersion,
      toVersion: result.version,
      // The updater ships payloads, not patches, so there is no diff of the
      // update itself to hand over. Saying so with an empty string is better
      // than inventing one from two directories that may no longer both exist.
      diff: '',
    },
    ...(sourceDir === null ? {} : { sourceDir }),
  };
}

/**
 * The port this installation is actually serving on.
 *
 * The port file is a claim; a 200 from the liveness endpoint is evidence the
 * port is live, and the version in that reply is evidence it is THIS install
 * rather than a second copy that happens to have taken the port we wrote down.
 * The candidate range is deliberately NOT scanned: a repair request is a write
 * that ends in code being changed, and there is no version of "try the ports
 * until something accepts it" that is safe to do with one.
 */
async function servingPort(currentVersion: string): Promise<number | null> {
  let port: number;
  try {
    const digits = readFileSync(join(dataDir(), 'runtime', 'port'), 'utf8').replace(/\D+/g, '');
    port = Number.parseInt(digits, 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(port) || port <= 0) return null;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/ibc-ping.txt`, {
      signal: AbortSignal.timeout(3_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const served = (await res.text()).trim().split(/\s+/)[1];
    return served === currentVersion ? port : null;
  } catch {
    return null;
  }
}

/**
 * Deliver the request. Returns when repair answered, whatever it answered --
 * throwing only when nothing did, which is the case the caller retries.
 */
async function postRepair(request: RepairRequest, port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/repair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'repair', ...request }),
    signal: AbortSignal.timeout(30_000),
  });
  // A refusal is still an answer -- "a repair is already running" is a 409 and a
  // perfectly good outcome. It is recorded, not retried.
  if (!res.ok) log.warn('update.repair.refused', { status: res.status });
}

/**
 * Hand a rolled-back failure to repair, at most once, and never block on it.
 *
 * Called from `updateStatus()` with the result `reconciledResult()` just
 * produced, so the trigger is the same observation the UI is about to render.
 */
function handOverToRepair(layout: Layout, result: UpdateResult | null): void {
  if (result === null || result.ok) return;
  const failure = result.failure;
  if (failure === null) return;

  // Not while an applier is still working. The result read here is the PREVIOUS
  // one -- a live progress file means the current attempt has not finished --
  // and a repair reasoning about a tree that is being replaced underneath it is
  // worse than one that starts a minute later.
  const progress = readProgress();
  if (progress !== null && progress.alive) return;

  const key = failureKey(result, failure);
  if (handedOverKey() === key) return;

  if (!failure.rollbackOk) {
    // The emergency. Claiming the key first is what keeps this to one line in
    // the log instead of one per poll; the loudness has to come from the
    // severity of the line, not from repeating it.
    if (claimHandover(key)) {
      log.error('update.repair.withheld', {
        code: failure.code,
        phase: failure.phase,
        version: result.version,
        reason: 'the rollback did not leave a healthy install; this needs a person',
      });
    }
    return;
  }

  if (!claimHandover(key)) return;

  const request = repairRequestFor(layout, result, failure);
  log.warn('update.repair.handover', {
    code: failure.code,
    phase: failure.phase,
    version: result.version,
    rolledBackTo: failure.rolledBackTo,
    hasSource: request.sourceDir !== undefined,
  });

  // Fire and forget: the caller is answering a poll, and a repair request that
  // waited on the repair subsystem would hold that poll open behind it.
  void (async () => {
    try {
      const port = await servingPort(layout.currentVersion);
      if (port === null) {
        log.warn('update.repair.unreachable', { detail: 'no port answered as this version' });
        releaseHandover(key);
        return;
      }
      await postRepair(request, port);
    } catch (e) {
      log.warn('update.repair.undelivered', { error: e });
      releaseHandover(key);
    }
  })();
}

export async function updateStatus(): Promise<UpdateStatus> {
  const layout = detectLayout();
  const source = readSource();
  const state = readState();
  const progress = readProgress();
  const lastResult = reconciledResult(layout);

  handOverToRepair(layout, lastResult);

  const latest = state.latest;
  const newer = latest !== null && isNewer(latest.version, layout.currentVersion);
  const available =
    latest !== null && newer ? toAvailable(latest, applicability(latest, layout.currentVersion)) : null;

  const busy = await applyBlocker(layout);

  return {
    currentVersion: layout.currentVersion,
    supported: layout.kind === 'bundle' && layout.updateScript !== null && layout.writable,
    unsupportedReason: layout.unsupportedReason,
    source: {
      kind: source.kind,
      label: source.label,
      automatic: source.automatic,
      checkIntervalHours: source.checkIntervalHours,
    },
    available,
    lastCheckedAt: state.lastCheckedAt,
    lastCheckError:
      state.lastCheckError === null
        ? null
        : {
            code: isUpdateFailureCode(state.lastCheckError.code)
              ? state.lastCheckError.code
              : 'UNKNOWN',
            message: state.lastCheckError.message,
            detail: state.lastCheckError.detail,
          },
    phase: progress !== null && progress.alive ? progress.phase : 'idle',
    progress: progress !== null && progress.alive ? progress : null,
    lastResult,
    installedVersions: layout.installedVersions,
    canRollback: layout.previousVersion !== null && layout.appLinkIsSymlink,
    busy,
  };
}

/* ─────────────────────────────── check ────────────────────────────────── */

async function performCheck(source: UpdateSource): Promise<UpdateState> {
  try {
    const resolved = await resolveManifest(source);
    const { manifest } = resolved;
    log.info('update.check.ok', { version: manifest.version, source: source.label });
    return patchState({
      lastCheckedAt: new Date().toISOString(),
      lastCheckError: null,
      latest: {
        version: manifest.version,
        publishedAt: manifest.publishedAt,
        sizeBytes: manifest.sizeBytes,
        notes: manifest.notes,
        critical: manifest.critical,
        sha256: manifest.sha256,
        downloadUrl: resolved.downloadUrl,
        minimumSupportedVersion: manifest.minimumSupportedVersion,
      },
    });
  } catch (e) {
    const err =
      e instanceof UpdateError ? e : new UpdateError('MANIFEST_UNREACHABLE', { cause: e });
    log.warn('update.check.failed', { code: err.updateCode, detail: err.detail });
    return patchState({
      lastCheckedAt: new Date().toISOString(),
      lastCheckError: {
        code: err.updateCode,
        message: failureInfo(err.updateCode).message,
        detail: err.detail ?? null,
      },
    });
  }
}

/** Never throws. A failed check is recorded and reported, not raised. */
export async function runCheck(): Promise<UpdateStatus> {
  const source = readSource();
  if (source.kind === 'none') {
    patchState({
      lastCheckedAt: new Date().toISOString(),
      lastCheckError: {
        code: 'NO_SOURCE',
        message: failureInfo('NO_SOURCE').message,
        detail: 'no manifestUrl and no githubRepo configured',
      },
    });
    return updateStatus();
  }

  inFlightCheck ??= performCheck(source).finally(() => {
    inFlightCheck = null;
  });
  await inFlightCheck;
  return updateStatus();
}

/* ─────────────────────────────── apply ────────────────────────────────── */

function nothingToDo(reason: UpdateBusy['reason'], detail: string): UpdateBusy {
  return { reason, detail };
}

/**
 * Start an apply, or say why not. The refusals are deliberately not exceptions:
 * "the queue is busy so this will happen later" is a normal outcome that the UI
 * renders as a sentence, not an error card.
 */
export async function startApply(): Promise<UpdateActionResponse> {
  const layout = detectLayout();
  const state = readState();
  const latest = state.latest;

  if (latest === null || !isNewer(latest.version, layout.currentVersion)) {
    return {
      accepted: false,
      deferred: nothingToDo('nothing-available', 'There is no newer version to install.'),
      status: await updateStatus(),
    };
  }

  const { applicable, blockedReason } = applicability(latest, layout.currentVersion);
  if (!applicable) {
    return {
      accepted: false,
      deferred: nothingToDo('not-applicable', blockedReason ?? 'This update cannot be applied.'),
      status: await updateStatus(),
    };
  }

  const blocker = await applyBlocker(layout);
  if (blocker !== null) {
    return { accepted: false, deferred: blocker, status: await updateStatus() };
  }

  // Re-resolved rather than replayed from the state file: a stored GitHub asset
  // URL carries a token-scoped identifier that can expire, and a check from
  // yesterday should not decide what gets downloaded today. The version is then
  // re-compared, so a release that was pulled cannot be installed from a stale
  // record.
  const source = readSource();
  const resolved = await resolveManifest(source);
  if (!isNewer(resolved.manifest.version, layout.currentVersion)) {
    return {
      accepted: false,
      deferred: nothingToDo('nothing-available', 'There is no newer version to install.'),
      status: await updateStatus(),
    };
  }

  const plan: ApplyPlan = {
    mode: 'apply',
    version: resolved.manifest.version,
    fromVersion: layout.currentVersion,
    downloadUrl: resolved.downloadUrl,
    sha256: resolved.manifest.sha256,
    sizeBytes: resolved.manifest.sizeBytes,
    authHeader: resolved.authHeader,
  };

  writePlanAndSpawn(layout, plan);
  return { accepted: true, deferred: null, status: await updateStatus() };
}

/**
 * Go back to the previous version on purpose.
 *
 * The applier does this by itself when a new version fails its health check.
 * This is the manual door for the case it cannot see: a version that starts
 * cleanly and then behaves wrongly.
 */
export async function startRollback(): Promise<UpdateActionResponse> {
  const layout = detectLayout();
  const target = layout.previousVersion;

  if (target === null || !layout.appLinkIsSymlink) {
    return {
      accepted: false,
      deferred: nothingToDo('nothing-available', 'There is no previous version on this Mac.'),
      status: await updateStatus(),
    };
  }

  const blocker = await applyBlocker(layout);
  if (blocker !== null) {
    return { accepted: false, deferred: blocker, status: await updateStatus() };
  }

  writePlanAndSpawn(layout, {
    mode: 'rollback',
    version: target,
    fromVersion: layout.currentVersion,
    // Nothing is downloaded: the directory is already on disk. The applier
    // refuses to fetch anything in rollback mode.
    downloadUrl: '',
    sha256: '',
    sizeBytes: null,
    authHeader: null,
  });

  return { accepted: true, deferred: null, status: await updateStatus() };
}

/* ─────────────────────────── background pass ──────────────────────────── */

let autoRunning = false;

function dueForCheck(state: UpdateState, hours: number): boolean {
  if (state.lastCheckedAt === null) return true;
  const last = Date.parse(state.lastCheckedAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= hours * 3_600_000;
}

/**
 * The "Bonnie does nothing" path.
 *
 * Called from GET /api/update, which the app polls, and safe to call from a timer
 * if one is ever added. It checks at most once per configured interval, and only
 * applies on its own when the source says it may AND the queue is idle. It never
 * throws and never blocks the response -- the caller does not await it.
 */
export function maybeAutoRun(): void {
  if (autoRunning) return;
  autoRunning = true;

  void (async () => {
    try {
      const source = readSource();
      if (source.kind === 'none') return;
      if (dueForCheck(readState(), source.checkIntervalHours)) await runCheck();
      if (!source.automatic) return;

      const layout = detectLayout();
      const latest = readState().latest;
      if (latest === null || !isNewer(latest.version, layout.currentVersion)) return;
      if (!applicability(latest, layout.currentVersion).applicable) return;
      if ((await applyBlocker(layout)) !== null) return;

      log.info('update.auto.apply', { version: latest.version, from: layout.currentVersion });
      await startApply();
    } catch (e) {
      // An automatic pass that fails must never surface as an error on a screen
      // Bonnie is looking at. The check result is recorded either way.
      log.warn('update.auto.failed', { error: e });
    } finally {
      autoRunning = false;
    }
  })();
}
