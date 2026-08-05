/**
 * Reading what the shell script is doing, and what it did.
 *
 * The applier runs outside this process -- it has to, because it restarts this
 * process half way through -- so the only channel between the two is a pair of
 * files it writes and this side reads. They are `key value` lines, one per line,
 * value being everything after the first space. WHY not JSON: the writer is
 * POSIX sh, and hand-rolled JSON escaping in shell is a bug waiting for the first
 * path with a quote in it. The parser here is deliberately forgiving about
 * everything except the fields it actually uses.
 *
 * The other half of this file is the liveness question, and it is the same lesson
 * the launcher learned: a `phase downloading` line is a CLAIM that an update is
 * in progress. The evidence is that the process which wrote it still exists. A
 * Mac that slept through an update leaves a perfectly well-formed progress file
 * describing something that stopped happening hours ago, and the UI must not
 * show a spinner for it forever.
 */

import { readFileSync, statSync } from 'node:fs';

import { isUpdateFailureCode } from './failures';
import { lockPidPath, progressPath, resultPath, updateLogPath } from './paths';
import type { UpdateFailure, UpdatePhase, UpdateProgress, UpdateResult } from './types';
import { UPDATE_PHASES } from './types';

/**
 * How long after the last write we keep believing a progress file whose process
 * we cannot see. Generous, because a large download can go minutes without a
 * phase change, and the pid check is the real answer anyway.
 */
const STALE_AFTER_MS = 30 * 60_000;

type Fields = ReadonlyMap<string, string>;

function readFields(path: string): { fields: Fields; mtimeMs: number } | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(path, 'utf8');
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space === -1) {
      fields.set(line, '');
      continue;
    }
    fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return { fields, mtimeMs };
}

function str(fields: Fields, key: string): string | null {
  const v = fields.get(key);
  return v === undefined || v === '' ? null : v;
}

function phaseOf(value: string | null): UpdatePhase {
  if (value === null) return 'idle';
  return UPDATE_PHASES.includes(value as UpdatePhase) ? (value as UpdatePhase) : 'idle';
}

/**
 * Is that pid still there? EPERM means it exists and is not ours, which for our
 * purposes is the same answer as "alive" -- and is the honest reading, because
 * refusing permission proves the process exists.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'EPERM';
  }
}

const TERMINAL: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>(['idle', 'done', 'failed']);

export function readProgress(): UpdateProgress | null {
  const read = readFields(progressPath());
  if (read === null) return null;
  const { fields, mtimeMs } = read;

  const phase = phaseOf(str(fields, 'phase'));
  if (TERMINAL.has(phase)) return null;

  const pidRaw = str(fields, 'pid');
  const pid = pidRaw === null ? 0 : Number.parseInt(pidRaw, 10);
  const alive = pidAlive(pid) && Date.now() - mtimeMs < STALE_AFTER_MS;

  return {
    phase,
    version: str(fields, 'version') ?? 'unknown',
    fromVersion: str(fields, 'fromVersion') ?? 'unknown',
    startedAt: str(fields, 'startedAt') ?? new Date(mtimeMs).toISOString(),
    note: str(fields, 'note') ?? '',
    alive,
  };
}

function failureFrom(fields: Fields, phase: UpdatePhase): UpdateFailure {
  const rawCode = str(fields, 'failCode') ?? 'UNKNOWN';
  const code = isUpdateFailureCode(rawCode) ? rawCode : 'UNKNOWN';
  const rolledBackTo = str(fields, 'rolledBackTo');
  return {
    code,
    phase,
    message: str(fields, 'message') ?? '',
    detail: str(fields, 'detail'),
    rolledBackTo,
    rollbackOk: str(fields, 'rollbackOk') === '1',
    logPath: updateLogPath(),
  };
}

export function readResult(): UpdateResult | null {
  const read = readFields(resultPath());
  if (read === null) return null;
  const { fields, mtimeMs } = read;

  const version = str(fields, 'version');
  if (version === null) return null;

  const ok = str(fields, 'ok') === '1';
  const phase = phaseOf(str(fields, 'failPhase'));
  const finishedAt = str(fields, 'finishedAt') ?? new Date(mtimeMs).toISOString();

  return {
    ok,
    version,
    fromVersion: str(fields, 'fromVersion') ?? 'unknown',
    startedAt: str(fields, 'startedAt') ?? finishedAt,
    finishedAt,
    failure: ok ? null : failureFrom(fields, phase),
  };
}

/**
 * An apply that was interrupted rather than finished. Synthesised here rather
 * than left to the shell, because a shell script that was SIGKILLed by definition
 * did not get to write anything.
 */
export function interruptedResult(progress: UpdateProgress): UpdateResult {
  return {
    ok: false,
    version: progress.version,
    fromVersion: progress.fromVersion,
    startedAt: progress.startedAt,
    finishedAt: new Date().toISOString(),
    failure: {
      code: 'INTERRUPTED',
      phase: progress.phase,
      message: 'The update stopped part way through.',
      detail: `no applier process is alive and the last phase was ${progress.phase}`,
      rolledBackTo: null,
      rollbackOk: false,
      logPath: updateLogPath(),
    },
  };
}

/** Is the mkdir lock held by a process that still exists? */
export function applyLockHolder(): number | null {
  let text: string;
  try {
    text = readFileSync(lockPidPath(), 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return pidAlive(pid) ? pid : null;
}
