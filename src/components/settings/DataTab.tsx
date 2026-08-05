'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowClockwise,
  Copy,
  Database,
  DownloadSimple,
  FilePdf,
  Files,
  FileText,
  FolderOpen,
  HardDrives,
  Warning,
} from '@phosphor-icons/react';

import { SettingsRow } from '@/components/settings/SettingsRow';
import {
  Button,
  Card,
  ProgressBar,
  SectionHeader,
  Spinner,
  StatTile,
  useToast,
} from '@/components/ui';
// Types only. @/lib/backup is server-only (node:fs, node:zlib); `import type` is
// erased at compile time, so nothing from it reaches the browser bundle.
import type { DataOverview } from '@/lib/backup';

/** Past this, a backup is old enough to mention. Not to shout about. */
const STALE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const count = new Intl.NumberFormat();

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'TB'}`;
}

function stamp(iso: string | null): string {
  if (iso === null) return 'Never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

/**
 * "About" because the estimate counts the PDFs at full size and the database
 * before it is compressed. Overstating the total is the safe direction: a bar
 * that finishes early reads as fast, one that sits at 100% reads as stuck.
 */
function progressLabel(progress: BackupProgress): string {
  if (progress.total === 0) return 'Copying the database and every PDF...';
  return `${sizeLabel(progress.received)} of about ${sizeLabel(progress.total)} copied.`;
}

function daysSince(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor((Date.now() - ms) / DAY_MS);
}

/* ─────────────────────── Talking to /api/backup ─────────────────────── */

/*
 * lib/client/api.ts owns every other call in the app, and this tab would live
 * there too if this pass owned that file. It does not, so the two calls are
 * inlined here against the same contract: never throw, always resolve to a
 * message the UI can render.
 */

async function messageFrom(res: Response, fallback: string): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fallback;
  }
  if (typeof body === 'object' && body !== null) {
    const error: unknown = Reflect.get(body, 'error');
    if (typeof error === 'object' && error !== null) {
      const message: unknown = Reflect.get(error, 'message');
      if (typeof message === 'string') return message;
    }
  }
  return fallback;
}

async function fetchOverview(): Promise<{ data?: DataOverview; error?: string }> {
  let res: Response;
  try {
    res = await fetch('/api/backup?info=1', { cache: 'no-store' });
  } catch {
    return { error: 'The tracker could not be reached.' };
  }
  if (!res.ok) return { error: await messageFrom(res, 'The data folder could not be read.') };
  try {
    return { data: (await res.json()) as DataOverview };
  } catch {
    return { error: 'The tracker answered with something unreadable.' };
  }
}

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="?([^";]+)"?/);
  return match?.[1] ?? fallback;
}

/** What the tab knows about a build in flight. `total` of 0 means "unknown". */
export interface BackupProgress {
  received: number;
  total: number;
}

/** The server's estimate of the uncompressed bytes it is about to send. */
const ESTIMATE_HEADER = 'X-Backup-Estimated-Bytes';

const ZIP_MIME = 'application/zip';

/** Roughly one repaint's worth. Fast enough to read as live, slow enough to be free. */
const PROGRESS_INTERVAL_MS = 120;

function estimateFrom(header: string | null): number {
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fetched rather than navigated to: a failed backup answers with JSON, and a
 * navigation would render that JSON in the window instead of a toast.
 *
 * Read chunk by chunk rather than with `.blob()`, because the server now
 * produces the archive as it sends it and this can legitimately run for a
 * minute. Without a progress reading, a minute of nothing is indistinguishable
 * from a hang, which is when people close the tab and lose the work.
 */
async function downloadBackup(
  onProgress: (progress: BackupProgress) => void,
): Promise<{ filename?: string; error?: string }> {
  let res: Response;
  try {
    res = await fetch('/api/backup', { cache: 'no-store' });
  } catch {
    return { error: 'The tracker could not be reached.' };
  }
  if (!res.ok) return { error: await messageFrom(res, 'The backup could not be built.') };

  const filename = filenameFrom(res.headers.get('Content-Disposition'), 'IBC-Contracts-Backup.zip');
  const total = estimateFrom(res.headers.get(ESTIMATE_HEADER));
  const body = res.body;
  if (body === null) return { error: 'The backup could not be built.' };

  const reader = body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  // The server sends a 256 KB chunk at a time; re-rendering on every one of them
  // would be thousands of renders to move a bar a few pixels.
  let nextReport = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      received += value.byteLength;
      const now = performance.now();
      if (now >= nextReport) {
        nextReport = now + PROGRESS_INTERVAL_MS;
        onProgress({ received, total });
      }
    }
    onProgress({ received, total });
  } catch {
    // The server aborts the stream rather than finish a zip it cannot vouch for,
    // so a break here means the partial bytes are deliberately worthless.
    return { error: 'The backup stopped part way through, so nothing was saved.' };
  }

  const href = URL.createObjectURL(new Blob(chunks, { type: ZIP_MIME }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously cancels the download in Safari.
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return { filename };
}

/* ────────────────────────────── The tab ─────────────────────────────── */

export function DataTab() {
  const { toast, dismiss } = useToast();
  const [overview, setOverview] = useState<DataOverview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const backingUp = progress !== null;

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchOverview();
    setLoading(false);
    if (result.data === undefined) {
      setFailure(result.error ?? 'The data folder could not be read.');
      return;
    }
    setOverview(result.data);
    setFailure(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copyPath = useCallback(
    (path: string) => {
      void navigator.clipboard
        .writeText(path)
        .then(() =>
          toast({
            title: 'Path copied',
            description: 'In Finder press Command-Shift-G and paste it.',
            tone: 'ok',
          }),
        )
        .catch(() => toast({ title: 'Could not reach the clipboard', tone: 'warn' }));
    },
    [toast],
  );

  async function backUpNow() {
    setProgress({ received: 0, total: 0 });
    const pending = toast({
      title: 'Packing everything up...',
      description: 'Leave this tab open. A large archive can take a minute.',
      duration: 0,
    });
    const result = await downloadBackup(setProgress);
    dismiss(pending);
    setProgress(null);
    if (result.filename === undefined) {
      toast({ title: result.error ?? 'The backup could not be built.', tone: 'bad' });
      return;
    }
    toast({
      title: `Saved ${result.filename}`,
      description: 'Put it somewhere that is not this Mac.',
      tone: 'ok',
    });
    void load();
  }

  if (overview === null) {
    return (
      <Card padding="none">
        <SettingsRow
          leading={loading ? <Spinner size={13} /> : undefined}
          label={failure ?? 'Reading the data folder...'}
          control={
            failure === null ? undefined : (
              <Button size="sm" onClick={() => void load()}>
                Try again
              </Button>
            )
          }
        />
      </Card>
    );
  }

  const age = daysSince(overview.lastBackupAt);
  const hasRecords = overview.counts.contracts > 0 || overview.counts.documents > 0;
  const overdue = hasRecords && (age === null || age >= STALE_DAYS);

  return (
    <div className="flex flex-col gap-[20px]">
      {overdue && <BackupNotice never={age === null} days={age} overview={overview} />}

      <section>
        <SectionHeader
          title="Backup"
          className="mb-[8px] px-[2px]"
          trailing={
            <Button
              size="sm"
              variant="ghost"
              icon={<ArrowClockwise size={13} />}
              loading={loading}
              onClick={() => void load()}
            >
              Recheck
            </Button>
          }
        />
        <Card padding="none">
          {/* Tiles divide with hairlines inside the one surface this region owns;
              a box per number is the nesting the kit exists to prevent. */}
          <div className="grid grid-cols-2 divide-x-[0.5px] divide-y-[0.5px] divide-separator sm:grid-cols-4 sm:divide-y-0">
            <StatTile
              label="Contracts"
              icon={FileText}
              value={count.format(overview.counts.contracts)}
            />
            <StatTile
              label="Documents"
              icon={Files}
              value={count.format(overview.counts.documents)}
            />
            <StatTile
              label="Archived PDFs"
              icon={FilePdf}
              value={count.format(overview.counts.archivedPdfs)}
            />
            <StatTile
              label="On disk"
              icon={HardDrives}
              value={sizeLabel(overview.bytes.total)}
              supporting={`${sizeLabel(overview.bytes.backup)} in a backup`}
            />
          </div>

          <div className="hairline-t">
            <SettingsRow
              label={progress === null ? 'Last backup' : 'Building the backup'}
              description={
                progress !== null
                  ? progressLabel(progress)
                  : age === null
                    ? 'No backup has been taken from this Mac.'
                    : `${stamp(overview.lastBackupAt)}${age === 0 ? ' - today' : age === 1 ? ' - yesterday' : ` - ${age} days ago`}`
              }
              control={
                <Button
                  variant="primary"
                  icon={<DownloadSimple size={14} />}
                  loading={backingUp}
                  onClick={() => void backUpNow()}
                >
                  Back up now
                </Button>
              }
            >
              {/* Inside the region's one Card, under the line it describes. A
                  bar in its own box would be the nesting the kit forbids. */}
              {progress !== null && (
                <ProgressBar
                  className="mt-[6px]"
                  label="Backup progress"
                  indeterminate={progress.total === 0}
                  value={progress.total === 0 ? 0 : progress.received / progress.total}
                />
              )}
            </SettingsRow>
          </div>
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          One zip holding the database, every PDF the tracker has read, and your settings. It
          arrives as a download, so your browser may put it in Downloads.
        </p>
      </section>

      <section>
        <SectionHeader title="Where the data lives" className="mb-[8px] px-[2px]" />
        <Card padding="none" divided>
          <PathRow
            icon={<FolderOpen size={14} className="text-label-tertiary" />}
            label="Application data"
            path={overview.dataDir}
            detail={`${sizeLabel(overview.bytes.total)} in total`}
            onCopy={copyPath}
          />
          <PathRow
            icon={<Database size={14} className="text-label-tertiary" />}
            label="Database"
            path={overview.databasePath}
            detail={`${sizeLabel(overview.bytes.database)} - every contract, its evidence and its audit trail`}
            onCopy={copyPath}
          />
          <PathRow
            icon={<FilePdf size={14} className="text-label-tertiary" />}
            label="PDF archive"
            path={overview.archivePath}
            detail={`${count.format(overview.counts.archivedPdfs)} files, ${sizeLabel(overview.bytes.archive)}`}
            onCopy={copyPath}
          />
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          Copy a path, then press Command-Shift-G in Finder and paste it to open the folder.
        </p>
      </section>

      <section>
        <SectionHeader title="If you ever need to restore" className="mb-[8px] px-[2px]" />
        <Card padding="lg">
          <ol className="flex flex-col gap-[8px]">
            {overview.restore.steps.map((step, index) => (
              <li key={index} className="flex gap-[10px]">
                <span className="tabular w-[16px] shrink-0 text-callout text-label-tertiary">
                  {index + 1}.
                </span>
                <span className="min-w-0 flex-1 text-callout text-label-secondary">{step}</span>
              </li>
            ))}
          </ol>
          <p className="hairline-t mt-[12px] pt-[12px] text-callout text-label-secondary">
            {overview.restore.apiKeyNote}
          </p>
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          The same steps are written into RESTORE.txt inside every backup, so they travel with it.
        </p>
      </section>
    </div>
  );
}

/**
 * Warning, not alarm: a tinted plane on the canvas rather than a bordered box,
 * and no button, because the one that fixes it is a few pixels below.
 */
function BackupNotice({
  never,
  days,
  overview,
}: {
  never: boolean;
  days: number | null;
  overview: DataOverview;
}) {
  const what =
    overview.counts.contracts > 0
      ? `${count.format(overview.counts.contracts)} approved ${overview.counts.contracts === 1 ? 'contract' : 'contracts'}`
      : `${count.format(overview.counts.documents)} ${overview.counts.documents === 1 ? 'document' : 'documents'}`;

  return (
    <section role="status" className="sq flex items-start gap-[10px] rounded-card bg-warn-quiet px-[14px] py-[11px]">
      <Warning size={18} weight="fill" className="mt-[-1px] shrink-0 text-warn" />
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <p className="text-body font-medium text-label">
          {never ? 'This has never been backed up.' : `The last backup was ${days} days ago.`}
        </p>
        <p className="text-callout text-label-secondary">
          {never
            ? `This Mac holds the only copy of ${what}. A backup takes a few seconds.`
            : `${what} live here. Take another one so the copy you keep elsewhere is current.`}
        </p>
      </div>
    </section>
  );
}

function PathRow({
  icon,
  label,
  path,
  detail,
  onCopy,
}: {
  icon: ReactNode;
  label: string;
  path: string;
  detail: string;
  onCopy: (path: string) => void;
}) {
  return (
    <SettingsRow
      leading={icon}
      label={label}
      description={
        <span title={path} className="block truncate font-mono">
          {path}
        </span>
      }
      control={
        <Button size="sm" icon={<Copy size={13} />} onClick={() => onCopy(path)}>
          Copy path
        </Button>
      }
    >
      <p className="mt-[2px] text-footnote text-label-tertiary">{detail}</p>
    </SettingsRow>
  );
}
