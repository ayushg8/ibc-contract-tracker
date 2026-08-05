'use client';

import { createContext, useContext, useId, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { motion } from 'motion/react';
import type { Icon } from '@phosphor-icons/react';
import { SPRING_SNAPPY } from './Glass';

export type TabsVariant = 'toolbar' | 'underline';

interface TabsContextValue {
  value: string;
  variant: TabsVariant;
  indicatorId: string;
}

const TabsCtx = createContext<TabsContextValue | null>(null);

function useTabsCtx(component: string): TabsContextValue {
  const ctx = useContext(TabsCtx);
  if (!ctx) throw new Error(`${component} must be rendered inside <Tabs>`);
  return ctx;
}

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** 'toolbar' is the Settings icon bar; 'underline' is an inline pane switch. */
  variant?: TabsVariant;
  className?: string;
  children: ReactNode;
}

export function Tabs({
  value,
  defaultValue = '',
  onValueChange,
  variant = 'toolbar',
  className,
  children,
}: TabsProps) {
  const indicatorId = useId();
  const [internal, setInternal] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : internal;

  return (
    <TabsCtx.Provider value={{ value: current, variant, indicatorId }}>
      <TabsPrimitive.Root
        value={current}
        onValueChange={(next) => {
          if (!controlled) setInternal(next);
          onValueChange?.(next);
        }}
        className={clsx('flex min-h-0 flex-col', className)}
      >
        {children}
      </TabsPrimitive.Root>
    </TabsCtx.Provider>
  );
}

export interface TabsListProps {
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

export function TabsList({ ariaLabel, className, children }: TabsListProps) {
  const { variant } = useTabsCtx('TabsList');
  return (
    <TabsPrimitive.List
      aria-label={ariaLabel}
      className={clsx(
        'flex shrink-0 items-center',
        variant === 'toolbar' ? 'gap-[2px]' : 'gap-[14px] hairline-b',
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export interface TabsTriggerProps {
  value: string;
  label: string;
  icon?: Icon;
  disabled?: boolean;
  className?: string;
}

export function TabsTrigger({ value, label, icon: IconGlyph, disabled, className }: TabsTriggerProps) {
  const { value: current, variant, indicatorId } = useTabsCtx('TabsTrigger');
  const active = current === value;

  return (
    <TabsPrimitive.Trigger
      value={value}
      disabled={disabled}
      className={clsx(
        'sq relative inline-flex select-none items-center justify-center rounded-control transition-colors duration-[var(--dur-fast)] ease-fast',
        variant === 'toolbar'
          ? 'h-[44px] min-w-[56px] flex-col gap-[2px] px-[10px] text-footnote'
          : 'h-[30px] gap-[5px] px-[2px] text-body font-medium',
        active ? 'text-label' : 'text-label-secondary hover:text-label',
        disabled === true && 'pointer-events-none text-[var(--text-disabled)]',
        className,
      )}
    >
      {active && variant === 'toolbar' && (
        <motion.span
          layoutId={indicatorId}
          transition={SPRING_SNAPPY}
          aria-hidden
          className="sq absolute inset-0 rounded-control bg-hover"
        />
      )}
      {active && variant === 'underline' && (
        <motion.span
          layoutId={indicatorId}
          transition={SPRING_SNAPPY}
          aria-hidden
          className="absolute -bottom-[0.5px] left-0 h-[2px] w-full rounded-full bg-accent"
        />
      )}
      <span
        className={clsx(
          'relative z-[1] inline-flex items-center',
          variant === 'toolbar' ? 'flex-col gap-[2px]' : 'gap-[5px]',
        )}
      >
        {IconGlyph && (
          <IconGlyph
            size={variant === 'toolbar' ? 18 : 14}
            weight={active ? 'fill' : 'regular'}
          />
        )}
        {label}
      </span>
    </TabsPrimitive.Trigger>
  );
}

export interface TabsContentProps {
  value: string;
  className?: string;
  children: ReactNode;
}

export function TabsContent({ value, className, children }: TabsContentProps) {
  return (
    <TabsPrimitive.Content
      value={value}
      className={clsx('min-h-0 flex-1 focus-visible:shadow-none', className)}
    >
      {children}
    </TabsPrimitive.Content>
  );
}
