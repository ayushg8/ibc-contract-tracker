/**
 * Starting an apply, and refusing to.
 *
 * Nothing in this file replaces a file. It writes a plan, then hands the job to
 * `packaging/app-template/bin/update.sh` and gets out of the way.
 *
 * WHY it has to be another process: step five of an apply is "restart the server
 * and health-check it". The server is this process. Code that restarts itself
 * cannot then observe whether the restart worked, and code that cannot observe
 * that cannot roll back -- which is the entire point of the exercise. So the
 * applier is spawned detached, in its own session, and this process is one of the
 * things it stops and starts. Progress comes back through files, which is why the
 * UI keeps working across the gap: the new server reads the same files the old
 * one was writing to.
 *
 * The queue check is the other reason this file exists. Losing a document half
 * way through being read is worse than being a day out of date, so an apply that
 * would interrupt an extraction is deferred, not forced.
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { log } from '@/lib/logger';

import { UpdateError } from './failures';
import type { Layout } from './install';
import { curlConfigPath, planPath, progressPath, updateDir, updateLogPath } from './paths';
import { applyLockHolder, readProgress } from './runtime';
import type { UpdateBusy } from './types';

export interface ApplyPlan {
  readonly mode: 'apply' | 'rollback';
  readonly version: string;
  readonly fromVersion: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly sizeBytes: number | null;
  readonly authHeader: string | null;
}

/**
 * Is the extraction queue idle?
 *
 * Imported lazily on purpose. The queue pulls in the whole extraction pipeline --
 * pdfjs, tesseract, the providers -- and the update route is the one route that
 * has to keep answering when something in that pipeline is broken, because that
 * is exactly when someone needs to ship a fix.
 */
export async function queueIsIdle(): Promise<{ idle: boolean; detail: string }> {
  try {
    const { extractionQueue } = await import('@/lib/extraction/queue');
    const status = extractionQueue.status();
    const busy = status.running + status.queued;
    if (busy === 0) return { idle: true, detail: 'nothing in the queue' };
    return {
      idle: false,
      detail:
        status.running > 0
          ? `${status.running} document(s) being read, ${status.queued} waiting`
          : `${status.queued} document(s) waiting`,
    };
  } catch (e) {
    // A queue we cannot ask about is a queue we cannot promise is idle.
    log.warn('update.queue.unreadable', { error: e });
    return { idle: false, detail: 'the document queue could not be asked whether it is busy' };
  }
}

/** The reasons an apply cannot start right now, in the order they are checked. */
export async function applyBlocker(layout: Layout): Promise<UpdateBusy | null> {
  if (layout.kind !== 'bundle' || layout.updateScript === null || !layout.writable) {
    return {
      reason: 'unsupported',
      detail: layout.unsupportedReason ?? 'This copy of the tracker cannot update itself.',
    };
  }

  const holder = applyLockHolder();
  if (holder !== null) {
    return { reason: 'apply-in-progress', detail: `an update is already running (pid ${holder})` };
  }
  const progress = readProgress();
  if (progress !== null && progress.alive) {
    return { reason: 'apply-in-progress', detail: `an update is already ${progress.phase}` };
  }

  const queue = await queueIsIdle();
  if (!queue.idle) return { reason: 'queue-busy', detail: queue.detail };

  return null;
}

/**
 * `key value` lines are only unambiguous while no value contains a newline. The
 * URL comes from a manifest, and a manifest carrying a line break could
 * otherwise append its own `sha256 ...` line and have it win over the real one.
 * Cheap defence on the one path in this app that ends in code being executed.
 */
function oneLine(label: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new UpdateError('MANIFEST_INVALID', { detail: `${label} contains a line break` });
  }
  return value;
}

function writePlan(plan: ApplyPlan, layout: Layout): void {
  const dir = updateDir();
  mkdirSync(dir, { recursive: true });

  // A curl config file, not an argument: arguments to curl are visible to every
  // process on the machine through `ps`, and this one can carry a GitHub token.
  let curlConfig: string | null = null;
  if (plan.authHeader !== null) {
    curlConfig = curlConfigPath();
    writeFileSync(curlConfig, `header = "${plan.authHeader.replace(/"/g, '')}"\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(curlConfig, 0o600);
  } else {
    rmSync(curlConfigPath(), { force: true });
  }

  const resources = layout.resourcesDir;
  if (resources === null) throw new UpdateError('NOT_SUPPORTED', { detail: 'no Resources folder' });

  // `key value`, value being everything after the first space. The bundle path
  // contains a space, which is exactly why the format is defined that way.
  const lines = [
    `mode ${plan.mode}`,
    `version ${oneLine('version', plan.version)}`,
    `fromVersion ${oneLine('fromVersion', plan.fromVersion)}`,
    `resources ${oneLine('resources', resources)}`,
    `sha256 ${oneLine('sha256', plan.sha256)}`,
    `url ${oneLine('url', plan.downloadUrl)}`,
    `sizeBytes ${plan.sizeBytes ?? 0}`,
    `requestedAt ${new Date().toISOString()}`,
  ];
  if (curlConfig !== null) lines.push(`curlConfig ${curlConfig}`);

  const target = planPath();
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, target);
}

/**
 * Claim the progress file before the shell script has had a chance to.
 *
 * Without this there is a window -- process spawn, shell startup, sourcing
 * common.sh -- where a UI polling GET /api/update sees no progress at all and
 * concludes nothing happened. `pid` is this process, which is alive by
 * definition, so the entry is never mistaken for a stale one.
 */
function claimProgress(plan: ApplyPlan): void {
  mkdirSync(updateDir(), { recursive: true });
  const lines = [
    'phase starting',
    `version ${oneLine('version', plan.version)}`,
    `fromVersion ${oneLine('fromVersion', plan.fromVersion)}`,
    `startedAt ${new Date().toISOString()}`,
    `pid ${process.pid}`,
    `note ${plan.mode === 'rollback' ? 'Going back to the previous version' : 'Getting ready'}`,
  ];
  writeFileSync(progressPath(), `${lines.join('\n')}\n`, 'utf8');
}

/**
 * Hand the job over. Returns once the applier has been started, not once it has
 * finished -- it outlives this process on purpose.
 */
export function spawnApplier(layout: Layout, plan: ApplyPlan): number {
  const script = layout.updateScript;
  if (script === null) throw new UpdateError('NOT_SUPPORTED', { detail: 'update.sh is not present' });

  claimProgress(plan);

  const child = spawn('/bin/sh', [script], {
    // detached puts it in a new session, so stopping this server -- which the
    // applier is about to do -- cannot take the applier down with it.
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      IBC_UPDATE_INVOKED_BY: 'server',
    },
  });
  child.unref();

  const pid = child.pid ?? 0;
  log.info('update.apply.spawned', {
    pid,
    mode: plan.mode,
    version: plan.version,
    from: plan.fromVersion,
    log: updateLogPath(),
  });
  return pid;
}

export function writePlanAndSpawn(layout: Layout, plan: ApplyPlan): number {
  writePlan(plan, layout);
  return spawnApplier(layout, plan);
}
