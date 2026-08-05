'use client';

import clsx from 'clsx';
import { motion } from 'motion/react';
import { SPRING_SMOOTH } from './Glass';

export type ProgressTone = 'accent' | 'ok' | 'warn' | 'bad';

const TONE: Record<ProgressTone, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

export interface ProgressBarProps {
  /** 0..1. Ignored when indeterminate. */
  value?: number;
  indeterminate?: boolean;
  size?: 'sm' | 'md';
  tone?: ProgressTone;
  label?: string;
  className?: string;
}

export function ProgressBar({
  value = 0,
  indeterminate = false,
  size = 'sm',
  tone = 'accent',
  label,
  className,
}: ProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : pct}
      className={clsx(
        'relative w-full overflow-hidden rounded-full bg-neutral-quiet',
        size === 'sm' ? 'h-[4px]' : 'h-[6px]',
        className,
      )}
    >
      {indeterminate ? (
        <motion.span
          className={clsx('absolute inset-y-0 w-[40%] rounded-full', TONE[tone])}
          animate={{ x: ['-100%', '250%'] }}
          transition={{ repeat: Infinity, duration: 1.15, ease: 'easeInOut' }}
        />
      ) : (
        // Smooth, not snappy: a progress bar that overshoots implies it went
        // backwards, which is a lie about the work.
        <motion.span
          className={clsx('absolute inset-y-0 left-0 rounded-full', TONE[tone])}
          // initial={false}: mount at the real width instead of sweeping up from
          // zero, so a document that is already 60% read does not replay.
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={SPRING_SMOOTH}
        />
      )}
    </div>
  );
}
