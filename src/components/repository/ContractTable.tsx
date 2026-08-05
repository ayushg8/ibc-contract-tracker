'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  ArrowUUpLeft,
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  DotsThree,
  Trash,
} from '@phosphor-icons/react';

import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  StatusPill,
} from '@/components/ui';
import type { RecordAction } from '@/lib/client/useRecordActions';
import type { AppSettings, ContractSortKey, ContractSummary } from '@/lib/db/types';
import { DOC_TYPE_LABELS } from '@/lib/fields';
import { formatShort } from '@/lib/util/dates';
import { displayGoverningLaw, MISSING } from './format';

/** Derived, not re-declared: density is a stored setting. */
export type Density = AppSettings['density'];

/** 44px is the row in the design; compact drops to the 34px list row. */
const ROW_HEIGHT: Record<Density, string> = {
  comfortable: 'h-[44px]',
  compact: 'h-[34px]',
};

function absent(): ReactNode {
  return <span className="text-label-quaternary">{MISSING}</span>;
}

function text(value: string | null): ReactNode {
  if (value === null || value.trim().length === 0) return absent();
  return value;
}

function date(value: string | null): ReactNode {
  const formatted = formatShort(value);
  if (formatted.length === 0) return absent();
  return <span className="tabular">{formatted}</span>;
}

interface ColumnSpec {
  /** Doubles as the column id, so a header click maps straight to the API's sort param. */
  key: ContractSortKey;
  label: string;
  width: string;
  cell: (row: ContractSummary) => ReactNode;
}

/**
 * The confidentiality cell.
 *
 * A record with no computable end for the obligation reads "No end date", never
 * "Expired" and never a blank. Both of the cases behind a null end -- a perpetual
 * clause, and a clause we could not resolve -- are indistinguishable from a
 * repository row, and both mean the same thing here: we have no date on which
 * this stops binding. Claiming it had ended would be the one lie this column
 * exists to prevent.
 */
function confidentiality(r: ContractSummary): ReactNode {
  if (r.confidentialityEnd === null) {
    return <StatusPill status="unknown" label="No end date" />;
  }
  return (
    <StatusPill
      status={r.confidentialityStatus}
      days={r.confidentialityDaysRemaining ?? undefined}
    />
  );
}

/**
 * The counterparty is the only column at full weight. She scans this table for a
 * company name and nothing else; giving the type, the dates and the jurisdiction
 * the same weight is what turns a table into a wall.
 *
 * BOTH clocks get a column. The table used to render `agreementStatus` as the
 * only status, which on a real corpus printed "Expired" across seven of
 * thirty-two records whose duty of confidence was still running -- answering "do
 * we have an NDA with X, and is it still in effect?" with a flat no when the
 * truthful answer is that the agreement has ended and the obligation has not.
 * Two pills in two labelled columns, rather than one merged verdict, because the
 * merged verdict cannot say WHICH clock is still running, and that is the fact
 * she acts on. One pill per column keeps it scannable at thirty rows.
 */
const COLUMNS: readonly ColumnSpec[] = [
  {
    key: 'counterparty',
    label: 'Counterparty',
    width: '23%',
    cell: (r) => <span className="font-medium text-label">{text(r.counterparty)}</span>,
  },
  {
    key: 'docType',
    label: 'Type',
    width: '12%',
    cell: (r) => DOC_TYPE_LABELS[r.docType],
  },
  {
    key: 'effectiveDate',
    label: 'Effective',
    width: '11%',
    cell: (r) => date(r.effectiveDate),
  },
  {
    key: 'terminationDate',
    label: 'Expires',
    width: '11%',
    cell: (r) => date(r.terminationDate),
  },
  {
    key: 'status',
    label: 'Agreement',
    width: '14%',
    cell: (r) => <StatusPill status={r.agreementStatus} days={r.daysRemaining ?? undefined} />,
  },
  {
    // Sorted by the end date rather than by the pill: it is the only ordering of
    // this column that stays stable as today moves.
    key: 'confidentialityEnd',
    label: 'Confidentiality',
    width: '14%',
    cell: confidentiality,
  },
  {
    key: 'governingLaw',
    label: 'Governing law',
    width: '10%',
    cell: (r) => text(displayGoverningLaw(r.governingLaw)),
  },
];

/** The unsortable trailing column that holds the per-row menu. */
const ACTION_WIDTH = '5%';

/**
 * The same three actions the detail sheet offers, one right-click away, so a bad
 * record can be corrected without opening it first.
 *
 * The trigger is invisible until the row is hovered or the button itself is
 * focused: six of these down the right edge would compete with the counterparty
 * column, which is the only thing anyone reads this table for. It stays in the tab
 * order the whole time, so the keyboard path is the same as the mouse path.
 */
function RowMenu({
  row,
  open,
  onOpenChange,
  onAction,
}: {
  row: ContractSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: RecordAction, row: ContractSummary) => void;
}) {
  return (
    // The row is itself a button, so a click or an Enter inside this cell would
    // otherwise open the record behind the menu.
    <span
      className="inline-flex"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Menu open={open} onOpenChange={onOpenChange}>
        <MenuTrigger asChild>
          <IconButton
            label={`Actions for ${row.counterparty ?? 'this record'}`}
            size="sm"
            className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <DotsThree size={15} weight="bold" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end" minWidth={232}>
          <MenuItem icon={ArrowUUpLeft} onSelect={() => onAction('unapprove', row)}>
            Send back to the Inbox
          </MenuItem>
          <MenuItem icon={ArrowsClockwise} onSelect={() => onAction('reextract', row)}>
            Re-read this document
          </MenuItem>
          <MenuSeparator />
          <MenuItem destructive icon={Trash} onSelect={() => onAction('archive', row)}>
            Remove from the repository
          </MenuItem>
        </MenuContent>
      </Menu>
    </span>
  );
}

export interface ContractTableProps {
  rows: ContractSummary[];
  /** null while the server is ordering by search relevance. */
  sort: ContractSortKey | null;
  dir: 'asc' | 'desc';
  onSortChange: (sort: ContractSortKey, dir: 'asc' | 'desc') => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  density: Density;
  /** Omitted, and the per-row menu is not rendered at all. */
  onAction?: (action: RecordAction, row: ContractSummary) => void;
}

/**
 * ONE surface on the canvas, with hairlines between rows. Not a card per row:
 * the table is a single object and the depth cue is the plane it sits on.
 *
 * Sorting is the server's job -- both statuses and both day counts are computed
 * at read time, so a client-side sort would order a different set of values than
 * the one the filter used.
 */
export function ContractTable({
  rows,
  sort,
  dir,
  onSortChange,
  selectedId,
  onSelect,
  density,
  onAction,
}: ContractTableProps) {
  /** Which row's menu is open. Right-click opens it without opening the record. */
  const [menuRow, setMenuRow] = useState<string | null>(null);

  function toggle(key: ContractSortKey) {
    if (sort !== key) {
      // First click on a date column reads newest-first; on a name, A to Z.
      onSortChange(key, key === 'counterparty' || key === 'governingLaw' ? 'asc' : 'desc');
      return;
    }
    onSortChange(key, dir === 'asc' ? 'desc' : 'asc');
  }

  return (
    // overflow-clip rather than overflow-hidden: hidden would make this element a
    // scrollport and the sticky header would stop tracking the pane's scroller.
    <div className="surface sq overflow-clip rounded-card">
      <table className="w-full table-fixed border-separate border-spacing-0 text-body">
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
          {onAction !== undefined && <col style={{ width: ACTION_WIDTH }} />}
        </colgroup>

        <thead>
          <tr>
            {COLUMNS.map((column, index) => {
              const active = sort === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  // Sticky on the cells rather than on <thead>: with border-separate
                  // a sticky thead leaves its hairline behind. The header sits on the
                  // recessed plane so rows pass under it, not through it.
                  className={clsx(
                    'eyebrow hairline-b sticky top-0 z-[1] h-[30px] bg-canvas px-[10px] text-left align-middle transition-colors duration-[var(--dur-fast)] ease-fast hover:bg-active',
                    index === 0 && 'pl-[14px]',
                    index === COLUMNS.length - 1 && onAction === undefined && 'pr-[14px]',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(column.key)}
                    className="inline-flex max-w-full items-center gap-[3px]"
                  >
                    <span className="truncate">{column.label}</span>
                    {active &&
                      (dir === 'asc' ? (
                        <CaretUp size={9} weight="bold" />
                      ) : (
                        <CaretDown size={9} weight="bold" />
                      ))}
                  </button>
                </th>
              );
            })}
            {onAction !== undefined && (
              <th
                scope="col"
                className="hairline-b sticky top-0 z-[1] h-[30px] bg-canvas pr-[14px] align-middle"
              >
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => {
            const selected = row.id === selectedId;
            return (
              <tr
                key={row.id}
                role="button"
                tabIndex={0}
                aria-current={selected ? true : undefined}
                onClick={() => onSelect(row.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelect(row.id);
                }}
                onContextMenu={
                  onAction === undefined
                    ? undefined
                    : (event) => {
                        // Right-click must not also open the record behind the menu.
                        event.preventDefault();
                        setMenuRow(row.id);
                      }
                }
                className={clsx(
                  'group transition-colors duration-[var(--dur-fast)] ease-fast last:[&>td]:border-b-0',
                  selected ? 'bg-accent-quiet' : 'hover:bg-hover',
                )}
              >
                {COLUMNS.map((column, index) => (
                  <td
                    key={column.key}
                    className={clsx(
                      'hairline-b truncate px-[10px] align-middle text-label-secondary',
                      ROW_HEIGHT[density],
                      index === 0 && 'pl-[14px]',
                      index === COLUMNS.length - 1 && onAction === undefined && 'pr-[14px]',
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
                {onAction !== undefined && (
                  <td
                    className={clsx(
                      'hairline-b pr-[10px] text-right align-middle',
                      ROW_HEIGHT[density],
                    )}
                  >
                    <RowMenu
                      row={row}
                      open={menuRow === row.id}
                      onOpenChange={(next) => setMenuRow(next ? row.id : null)}
                      onAction={onAction}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
