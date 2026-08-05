'use client';

import clsx from 'clsx';

export interface KbdProps {
  /** Glyphs as macOS prints them: command, shift, then the key. */
  keys: readonly string[];
  /**
   * 'bare' matches a macOS menu, which prints the glyphs with no chrome at all.
   * 'chip' is for docs and onboarding, where the keys need to read as objects.
   */
  variant?: 'bare' | 'chip';
  className?: string;
}

export function Kbd({ keys, variant = 'bare', className }: KbdProps) {
  return (
    <kbd
      className={clsx(
        'inline-flex items-center font-ui not-italic',
        variant === 'bare' ? 'gap-[1px] text-label-tertiary' : 'gap-[3px]',
        className,
      )}
    >
      {keys.map((k, i) => (
        <span
          key={`${k}-${i}`}
          // 22px keeps --r-control (11px) at exactly half the height, which is
          // the ceiling the squircle correction allows.
          className={
            variant === 'chip'
              ? 'sq grid h-[22px] min-w-[22px] place-items-center rounded-control bg-sunken px-[5px] text-callout text-label-secondary shadow-[inset_0_0_0_0.5px_var(--separator)]'
              : undefined
          }
        >
          {k}
        </span>
      ))}
    </kbd>
  );
}
