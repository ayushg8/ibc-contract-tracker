'use client';

import clsx from 'clsx';
import { Pill } from './Pill';
import type { PillSize, PillTone } from './Pill';

export type AgreementStatus = 'active' | 'expiring' | 'expired' | 'unknown';

/**
 * Expired is 'neutral', not 'quiet'. The first build gave it a grey-on-grey
 * hairline chip that vanished on white - a lapsed agreement is a fact the reader
 * has to be able to see across a table, so it gets a real wash.
 */
const TONE: Record<AgreementStatus, PillTone> = {
  active: 'ok',
  expiring: 'warn',
  expired: 'neutral',
  unknown: 'quiet',
};

export interface StatusPillProps {
  status: AgreementStatus;
  /** Days until the agreement lapses. Only read when status is 'expiring'. */
  days?: number;
  /** Overrides the derived text, e.g. for the confidentiality clock. */
  label?: string;
  size?: PillSize;
  className?: string;
}

function textFor(status: AgreementStatus, days: number | undefined): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'expiring':
      if (days === undefined) return 'Expiring';
      return days === 1 ? '1 day' : `${days} days`;
    case 'expired':
      return 'Expired';
    case 'unknown':
      return 'Unknown';
  }
}

export function StatusPill({ status, days, label, size = 'sm', className }: StatusPillProps) {
  const filled = status === 'active' || status === 'expiring';
  const text = label ?? textFor(status, days);
  const dot = (
    <span
      aria-hidden
      className={clsx(
        'block size-[6px] shrink-0 rounded-full',
        filled ? 'bg-current' : 'shadow-[inset_0_0_0_1px_currentColor] opacity-70',
      )}
    />
  );

  return (
    <Pill tone={TONE[status]} size={size} leading={dot} className={className} title={text}>
      {text}
    </Pill>
  );
}
