'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface SectionHeaderProps {
  title: string;
  /** Count, action, or disclosure control, right-aligned on the baseline. */
  trailing?: ReactNode;
  /**
   * Draws a hairline from the end of the label to the right edge. This is the
   * grouping device that replaces a box: it fences a region off without adding
   * a second plane, so the surface underneath stays whole.
   */
  rule?: boolean;
  as?: 'h2' | 'h3' | 'div';
  className?: string;
}

export function SectionHeader({
  title,
  trailing,
  rule = false,
  as = 'h3',
  className,
}: SectionHeaderProps) {
  const Heading = as as 'h3';
  return (
    <div className={clsx('flex min-h-[20px] items-center gap-[10px]', className)}>
      <Heading className="eyebrow shrink-0">{title}</Heading>
      {/* Always present so `trailing` sits hard right whether or not the rule
          is drawn - two layouts for one component would drift apart. */}
      <span aria-hidden className={clsx('h-[0.5px] min-w-0 flex-1', rule && 'bg-separator')} />
      {trailing}
    </div>
  );
}
