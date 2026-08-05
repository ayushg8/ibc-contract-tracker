'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { motion } from 'motion/react';
import { Check } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { Kbd } from './Kbd';
import { SPRING_SNAPPY } from './Glass';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

const ITEM_BASE =
  'sq relative flex h-[26px] cursor-default select-none items-center gap-[8px] rounded-control px-[8px] text-body outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:pointer-events-none data-[disabled]:text-[var(--text-disabled)]';

export interface MenuContentProps {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  minWidth?: number;
  className?: string;
}

export function MenuContent({
  children,
  align = 'start',
  side = 'bottom',
  minWidth = 180,
  className,
}: MenuContentProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align={align} side={side} sideOffset={5} collisionPadding={8} asChild>
        {/* No exit animation on purpose: a macOS menu vanishes on selection.
            Animating it out delays the feedback from the thing you just picked. */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={SPRING_SNAPPY}
          style={{ transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)' }}
          className={clsx('glass sq z-50 rounded-card p-[4px]', className)}
        >
          <div style={{ minWidth }}>{children}</div>
        </motion.div>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: Icon;
  keys?: readonly string[];
  disabled?: boolean;
  destructive?: boolean;
  className?: string;
}

export function MenuItem({
  children,
  onSelect,
  icon: IconGlyph,
  keys,
  disabled,
  destructive = false,
  className,
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(ITEM_BASE, destructive ? 'text-bad' : 'text-label', className)}
    >
      {IconGlyph && <IconGlyph size={14} weight="regular" className="shrink-0" />}
      <span className="flex-1 truncate">{children}</span>
      {keys !== undefined && <Kbd keys={keys} className="opacity-70" />}
    </DropdownMenu.Item>
  );
}

export interface MenuCheckboxItemProps {
  children: ReactNode;
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}

export function MenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
  disabled,
}: MenuCheckboxItemProps) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={clsx(ITEM_BASE, 'pl-[6px] text-label')}
    >
      <span className="grid size-[14px] shrink-0 place-items-center">
        <DropdownMenu.ItemIndicator>
          <Check size={12} weight="bold" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="flex-1 truncate">{children}</span>
    </DropdownMenu.CheckboxItem>
  );
}

export interface MenuRadioItemProps {
  children: ReactNode;
  value: string;
  disabled?: boolean;
}

export function MenuRadioItem({ children, value, disabled }: MenuRadioItemProps) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      disabled={disabled}
      className={clsx(ITEM_BASE, 'pl-[6px] text-label')}
    >
      <span className="grid size-[14px] shrink-0 place-items-center">
        <DropdownMenu.ItemIndicator>
          <Check size={12} weight="bold" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="flex-1 truncate">{children}</span>
    </DropdownMenu.RadioItem>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-[4px] h-[0.5px] bg-separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="eyebrow px-[8px] pb-[2px] pt-[4px]">
      {children}
    </DropdownMenu.Label>
  );
}
