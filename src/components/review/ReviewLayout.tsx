'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowLeft, Code, FolderOpen } from '@phosphor-icons/react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import {
  Button,
  IconButton,
  Pill,
  ProgressBar,
  Spinner,
  Tooltip,
} from '@/components/ui';
import { ProvenanceNotes } from '@/components/provenance/ProvenanceNotes';
import { provenanceNotices, type ProvenanceInput } from '@/lib/client/provenance';
import type {
  ContractSummary,
  DocType,
  DocumentDetail,
  FieldKey,
  FieldRecord,
} from '@/lib/db/types';
import { ApproveBar, type ApproveBlocker } from './ApproveBar';
import { DocTypeSelect } from './DocTypeSelect';
import { FieldPanel, type FieldPanelHandle } from './FieldPanel';
import { PdfPane, type PdfCitation, type PdfPaneHandle } from './PdfPane';
import { RawDrawer } from './RawDrawer';

const SPLIT_KEY = 'ibc.review.split';
const PDF_PANEL = 'pdf';
const FIELDS_PANEL = 'fields';

const PHASE_LABEL: Record<string, string> = {
  queued: 'Waiting in the queue',
  hashing: 'Checking for a duplicate',
  reading: 'Reading the pages',
  extracting: 'Pulling out the terms',
};

function readSplit(): Layout | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(SPLIT_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record: Record<string, unknown> = { ...parsed };
    const left = record[PDF_PANEL];
    const right = record[FIELDS_PANEL];
    if (typeof left !== 'number' || typeof right !== 'number') return undefined;
    return { [PDF_PANEL]: left, [FIELDS_PANEL]: right };
  } catch {
    return undefined;
  }
}

export interface ReviewLayoutProps {
  /**
   * The document row plus its read provenance. Spelled out rather than left to
   * DocumentDetail because the provenance columns are newer than that contract:
   * a row written before they existed simply has none, which is why every one of
   * them is optional and why a missing one renders as silence.
   */
  document: DocumentDetail & ProvenanceInput;
  fields: FieldRecord[];
  contract: ContractSummary | null;
  /** 'extracting' hides the fields and shows live progress instead. */
  phase: 'extracting' | 'review';
  /** A field the page wants jumped to, e.g. the one that blocked an approve. */
  focusKey?: FieldKey | null;
  onFocusHandled?: () => void;
  onCommitField: (key: FieldKey, value: string | null) => void;
  onNotApplicable: (key: FieldKey) => void;
  onDocTypeChange: (type: DocType) => void;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onBack: () => void;
  onOpenRecord?: () => void;
  savingKeys: ReadonlySet<FieldKey>;
  approving?: boolean;
  rejecting?: boolean;
  retrying?: boolean;
  docTypeSaving?: boolean;
}

export function ReviewLayout({
  document,
  fields,
  contract,
  phase,
  focusKey = null,
  onFocusHandled,
  onCommitField,
  onNotApplicable,
  onDocTypeChange,
  onApprove,
  onReject,
  onRetry,
  onBack,
  onOpenRecord,
  savingKeys,
  approving = false,
  rejecting = false,
  retrying = false,
  docTypeSaving = false,
}: ReviewLayoutProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const [defaultLayout] = useState<Layout | undefined>(readSplit);

  const pdf = useRef<PdfPaneHandle>(null);
  const panel = useRef<FieldPanelHandle>(null);

  const approved = document.status === 'approved';
  const locked = approved || phase === 'extracting';

  const blockers = useMemo<ApproveBlocker[]>(
    () =>
      fields
        .filter((f) => f.requiredToApprove && f.value === null && f.method !== 'na')
        .map((f) => ({ key: f.key, label: f.label })),
    [fields],
  );

  /**
   * How this document was read. It belongs above the split, not in a field row:
   * on a scan every one of the sixteen fields carries the same caveat, and the
   * reviewer has to know it before she reads the first value -- not after she
   * has already believed one.
   */
  const notices = useMemo(() => provenanceNotices(document), [document]);

  const citations = useMemo<PdfCitation[]>(
    () =>
      fields
        .filter(
          (f): f is FieldRecord & { quote: string; page: number } =>
            f.quote !== null && f.quote.length > 0 && f.page !== null,
        )
        .map((f) => ({ key: f.key, quote: f.quote, page: f.page })),
    [fields],
  );

  const onQuoteClick = useCallback((field: FieldRecord) => {
    if (field.quote === null) return;
    pdf.current?.highlight(field.quote, field.page ?? 1);
  }, []);

  const onCitationClick = useCallback(
    (key: string) => {
      const field = fields.find((f) => f.key === key);
      if (field !== undefined) panel.current?.focusField(field.key);
    },
    [fields],
  );

  useEffect(() => {
    if (focusKey === null || phase !== 'review') return;
    panel.current?.focusField(focusKey);
    onFocusHandled?.();
  }, [focusKey, phase, onFocusHandled]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
      if (locked || blockers.length > 0 || approving) return;
      event.preventDefault();
      onApprove();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [locked, blockers.length, approving, onApprove]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="hairline-b flex shrink-0 items-center gap-[10px] px-[12px] py-[8px]">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={12} />} onClick={onBack}>
          Inbox
        </Button>

        <span
          className="min-w-0 flex-1 truncate text-title-3 font-medium text-label"
          title={document.filename}
        >
          {document.filename}
        </span>

        <DocTypeSelect
          value={document.docType}
          onChange={onDocTypeChange}
          disabled={approved}
          busy={docTypeSaving}
        />

        {document.pageCount > 0 && (
          <span className="tabular shrink-0 text-footnote text-label-tertiary">
            {document.pageCount === 1 ? '1 page' : `${document.pageCount} pages`}
          </span>
        )}

        {!approved && (
          <Tooltip content="Read this document again">
            <IconButton
              label="Read again"
              size="sm"
              loading={retrying}
              onClick={onRetry}
            >
              <ArrowClockwise size={13} />
            </IconButton>
          </Tooltip>
        )}

        {/*
          Where this contract lives, one click away. The folder holds the original
          PDF, the text the model was actually given, and the readable record, so
          opening it answers most of what someone would otherwise ask the app for.
        */}
        <Tooltip content="Show this contract's folder in Finder">
          <IconButton
            label="Show in Finder"
            size="sm"
            onClick={() => {
              void fetch('/api/reveal', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ documentId: document.id }),
              }).catch(() => undefined);
            }}
          >
            <FolderOpen size={13} />
          </IconButton>
        </Tooltip>

        <Button
          size="sm"
          variant="ghost"
          icon={<Code size={12} />}
          onClick={() => setRawOpen((open) => !open)}
        >
          Raw
        </Button>

        {phase === 'extracting' ? (
          <Pill leading={<Spinner size={10} className="text-label-secondary" />}>
            {PHASE_LABEL[document.status] ?? 'Working'}
          </Pill>
        ) : (
          <ApproveBar
            blockers={blockers}
            onApprove={onApprove}
            onReject={onReject}
            onJumpToBlocker={(key) => panel.current?.focusField(key)}
            approving={approving}
            rejecting={rejecting}
            approved={approved}
            onOpenRecord={contract === null ? undefined : onOpenRecord}
          />
        )}
      </header>

      {/* Hidden while the read is still running: the provenance is not written
          until it finishes, and a caveat that appears halfway through reads as a
          new problem rather than as the answer to "how was this read". */}
      {phase === 'review' && notices.length > 0 && (
        <div className="hairline-b shrink-0 px-[12px] py-[8px]">
          <ProvenanceNotes notices={notices} />
        </div>
      )}

      <Group
        orientation="horizontal"
        id="review-split"
        defaultLayout={defaultLayout}
        onLayoutChanged={(layout) => {
          try {
            window.localStorage.setItem(SPLIT_KEY, JSON.stringify(layout));
          } catch {
            // A full or locked disk must not cost her the review session.
          }
        }}
        className="min-h-0 flex-1"
      >
        <Panel id={PDF_PANEL} defaultSize="58" minSize="30" className="min-w-0">
          <PdfPane
            ref={pdf}
            url={document.pdfUrl}
            citations={citations}
            onCitationClick={onCitationClick}
          />
        </Panel>

        <Separator className="group/split relative w-[7px] shrink-0 bg-transparent">
          <span
            aria-hidden
            className="absolute left-1/2 top-0 h-full w-[0.5px] -translate-x-1/2 bg-[var(--separator)] transition-colors duration-[var(--dur-fast)] ease-fast group-hover/split:bg-accent"
          />
        </Separator>

        <Panel id={FIELDS_PANEL} defaultSize="42" minSize="26" className="min-w-0">
          <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface">
            {phase === 'extracting' ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-[10px] px-[24px] text-center">
                <p className="text-title-3 font-medium text-label">
                  {PHASE_LABEL[document.status] ?? 'Working on it'}
                </p>
                <p className="max-w-[280px] text-callout text-label-secondary">
                  You can read the document while this runs. The fields appear the moment
                  they are found.
                </p>
                <div className="w-full max-w-[220px]">
                  <ProgressBar indeterminate />
                </div>
              </div>
            ) : (
              <FieldPanel
                ref={panel}
                fields={fields}
                onCommit={onCommitField}
                onNotApplicable={onNotApplicable}
                onQuoteClick={onQuoteClick}
                savingKeys={savingKeys}
                locked={locked}
              />
            )}

            <RawDrawer open={rawOpen} onClose={() => setRawOpen(false)} document={document} />
          </div>
        </Panel>
      </Group>
    </div>
  );
}
