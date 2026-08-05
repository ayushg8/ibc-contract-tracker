'use client';

import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import clsx from 'clsx';
import { motion } from 'motion/react';
import type { Icon } from '@phosphor-icons/react';
import { SPRING_SNAPPY } from './Glass';

export type SegmentedSize = 'sm' | 'md';

const TRACK: Record<SegmentedSize, string> = {
  sm: 'h-[26px]',
  md: 'h-[30px]',
};

const SEGMENT: Record<SegmentedSize, string> = {
  sm: 'h-[22px] gap-[4px] px-[8px] text-callout',
  md: 'h-[26px] gap-[5px] px-[10px] text-body',
};

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: Icon;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: SegmentedSize;
  fullWidth?: boolean;
  className?: string;
}

/**
 * The macOS segmented control. The thumb is one motion.div carried between
 * segments by layoutId, so it SLIDES; a cross-fade between per-segment
 * backgrounds is the tell that a segmented control was faked.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  fullWidth = false,
  className,
}: SegmentedProps<T>) {
  const thumbId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function move(from: number, direction: 1 | -1) {
    const count = options.length;
    for (let step = 1; step <= count; step += 1) {
      const index = (from + direction * step + count * count) % count;
      const option = options[index];
      if (option && option.disabled !== true) {
        onChange(option.value);
        buttons.current[index]?.focus();
        return;
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        move(-1, 1);
        break;
      case 'End':
        event.preventDefault();
        move(options.length, -1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={clsx(
        // A recessed groove carrying a raised thumb - the macOS pattern. The
        // track is the sunken plane and the thumb is the surface plane, which is
        // the same two-plane rule the whole app runs on, at control scale.
        'sq items-center gap-[2px] rounded-control p-[2px]',
        'bg-sunken shadow-[inset_0_0_0_0.5px_var(--separator)]',
        TRACK[size],
        // Conditional rather than an override: .flex and .inline-flex are the
        // same utility group, so class order in the file would not decide it.
        fullWidth ? 'flex w-full' : 'inline-flex',
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        const IconGlyph = option.icon;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={clsx(
              'sq relative inline-flex flex-1 select-none items-center justify-center whitespace-nowrap rounded-control font-medium transition-colors duration-[var(--dur-fast)] ease-fast',
              SEGMENT[size],
              active ? 'text-label' : 'text-label-secondary hover:text-label',
              option.disabled === true && 'pointer-events-none text-[var(--text-disabled)]',
            )}
          >
            {active && (
              <motion.span
                layoutId={thumbId}
                transition={SPRING_SNAPPY}
                aria-hidden
                className="sq absolute inset-0 rounded-control bg-surface shadow-e1"
              />
            )}
            <span className="relative z-[1] inline-flex items-center gap-[5px]">
              {IconGlyph && (
                // regular -> fill on selection. One of the highest-value
                // details in the whole design; do not swap it for a colour change.
                <IconGlyph size={size === 'sm' ? 13 : 14} weight={active ? 'fill' : 'regular'} />
              )}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
