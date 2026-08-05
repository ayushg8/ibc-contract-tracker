'use client';

import clsx from 'clsx';

import { SectionHeader } from '@/components/ui';
import type { ContractSummary } from '@/lib/db/types';
import { DOC_TYPE_LABELS } from '@/lib/fields';
import { statusDetail } from '@/lib/status';
import { formatShort } from '@/lib/util/dates';
import { displayTitle } from './format';

export interface ExpiringItem {
  row: ContractSummary;
  /** Days until the sooner of the two clocks runs out. Drives the grouping. */
  days: number;
}

/**
 * Either clock can be the reason a record needs attention. An evaluation
 * agreement whose 90-day term has already lapsed can still carry a
 * confidentiality obligation that ends next month, and that is exactly the case
 * a single-status spreadsheet loses.
 */
export function collectExpiring(rows: readonly ContractSummary[]): ExpiringItem[] {
  const items: ExpiringItem[] = [];
  for (const row of rows) {
    const clocks: number[] = [];
    if (row.agreementStatus === 'expiring' && row.daysRemaining !== null) {
      clocks.push(row.daysRemaining);
    }
    if (row.confidentialityStatus === 'expiring' && row.confidentialityDaysRemaining !== null) {
      clocks.push(row.confidentialityDaysRemaining);
    }
    if (clocks.length === 0) continue;
    items.push({ row, days: Math.min(...clocks) });
  }
  return items.sort((a, b) => a.days - b.days);
}

export interface ExpiringListProps {
  items: readonly ExpiringItem[];
  onSelect: (contractId: string) => void;
}

export function ExpiringList({ items, onSelect }: ExpiringListProps) {
  const soon = items.filter((i) => i.days <= 30);
  const later = items.filter((i) => i.days > 30);

  return (
    <div className="flex flex-col gap-[24px]">
      {soon.length > 0 && <Group title="Within 30 days" items={soon} onSelect={onSelect} />}
      {later.length > 0 && <Group title="Within 90 days" items={later} onSelect={onSelect} />}
    </div>
  );
}

function Group({
  title,
  items,
  onSelect,
}: {
  title: string;
  items: readonly ExpiringItem[];
  onSelect: (contractId: string) => void;
}) {
  return (
    <section>
      <SectionHeader as="h2" rule title={title} className="mb-[8px] px-[2px]" />

      {/* One surface for the whole group. The rows are divided by hairlines, not
          by a box each -- a stack of cards is the thing that made this screen
          read as fifteen separate objects. */}
      <ul className="surface sq overflow-clip rounded-card">
        {items.map(({ row }) => (
          <ExpiringRow key={row.id} row={row} onSelect={onSelect} />
        ))}
      </ul>
    </section>
  );
}

/** "Mar 1 2024" when there is a date, the honest sentence when there is not. */
function endsOn(iso: string | null, absent: string): string {
  const formatted = formatShort(iso);
  return formatted.length > 0 ? formatted : absent;
}

function ExpiringRow({
  row,
  onSelect,
}: {
  row: ContractSummary;
  onSelect: (contractId: string) => void;
}) {
  const agreementUrgent = row.agreementStatus === 'expiring';
  const confidentialityUrgent = row.confidentialityStatus === 'expiring';

  return (
    <li className="hairline-b last:border-b-0">
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        className="grid w-full grid-cols-1 items-center gap-[8px] px-[14px] py-[10px] text-left transition-colors duration-[var(--dur-fast)] ease-fast hover:bg-hover sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <span className="block min-w-0">
          <span className="block truncate text-title-3 font-medium text-label">
            {row.counterparty ?? 'Unnamed counterparty'}
          </span>
          {/* The contract's own title when it has one: "Mutual NDA - Mutual
              Nondisclosure Agreement" is the same fact twice. */}
          <span className="mt-[1px] block truncate text-callout text-label-secondary">
            {displayTitle(row.contractName) ?? DOC_TYPE_LABELS[row.docType]}
          </span>
        </span>

        {/* Both clocks, always. A 90-day evaluation agreement can carry a
            five-year duty of confidence, and one status line cannot say so.
            One grid for the pair, so the dates and the counts line up. */}
        <span className="tabular grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-[10px] gap-y-[2px] text-callout sm:w-[330px]">
          <ClockLine
            label="Agreement"
            value={endsOn(row.terminationDate, 'unknown end date')}
            detail={statusDetail({
              status: row.agreementStatus,
              daysRemaining: row.daysRemaining,
            })}
            urgent={agreementUrgent}
          />
          <ClockLine
            label="Confidentiality"
            value={endsOn(row.confidentialityEnd, 'no stated end')}
            detail={
              row.confidentialityEnd === null
                ? 'Still bound'
                : statusDetail({
                    status: row.confidentialityStatus,
                    daysRemaining: row.confidentialityDaysRemaining,
                  })
            }
            urgent={confidentialityUrgent}
          />
        </span>
      </button>
    </li>
  );
}

function ClockLine({
  label,
  value,
  detail,
  urgent,
}: {
  label: string;
  value: string;
  detail: string;
  urgent: boolean;
}) {
  return (
    <>
      <span className="text-right text-label-tertiary">{label}</span>
      <span className="truncate text-label-secondary">{value}</span>
      <span
        className={clsx('text-right', urgent ? 'font-medium text-warn' : 'text-label-tertiary')}
      >
        {detail}
      </span>
    </>
  );
}
