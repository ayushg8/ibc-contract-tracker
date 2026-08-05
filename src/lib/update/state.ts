/**
 * The record of what has been checked and what happened.
 *
 * Written by this side only, and written atomically -- a temp file plus a rename,
 * because the process doing the writing is the process an update is about to
 * kill. A half-written state file that says an update is available when it is
 * not is a support call; a state file that is simply older than the truth is a
 * refresh.
 *
 * Anything unreadable is treated as absent. There is nothing in here that cannot
 * be rediscovered by checking again, so refusing to start over a corrupt JSON
 * file would trade a recoverable state for an unrecoverable one.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import { log } from '@/lib/logger';

import { isUpdateFailureCode } from './failures';
import { statePath, updateDir } from './paths';
import type { AvailableUpdate, UpdateFailureCode } from './types';

const AvailableSchema = z.object({
  version: z.string(),
  publishedAt: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  notes: z.string().nullable(),
  critical: z.boolean(),
  sha256: z.string(),
  downloadUrl: z.string(),
  minimumSupportedVersion: z.string().nullable(),
});

const StateSchema = z.object({
  schemaVersion: z.literal(1),
  lastCheckedAt: z.string().nullable(),
  lastCheckError: z
    .object({ code: z.string(), message: z.string(), detail: z.string().nullable() })
    .nullable(),
  /** The manifest of the newest release seen, whether or not it is newer than us. */
  latest: AvailableSchema.nullable(),
  /** Stamped after a successful apply so a rollback has something to compare to. */
  installedVersion: z.string().nullable(),
  lastAppliedAt: z.string().nullable(),
});

export type StoredLatest = z.output<typeof AvailableSchema>;
export type UpdateState = z.output<typeof StateSchema>;

export const EMPTY_STATE: UpdateState = {
  schemaVersion: 1,
  lastCheckedAt: null,
  lastCheckError: null,
  latest: null,
  installedVersion: null,
  lastAppliedAt: null,
};

export function readState(): UpdateState {
  let text: string;
  try {
    text = readFileSync(statePath(), 'utf8');
  } catch {
    return EMPTY_STATE;
  }
  try {
    const parsed = StateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      log.warn('update.state.invalid', { issue: parsed.error.issues[0]?.message ?? 'unknown' });
      return EMPTY_STATE;
    }
    return parsed.data;
  } catch (e) {
    log.warn('update.state.unparseable', { error: e });
    return EMPTY_STATE;
  }
}

export function writeState(state: UpdateState): void {
  const dir = updateDir();
  const target = statePath();
  const temp = `${target}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    // rename(2) is atomic on the same filesystem, so a reader either sees the
    // whole old file or the whole new one and never a truncated middle.
    renameSync(temp, target);
  } catch (e) {
    // State is a convenience, never a correctness requirement: everything in it
    // can be rediscovered. Failing a route over it would be the wrong trade.
    log.error('update.state.write.failed', { error: e });
  }
}

export function patchState(patch: Partial<UpdateState>): UpdateState {
  const next: UpdateState = { ...readState(), ...patch, schemaVersion: 1 };
  writeState(next);
  return next;
}

export function failureCodeOf(stored: { code: string } | null): UpdateFailureCode | null {
  if (stored === null) return null;
  return isUpdateFailureCode(stored.code) ? stored.code : 'UNKNOWN';
}

/** The public projection of a stored release. Drops the URL, keeps what she reads. */
export function toAvailable(
  latest: StoredLatest,
  opts: { applicable: boolean; blockedReason: string | null },
): AvailableUpdate {
  return {
    version: latest.version,
    publishedAt: latest.publishedAt,
    sizeBytes: latest.sizeBytes,
    notes: latest.notes,
    critical: latest.critical,
    applicable: opts.applicable,
    blockedReason: opts.blockedReason,
  };
}
