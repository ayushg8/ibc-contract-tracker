'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArrowClockwise, Plus, Tray, WarningCircle } from '@phosphor-icons/react';
import { Button, EmptyState, IconButton, ProgressBar, useToast } from '@/components/ui';
import { TitlebarActions } from '@/components/layout/Titlebar';
import { DropZone, type DropZoneHandle } from '@/components/inbox/DropZone';
import { InboxFilter, INBOX_GROUPS, type InboxGroup } from '@/components/inbox/InboxFilter';
import { InboxGrid } from '@/components/inbox/InboxGrid';
import { SelectionBar } from '@/components/inbox/SelectionBar';
import type { CardSelection } from '@/components/inbox/DocumentCard';
import { api, usePoll, type UploadResponse } from '@/lib/client/api';
import { batchUnapproveToast } from '@/lib/client/copy';
import { refreshStats } from '@/lib/client/useStats';
import { useSettings } from '@/lib/client/useSettings';
import type { DocumentStatus, DocumentSummary } from '@/lib/db/types';
import { EngineError, type SerialisedEngineError } from '@/lib/providers/errors';

const IN_FLIGHT: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'queued',
  'hashing',
  'reading',
  'extracting',
]);

/** How often the list is refreshed while something on it is still being read. */
const IN_FLIGHT_POLL_MS = 2_000;

/**
 * How often the list is refreshed when nothing on it is in flight.
 *
 * This one is unconditional, and that is the whole point. Documents do not only
 * arrive because she dropped them: the watched folder ingests on its own, and
 * for four minutes an Inbox that was open, focused and showing "Pending - 1"
 * could sit in front of 35 documents the server had already taken in, because
 * the only poll there was refused to run once nothing on SCREEN was in flight --
 * a condition derived from the very list that was out of date.
 *
 * Ten seconds against /api/documents is a local SQLite query behind a route, it
 * only runs while the window is in front (see usePoll), and it is the only thing
 * in the product that can ever show her what the folder picked up.
 */
const HEARTBEAT_MS = 10_000;

/** Ten minutes of a queue that has not moved is a problem, not slowness. */
const MAX_POLLS = 300;

const EMPTY_GROUPS: Record<InboxGroup, string[]> = { pending: [], attention: [], rejected: [] };

interface Upload {
  id: string;
  name: string;
  progress: number;
  error: string | null;
}

/** A drop can also bring a rejected document back, which is not a duplicate. */
interface DropResult extends UploadResponse {
  reopened: { filename: string; documentId: string }[];
}

interface BulkApproved {
  id: string;
  contractId: string;
  counterparty: string | null;
}

interface BulkApproveResponse {
  approved: BulkApproved[];
  failed: { id: string; filename: string | null; error: SerialisedEngineError }[];
}

type Posted<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: SerialisedEngineError };

function localError(detail: string, offline = false): SerialisedEngineError {
  return new EngineError(offline ? 'NETWORK_UNAVAILABLE' : 'UNKNOWN', { detail }).toJSON();
}

/**
 * Bulk approve, reopen and unapprove are not on the shared `api` client, which
 * this screen does not own. Same contract as everything there: never throws,
 * always resolves to data or the serialised error the route handlers emit.
 */
async function post<T>(path: string, body?: unknown): Promise<Posted<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return { error: localError(detail, offline) };
  }

  let parsed: unknown = null;
  try {
    parsed = (await res.json()) as unknown;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const carried =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { error?: SerialisedEngineError }).error
        : undefined;
    return { error: carried ?? localError(`HTTP ${res.status} ${res.statusText} from ${path}`) };
  }
  return { data: parsed as T };
}

function messageOf(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return fallback;
}

function readUpload(body: unknown): DropResult {
  const shape = (body ?? {}) as Partial<DropResult>;
  return {
    accepted: Array.isArray(shape.accepted) ? shape.accepted : [],
    duplicates: Array.isArray(shape.duplicates) ? shape.duplicates : [],
    reopened: Array.isArray(shape.reopened) ? shape.reopened : [],
  };
}

function readGroups(value: unknown): Record<InboxGroup, string[]> {
  const raw = (value ?? {}) as Partial<Record<InboxGroup, unknown>>;
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : [];
  return {
    pending: ids(raw.pending),
    attention: ids(raw.attention),
    rejected: ids(raw.rejected),
  };
}

/** Document id -> how many required fields it is still short of. */
function readUnresolved(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof value !== 'object' || value === null) return out;
  for (const [id, n] of Object.entries(value)) {
    if (typeof n === 'number' && Number.isFinite(n)) out.set(id, n);
  }
  return out;
}

/**
 * The one call that does not go through `api`: dropping 200 scanned PDFs needs a
 * real upload-progress event per file, and fetch still cannot report request
 * progress. One request per file, so one duplicate cannot fail the whole drop.
 */
function uploadOne(file: File, onProgress: (fraction: number) => void): Promise<DropResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('files', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error('The upload could not reach the tracker.'));
    xhr.onabort = () => reject(new Error('That upload was cancelled.'));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText) as unknown;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(readUpload(body));
        return;
      }
      // 409 means every file in that request was already in the tracker. That is
      // information, not a failure.
      if (xhr.status === 409) {
        const parsed = readUpload(body);
        if (parsed.duplicates.length > 0) {
          onProgress(1);
          resolve(parsed);
          return;
        }
      }
      reject(new Error(messageOf(body, 'That file could not be added.')));
    };
    xhr.send(form);
  });
}

const EMPTY_COPY: Record<InboxGroup, { icon: typeof Tray; title: string; body: string }> = {
  pending: {
    icon: Tray,
    title: 'Nothing is waiting',
    body: 'Drop PDFs anywhere on this page and they will start reading themselves.',
  },
  attention: {
    icon: WarningCircle,
    title: 'Nothing needs a decision',
    body: 'Anything the tracker cannot finish on its own will wait for you here.',
  },
  rejected: {
    icon: Archive,
    // Reassuring, not sad: an empty graveyard is good news, and the sentence
    // that matters is the one promising that rejecting is never final.
    title: 'Nothing has been set aside',
    body: 'Anything you reject waits here with its file intact, ready to come back.',
  },
};

export default function InboxPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { settings } = useSettings();

  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [groups, setGroups] = useState<Record<InboxGroup, string[]>>(EMPTY_GROUPS);
  const [unresolved, setUnresolved] = useState<ReadonlyMap<string, number>>(new Map());
  const [group, setGroup] = useState<InboxGroup>('pending');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [loadError, setLoadError] = useState<SerialisedEngineError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [stalled, setStalled] = useState(false);

  const dropZone = useRef<DropZoneHandle>(null);
  const uploadSeq = useRef(0);
  const polls = useRef(0);
  /** Sequence number of the most recent list request. See `load`. */
  const loads = useRef(0);
  /** Where the last shift-less tick landed, for range select. */
  const anchor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const token = ++loads.current;
    const result = await api.documents('all');
    // Two polling lanes, the Refresh button, and every mutation on this screen
    // can have a request in the air at the same time. A slower earlier answer
    // must never land on top of a newer one, or a card she has just dealt with
    // comes back for as long as the stale response took.
    if (token !== loads.current) return;
    if (result.error !== undefined) {
      setLoadError(result.error);
      return;
    }
    // The route returns two keys the shared client's type does not carry yet;
    // both are read defensively rather than trusted, the same way the upload
    // response is.
    const feed = result.data as typeof result.data & {
      groups?: unknown;
      unresolved?: unknown;
    };
    setDocuments(feed.documents);
    setGroups(readGroups(feed.groups));
    setUnresolved(readUnresolved(feed.unresolved));
    setLoadError(null);
    // Anything that has left the Inbox stops being selected. Losing eligibility
    // is NOT a reason to untick: a bulk approve that half failed leaves those
    // documents selected on purpose, and they are ineligible by definition.
    const present = new Set(feed.documents.map((d) => d.id));
    setSelected((current) => {
      if (current.size === 0) return current;
      const kept = new Set([...current].filter((id) => present.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const working = documents?.some((d) => IN_FLIGHT.has(d.status)) ?? false;

  useEffect(() => {
    polls.current = 0;
    if (!working) setStalled(false);
  }, [working]);

  // The fast lane: while a document on screen is being read, two seconds is what
  // makes a progress bar feel live. usePoll already stops itself when the window
  // is not in front; the counter is the second half of "never poll forever" -- a
  // stuck queue gets told about instead of being hammered at 2s for the rest of
  // the day.
  usePoll(() => {
    if (!working || stalled) return;
    polls.current += 1;
    if (polls.current > MAX_POLLS) {
      setStalled(true);
      return;
    }
    void load();
  }, IN_FLIGHT_POLL_MS);

  // The slow lane, and it has no conditions on it. It stands down only while the
  // fast lane is already covering the same ground, so the two never fetch the
  // same list twice; once the queue stalls or empties, this is what keeps going.
  usePoll(() => {
    if (working && !stalled) return;
    void load();
  }, HEARTBEAT_MS);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setStalled(false);
    polls.current = 0;
    await load();
    setRefreshing(false);
  }, [load]);

  const counts = useMemo(
    () => ({
      pending: groups.pending.length,
      attention: groups.attention.length,
      rejected: groups.rejected.length,
    }),
    [groups],
  );

  const visible = useMemo(() => {
    if (documents === null) return [];
    const members = new Set(groups[group]);
    return documents.filter((d) => members.has(d.id));
  }, [documents, groups, group]);

  /** Selectable ids in the order they are on screen. Shift-click reads this. */
  const eligible = useMemo(
    () => visible.filter((d) => unresolved.get(d.id) === 0).map((d) => d.id),
    [visible, unresolved],
  );

  const clearSelection = useCallback(() => {
    anchor.current = null;
    setSelected(new Set());
  }, []);

  useEffect(() => {
    if (selected.size === 0) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') clearSelection();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected.size, clearSelection]);

  const toggleSelect = useCallback(
    (id: string, opts: { range: boolean }) => {
      setSelected((current) => {
        const next = new Set(current);
        const from = anchor.current;
        if (opts.range && from !== null && from !== id) {
          const a = eligible.indexOf(from);
          const b = eligible.indexOf(id);
          if (a !== -1 && b !== -1) {
            // A range always adds and never toggles: a shift-click that quietly
            // unpicked half of what you had is how a selection of 60 is lost.
            for (const pick of eligible.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(pick);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = id;
    },
    [eligible],
  );

  const selectAllReady = useCallback(() => {
    setSelected(new Set(eligible));
    anchor.current = eligible[eligible.length - 1] ?? null;
  }, [eligible]);

  const changeGroup = useCallback(
    (next: InboxGroup) => {
      // Selection does not survive a tab change: approving something you can no
      // longer see is the one thing bulk approve must never do.
      clearSelection();
      setGroup(next);
    },
    [clearSelection],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      const queued: Upload[] = files.map((file) => ({
        id: `u${(uploadSeq.current += 1)}`,
        name: file.name,
        progress: 0,
        error: null,
      }));
      setUploads((current) => [...current, ...queued]);

      const duplicates: { filename: string; documentId: string }[] = [];
      const reopened: { filename: string; documentId: string }[] = [];

      for (const [index, file] of files.entries()) {
        const entry = queued[index];
        if (entry === undefined) continue;
        try {
          const result = await uploadOne(file, (fraction) => {
            setUploads((current) =>
              current.map((u) => (u.id === entry.id ? { ...u, progress: fraction } : u)),
            );
          });
          duplicates.push(...result.duplicates);
          reopened.push(...result.reopened);
          if (result.accepted.length > 0) {
            // Into the pending group by hand as well as the list: membership is
            // the server's answer, and waiting for the next one would leave a
            // card she just dropped invisible until the whole batch finished.
            const fresh = result.accepted.map((d) => d.id);
            setDocuments((current) => [...result.accepted, ...(current ?? [])]);
            setGroups((current) => ({ ...current, pending: [...fresh, ...current.pending] }));
          }
          setUploads((current) => current.filter((u) => u.id !== entry.id));
        } catch (e) {
          const message = e instanceof Error ? e.message : 'That file could not be added.';
          setUploads((current) =>
            current.map((u) => (u.id === entry.id ? { ...u, error: message } : u)),
          );
        }
      }

      if (reopened.length > 0) {
        toast({
          title:
            reopened.length === 1
              ? `${reopened[0]?.filename ?? 'That file'} was set aside, and is back`
              : `${reopened.length} of those had been set aside, and are back`,
          description: 'They are queued to be read again.',
        });
      }

      if (duplicates.length > 0) {
        const first = duplicates[0];
        toast({
          title:
            duplicates.length === 1
              ? `${first?.filename ?? 'That file'} is already in the tracker`
              : `${duplicates.length} of those were already in the tracker`,
          description: 'Documents are matched by their contents, not their filename.',
          action:
            first === undefined
              ? undefined
              : {
                  label: 'Open the existing record',
                  onClick: () => router.push(`/review/${first.documentId}`),
                },
        });
      }

      await load();
      refreshStats();
    },
    [load, router, toast],
  );

  const handleRejected = useCallback(
    (names: string[]) => {
      toast({
        tone: 'warn',
        title:
          names.length === 1
            ? `${names[0] ?? 'That file'} is not a PDF`
            : `${names.length} of those files were not PDFs`,
        description: 'The tracker only reads PDFs. Nothing else was touched.',
      });
    },
    [toast],
  );

  const markBusy = useCallback((id: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleRetry = useCallback(
    async (id: string) => {
      markBusy(id, true);
      const result = await api.retryDocument(id);
      if (result.error !== undefined) {
        toast({
          tone: 'bad',
          title: 'That document could not be re-read',
          description: result.error.message,
        });
      } else {
        await load();
        refreshStats();
      }
      markBusy(id, false);
    },
    [load, markBusy, toast],
  );

  const handleReopen = useCallback(
    async (id: string) => {
      const name = documents?.find((d) => d.id === id)?.filename ?? 'That document';
      markBusy(id, true);
      const result = await post(`/api/documents/${id}/reopen`);
      if (result.error !== undefined) {
        toast({
          tone: 'bad',
          title: 'That document could not be reopened',
          description: result.error.message,
        });
      } else {
        toast({
          tone: 'ok',
          title: `${name} is back in the Inbox`,
          description: 'It is queued to be read again.',
          action: { label: 'Show me', onClick: () => changeGroup('pending') },
        });
        await load();
        refreshStats();
      }
      markBusy(id, false);
    },
    [changeGroup, documents, load, markBusy, toast],
  );

  const undoBatch = useCallback(
    async (approved: BulkApproved[]) => {
      // One call per contract: unapprove is the contract's own transaction, and a
      // batch endpoint for the undo of a batch would be a second way to be wrong.
      const results = await Promise.all(
        approved.map((entry) => post(`/api/contracts/${entry.contractId}/unapprove`)),
      );
      const stuck = results.filter((r) => r.error !== undefined).length;
      await load();
      refreshStats();
      // The copy compares the two numbers rather than assuming a remainder: when
      // every unapprove fails there is no rest, and saying there is turns a total
      // failure into a partial success on screen.
      toast(batchUnapproveToast(approved.length, stuck));
    },
    [load, toast],
  );

  const approveSelected = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setApproving(true);
    const result = await post<BulkApproveResponse>('/api/documents/bulk-approve', { ids });
    if (result.error !== undefined) {
      toast({
        tone: 'bad',
        title: 'Those could not be approved',
        description: result.error.message,
      });
      setApproving(false);
      return;
    }

    const { approved, failed } = result.data;
    // The ones that would not go stay ticked, so the selection itself is the
    // answer to "which ones?" -- no list to read, no ids to match up.
    setSelected(new Set(failed.map((f) => f.id)));
    anchor.current = null;

    if (approved.length === 0) {
      toast({
        tone: 'bad',
        title: 'Nothing could be approved',
        description: failed[0]?.error.message ?? 'They are still in the Inbox.',
      });
    } else {
      toast({
        tone: failed.length > 0 ? 'warn' : 'ok',
        title:
          approved.length === 1
            ? '1 agreement added to the repository'
            : `${approved.length} agreements added to the repository`,
        description:
          failed.length === 0
            ? 'Their fields and quotes were saved with them.'
            : failed.length === 1
              ? '1 still needs an answer and is left selected.'
              : `${failed.length} still need answers and are left selected.`,
        onUndo: () => void undoBatch(approved),
      });
    }

    await load();
    refreshStats();
    setApproving(false);
  }, [load, selected, toast, undoBatch]);

  const openSettings = useCallback(() => router.push('/settings'), [router]);
  const openReview = useCallback((id: string) => router.push(`/review/${id}`), [router]);

  const blockedReason = useCallback(
    (doc: DocumentSummary): string => {
      const short = unresolved.get(doc.id);
      if (short !== undefined && short > 0) {
        return short === 1
          ? 'One required field still needs an answer. Open it to fill that in.'
          : `${short} required fields still need answers. Open it to fill those in.`;
      }
      if (IN_FLIGHT.has(doc.status)) return 'Still being read.';
      if (doc.status === 'failed') {
        return 'This one could not be read, so there is nothing to approve yet.';
      }
      return 'This one has to be opened before it can be approved.';
    },
    [unresolved],
  );

  const selectionFor = useCallback(
    (doc: DocumentSummary): CardSelection => {
      // Already ticked wins over newly ineligible. Eligibility gates what she can
      // pick, not what she has picked -- a tick that vanished from under her
      // after a partial batch would be the app editing her selection silently.
      if (selected.has(doc.id)) return { mode: 'ready', selected: true };
      if (unresolved.get(doc.id) === 0) return { mode: 'ready', selected: false };
      return { mode: 'blocked', reason: blockedReason(doc) };
    },
    [blockedReason, selected, unresolved],
  );

  const total = INBOX_GROUPS.reduce((sum, name) => sum + counts[name], 0);
  const nothingAtAll = documents !== null && total === 0;
  const unpicked = eligible.filter((id) => !selected.has(id)).length;
  const rejectedTab = group === 'rejected';
  const empty = EMPTY_COPY[group];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TitlebarActions>
        <Button
          size="sm"
          icon={<Plus size={12} weight="bold" />}
          onClick={() => dropZone.current?.openPicker()}
        >
          Add PDFs
        </Button>
        <IconButton label="Refresh" size="sm" loading={refreshing} onClick={() => void refresh()}>
          <ArrowClockwise size={14} />
        </IconButton>
      </TitlebarActions>

      <DropZone
        ref={dropZone}
        mode={nothingAtAll ? 'panel' : 'overlay'}
        watchFolder={settings?.watchFolder ?? null}
        onChangeFolder={openSettings}
        onFiles={(files) => void handleFiles(files)}
        onRejected={handleRejected}
        className={
          nothingAtAll
            ? 'min-h-0 flex-1 justify-center overflow-y-auto p-[24px]'
            : 'min-h-0 flex-1 overflow-y-auto p-[24px]'
        }
      >
        <div
          className={
            nothingAtAll
              ? 'flex w-full max-w-[560px] flex-col gap-[12px]'
              : 'flex flex-col gap-[16px]'
          }
        >
          {loadError !== null && (
            <div className="surface sq flex items-center justify-between gap-[12px] rounded-card p-[14px]">
              <p className="flex items-center gap-[6px] text-body text-label">
                <WarningCircle size={16} weight="fill" className="text-bad" />
                {loadError.message}
              </p>
              <Button size="sm" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          )}

          {uploads.length > 0 && (
            <ul className="surface sq list-none divide-y-[0.5px] divide-separator rounded-card px-[14px]">
              {uploads.map((upload) => (
                <li key={upload.id} className="flex items-center gap-[12px] py-[10px]">
                  <span className="min-w-0 flex-1 truncate text-body text-label">
                    {upload.name}
                  </span>
                  {upload.error === null ? (
                    <div className="w-[160px] shrink-0">
                      <ProgressBar value={upload.progress} label={`Uploading ${upload.name}`} />
                    </div>
                  ) : (
                    <>
                      <span className="text-callout text-bad">{upload.error}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setUploads((current) => current.filter((u) => u.id !== upload.id))
                        }
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!nothingAtAll && documents !== null && (
            <InboxFilter
              value={group}
              onChange={changeGroup}
              counts={counts}
              selectAll={
                rejectedTab || unpicked === 0
                  ? undefined
                  : { count: unpicked, onSelect: selectAllReady }
              }
            />
          )}

          {stalled && (
            <p className="text-callout text-label-secondary">
              Still waiting on the engine. Refresh to check again.
            </p>
          )}

          {documents === null && (
            // Ghost cards, not a shimmer: they hold the grid so the real cards
            // land in place instead of shoving the page around.
            <ul aria-hidden className="grid list-none grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <li key={i} className="surface sq overflow-hidden rounded-card">
                  <div className="hairline-b aspect-[7/4] w-full bg-sunken" />
                  <div className="flex flex-col gap-[8px] p-[14px]">
                    <div className="h-[15px] w-2/3 rounded-full bg-hover" />
                    <div className="h-[11px] w-1/3 rounded-full bg-hover" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!nothingAtAll && visible.length === 0 && documents !== null && (
            <EmptyState
              icon={empty.icon}
              title={empty.title}
              body={empty.body}
              action={
                group === 'pending' ? (
                  <Button size="sm" onClick={() => dropZone.current?.openPicker()}>
                    Add PDFs
                  </Button>
                ) : undefined
              }
            />
          )}

          {visible.length > 0 && (
            <InboxGrid
              documents={visible}
              onOpen={openReview}
              onRetry={(id) => void handleRetry(id)}
              onOpenSettings={openSettings}
              onReopen={(id) => void handleReopen(id)}
              selectionFor={rejectedTab ? undefined : selectionFor}
              selectionActive={selected.size > 0}
              onToggleSelect={toggleSelect}
              busyIds={busy}
            />
          )}
        </div>
      </DropZone>

      <SelectionBar
        count={selected.size}
        approving={approving}
        onApprove={() => void approveSelected()}
        onClear={clearSelection}
      />
    </div>
  );
}
