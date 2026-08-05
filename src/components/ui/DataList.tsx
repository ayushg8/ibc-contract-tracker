'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';

export type DataListTone = 'default' | 'quiet' | 'ok' | 'warn' | 'bad' | 'accent';

const TONE: Record<DataListTone, string> = {
  default: 'text-label',
  quiet: 'text-label-tertiary',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  accent: 'text-accent',
};

export interface DataListItem {
  label: ReactNode;
  value: ReactNode;
  /** One quiet line under the value: a unit, a derivation, a caveat. */
  hint?: ReactNode;
  /** Monospace and tabular. For dates, amounts, IDs and file paths. */
  mono?: boolean;
  tone?: DataListTone;
}

export interface DataListProps {
  items: readonly DataListItem[];
  /** px tab stop for the label column. Widen it for long field names. */
  labelWidth?: number;
  className?: string;
}

/**
 * The definition list. This is what a record is made of, and it is the thing
 * that replaces a card per field: labels line up on one tab stop, values carry
 * the weight, and a hairline - not a box - separates one fact from the next.
 */
export function DataList({ items, labelWidth = 132, className }: DataListProps) {
  return (
    <dl className={clsx('min-w-0', className)}>
      {items.map((item, index) => (
        <div
          key={index}
          className={clsx(
            'flex min-w-0 items-baseline gap-[16px] py-[8px]',
            index < items.length - 1 && 'hairline-b',
          )}
        >
          <dt
            className="shrink-0 text-callout text-label-secondary"
            style={{ width: labelWidth }}
          >
            {item.label}
          </dt>
          <dd className="min-w-0 flex-1">
            <div
              className={clsx(
                'text-body',
                TONE[item.tone ?? 'default'],
                item.mono === true && 'tabular font-mono',
              )}
            >
              {item.value}
            </div>
            {item.hint !== undefined && (
              <div className="mt-[2px] text-footnote text-label-tertiary">{item.hint}</div>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
