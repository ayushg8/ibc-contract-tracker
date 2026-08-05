'use client';

import { useId, useState } from 'react';
import clsx from 'clsx';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { motion } from 'motion/react';
import { SPRING_SNAPPY } from './Glass';

const GEOMETRY = {
  sm: { w: 30, h: 18, knob: 14 },
  md: { w: 38, h: 22, knob: 18 },
} as const;

export type SwitchSize = keyof typeof GEOMETRY;

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: SwitchSize;
  /** Rendered to the right and wired to the control. Omit for a bare switch. */
  label?: string;
  /** Required when there is no visible label. */
  ariaLabel?: string;
  id?: string;
  name?: string;
  className?: string;
}

export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  size = 'md',
  label,
  ariaLabel,
  id,
  name,
  className,
}: SwitchProps) {
  const fallbackId = useId();
  const switchId = id ?? fallbackId;
  const [internal, setInternal] = useState(defaultChecked);
  const controlled = checked !== undefined;
  const on = controlled ? checked : internal;
  const { w, h, knob } = GEOMETRY[size];
  const travel = w - knob - 4;

  function handleChange(next: boolean) {
    if (!controlled) setInternal(next);
    onCheckedChange?.(next);
  }

  const control = (
    <SwitchPrimitive.Root
      id={switchId}
      name={name}
      checked={on}
      onCheckedChange={handleChange}
      disabled={disabled}
      aria-label={label === undefined ? ariaLabel : undefined}
      className={clsx(
        'relative inline-flex shrink-0 items-center rounded-full p-[2px] transition-colors duration-[var(--dur-fast)] ease-fast',
        // The off track has to read as a filled track, not as a tint, so it is
        // heavier than the --neutral-quiet wash used for inert bars.
        on ? 'bg-accent' : 'bg-[color-mix(in_srgb,var(--label)_16%,transparent)]',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
      style={{ width: w, height: h }}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          // --label-onaccent, not a raw white: the knob rides the accent track
          // when on, and it is white in both appearances by design.
          className="block rounded-full bg-onaccent shadow-e1"
          style={{ width: knob, height: knob }}
          animate={{ x: on ? travel : 0 }}
          transition={SPRING_SNAPPY}
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );

  if (label === undefined) return control;

  return (
    <div className="flex items-center gap-[8px]">
      {control}
      <label
        htmlFor={switchId}
        className={clsx('select-none text-body', disabled ? 'text-[var(--text-disabled)]' : 'text-label')}
      >
        {label}
      </label>
    </div>
  );
}
