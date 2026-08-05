'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { motion } from 'motion/react';
import type { HTMLMotionProps } from 'motion/react';
import { SPRING_SNAPPY } from './Glass';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-[24px] px-[8px] text-callout',
  md: 'h-[30px] px-[12px] text-body',
  lg: 'h-[36px] px-[16px] text-body',
};

const GAP: Record<ButtonSize, string> = {
  sm: 'gap-[4px]',
  md: 'gap-[6px]',
  lg: 'gap-[6px]',
};

/**
 * Shared with IconButton so the two families cannot drift.
 *
 * Secondary is white with a hairline, NOT a grey fill: on a white surface a grey
 * button is the loudest thing on screen, and it is the wrong hierarchy for a
 * control that is by definition the second choice.
 */
export const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg shadow-e1 hover:bg-accent-hover active:bg-accent-active',
  // brightness() rather than a second colour token: there is no --bad-hover, and
  // a hand-picked shade would drift from the accessible variant.
  destructive: 'bg-bad text-accent-fg shadow-e1 hover:brightness-[1.06] active:brightness-[0.94]',
  secondary:
    'bg-surface text-label shadow-[inset_0_0_0_0.5px_var(--border),var(--shadow-1)] hover:bg-[color-mix(in_srgb,var(--label)_4%,var(--surface))]',
  // No text colour on purpose. Tailwind emits .text-accent before .text-label,
  // so a variant colour here would silently beat a caller's className override.
  // Ghost inherits --label from the document and stays overridable.
  ghost: 'hover:bg-hover active:bg-active',
};

export interface ButtonProps extends HTMLMotionProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Swaps the label for a spinner while holding the measured width. */
  loading?: boolean;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    trailingIcon,
    fullWidth,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const inert = disabled === true || loading;
  // Disabled LOOKS greyed; loading does not - it is a busy state, not a dead one.
  const greyed = disabled === true && !loading;

  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={inert}
      aria-busy={loading || undefined}
      whileTap={inert ? undefined : { scale: 0.97 }}
      transition={SPRING_SNAPPY}
      className={clsx(
        'sq relative inline-flex select-none items-center justify-center whitespace-nowrap rounded-control font-medium transition-[background-color,box-shadow,filter] duration-[var(--dur-fast)] ease-fast',
        SIZE[size],
        fullWidth && 'w-full',
        greyed
          ? 'bg-sunken text-[var(--text-disabled)] shadow-none'
          : BUTTON_VARIANT[variant],
        inert && 'pointer-events-none',
        className,
      )}
      {...rest}
    >
      <span className={clsx('inline-flex items-center', GAP[size], loading && 'invisible')}>
        {icon}
        {children}
        {trailingIcon}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner
            size={size === 'sm' ? 12 : 14}
            className={variant === 'primary' || variant === 'destructive' ? 'text-accent-fg' : undefined}
          />
        </span>
      )}
    </motion.button>
  );
});
