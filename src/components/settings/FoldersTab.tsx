'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DragEvent } from 'react';

import { StateDot } from '@/components/settings/HealthRow';
import { SettingsRow } from '@/components/settings/SettingsRow';
import type { SettingsPatch } from '@/components/settings/SettingsTabs';
import { Button, Card, Input, SectionHeader, useToast } from '@/components/ui';
import { usePoll, type HealthResponse } from '@/lib/client/api';
import { readWatch, rescanWatch, sinceLabel, type WatchStatus } from '@/lib/client/watch';
import {
  folderPathFromDrop,
  FOLDER_PATH_HINT,
  normalizeFolderPath,
} from '@/lib/engine-diagnosis';
import type { AppSettings } from '@/lib/db/types';
import type { HealthState } from '@/lib/providers/types';

type FolderId = 'watch' | 'archive' | 'export';

/** Often enough that Scan now feels live, rare enough to be invisible. */
const WATCH_POLL_MS = 4_000;

/** Enough to show the pattern without turning the row into a log viewer. */
const SKIPS_SHOWN = 3;

interface FolderSpec {
  id: FolderId;
  label: string;
  blurb: string;
  path: (settings: AppSettings) => string | null;
  patch: (path: string | null) => SettingsPatch;
  /** Only the watch folder is allowed to be unset. */
  clearable: boolean;
}

const FOLDERS: readonly FolderSpec[] = [
  {
    id: 'watch',
    label: 'Watch folder',
    // Deliberately not "picked up automatically". That claim is made by the live
    // line under this row, and only while the watcher is actually running.
    blurb: 'The tracker looks here for new PDFs.',
    path: (s) => s.watchFolder,
    patch: (path) => ({ watchFolder: path }),
    clearable: true,
  },
  {
    id: 'archive',
    label: 'PDF archive',
    blurb: 'The tracker keeps its own copy of every approved document here.',
    path: (s) => s.archiveFolder,
    patch: (path) => (path === null ? {} : { archiveFolder: path }),
    clearable: false,
  },
  {
    id: 'export',
    label: 'Export destination',
    // True as of the export route writing the workbook here before it hands the
    // browser its copy. It was not true before, and this row was the claim.
    blurb: 'Every workbook the tracker exports is written here.',
    path: (s) => s.exportFolder,
    patch: (path) => (path === null ? {} : { exportFolder: path }),
    clearable: false,
  },
];

/* ───────────────────────────── watcher state ───────────────────────────── */

function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The live state of the watched folder, in the row that configures it.
 *
 * The health check above answers "can this folder be read". This answers the
 * question that actually matters to her, which is "is anything reading it".
 */
function watchState(watch: WatchStatus | null, fallback: HealthState): HealthState {
  if (watch === null) return fallback;
  if (watch.folder === null) return 'warn';
  if (watch.error !== null) return 'fail';
  return watch.running ? 'ok' : 'warn';
}

/* ─────────────────────────────── the tab ───────────────────────────────── */

export interface FoldersTabProps {
  settings: AppSettings;
  health: HealthResponse | null;
  onPatch: (patch: SettingsPatch) => Promise<boolean>;
}

export function FoldersTab({ settings, health, onPatch }: FoldersTabProps) {
  const { toast } = useToast();
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    const next = await readWatch();
    if (next !== null) setWatch(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePoll(() => {
    void refresh();
  }, WATCH_POLL_MS);

  const scanNow = useCallback(async () => {
    // The counters are cumulative for the life of the process, so what this one
    // scan did is the difference across it. Saying "picked up 4" when the four
    // arrived an hour ago would be the same species of lie as the old copy.
    const before = watch;
    setScanning(true);
    const next = await rescanWatch();
    setScanning(false);
    if (next === null) {
      toast({ title: 'The tracker could not reach the folder watcher', tone: 'bad' });
      return;
    }
    setWatch(next);
    if (next.error !== null) {
      toast({ title: next.error.message, tone: 'bad' });
      return;
    }
    const added =
      next.ingested + next.reopened - (before === null ? 0 : before.ingested + before.reopened);
    toast({
      title:
        added > 0 ? `${countLabel(added, 'PDF added', 'PDFs added')}` : 'Folder checked',
      description:
        added > 0
          ? 'They are in the Inbox now.'
          : next.settling > 0
            ? `${countLabel(next.settling, 'file is', 'files are')} still being copied. They are picked up as soon as they stop changing.`
            : 'Everything in the folder is already in the tracker.',
      tone: 'ok',
    });
  }, [toast, watch]);

  return (
    <div className="flex flex-col gap-[20px]">
      <section>
        <SectionHeader title="Folders" className="mb-[8px] px-[2px]" />
        <Card padding="none" divided>
          {FOLDERS.map((spec) => (
            <FolderRow
              key={spec.id}
              spec={spec}
              path={spec.path(settings)}
              state={
                spec.id === 'watch'
                  ? watchState(watch, health?.checks.find((c) => c.id === 'watch')?.state ?? 'unknown')
                  : health?.checks.find((c) => c.id === spec.id)?.state ?? 'unknown'
              }
              detail={health?.checks.find((c) => c.id === spec.id)?.detail ?? null}
              watch={spec.id === 'watch' ? watch : null}
              scanning={spec.id === 'watch' ? scanning : false}
              onScan={spec.id === 'watch' ? scanNow : undefined}
              onPatch={onPatch}
            />
          ))}
        </Card>
        {/* No picker is promised here. This app is a page in a browser -- a page is
            handed the bytes of a file, never its location -- so the only honest
            answer is the Finder move that puts a path on the clipboard. */}
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          {FOLDER_PATH_HINT}
        </p>
      </section>
    </div>
  );
}

function FolderRow({
  spec,
  path,
  state,
  detail,
  watch,
  scanning,
  onScan,
  onPatch,
}: {
  spec: FolderSpec;
  path: string | null;
  state: HealthState;
  detail: string | null;
  watch: WatchStatus | null;
  scanning: boolean;
  onScan?: () => Promise<void>;
  onPatch: (patch: SettingsPatch) => Promise<boolean>;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function beginEdit() {
    setDraft(path ?? '');
    setEditing(true);
  }

  /**
   * A drop is offered but never promised: Chrome hands a page the bytes of a
   * dragged file and not its location, so most folder drags carry no path at all.
   * When one does not, she gets the Finder move that always works rather than
   * silence. preventDefault regardless -- a folder dropped on a page that ignores
   * it navigates Chrome away from the app.
   */
  function dropPath(event: DragEvent<HTMLInputElement>) {
    event.preventDefault();
    const dropped = folderPathFromDrop(event.dataTransfer);
    if (dropped === null) {
      toast({
        title: 'That drop did not carry a folder location',
        description: FOLDER_PATH_HINT,
        tone: 'warn',
      });
      return;
    }
    setDraft(dropped);
  }

  async function save() {
    // Everything Finder and Terminal put on a clipboard reduces to a plain path
    // here, so a pasted file:// URL is not rejected as a folder that does not exist.
    const next = normalizeFolderPath(draft);
    if (next.length === 0 && !spec.clearable) {
      setEditing(false);
      return;
    }
    setSaving(true);
    // The route checks the folder is there and writable before it stores it, so a
    // rejected save leaves the old path in place and the reason in a toast.
    const ok = await onPatch(spec.patch(next.length === 0 ? null : next));
    setSaving(false);
    if (ok) setEditing(false);
  }

  function copyPath() {
    if (path === null) return;
    void navigator.clipboard
      .writeText(path)
      .then(() =>
        toast({
          title: 'Path copied',
          description: 'In Finder press Command-Shift-G and paste it.',
          tone: 'ok',
        }),
      )
      .catch(() =>
        toast({ title: 'Could not reach the clipboard', tone: 'warn' }),
      );
  }

  // Only a real failure turns the line red. "Not chosen yet" is already the value
  // on the line above, and the amber dot says the rest.
  const broken = state === 'fail';

  return (
    <SettingsRow
      leading={<StateDot state={state} />}
      label={spec.label}
      description={
        editing ? (
          <div className="mt-[4px] flex items-center gap-[6px]">
            <Input
              autoFocus
              mono
              size="sm"
              value={draft}
              placeholder="/Users/you/IBC/NDAs"
              disabled={saving}
              wrapperClassName="flex-1"
              onChange={(event) => setDraft(event.target.value)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={dropPath}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <span title={path ?? undefined} className="block truncate font-mono">
            {path ?? 'Not chosen yet'}
          </span>
        )
      }
      control={
        editing ? undefined : (
          <>
            <Button size="sm" onClick={beginEdit}>
              Change
            </Button>
            <Button size="sm" variant="ghost" disabled={path === null} onClick={copyPath}>
              Copy path
            </Button>
          </>
        )
      }
    >
      {onScan === undefined ? (
        <p className={broken ? 'mt-[2px] text-callout text-bad' : 'mt-[2px] text-footnote text-label-tertiary'}>
          {broken && detail !== null ? detail : spec.blurb}
        </p>
      ) : (
        <WatchLine
          blurb={spec.blurb}
          watch={watch}
          scanning={scanning}
          onScan={onScan}
          onChooseFolder={beginEdit}
        />
      )}
    </SettingsRow>
  );
}

/**
 * What the watcher is doing, in one sentence, and never more than it knows.
 *
 * The word "automatically" appears in exactly one branch of this component: the
 * one where a folder is configured, reachable, and being polled. For a year the
 * Settings screen made that promise unconditionally against code that did not
 * exist, and this is the correction.
 */
function WatchLine({
  blurb,
  watch,
  scanning,
  onScan,
  onChooseFolder,
}: {
  blurb: string;
  watch: WatchStatus | null;
  scanning: boolean;
  onScan: () => Promise<void>;
  onChooseFolder: () => void;
}) {
  if (watch === null) {
    return <p className="mt-[2px] text-footnote text-label-tertiary">{blurb}</p>;
  }

  if (watch.folder === null) {
    return (
      <p className="mt-[2px] text-footnote text-label-tertiary">
        Choose a folder and new PDFs put there are picked up automatically.
      </p>
    );
  }

  if (watch.error !== null) {
    return (
      <div className="mt-[4px] flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
        <p className="text-callout text-bad">{watch.error.message}</p>
        {watch.error.remedy.action === 'choose-folder' ? (
          <Button size="sm" onClick={onChooseFolder}>
            {watch.error.remedy.label}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" loading={scanning} onClick={() => void onScan()}>
          Check again
        </Button>
      </div>
    );
  }

  const picked = watch.ingested + watch.reopened;

  return (
    <div className="mt-[2px] flex flex-col gap-[3px]">
      <p className="flex flex-wrap items-center gap-x-[6px] text-footnote text-label-tertiary">
        <span className={watch.running ? undefined : 'text-warn'}>
          {watch.running
            ? 'New PDFs put here are picked up automatically.'
            : 'Not being checked right now.'}
        </span>
        <span aria-hidden className="text-label-quaternary">
          {'·'}
        </span>
        <span>Last checked {sinceLabel(watch.lastScanAt)}</span>
        <span aria-hidden className="text-label-quaternary">
          {'·'}
        </span>
        <span>{countLabel(picked, 'PDF picked up', 'PDFs picked up')} since the tracker started</span>
        <Button size="sm" variant="ghost" loading={scanning} onClick={() => void onScan()}>
          <span className="text-accent">Scan now</span>
        </Button>
      </p>

      {watch.settling > 0 && (
        <p className="text-footnote text-label-tertiary">
          {countLabel(watch.settling, 'file is', 'files are')} still being copied into the folder.
          Nothing is read until a file stops changing.
        </p>
      )}

      {watch.backedOff && (
        <p className="text-footnote text-warn">
          Checking less often while the engine is paused. It speeds back up on its own.
        </p>
      )}

      {watch.skipped.length > 0 && (
        <div className="flex flex-col gap-[1px]">
          {watch.skipped.slice(0, SKIPS_SHOWN).map((skip) => (
            <p key={`${skip.filename}-${skip.at}`} className="truncate text-footnote text-warn">
              <span className="font-mono">{skip.filename}</span>
              {' — '}
              {skip.error.message}
            </p>
          ))}
          {watch.skipped.length > SKIPS_SHOWN && (
            <p className="text-footnote text-label-tertiary">
              and {watch.skipped.length - SKIPS_SHOWN} more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
