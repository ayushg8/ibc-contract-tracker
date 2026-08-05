'use client';

import clsx from 'clsx';
import type { Confidence } from '@/lib/fields';

const FILL: Record<Confidence, string> = {
  high: 'bg-ok-mark',
  medium: 'bg-warn-mark',
  // Hollow, not filled: red/orange is the commonest colour-blindness confusion,
  // so 'nothing found' is distinguished by shape as well as hue.
  none: 'bg-transparent shadow-[inset_0_0_0_2px_var(--bad-mark)]',
};

const DEFAULT_LABEL: Record<Confidence, string> = {
  high: 'Verified',
  medium: 'Needs a check',
  none: 'Not found',
};

export interface DotProps {
  confidence: Confidence;
  /** Overrides the accessible name and the native tooltip. */
  label?: string;
  /**
   * Low-emphasis rendering for read-only contexts. On an approved record the
   * confidence of each field is settled history, not an open question - so it
   * either recedes or, better, the caller drops the dot entirely.
   */
  muted?: boolean;
  className?: string;
}

/**
 * The confidence indicator. Deliberately static: a pulsing status light reads
 * as "something is happening" when the truth is "this value is settled".
 */
export function Dot({ confidence, label, muted = false, className }: DotProps) {
  const name = label ?? DEFAULT_LABEL[confidence];
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={clsx(
        'inline-block size-[7px] shrink-0 rounded-full',
        'shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--label)_14%,transparent)]',
        FILL[confidence],
        muted && 'opacity-40',
        className,
      )}
    />
  );
}
