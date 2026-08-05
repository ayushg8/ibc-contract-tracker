'use client';

import { displayTitle } from '@/components/repository/format';
import { useState } from 'react';
import type { MouseEvent } from 'react';
import clsx from 'clsx';
import { motion } from 'motion/react';
import { ArrowUUpLeft, FileText, WarningCircle } from '@phosphor-icons/react';
import { Button, Checkbox, Pill, ProgressBar, SPRING_SNAPPY, Spinner, Tooltip } from '@/components/ui';
import { DOC_TYPE_LABELS } from '@/lib/fields';
import type { DocumentStatus, DocumentSummary } from '@/lib/db/types';
import { errorInfo, type EngineErrorCode, type RemedyAction } from '@/lib/providers/errors';

/** The four statuses where the pipeline still owns the document. */
const IN_FLIGHT: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'queued',
  'hashing',
  'reading',
  'extracting',
]);

const PHASE_LABEL: Record<DocumentStatus, string> = {
  queued: 'Waiting in the queue',
  hashing: 'Checking for a duplicate',
  reading: 'Reading the pages',
  extracting: 'Pulling out the terms',
  ready: 'Ready',
  needs_attention: 'Needs a check',
  approved: 'Approved',
  failed: 'Could not be read',
  rejected: 'Rejected',
  duplicate: 'Already in the tracker',
};

/** Escaped so the source stays ASCII. */
const MIDDOT = '\u00B7';

/**
 * How a card takes part in a multi-selection.
 *
 * `blocked` carries the sentence that explains itself on hover rather than a
 * boolean: a checkbox that is simply missing teaches nothing, and a backfill of
 * two hundred documents is exactly where "why can't I tick this one?" happens.
 * `off` is the Rejected tab, where there is nothing to approve in bulk.
 */
export type CardSelection =
  | { mode: 'off' }
  | { mode: 'ready'; selected: boolean }
  | { mode: 'blocked'; reason: string };

export interface DocumentCardProps {
  doc: DocumentSummary;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  /** Settings, for the remedies that are fixed there rather than here. */
  onOpenSettings: () => void;
  /** Only rendered on a rejected card. */
  onReopen?: (id: string) => void;
  selection?: CardSelection;
  /** True while anything at all is selected: the boxes stay out, not on hover. */
  selectionActive?: boolean;
  onToggleSelect?: (id: string, opts: { range: boolean }) => void;
  busy?: boolean;
}

/**
 * The stored code is a plain string by the time it reaches the browser. errorInfo
 * normalises anything it does not recognise to UNKNOWN, so this is the one place
 * the string is trusted as a key -- narrowing it any other way would mean
 * re-declaring the taxonomy, which errors.ts owns.
 */
function remedyOf(code: string) {
  return errorInfo(code as EngineErrorCode).remedy;
}

/** Where each remedy goes from an Inbox card. */
const HANDLED_HERE: ReadonlySet<RemedyAction> = new Set<RemedyAction>([
  'retry',
  'wait-and-retry',
]);
const OPENS_REVIEW: ReadonlySet<RemedyAction> = new Set<RemedyAction>(['enter-manually']);

function StatusChip({ doc }: { doc: DocumentSummary }) {
  if (IN_FLIGHT.has(doc.status)) {
    return (
      <Pill leading={<Spinner size={10} className="text-label-secondary" />}>
        {PHASE_LABEL[doc.status]}
      </Pill>
    );
  }
  // A bad scan is routine, so the failure is one quiet badge -- not a red card.
  if (doc.status === 'failed') {
    return (
      <Pill tone="bad" leading={<WarningCircle size={10} weight="fill" />}>
        Could not be read
      </Pill>
    );
  }
  if (doc.status === 'needs_attention') {
    const n = doc.counts.medium + doc.counts.none;
    return <Pill tone="warn">{n === 1 ? '1 to check' : `${n} to check`}</Pill>;
  }
  if (doc.status === 'approved') {
    return <Pill tone="ok">Approved</Pill>;
  }
  if (doc.status === 'ready') {
    return <Pill tone="ok">Ready</Pill>;
  }
  return <Pill tone="quiet">{PHASE_LABEL[doc.status]}</Pill>;
}

export function DocumentCard({
  doc,
  onOpen,
  onRetry,
  onOpenSettings,
  onReopen,
  selection = { mode: 'off' },
  selectionActive = false,
  onToggleSelect,
  busy = false,
}: DocumentCardProps) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const working = IN_FLIGHT.has(doc.status);
  const failed = doc.status === 'failed';
  const rejected = doc.status === 'rejected';
  const named = doc.counterparty !== null;
  // Same fold as the detail sheet: a preamble in all-caps is typography, not a name.
  const title = (doc.counterparty === null ? null : displayTitle(doc.counterparty)) ?? doc.filename;
  const subtitle = doc.docType ? DOC_TYPE_LABELS[doc.docType] : named ? doc.filename : null;

  const remedy = failed && doc.errorCode !== null ? remedyOf(doc.errorCode) : null;
  const remedyHandledHere = remedy === null || HANDLED_HERE.has(remedy.action);

  const selectable = selection.mode === 'ready';
  const selected = selection.mode === 'ready' && selection.selected;
  // A blocked box is only ever a hover explanation. Parking a row of dead
  // checkboxes on screen would make the ineligible documents the loudest thing
  // in a grid whose whole job is to surface the ready ones.
  const pinned = selectable && (selected || selectionActive);

  function toggle(event: MouseEvent<HTMLSpanElement>) {
    if (!selectable) return;
    // The chip sits over the thumbnail's open-for-review button, not inside it,
    // so this only has to stop the card's own click handling, never a submit.
    event.stopPropagation();
    onToggleSelect?.(doc.id, { range: event.shiftKey });
  }

  return (
    <motion.div
      // The lift is the whole point of the hover: it makes a record feel like an
      // object you can pick up rather than a row in a list.
      whileHover={{ y: -2 }}
      transition={SPRING_SNAPPY}
      className={clsx(
        'group relative h-full',
        // The ring goes on the wrapper because the card itself already spends its
        // box-shadow on the surface elevation, and two shadow utilities on one
        // element have undefined order.
        selected && 'sq rounded-card shadow-[0_0_0_2px_var(--accent)]',
      )}
    >
      {selection.mode !== 'off' && (
        <div className="absolute left-[8px] top-[8px] z-[1]">
          <Tooltip
            content={selection.mode === 'blocked' ? selection.reason : ''}
            disabled={selection.mode !== 'blocked'}
            side="right"
            delayDuration={250}
          >
            <span
              onClick={toggle}
              className={clsx(
                'sq grid size-[24px] place-items-center rounded-control bg-surface shadow-e1',
                'transition-opacity duration-[var(--dur-fast)] ease-fast',
                selectable ? 'cursor-pointer' : 'cursor-not-allowed',
                pinned
                  ? 'opacity-100'
                  : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
              )}
            >
              {/* Controlled with no change handler on purpose: the click and its
                  shift key are read on the wrapper, which is also the padding a
                  finger actually hits. */}
              <Checkbox
                checked={selected}
                disabled={!selectable}
                ariaLabel={selectable ? `Select ${title}` : `${title} cannot be approved in bulk`}
              />
            </span>
          </Tooltip>
        </div>
      )}

      <div
        className={clsx(
          'surface sq flex h-full flex-col overflow-hidden rounded-card text-left',
          'transition-shadow duration-[var(--dur-fast)] ease-fast group-hover:shadow-e2',
          busy && 'opacity-60',
        )}
      >
        <button
          type="button"
          onClick={() => onOpen(doc.id)}
          aria-label={`Review ${title}`}
          className="sq block w-full text-left"
        >
          {/* The top third of page one, not the whole page. A full page shrunk to
              card width is a grey smear; the crop keeps the title and the opening
              of the preamble at a size that can actually be read. The image is
              also blown past the container width to cut the paper margins. */}
          <div className="hairline-b relative aspect-[7/4] w-full overflow-hidden bg-sunken">
            {doc.thumbnailUrl !== null && !thumbBroken ? (
              // A plain <img>: the thumbnail comes off a local route already at
              // the right size, and image optimisation is off for this app.
              <img
                src={doc.thumbnailUrl}
                alt=""
                onError={() => setThumbBroken(true)}
                // Anchored left, not centred. At 124% width a centred crop eats
                // the left margin, and that is where every line of a contract
                // starts -- "MUTUAL CONFIDENTIALITY" rendered as "AL CONFIDENTIALITY".
                className="absolute left-0 top-0 w-[124%] max-w-none object-cover object-left-top"
              />
            ) : (
              <div className="grid size-full place-items-center">
                <FileText size={26} className="text-label-quaternary" />
              </div>
            )}
            {working && (
              <div className="absolute inset-x-0 bottom-0">
                <ProgressBar indeterminate label={PHASE_LABEL[doc.status]} />
              </div>
            )}
          </div>
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-[8px] p-[14px]">
          <div className="flex min-w-0 items-start justify-between gap-[10px]">
            <div className="min-w-0 flex-1">
              <p className="truncate text-title-3 font-medium text-label" title={title}>
                {title}
              </p>
              {subtitle !== null && (
                <p className="truncate text-callout text-label-secondary" title={subtitle}>
                  {subtitle}
                </p>
              )}
            </div>
            <StatusChip doc={doc} />
          </div>

          {failed && (
            <div className="flex flex-1 flex-col items-start gap-[8px]">
              <p className="text-body text-label">
                {doc.errorMessage ?? 'Something unexpected went wrong.'}
              </p>
              {remedy !== null && remedy.hint !== undefined && (
                <p className="text-callout text-label-secondary">{remedy.hint}</p>
              )}
              <div className="mt-auto flex items-center gap-[6px] pt-[2px]">
                {remedyHandledHere ? (
                  <Button size="sm" onClick={() => onRetry(doc.id)} disabled={busy}>
                    Try again
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      onClick={
                        remedy !== null && OPENS_REVIEW.has(remedy.action)
                          ? () => onOpen(doc.id)
                          : onOpenSettings
                      }
                    >
                      {remedy?.label}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onRetry(doc.id)}
                      disabled={busy}
                    >
                      Try again
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {rejected && (
            <div className="flex flex-1 flex-col items-start gap-[8px]">
              <p className="text-body text-label-secondary">
                Set aside. The file is still in the archive.
              </p>
              <div className="mt-auto flex w-full items-center justify-between gap-[8px] pt-[2px]">
                <span className="tabular text-footnote text-label-tertiary">
                  {doc.pageCount > 0
                    ? doc.pageCount === 1
                      ? '1 page'
                      : `${doc.pageCount} pages`
                    : ''}
                </span>
                {/* Always visible, never revealed on hover: this is the only way
                    back, and a control you have to discover is not a way back. */}
                <Button
                  size="sm"
                  icon={<ArrowUUpLeft size={12} />}
                  loading={busy}
                  onClick={() => onReopen?.(doc.id)}
                >
                  Reopen
                </Button>
              </div>
            </div>
          )}

          {!failed && !rejected && (
            <>
              <p className="tabular text-footnote text-label-tertiary">
                {working
                  ? PHASE_LABEL[doc.status]
                  : `${doc.counts.high} high ${MIDDOT} ${doc.counts.medium} medium ${MIDDOT} ${doc.counts.none} none`}
              </p>
              <div className="mt-auto flex items-center justify-between gap-[8px] pt-[2px]">
                <span className="tabular text-footnote text-label-tertiary">
                  {doc.pageCount > 0
                    ? doc.pageCount === 1
                      ? '1 page'
                      : `${doc.pageCount} pages`
                    : ''}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => onOpen(doc.id)}
                  // Revealed on hover, but never hidden from the keyboard.
                  className="opacity-0 transition-opacity duration-[var(--dur-fast)] ease-fast group-hover:opacity-100 focus-visible:opacity-100"
                >
                  {working ? 'Open' : 'Review'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
