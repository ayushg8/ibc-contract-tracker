'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from '@phosphor-icons/react';

export type CheckedState = boolean | 'indeterminate';

export interface CheckboxProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
  disabled?: boolean;
  label?: ReactNode;
  /** Required when there is no visible label. */
  ariaLabel?: string;
  id?: string;
  name?: string;
  className?: string;
}

export function Checkbox({
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  label,
  ariaLabel,
  id,
  name,
  className,
}: CheckboxProps) {
  const fallbackId = useId();
  const boxId = id ?? fallbackId;
  const [internal, setInternal] = useState<CheckedState>(defaultChecked);
  const controlled = checked !== undefined;
  const state = controlled ? checked : internal;
  const filled = state === true || state === 'indeterminate';

  const box = (
    <CheckboxPrimitive.Root
      id={boxId}
      name={name}
      checked={state}
      disabled={disabled}
      aria-label={label === undefined ? ariaLabel : undefined}
      onCheckedChange={(next) => {
        if (!controlled) setInternal(next);
        onCheckedChange?.(next);
      }}
      className={clsx(
        // rounded-sm (4px) rather than --r-control: at 14px the control radius
        // would exceed half the box and collapse the square into a lozenge.
        'sq grid size-[14px] shrink-0 place-items-center rounded-sm transition-colors duration-[var(--dur-fast)] ease-fast',
        filled
          ? 'bg-accent text-accent-fg'
          : 'bg-surface shadow-[inset_0_0_0_1px_var(--border-strong)]',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        {state === 'indeterminate' ? (
          <Minus size={10} weight="bold" />
        ) : (
          <Check size={10} weight="bold" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );

  if (label === undefined) return box;

  return (
    <div className="flex items-center gap-[6px]">
      {box}
      <label
        htmlFor={boxId}
        className={clsx(
          'select-none text-body',
          disabled ? 'text-[var(--text-disabled)]' : 'text-label',
        )}
      >
        {label}
      </label>
    </div>
  );
}
