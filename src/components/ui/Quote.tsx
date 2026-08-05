'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { CircleDashed, WarningCircle } from '@phosphor-icons/react';

const CLAMP: Record<2 | 3 | 4 | 5, string> = {
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
};

export type QuoteDensity = 'inline' | 'block';

export interface QuoteProps {
  /** The verbatim span from the document. Never paraphrase into this. */
  text: string;
  page?: number;
  /**
   * Three states, and all three are rendered differently.
   *
   *   true  - the wording was found in the document. Nothing is drawn.
   *   false - it was searched for and not found. Amber rule, "unverified".
   *   null  - it was never checked, because there was no text to check against.
   *           Its own quiet marker: not proven, and not disproven either.
   *
   * Collapsing null into true is the one thing this prop must never do. It is
   * how sixteen unchecked guesses off a bad scan came to render pixel-identical
   * to a citation-verified digital NDA.
   */
  verified?: boolean | null;
  /** Jump the PDF pane to this citation and pulse the highlight. */
  onClick?: () => void;
  clamp?: 2 | 3 | 4 | 5 | false;
  /**
   * 'inline' is one clamped line that opens on hover or focus. Use it wherever a
   * screen shows many quotes at once - sixteen expanded quotes are a wall, and
   * evidence must never outweigh the value it supports.
   */
  density?: QuoteDensity;
  className?: string;
}

export function Quote({
  text,
  page,
  verified = true,
  onClick,
  clamp = 3,
  density = 'block',
  className,
}: QuoteProps) {
  const interactive = onClick !== undefined;
  const Comp = interactive ? 'button' : 'div';
  const inline = density === 'inline';

  // Page and provenance ride at the end of the quote, not on a chip row of their
  // own: a second row would give the receipt more space than the value it backs.
  const marker: ReactNode = (
    <>
      {page !== undefined && (
        <span className="tabular ml-[6px] whitespace-nowrap text-footnote text-label-tertiary">
          p.{page}
        </span>
      )}
      {verified === false && (
        <span className="ml-[6px] inline-flex items-center gap-[2px] whitespace-nowrap text-footnote text-warn">
          <WarningCircle size={9} weight="fill" aria-hidden />
          unverified
        </span>
      )}
      {verified === null && (
        <span className="ml-[6px] inline-flex items-center gap-[2px] whitespace-nowrap text-footnote text-label-tertiary">
          <CircleDashed size={9} weight="bold" aria-hidden />
          not checked
        </span>
      )}
    </>
  );

  return (
    <Comp
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      title={
        verified === false
          ? 'This wording was not found verbatim in the document'
          : verified === null
            ? 'This wording was never checked against the document'
            : undefined
      }
      className={clsx(
        'group sq relative block w-full overflow-hidden rounded-row bg-quote-bg py-[5px] pl-[11px] pr-[8px] text-left transition-colors duration-[var(--dur-fast)] ease-fast',
        interactive && 'hover:bg-[color-mix(in_srgb,var(--label)_6%,transparent)]',
        className,
      )}
    >
      {/* The rule is a child, not a border: a 2px border would follow the
          squircle and curve away from the text block at both ends. */}
      <span
        aria-hidden
        className={clsx(
          'absolute left-0 top-0 h-full w-[2px]',
          verified === false
            ? 'bg-warn'
            : verified === null
              ? 'bg-label-quaternary'
              : 'bg-quote-rule',
        )}
      />
      <span className={inline ? 'flex items-baseline' : 'block'}>
        <span
          className={clsx(
            'text-callout text-quote-text',
            inline
              ? 'min-w-0 flex-1 line-clamp-1 group-hover:line-clamp-none group-focus-within:line-clamp-none'
              : clamp !== false && CLAMP[clamp],
          )}
        >
          {'\u201C'}
          {text}
          {'\u201D'}
          {!inline && marker}
        </span>
        {inline && <span className="shrink-0">{marker}</span>}
      </span>
    </Comp>
  );
}
