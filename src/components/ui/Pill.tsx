'use client';

import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export type PillTone = 'neutral' | 'quiet' | 'accent' | 'ok' | 'warn' | 'bad';
export type PillSize = 'sm' | 'md';

/**
 * Wash background, solid colour as text. The light palette already uses Apple's
 * accessible status variants, so the raw token is legible at label size and the
 * old mix-toward-label trick is not needed - it only muddied the hue.
 */
const TONE: Record<PillTone, string> = {
  neutral: 'bg-neutral-quiet text-neutral',
  quiet: 'text-label-tertiary shadow-[inset_0_0_0_0.5px_var(--separator)]',
  accent: 'bg-accent-quiet text-accent',
  ok: 'bg-ok-quiet text-ok',
  warn: 'bg-warn-quiet text-warn',
  bad: 'bg-bad-quiet text-bad',
};

const SIZE: Record<PillSize, string> = {
  sm: 'h-[16px] gap-[3px] px-[5px] text-footnote',
  md: 'h-[20px] gap-[4px] px-[7px] text-subhead',
};

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  size?: PillSize;
  leading?: ReactNode;
  mono?: boolean;
  children?: ReactNode;
}

/**
 * Capsule, not squircle. A superellipse at 50% radius flattens the ends and
 * stops reading as an Apple badge; the capsule is the correct shape here.
 */
export const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  { tone = 'neutral', size = 'sm', leading, mono, className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={clsx(
        'tabular inline-flex shrink-0 items-center rounded-full font-medium',
        SIZE[size],
        mono && 'font-mono',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
    </span>
  );
});
