'use client';

import { createContext, forwardRef, useCallback, useContext, useEffect, useRef } from 'react';
import type { ForwardedRef, HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * 'surface' is the raised plane and there is exactly ONE per region.
 * 'sunken' is a well. 'none' groups without drawing anything.
 */
export type CardElevation = 'surface' | 'sunken' | 'none';

const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-[8px]',
  md: 'p-[12px]',
  lg: 'p-[16px]',
};

/**
 * True once a raised plane is open above us. Depth in this system comes from
 * canvas-vs-surface plus a hairline, so a second raised plane inside the first
 * is always a mistake rather than a stronger signal.
 */
const RaisedCtx = createContext(false);

const warned = new Set<string>();

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  as?: 'div' | 'section' | 'ul' | 'li' | 'form';
  padding?: CardPadding;
  elevation?: CardElevation;
  /** shadow-e2 instead of shadow-1. Popovers, not settings groups. */
  elevated?: boolean;
  /** Hairline between direct children - the macOS grouped-list look. */
  divided?: boolean;
  children?: ReactNode;
}

/**
 * The content-layer surface. Never glass: this is where the data tables and the
 * legal text live, and the HIG prohibits Liquid Glass in the content layer.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    as = 'div',
    padding = 'md',
    elevation = 'surface',
    elevated = false,
    divided = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  const Comp = as as 'div';
  const raisedAbove = useContext(RaisedCtx);
  const raised = elevation === 'surface';
  const node = useRef<HTMLDivElement | null>(null);

  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      assign(ref, el);
    },
    [ref],
  );

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!raised || !raisedAbove) return;
    const text = node.current?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 56) ?? '';
    const key = `${text}|${className ?? ''}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(
      `[Card] A raised card is nested inside another raised card: "${text || '(no text)'}"` +
        `${className ? ` (className: ${className})` : ''}. ` +
        'Stacked rounded boxes are the pattern this design system exists to remove. ' +
        'Use elevation="none" to group, elevation="sunken" for a well, or hoist the container.',
    );
  }, [raised, raisedAbove, className]);

  const body = (
    <Comp
      ref={setRefs}
      className={clsx(
        'sq rounded-card',
        raised &&
          (elevated
            ? 'border-[0.5px] border-border bg-surface shadow-e2'
            : 'surface'),
        elevation === 'sunken' && 'bg-sunken',
        divided && 'divide-y-[0.5px] divide-separator',
        PADDING[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </Comp>
  );

  if (!raised) return body;
  return <RaisedCtx.Provider value>{body}</RaisedCtx.Provider>;
});

function assign(ref: ForwardedRef<HTMLDivElement>, el: HTMLDivElement | null) {
  if (typeof ref === 'function') ref(el);
  else if (ref) ref.current = el;
}
