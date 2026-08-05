'use client';

import clsx from 'clsx';
import { CheckCircle } from '@phosphor-icons/react';

import type { ModelTier } from '@/lib/db/types';
import { estimateCostUsd, MODELS } from '@/lib/providers/types';

/**
 * A five-page NDA: roughly 8k tokens of text in, 400 tokens of JSON out. Held
 * here as constants so the three cards quote one comparable number instead of
 * three unrelated guesses, and so the price comes from the model table rather
 * than from a hardcoded cent figure that will silently rot.
 */
const TYPICAL_INPUT_TOKENS = 8_000;
const TYPICAL_OUTPUT_TOKENS = 400;

/** Visual encoding only -- the words come from the model's own blurb. */
const SPEED_BARS: Record<ModelTier, number> = { fast: 3, balanced: 2, deep: 1 };

export interface ModelCardProps {
  tier: ModelTier;
  selected: boolean;
  onSelect: (tier: ModelTier) => void;
  disabled?: boolean;
}

/**
 * Three cards rather than a dropdown: the cost/depth trade-off has to be visible
 * at the moment of choosing, not one click behind a popup.
 *
 * The button IS the surface. Wrapping it in a Card would put a bordered box
 * inside a bordered box for no gain, and selection is an accent border over an
 * accent wash rather than a filled tile -- a solid blue card on white buries the
 * price it exists to show.
 */
export function ModelCard({ tier, selected, onSelect, disabled = false }: ModelCardProps) {
  const model = MODELS[tier];
  const cost = estimateCostUsd(tier, TYPICAL_INPUT_TOKENS, TYPICAL_OUTPUT_TOKENS);
  const bars = SPEED_BARS[tier];

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(tier)}
      className={clsx(
        'sq flex h-full w-full flex-col items-start gap-[6px] rounded-card border-[0.5px] px-[12px] py-[10px] text-left shadow-e1 transition-colors duration-[var(--dur-fast)] ease-fast',
        selected ? 'border-accent bg-accent-quiet' : 'border-border bg-surface',
        disabled ? 'text-[var(--text-disabled)]' : !selected && 'hover:border-border-strong',
      )}
    >
      <span className="flex w-full items-center justify-between gap-[6px]">
        <span className="text-title-3 font-semibold text-label">{model.label}</span>
        {selected && <CheckCircle size={16} weight="fill" className="shrink-0 text-accent" />}
      </span>

      <span className="flex items-baseline gap-[4px]">
        <span className="tabular text-title-3 font-semibold text-label">
          {cost === null ? '--' : `$${cost.toFixed(2)}`}
        </span>
        <span className="text-footnote text-label-tertiary">per document</span>
      </span>

      {/* The blurb already names the speed; the bars only have to make the three
          cards comparable at a glance. */}
      <span role="img" aria-label={`Speed ${bars} of 3`} className="flex items-end gap-[2px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={clsx(
              'block w-[4px] rounded-full',
              i < bars ? 'bg-accent' : 'bg-label-quaternary',
            )}
            style={{ height: 4 + i * 3 }}
          />
        ))}
      </span>

      <span className="text-callout text-label-secondary">{model.blurb}</span>
    </button>
  );
}
