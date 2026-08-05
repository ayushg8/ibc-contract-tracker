'use client';

import { createContext, useContext } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Harmless in a browser, correct the day this is wrapped in a native window:
 * the top strip drags the window and the controls inside it do not.
 */
export const DRAG_REGION = { WebkitAppRegion: 'drag' } as CSSProperties;
export const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

/**
 * The right-hand action slot. AppFrame owns the element; a screen fills it with
 * <TitlebarActions> from anywhere in its tree, so page controls sit in the
 * window chrome without the shell having to know what any screen needs.
 */
const SlotContext = createContext<HTMLElement | null>(null);

export const TitlebarSlotProvider = SlotContext.Provider;

export function TitlebarActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  if (slot === null) return null;
  return createPortal(children, slot);
}

export interface TitlebarProps {
  title: string;
  /** Second line of context, e.g. a filename. Optional by design. */
  subtitle?: string;
  /** Ref callback for the action slot. AppFrame passes it; screens do not. */
  slotRef?: (el: HTMLDivElement | null) => void;
  children?: ReactNode;
}

export function Titlebar({ title, subtitle, slotRef, children }: TitlebarProps) {
  return (
    <header
      className="hairline-b flex h-[52px] shrink-0 items-center gap-[12px] px-[16px]"
      style={DRAG_REGION}
    >
      <div className="flex min-w-0 flex-col justify-center">
        <h1 className="truncate text-title-3 font-semibold text-label">{title}</h1>
        {subtitle !== undefined && (
          <span className="truncate text-callout text-label-secondary">{subtitle}</span>
        )}
      </div>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-[8px]" style={NO_DRAG} ref={slotRef}>
        {children}
      </div>
    </header>
  );
}
