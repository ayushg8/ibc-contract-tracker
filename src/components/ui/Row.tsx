'use client';

import { forwardRef } from 'react';
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import clsx from 'clsx';

export type RowSize = 'sm' | 'md';

const SIZE: Record<RowSize, string> = {
  sm: 'h-[32px] px-[8px]',
  md: 'h-[44px] px-[10px]',
};

export interface RowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  as?: 'div' | 'li';
  size?: RowSize;
  selected?: boolean;
  /**
   * The AppKit "inactive window" selection: same row, desaturated fill. Use it
   * when the list is not the focused pane.
   */
  unemphasized?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}

export const Row = forwardRef<HTMLDivElement, RowProps>(function Row(
  {
    as = 'div',
    size = 'md',
    selected = false,
    unemphasized = false,
    disabled = false,
    leading,
    trailing,
    title,
    subtitle,
    className,
    children,
    onClick,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const Comp = as as 'div';
  const clickable = onClick !== undefined && !disabled;
  const emphasized = selected && !unemphasized;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (!clickable || event.defaultPrevented) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.currentTarget.click();
    }
  }

  return (
    <Comp
      ref={ref}
      // The radius rides on the row itself so the hover highlight is a squircle
      // pill inset from the pane edge, the way a macOS source list draws it.
      //
      // Selection is a 10% accent wash with accent text, not a saturated fill.
      // A solid blue bar is an AppKit dark-mode habit; on white it stamps a
      // billboard into the middle of a quiet list.
      className={clsx(
        'sq relative flex select-none items-center gap-[8px] rounded-row transition-colors duration-[var(--dur-fast)] ease-fast',
        SIZE[size],
        clickable && !selected && 'hover:bg-hover active:bg-active',
        emphasized && 'bg-accent-quiet text-accent',
        selected && unemphasized && 'bg-neutral-quiet text-label',
        disabled && 'text-[var(--text-disabled)]',
        className,
      )}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      // aria-current, not aria-selected: ARIA prohibits aria-selected on
      // role=button, and Row does not own the listbox container that would
      // make role=option legal.
      aria-current={selected ? true : undefined}
      data-selected={selected ? '' : undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {leading}
      {children ?? (
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          {title !== undefined && (
            <span className={clsx('truncate text-body', emphasized && 'font-medium')}>
              {title}
            </span>
          )}
          {subtitle !== undefined && (
            <span
              className={clsx(
                'truncate text-callout',
                emphasized ? 'text-accent/70' : 'text-label-secondary',
              )}
            >
              {subtitle}
            </span>
          )}
        </span>
      )}
      {trailing}
    </Comp>
  );
});
