'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import clsx from 'clsx';
import type { Icon } from '@phosphor-icons/react';

import { Tooltip } from '@/components/ui';

export interface NavItemProps {
  /** Omit for an item that only runs an action, e.g. Export. */
  href?: string;
  label: string;
  icon: Icon;
  /** null renders no badge at all, which is not the same as 0. */
  count?: number | null;
  /** Amber badge once the count is above zero, i.e. the count is a to-do. */
  alert?: boolean;
  keys?: readonly string[];
  onSelect?: () => void;
}

/**
 * The source-list row. On white a saturated accent fill behind the selected row
 * is a dark-mode pattern and shouts; the light treatment is an `--accent-quiet`
 * wash with accent text and the glyph flipped to `fill`. That flip is the whole
 * selection signal, so it is not written as a generic Row: Row's selected state
 * is a filled row, and a colour override on it would lose to the hover rule.
 */
export function NavItem({
  href,
  label,
  icon: Glyph,
  count = null,
  alert = false,
  keys,
  onSelect,
}: NavItemProps) {
  const pathname = usePathname();
  const router = useRouter();
  const active = href !== undefined && (pathname === href || pathname.startsWith(`${href}/`));

  // No <Link>, so nothing prefetches on its own; a source-list row that stalls
  // on click is the difference between an app and a website.
  useEffect(() => {
    if (href !== undefined) router.prefetch(href);
  }, [href, router]);

  function select() {
    onSelect?.();
    if (href !== undefined && !active) router.push(href);
  }

  // macOS hides a zero badge rather than drawing it. A "0" next to Inbox is
  // noise; the absence of a badge already says it.
  const showCount = count !== null && !(alert && count === 0);
  const amber = alert && showCount && count > 0;

  const row = (
    <button
      type="button"
      onClick={select}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'sq mx-[8px] flex h-[32px] select-none items-center gap-[8px] rounded-row px-[8px] text-left transition-colors duration-[var(--dur-fast)] ease-fast',
        active ? 'bg-accent-quiet text-accent' : 'text-label-secondary hover:bg-hover',
      )}
    >
      <Glyph size={16} weight={active ? 'fill' : 'regular'} className="shrink-0" />
      <span className={clsx('min-w-0 flex-1 truncate text-body', active && 'font-medium')}>
        {label}
      </span>
      {showCount && (
        <span
          className={clsx(
            'tabular inline-flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full px-[5px] text-footnote font-medium',
            amber ? 'bg-warn-quiet text-warn' : 'bg-neutral-quiet text-label-secondary',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );

  if (keys === undefined) return row;
  return (
    <Tooltip content={label} keys={keys} side="right">
      {row}
    </Tooltip>
  );
}
