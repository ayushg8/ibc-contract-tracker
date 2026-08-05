'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface SettingsRowProps {
  label: ReactNode;
  /** The one line under the label that says what the control actually does. */
  description?: ReactNode;
  /** A state dot or spinner ahead of the label. */
  leading?: ReactNode;
  /** Right-aligned control: a Switch, a Segmented, a Button. */
  control?: ReactNode;
  /** Extra content under the description, e.g. an inline editor or a value. */
  children?: ReactNode;
  className?: string;
}

/**
 * The macOS settings row, and the only row shape in this screen. Every group is
 * ONE surface Card with a hairline between its rows -- a card per row was the
 * nesting that made the first build read as a stack of boxes.
 */
export function SettingsRow({
  label,
  description,
  leading,
  control,
  children,
  className,
}: SettingsRowProps) {
  return (
    <div
      className={clsx('flex min-h-[44px] items-start gap-[10px] px-[12px] py-[10px]', className)}
    >
      {leading !== undefined && (
        // Optical: aligns the dot to the cap height of a 13px label rather than
        // to the top of its line box.
        <span className="mt-[4px] flex shrink-0 items-center">{leading}</span>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[1px]">
        <div className="text-body text-label">{label}</div>
        {description !== undefined && (
          <div className="text-callout text-label-secondary">{description}</div>
        )}
        {children}
      </div>
      {control !== undefined && <div className="flex shrink-0 items-center gap-[6px]">{control}</div>}
    </div>
  );
}
