'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Kbd } from './Kbd';

export interface TooltipProviderProps {
  children: ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}

/**
 * Optional at the app root. Tooltip already carries its own provider so a screen
 * cannot crash by forgetting this; mount it anyway to share the skip-delay
 * window across a whole toolbar.
 */
export function TooltipProvider({
  children,
  delayDuration = 500,
  skipDelayDuration = 200,
}: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
    >
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** Shortcut glyphs shown after the text, rendered through Kbd. */
  keys?: readonly string[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  /** Skips the tooltip entirely - for when the label is already visible. */
  disabled?: boolean;
  children: ReactNode;
}

export function Tooltip({
  content,
  keys,
  side = 'top',
  align = 'center',
  delayDuration = 500,
  disabled = false,
  children,
}: TooltipProps) {
  if (disabled) return <>{children}</>;

  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={clsx(
              // 22px tall keeps --r-control at exactly half the height.
              'glass sq z-50 flex h-[22px] items-center gap-[6px] rounded-control px-[8px] text-subhead text-label',
            )}
          >
            {content}
            {keys !== undefined && <Kbd keys={keys} />}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
