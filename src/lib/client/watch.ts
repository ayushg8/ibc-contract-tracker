'use client';

/**
 * The browser's side of the watched folder.
 *
 * Two screens ask the same question -- Settings, which configures the folder, and
 * the Inbox, which names it -- and they must not answer it differently. One
 * reader, one type guard, one place that decides what "running" means on screen.
 *
 * Nothing here throws, on the same principle as lib/client/api: a screen never
 * handles a transport failure, it simply knows less than it did and says less.
 *
 * The status type comes from the server module by `import type`, which TypeScript
 * erases entirely, so node:fs never reaches the browser bundle.
 */

import type { WatchStatus } from '@/lib/watch';

export type { WatchStatus, WatchSkip } from '@/lib/watch';

function isWatchStatus(value: unknown): value is WatchStatus {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o['running'] === 'boolean' &&
    typeof o['started'] === 'boolean' &&
    typeof o['ingested'] === 'number' &&
    Array.isArray(o['skipped'])
  );
}

/** GET the current state. Null means "could not ask", never "not running". */
export async function readWatch(): Promise<WatchStatus | null> {
  return call();
}

/** POST a forced rescan and return the state it left behind. */
export async function rescanWatch(): Promise<WatchStatus | null> {
  return call({ method: 'POST' });
}

async function call(init?: RequestInit): Promise<WatchStatus | null> {
  try {
    const res = await fetch('/api/watch', { cache: 'no-store', ...init });
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const value = (body as { watch?: unknown }).watch;
    return isWatchStatus(value) ? value : null;
  } catch {
    return null;
  }
}

/** "not yet" / "just now" / "3 min ago". Deliberately coarse: this is a heartbeat. */
export function sinceLabel(iso: string | null): string {
  if (iso === null) return 'not yet';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
