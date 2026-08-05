'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Archive,
  Copy,
  DownloadSimple,
  GearSix,
  MagnifyingGlass,
  TestTube,
  Tray,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

import clsx from 'clsx';

import { Kbd, SectionHeader, Spinner, StatusPill, useToast } from '@/components/ui';
import { api, copySupportBundle, downloadExport } from '@/lib/client/api';
import { DOC_TYPE_LABELS } from '@/lib/fields';
import { refreshStats } from '@/lib/client/useStats';
import { closePalette, KEY, usePaletteOpen, usePaletteSearch } from './usePalette';

interface PaletteItem {
  id: string;
  section: 'Contracts' | 'Actions';
  label: string;
  sublabel?: string;
  icon?: Icon;
  trailing?: ReactNode;
  run: () => void;
}

/**
 * Cmd+K. For a salesperson the fastest question is "are we clear to talk to
 * these people", so a contract row answers it in place -- counterparty plus
 * status, no navigation required.
 */
export function CommandPalette() {
  const open = usePaletteOpen();
  const router = useRouter();
  const { toast, dismiss } = useToast();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const search = usePaletteSearch(query, open);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const actions = useMemo<PaletteItem[]>(
    () => [
      {
        id: 'action:export',
        section: 'Actions',
        label: 'Export to Excel',
        sublabel: 'NDA and Eval Agmt sheets',
        icon: DownloadSimple,
        run: () => {
          void downloadExport().then((result) => {
            toast(
              result.error !== undefined
                ? { title: result.error.message, tone: 'bad' }
                : { title: `Saved ${result.data.filename}`, tone: 'ok' },
            );
          });
        },
      },
      {
        id: 'action:inbox',
        section: 'Actions',
        label: 'Open Inbox',
        icon: Tray,
        run: () => router.push('/inbox'),
      },
      {
        id: 'action:repository',
        section: 'Actions',
        label: 'Open Repository',
        icon: Archive,
        run: () => router.push('/repository'),
      },
      {
        id: 'action:settings',
        section: 'Actions',
        label: 'Open Settings',
        icon: GearSix,
        run: () => router.push('/settings'),
      },
      {
        id: 'action:selftest',
        section: 'Actions',
        label: 'Run test extraction',
        sublabel: 'Proves the whole path works',
        icon: TestTube,
        run: () => {
          const pending = toast({ title: 'Running a test extraction...', duration: 0 });
          void api.testEngine().then((result) => {
            dismiss(pending);
            if (result.error !== undefined) {
              toast({ title: result.error.message, tone: 'bad' });
            } else if (result.data.ok) {
              toast({
                title: `Engine works. ${result.data.fieldsFound} of ${result.data.fieldsTotal} fields found.`,
                description: `${Math.round(result.data.durationMs / 100) / 10}s`,
                tone: 'ok',
              });
            } else {
              toast({
                title: result.data.error?.message ?? 'The test extraction did not finish.',
                tone: 'bad',
              });
            }
            refreshStats();
          });
        },
      },
      {
        id: 'action:support',
        section: 'Actions',
        label: 'Copy support bundle',
        sublabel: 'Redacted diagnostics, for email',
        icon: Copy,
        run: () => {
          void copySupportBundle().then((result) => {
            toast(
              result.error !== undefined
                ? { title: result.error.message, tone: 'bad' }
                : { title: 'Support details copied.', tone: 'ok' },
            );
          });
        },
      },
    ],
    [dismiss, router, toast],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const needle = query.trim().toLowerCase();
    const contracts: PaletteItem[] = search.rows.map((row) => ({
      id: `contract:${row.id}`,
      section: 'Contracts',
      label: row.counterparty ?? row.contractName ?? 'Untitled agreement',
      sublabel: [DOC_TYPE_LABELS[row.docType], row.contractName]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' \u00b7 '),
      trailing: (
        <StatusPill
          status={row.agreementStatus}
          days={row.daysRemaining ?? undefined}
        />
      ),
      run: () => router.push(`/repository?contract=${row.id}`),
    }));

    const matching =
      needle.length === 0
        ? actions
        : actions.filter((a) => a.label.toLowerCase().includes(needle));

    return [...contracts, ...matching];
  }, [actions, query, router, search.rows]);

  // The list changes under the cursor as results arrive; anchoring to the top is
  // the only honest place to be.
  useEffect(() => {
    setActive(0);
  }, [items.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, items.length]);

  function runItem(item: PaletteItem | undefined) {
    if (item === undefined) return;
    closePalette();
    item.run();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(items.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runItem(items[active]);
    }
  }

  let lastSection: PaletteItem['section'] | null = null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : closePalette())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[45] bg-[color-mix(in_srgb,var(--label)_10%,transparent)]" />
        {/* glass-over, not glass: the palette floats above the sidebar, which is
            already blurring the desktop, and a second backdrop-filter pass buys
            a compositing layer and renders nothing. */}
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className="glass-over sq fixed left-1/2 top-[20vh] z-[46] flex max-h-[60vh] w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-panel"
        >
          <Dialog.Title className="sr-only">Search contracts and actions</Dialog.Title>

          <div className="flex h-[52px] shrink-0 items-center gap-[10px] px-[16px]">
            <MagnifyingGlass size={18} className="shrink-0 text-label-tertiary" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contracts, or type a command"
              aria-label="Search contracts and actions"
              spellCheck={false}
              autoComplete="off"
              className="h-[24px] min-w-0 flex-1 bg-transparent text-title-3 text-label outline-none placeholder:text-label-tertiary"
            />
            {search.loading && <Spinner size={14} className="text-label-tertiary" />}
          </div>

          <div
            ref={listRef}
            className="hairline-t min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[6px]"
          >
            {items.length === 0 && !search.loading && (
              <p className="px-[16px] py-[20px] text-center text-callout text-label-secondary">
                {search.error !== null ? search.error.message : 'Nothing matches that.'}
              </p>
            )}
            {items.map((item, index) => {
              const header = item.section !== lastSection ? item.section : null;
              lastSection = item.section;
              const Glyph = item.icon;
              const highlighted = index === active;
              return (
                <div key={item.id}>
                  {header !== null && (
                    <SectionHeader title={header} className="px-[16px] pb-[2px] pt-[10px]" />
                  )}
                  {/* The highlight follows the keyboard, so it is a cursor rather
                      than a selection: an accent wash, never a filled row. */}
                  <button
                    type="button"
                    data-active={highlighted}
                    onClick={() => runItem(item)}
                    onMouseMove={() => setActive(index)}
                    className={clsx(
                      'sq mx-[8px] flex h-[44px] w-[calc(100%-16px)] select-none items-center gap-[8px] rounded-row px-[10px] text-left transition-colors duration-[var(--dur-fast)] ease-fast',
                      highlighted && 'bg-accent-quiet',
                    )}
                  >
                    {Glyph !== undefined && (
                      <Glyph
                        size={16}
                        weight={highlighted ? 'fill' : 'regular'}
                        className={clsx(
                          'shrink-0',
                          highlighted ? 'text-accent' : 'text-label-secondary',
                        )}
                      />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col justify-center">
                      <span className="truncate text-body text-label">{item.label}</span>
                      {item.sublabel !== undefined && (
                        <span className="truncate text-callout text-label-secondary">
                          {item.sublabel}
                        </span>
                      )}
                    </span>
                    {item.trailing}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="hairline-t flex h-[30px] shrink-0 items-center gap-[14px] px-[16px] text-footnote text-label-tertiary">
            <span className="flex items-center gap-[4px]">
              <Kbd keys={[KEY.up, KEY.down]} />
              Move
            </span>
            <span className="flex items-center gap-[4px]">
              <Kbd keys={[KEY.enter]} />
              Open
            </span>
            <span className="flex items-center gap-[4px]">
              <Kbd keys={[KEY.escape]} />
              Close
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
