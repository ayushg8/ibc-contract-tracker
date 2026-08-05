'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { Icon } from '@phosphor-icons/react';

export type StatTone = 'default' | 'ok' | 'warn' | 'bad' | 'accent';

const VALUE_TONE: Record<StatTone, string> = {
  default: 'text-label',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  accent: 'text-accent',
};

export interface StatTileProps {
  /** Eyebrow above the number. Two or three words. */
  label: string;
  value: ReactNode;
  /** One line under the number: the date behind it, or what it counts down to. */
  supporting?: ReactNode;
  tone?: StatTone;
  icon?: Icon;
  className?: string;
}

/**
 * A headline number and what it means. Deliberately draws NO background and NO
 * border: tiles sit side by side inside the one surface a region already owns,
 * divided by a hairline. Boxing each one is how a dashboard turns into rubble.
 */
export function StatTile({
  label,
  value,
  supporting,
  tone = 'default',
  icon: IconGlyph,
  className,
}: StatTileProps) {
  return (
    <div className={clsx('flex min-w-0 flex-col gap-[3px] px-[16px] py-[14px]', className)}>
      <div className="flex items-center gap-[5px]">
        {IconGlyph && (
          <IconGlyph size={11} weight="regular" aria-hidden className="text-label-tertiary" />
        )}
        <span className="eyebrow truncate">{label}</span>
      </div>
      <span
        className={clsx(
          'tabular truncate text-large-title font-semibold',
          VALUE_TONE[tone],
        )}
        style={{ letterSpacing: 'var(--tr-large-title)' }}
      >
        {value}
      </span>
      {supporting !== undefined && (
        <span className="truncate text-callout text-label-secondary">{supporting}</span>
      )}
    </div>
  );
}
