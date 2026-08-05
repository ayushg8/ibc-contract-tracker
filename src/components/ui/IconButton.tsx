'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { motion } from 'motion/react';
import type { HTMLMotionProps } from 'motion/react';
import { SPRING_SNAPPY } from './Glass';
import { Spinner } from './Spinner';
import { BUTTON_VARIANT } from './Button';
import type { ButtonSize, ButtonVariant } from './Button';

const SIZE: Record<ButtonSize, string> = {
  sm: 'size-[24px]',
  md: 'size-[30px]',
  lg: 'size-[36px]',
};

export interface IconButtonProps extends HTMLMotionProps<'button'> {
  /** Required: an icon-only control has no accessible name of its own. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Toggled-on look for things like a filter or sidebar toggle. */
  active?: boolean;
  children?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    variant = 'ghost',
    size = 'md',
    loading = false,
    active = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const inert = disabled === true || loading;
  const greyed = disabled === true && !loading;

  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={inert}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      aria-busy={loading || undefined}
      whileTap={inert ? undefined : { scale: 0.94 }}
      transition={SPRING_SNAPPY}
      className={clsx(
        'sq relative inline-grid shrink-0 place-items-center rounded-control transition-[background-color,box-shadow,filter,color] duration-[var(--dur-fast)] ease-fast',
        SIZE[size],
        greyed ? 'text-[var(--text-disabled)] shadow-none' : BUTTON_VARIANT[variant],
        // Ghost colour lands here, not in the shared map: an `active` override
        // cannot beat a colour set there, because Tailwind emits .text-label
        // before .text-label-secondary.
        !greyed &&
          variant === 'ghost' &&
          (active ? 'bg-hover text-label' : 'text-label-secondary hover:text-label'),
        inert && 'pointer-events-none',
        className,
      )}
      {...rest}
    >
      <span className={clsx('inline-grid place-items-center', loading && 'invisible')}>
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={size === 'sm' ? 12 : 14} />
        </span>
      )}
    </motion.button>
  );
});
