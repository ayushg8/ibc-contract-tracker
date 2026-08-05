'use client';

import { useState } from 'react';
import clsx from 'clsx';
import * as SliderPrimitive from '@radix-ui/react-slider';

export interface SliderProps {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  /** Fires once on pointer-up / key-up. Use this to persist, not onValueChange. */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  /** Renders evenly spaced tick marks under the track, e.g. Off .. Full. */
  ticks?: number;
  className?: string;
}

export function Slider({
  value,
  defaultValue = 0,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  ariaLabel,
  ticks,
  className,
}: SliderProps) {
  const [internal, setInternal] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : internal;

  return (
    <div className={clsx('w-full', className)}>
      <SliderPrimitive.Root
        value={[current]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        onValueChange={(next) => {
          const first = next[0];
          if (first === undefined) return;
          if (!controlled) setInternal(first);
          onValueChange?.(first);
        }}
        onValueCommit={(next) => {
          const first = next[0];
          if (first !== undefined) onValueCommit?.(first);
        }}
        className={clsx(
          'relative flex h-[20px] w-full touch-none select-none items-center',
          disabled && 'opacity-40',
        )}
      >
        <SliderPrimitive.Track className="relative h-[4px] w-full grow rounded-full bg-neutral-quiet">
          <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block size-[16px] rounded-full bg-onaccent shadow-e2 outline-none" />
      </SliderPrimitive.Root>
      {ticks !== undefined && ticks > 1 && (
        <div aria-hidden className="mt-[2px] flex justify-between px-[7px]">
          {Array.from({ length: ticks }, (_, i) => (
            <span key={i} className="block h-[4px] w-[1px] bg-label-quaternary" />
          ))}
        </div>
      )}
    </div>
  );
}
