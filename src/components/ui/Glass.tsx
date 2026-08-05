'use client';

import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';
import type { Transition } from 'motion/react';

/**
 * SwiftUI spring physics. mass 1, stiffness = (2*PI / 0.5s)^2, damping =
 * 4*PI*(1-bounce)/0.5s.
 *
 * These constants live in this module, not in index.ts, because index.ts
 * imports every component: a component reaching back into the barrel for them
 * would close a module cycle. Glass imports nothing, so it is safe for all.
 *
 * Never pass `visualDuration` alongside these - it zeroes entry velocity, so an
 * interrupted animation restarts from rest instead of redirecting mid-flight.
 * Never use the bouncy damping (17.59): overshoot on a contract record reads as
 * toy software.
 */
export const SPRING_SNAPPY: Transition = {
  type: 'spring',
  stiffness: 157.91,
  damping: 21.36,
  mass: 1,
};

export const SPRING_SMOOTH: Transition = {
  type: 'spring',
  stiffness: 157.91,
  damping: 25.13,
  mass: 1,
};

export type Radius = 'control' | 'row' | 'card' | 'panel' | 'none';

export const RADIUS_CLASS: Record<Radius, string> = {
  control: 'rounded-control',
  row: 'rounded-row',
  card: 'rounded-card',
  panel: 'rounded-panel',
  none: '',
};

export type GlassTag =
  | 'div'
  | 'aside'
  | 'header'
  | 'footer'
  | 'section'
  | 'nav'
  | 'ul'
  | 'form';

export interface GlassProps extends HTMLAttributes<HTMLElement> {
  as?: GlassTag;
  /**
   * 1 = the real material (blur + saturate + brightness).
   * 2 = a second visual depth WITHOUT a second blur. Native vibrancy and
   * backdrop-filter do not stack, so a nested blur costs a compositing pass
   * and renders nothing; tint + a stronger rim fakes the depth for free.
   */
  depth?: 1 | 2;
  radius?: Radius;
  children?: ReactNode;
}

export const Glass = forwardRef<HTMLDivElement, GlassProps>(function Glass(
  { as = 'div', depth = 1, radius = 'panel', className, children, ...rest },
  ref,
) {
  // Narrowing the tag union to one member is what lets the ref stay typed as a
  // concrete element instead of going through `unknown`. Runtime renders `as`.
  const Comp = as as 'div';
  return (
    <Comp
      ref={ref}
      className={clsx(depth === 1 ? 'glass' : 'glass-over', RADIUS_CLASS[radius], className)}
      {...rest}
    >
      {children}
    </Comp>
  );
});

/**
 * The first glass surface mounted in a session pays a one-time filter-graph
 * build. Mount this once at the app root and the hitch lands on an invisible
 * 1x1 pixel instead of on the sidebar.
 */
export function GlassPrewarm() {
  return (
    <div
      aria-hidden
      className="glass pointer-events-none fixed left-0 top-0 size-px opacity-[0.02]"
    />
  );
}
