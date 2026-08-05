'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { Icon } from '@phosphor-icons/react';

export interface EmptyStateProps {
  icon?: Icon;
  title: string;
  /** One line. If it needs two, the screen is explaining too much. */
  body?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: IconGlyph, title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-[8px] px-[24px] py-[40px] text-center',
        className,
      )}
    >
      {IconGlyph && <IconGlyph size={32} weight="regular" className="text-label-quaternary" />}
      <p className="text-title-3 font-semibold text-label">{title}</p>
      {body !== undefined && (
        <p className="max-w-[320px] text-callout text-label-secondary">{body}</p>
      )}
      {action !== undefined && <div className="mt-[8px]">{action}</div>}
    </div>
  );
}
