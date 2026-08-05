/**
 * Durable repair state, and where repair keeps its things.
 *
 * The state file is the source of truth, not the LaunchAgent and not any timer
 * in this process. A scheduled job is a trigger; if launchd never fires, or the
 * Mac was asleep, or the app was reinstalled, the answer to "is a repair owed?"
 * still has to be knowable from a file on disk. That is what makes
 * `dueForResume()` possible and what stops a usage limit from quietly ending a
 * repair that was supposed to continue.
 *
 * Writes are atomic (temp file plus rename) because the process may be killed at
 * any point -- including by the very update that is being repaired -- and a
 * half-written state file would be indistinguishable from no cap at all.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '@/lib/logger';
import { dataDir } from '@/lib/paths';

import {
  KEEP_WORKSPACES,
  MAX_ATTEMPTS_PER_SIGNATURE,
  type AttemptRecord,
  type PendingPromotion,
  type RepairPhase,
  type RepairState,
  type SuspendedAttempt,
} from './types';

/* ──────────────────────────────── paths ─────────────────────────────── */

export function repairDir(): string {
  return join(dataDir(), 'repair');
}

export function statePath(): string {
  return join(repairDir(), 'state.json');
}

/** Append-only record of every repair event, readable without opening the database. */
export function journalPath(): string {
  return join(repairDir(), 'journal.jsonl');
}

export function workspacesDir(): string {
  return join(repairDir(), 'workspaces');
}

/** Where the live files displaced by a promote are kept, so a promote can be undone. */
export function backupsDir(): string {
  return join(repairDir(), 'backups');
}

/** Copies of the scripts the scheduled agent runs. See schedule.ts for why. */
export function repairBinDir(): string {
  return join(repairDir(), 'bin');
}

export function attemptDir(attemptId: string): string {
  return join(repairDir(), 'attempts', attemptId);
}

export function ensureRepairDirs(): void {
  for (const dir of [repairDir(), workspacesDir(), backupsDir(), repairBinDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}

/* ──────────────────────────────── state ─────────────────────────────── */

export function emptyState(): RepairState {
  return {
    version: 1,
    phase: 'idle',
    activeSignature: null,
    attempts: {},
    suspended: null,
    pending: null,
    lastAttempt: null,
    emergency: null,
    updatedAt: new Date().toISOString(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a state file defensively.
 *
 * A malformed file must not throw: the caller is usually in the middle of
 * deciding whether it may spend one of three attempts, and an exception there
 * would either block repair forever or -- worse -- be caught somewhere that
 * treats it as "no attempts used yet". Unreadable state is empty state, except
 * for the attempt counts, which are salvaged when they are salvageable.
 */
export function parseState(text: string): RepairState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyState();
  }
  if (!isRecord(raw)) return emptyState();

  const base = emptyState();
  const attempts: Record<string, number> = {};
  const rawAttempts = raw['attempts'];
  if (isRecord(rawAttempts)) {
    for (const [key, value] of Object.entries(rawAttempts)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        attempts[key] = Math.trunc(value);
      }
    }
  }

  return {
    version: 1,
    phase: typeof raw['phase'] === 'string' ? (raw['phase'] as RepairPhase) : base.phase,
    activeSignature: typeof raw['activeSignature'] === 'string' ? raw['activeSignature'] : null,
    attempts,
    suspended: isRecord(raw['suspended']) ? (raw['suspended'] as unknown as SuspendedAttempt) : null,
    pending: isRecord(raw['pending']) ? (raw['pending'] as unknown as PendingPromotion) : null,
    lastAttempt: isRecord(raw['lastAttempt'])
      ? (raw['lastAttempt'] as unknown as AttemptRecord)
      : null,
    emergency: isRecord(raw['emergency'])
      ? {
          at: String(raw['emergency']['at'] ?? ''),
          reason: String(raw['emergency']['reason'] ?? ''),
        }
      : null,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : base.updatedAt,
  };
}

export function loadState(): RepairState {
  try {
    return parseState(readFileSync(statePath(), 'utf8'));
  } catch {
    return emptyState();
  }
}

/** Temp file then rename: a killed process leaves either the old state or the new one. */
export function saveState(state: RepairState): void {
  ensureRepairDirs();
  const next: RepairState = { ...state, updatedAt: new Date().toISOString() };
  const target = statePath();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, target);
  } catch (e) {
    log.error('repair.state.write-failed', { error: e });
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing further to do: the old state file is still intact.
    }
  }
}

/** Read, change, write. The only way phase is ever moved. */
export function updateState(fn: (state: RepairState) => RepairState): RepairState {
  const next = fn(loadState());
  saveState(next);
  return next;
}

/**
 * Spend one attempt against a signature.
 *
 * Counted BEFORE the work starts, never after. A crash, a power cut or an
 * update that kills this process mid-repair must not hand the agent a free
 * attempt -- three tries has to mean three tries even when the third one is what
 * takes the machine down.
 */
export function spendAttempt(signature: string): number {
  const state = updateState((s) => ({
    ...s,
    activeSignature: signature,
    attempts: { ...s.attempts, [signature]: (s.attempts[signature] ?? 0) + 1 },
  }));
  return state.attempts[signature] ?? 1;
}

/**
 * Give one back.
 *
 * Used for exactly one case: the subscription cap. Being told to come back at
 * 3pm is not an attempt at solving the problem, and counting it would let three
 * usage limits exhaust the allowance without Claude ever having read the code.
 */
export function refundAttempt(signature: string): void {
  updateState((s) => {
    const used = s.attempts[signature] ?? 0;
    return { ...s, attempts: { ...s.attempts, [signature]: Math.max(0, used - 1) } };
  });
}

export function attemptsUsed(state: RepairState, signature: string | null): number {
  if (signature === null) return 0;
  return state.attempts[signature] ?? 0;
}

export function capReached(state: RepairState, signature: string): boolean {
  return attemptsUsed(state, signature) >= MAX_ATTEMPTS_PER_SIGNATURE;
}

/**
 * Is a suspended attempt owed a run now?
 *
 * Deliberately does not care why it stopped or whether anything was scheduled.
 * The state file said "not before this moment"; the moment has passed.
 */
export function dueForResume(state: RepairState, now: number = Date.now()): boolean {
  if (state.suspended === null) return false;
  if (state.emergency !== null) return false;
  const at = Date.parse(state.suspended.resumeAt);
  return Number.isFinite(at) ? at <= now : true;
}

/* ─────────────────────────────── journal ────────────────────────────── */

/**
 * One line per event, never throws, never awaits. Same contract as logger.ts and
 * for the same reason: this has to keep working while the thing it describes is
 * broken. The audit table is the record of account; this is the record that
 * survives a database that will not open.
 */
export function journal(event: string, data: Record<string, unknown>): void {
  try {
    ensureRepairDirs();
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
    const file = journalPath();
    // Rolled by hand rather than by the logger, which is keyed to the app log.
    try {
      if (statSync(file).size > 2 * 1024 * 1024) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      // No file yet, or no room to roll. Appending is still the right move.
    }
    writeFileSync(file, `${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    // Swallowed on purpose. See the comment above.
  }
}

/* ───────────────────────────── housekeeping ─────────────────────────── */

/**
 * Keep the last few workspaces and drop the rest.
 *
 * They are kept at all because when a repair goes wrong the workspace is the
 * only place the evidence lives; they are dropped because each one is a copy of
 * the whole app and this is somebody's laptop.
 */
export function pruneWorkspaces(keep: number = KEEP_WORKSPACES, protectPath?: string): void {
  let entries: string[];
  try {
    entries = readdirSync(workspacesDir());
  } catch {
    return;
  }
  const dated = entries
    .map((name) => {
      const full = join(workspacesDir(), name);
      try {
        return { full, at: statSync(full).mtimeMs };
      } catch {
        return { full, at: 0 };
      }
    })
    .sort((a, b) => b.at - a.at);

  for (const entry of dated.slice(keep)) {
    if (entry.full === protectPath) continue;
    try {
      rmSync(entry.full, { recursive: true, force: true });
    } catch {
      // A workspace we cannot remove is disk we do not get back, not a failure.
    }
  }
}
