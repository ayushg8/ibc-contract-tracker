'use client';

/**
 * The four ways an approved record stops being a one-way door: send it back to
 * the Inbox, read the document again, take it out of the repository, or put it
 * back.
 *
 * One hook rather than four call sites, because the copy and the Undo are the
 * feature. A record that vanishes with no toast and no way back is the thing this
 * exists to prevent, and that guarantee has to hold whether she used the detail
 * sheet or right-clicked a row.
 *
 * WHY the fetch helpers are here and not in api.ts: api.ts is owned by another
 * workstream in this pass. These calls belong on the `api` object; fold them in
 * and delete `post` and `getJson` when the two files can be edited together.
 */

import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';

import { useToast } from '@/components/ui';
import type { ContractSummary } from '@/lib/db/types';
import { api } from './api';
import { rereadToast } from './copy';

export type RecordAction = 'unapprove' | 'reextract' | 'archive';

/** What a toast needs to name the record, and what the routes need to address it. */
export interface RecordTarget {
  contractId: string;
  documentId: string;
  /** Counterparty, contract name or filename -- whatever the screen shows. */
  label: string;
}

export interface RecordActions {
  /** Back to the Inbox for review. Undo re-approves. */
  sendBackToInbox: (target: RecordTarget) => Promise<boolean>;
  /**
   * Re-read the PDF with the current prompt and model. The model's own answers
   * are replaced; rows a human filled in by hand or marked as not applicable
   * survive it. `expectedKept` is how many of those the caller can see on the
   * record it is acting on, so the toast can name the number.
   */
  reread: (target: RecordTarget, expectedKept?: number) => Promise<boolean>;
  /** Soft delete. Undo restores it. */
  remove: (target: RecordTarget) => Promise<boolean>;
  /** Out of the Removed view and back into the table. Undo removes it again. */
  restore: (target: RecordTarget) => Promise<boolean>;
}

interface PostResult {
  ok: boolean;
  /** Plain English, already normalised by the route. Empty when ok. */
  message: string;
  /** The parsed body, for the routes that report a count. */
  body: unknown;
}

/** Pull the route's plain-English headline out of an error body, if there is one. */
function messageOf(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const error = (body as Record<string, unknown>)['error'];
  if (typeof error !== 'object' || error === null) return fallback;
  const message = (error as Record<string, unknown>)['message'];
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

const UNREACHABLE = 'The tracker could not reach its own server.';

async function post(path: string): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', cache: 'no-store' });
  } catch {
    return { ok: false, message: UNREACHABLE, body: undefined };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) return { ok: false, message: messageOf(body, UNREACHABLE), body };
  return { ok: true, message: '', body };
}

/**
 * How many rows the re-extract route says it kept. Accepts either a count or the
 * list of keys, because the pipeline carries `preservedFields` as keys and the
 * route may report either. Null when it reported neither -- and null has to stay
 * null, so the toast can fall back to what the caller could see for itself
 * rather than print a number nobody sent.
 */
function keptCount(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>)['preservedFields'];
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  return null;
}

/* ─────────────────────────── The Removed list ─────────────────────────── */

export interface RemovedRecord extends ContractSummary {
  /** When it left the repository. What the Removed view dates its rows by. */
  archivedAt: string;
}

export interface RemovedList {
  rows: RemovedRecord[];
  /** Plain English. Null when the list is trustworthy, including when empty. */
  error: string | null;
}

const NOT_REMOVED =
  'The Removed view could not be read. This copy of the tracker cannot list removed records.';

/**
 * Read the records that have been taken out of the repository.
 *
 * The response's own `archived` flag is checked rather than assumed. A build
 * whose list route ignores the parameter answers with the LIVE records, and a
 * screen headed "Removed" offering to restore records that were never removed is
 * a worse failure than no screen at all -- so an unconfirmed answer is refused.
 */
export async function listRemoved(search: string): Promise<RemovedList> {
  const trimmed = search.trim();
  const path = `/api/contracts?archived=1${trimmed.length > 0 ? `&q=${encodeURIComponent(trimmed)}` : ''}`;

  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store' });
  } catch {
    return { rows: [], error: UNREACHABLE };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) return { rows: [], error: messageOf(body, UNREACHABLE) };
  if (typeof body !== 'object' || body === null) return { rows: [], error: NOT_REMOVED };

  const record = body as Record<string, unknown>;
  if (record['archived'] !== true || !Array.isArray(record['contracts'])) {
    return { rows: [], error: NOT_REMOVED };
  }
  return { rows: record['contracts'] as RemovedRecord[], error: null };
}

export function useRecordActions(onChanged: () => void): RecordActions {
  const { toast } = useToast();
  const router = useRouter();

  const failed = useCallback(
    (title: string, message: string) => {
      toast({ title, description: message, tone: 'bad' });
    },
    [toast],
  );

  const sendBackToInbox = useCallback(
    async (target: RecordTarget): Promise<boolean> => {
      const result = await post(`/api/contracts/${target.contractId}/unapprove`);
      if (!result.ok) {
        failed('That record was not sent back', result.message);
        return false;
      }
      onChanged();
      toast({
        title: 'Sent back to the Inbox',
        description: `${target.label} is waiting for review again.`,
        onUndo: () => {
          void api.approve(target.documentId).then((undone) => {
            onChanged();
            if (undone.error !== undefined) {
              failed('That could not be put back', undone.error.message);
            }
          });
        },
      });
      return true;
    },
    [failed, onChanged, toast],
  );

  const reread = useCallback(
    async (target: RecordTarget, expectedKept?: number): Promise<boolean> => {
      const result = await post(`/api/contracts/${target.contractId}/reextract`);
      if (!result.ok) {
        failed('That document was not re-read', result.message);
        return false;
      }
      onChanged();
      // No Undo: the new read replaces what the model found last time, so there
      // is nothing honest to restore. What she typed by hand is carried across it
      // -- the route's own count when it sends one, otherwise the count the
      // caller could see on the record it acted on.
      toast({
        ...rereadToast(target.label, keptCount(result.body) ?? expectedKept ?? null),
        action: { label: 'Go to Inbox', onClick: () => router.push('/inbox') },
      });
      return true;
    },
    [failed, onChanged, router, toast],
  );

  const remove = useCallback(
    async (target: RecordTarget): Promise<boolean> => {
      const result = await post(`/api/contracts/${target.contractId}/archive`);
      if (!result.ok) {
        failed('That record was not removed', result.message);
        return false;
      }
      onChanged();
      toast({
        title: 'Removed from the repository',
        description: `${target.label} is out of the table and the export.`,
        onUndo: () => {
          void post(`/api/contracts/${target.contractId}/archive?undo=1`).then((undone) => {
            onChanged();
            if (!undone.ok) failed('That record could not be put back', undone.message);
          });
        },
      });
      return true;
    },
    [failed, onChanged, toast],
  );

  const restore = useCallback(
    async (target: RecordTarget): Promise<boolean> => {
      const result = await post(`/api/contracts/${target.contractId}/restore`);
      if (!result.ok) {
        failed('That record was not put back', result.message);
        return false;
      }
      onChanged();
      toast({
        tone: 'ok',
        title: 'Back in the repository',
        description: `${target.label} is in the table and the export again.`,
        onUndo: () => {
          void post(`/api/contracts/${target.contractId}/archive`).then((undone) => {
            onChanged();
            if (!undone.ok) failed('That record could not be removed again', undone.message);
          });
        },
      });
      return true;
    },
    [failed, onChanged, toast],
  );

  return useMemo(
    () => ({ sendBackToInbox, reread, remove, restore }),
    [sendBackToInbox, reread, remove, restore],
  );
}
