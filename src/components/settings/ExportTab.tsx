'use client';

import { useCallback, useEffect, useState } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';

import { SettingsRow } from '@/components/settings/SettingsRow';
import { Button, Card, Checkbox, SectionHeader, Spinner, useToast } from '@/components/ui';
import { api, downloadExport, type ExportPreviewResponse } from '@/lib/client/api';
import type { AppSettings, DocType } from '@/lib/db/types';

/** Her workbook has these two tabs; 'Other' ships only when it is asked for. */
const DEFAULT_SHEETS: readonly DocType[] = ['nda', 'evaluation'];

/**
 * Mirrors exportFilename() in @/lib/excel/export, which is server-only and cannot
 * be imported here. Kept in one expression so the drift, if it ever happens, is
 * one line to fix.
 */
function generatedFilename(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `Tracker_${y}-${m}-${d}.xlsx`;
}

/**
 * Where the file the export just wrote actually is. The route writes it to the
 * configured folder under exactly this name, so this composes rather than guesses.
 */
function savedPath(folder: string, filename: string): string {
  return `${folder.replace(/\/+$/, '')}/${filename}`;
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

export interface ExportTabProps {
  settings: AppSettings;
  /** Re-reads settings so the last-export stamp is current after a write. */
  onRefresh: () => void;
}

export function ExportTab({ settings, onRefresh }: ExportTabProps) {
  const { toast, dismiss } = useToast();
  const [preview, setPreview] = useState<ExportPreviewResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<DocType>>(new Set(DEFAULT_SHEETS));
  const [exporting, setExporting] = useState(false);
  /** The exact file the last export wrote, so "where did it go" is answered here. */
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.exportPreview();
    if (result.error !== undefined) {
      setFailure(result.error.message);
      return;
    }
    setPreview(result.data);
    setFailure(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = preview?.sheets.reduce(
    (sum, sheet) => (chosen.has(sheet.id) ? sum + sheet.rows : sum),
    0,
  );

  function copySaved() {
    if (saved === null) return;
    void navigator.clipboard
      .writeText(saved)
      .then(() =>
        toast({
          title: 'Path copied',
          description: 'In Finder press Command-Shift-G and paste it.',
          tone: 'ok',
        }),
      )
      .catch(() => toast({ title: 'Could not reach the clipboard', tone: 'warn' }));
  }

  function toggle(id: DocType, on: boolean) {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function run() {
    setExporting(true);
    const pending = toast({ title: 'Building the workbook...', duration: 0 });
    const result = await downloadExport([...chosen]);
    dismiss(pending);
    setExporting(false);
    if (result.error !== undefined) {
      // A failure can come from either end of the wire, so nothing here may claim
      // what did or did not reach the folder. The error speaks for itself, and the
      // saved path goes rather than point at a file this cannot vouch for.
      setSaved(null);
      toast({ title: result.error.message, tone: 'bad' });
      return;
    }
    const where = savedPath(settings.exportFolder, result.data.filename);
    setSaved(where);
    toast({
      title: `Saved ${result.data.filename}`,
      description: `Written to ${settings.exportFolder}. Your browser downloaded its own copy as well.`,
      tone: 'ok',
    });
    // The export stamps lastExportedAt and writes an audit row per contract.
    onRefresh();
    void load();
  }

  return (
    <div className="flex flex-col gap-[20px]">
      <section>
        <SectionHeader
          title="Sheets"
          className="mb-[8px] px-[2px]"
          trailing={
            rows === undefined ? undefined : (
              <span className="tabular text-footnote text-label-tertiary">
                {rows} {rows === 1 ? 'row' : 'rows'} selected
              </span>
            )
          }
        />
        <Card padding="none" divided>
          {preview === null && failure === null && (
            <div className="flex items-center gap-[8px] px-[12px] py-[14px] text-callout text-label-secondary">
              <Spinner size={13} />
              Counting rows...
            </div>
          )}

          {failure !== null && (
            <SettingsRow
              label={failure}
              control={
                <Button size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          )}

          {preview?.sheets.map((sheet) => (
            <div
              key={sheet.id}
              className="flex min-h-[44px] items-center gap-[10px] px-[12px] py-[10px]"
            >
              <Checkbox
                checked={chosen.has(sheet.id)}
                onCheckedChange={(next) => toggle(sheet.id, next === true)}
                label={sheet.label}
              />
              <div className="flex-1" />
              <span className="tabular text-callout text-label-secondary">
                {sheet.rows} {sheet.rows === 1 ? 'row' : 'rows'}
              </span>
            </div>
          ))}
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          Same tabs and the same column order as the tracker you already keep.
        </p>
      </section>

      <section>
        <SectionHeader title="Destination" className="mb-[8px] px-[2px]" />
        <Card padding="none" divided>
          <Detail label="Folder" value={settings.exportFolder} mono />
          <Detail label="Filename" value={generatedFilename()} mono />
          <Detail label="Last exported" value={stamp(preview?.lastExportedAt ?? null)} />
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          The workbook is written to this folder every time. Your browser downloads its own
          second copy as well, wherever it normally puts downloads.
        </p>
      </section>

      <div>
        <Button
          variant="primary"
          size="lg"
          icon={<DownloadSimple size={14} />}
          loading={exporting}
          disabled={chosen.size === 0}
          onClick={() => void run()}
        >
          Export now
        </Button>
        {chosen.size === 0 && (
          <p className="mt-[6px] text-footnote text-label-tertiary">
            Pick at least one sheet.
          </p>
        )}
        {/* The exact file, because "it exported" is not an answer to "where is it".
            Copy path, then Command-Shift-G in Finder. */}
        {saved !== null && (
          <div className="mt-[8px] flex items-center gap-[6px]">
            <span className="shrink-0 text-footnote text-label-tertiary">Saved to</span>
            <span
              title={saved}
              className="min-w-0 flex-1 truncate font-mono text-footnote text-label-tertiary"
            >
              {saved}
            </span>
            <Button size="sm" variant="ghost" onClick={copySaved}>
              Copy path
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <SettingsRow
      label={label}
      control={
        <span
          title={value}
          className={
            mono === true
              ? 'max-w-[320px] truncate font-mono text-callout text-label-secondary'
              : 'tabular max-w-[320px] truncate text-callout text-label-secondary'
          }
        >
          {value}
        </span>
      }
    />
  );
}
