'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { GlassPrewarm, ToastProvider, TooltipProvider, useToast } from '@/components/ui';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { openPalette, togglePalette } from '@/components/palette/usePalette';
import { downloadExport } from '@/lib/client/api';
import { HaltBanner } from './HaltBanner';
import { Sidebar } from './Sidebar';
import { Titlebar, TitlebarSlotProvider } from './Titlebar';

const APP_NAME = 'IBC Contracts';

/** Longest prefix wins, so /review keeps its own title under /inbox's shortcut. */
const SECTIONS: readonly { prefix: string; title: string }[] = [
  { prefix: '/inbox', title: 'Inbox' },
  { prefix: '/review', title: 'Review' },
  { prefix: '/repository', title: 'Repository' },
  { prefix: '/expiring', title: 'Expiring' },
  { prefix: '/settings', title: 'Settings' },
];

function sectionTitle(pathname: string): string {
  return SECTIONS.find((s) => pathname === s.prefix || pathname.startsWith(`${s.prefix}/`))?.title
    ?? 'Inbox';
}

/**
 * A shortcut that fires while she is typing a party name is a bug, not a
 * feature: every one of these is suppressed inside a text field.
 */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/** Screens tag their search field with this so Cmd+F knows where to go. */
const SEARCH_SELECTOR = '[data-app-search]';

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { toast, dismiss } = useToast();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const title = sectionTitle(pathname);

  useEffect(() => {
    document.title = `${title} \u00b7 ${APP_NAME}`;
  }, [title]);

  const runExport = useCallback(() => {
    const pending = toast({ title: 'Building the workbook...', duration: 0 });
    void downloadExport().then((result) => {
      dismiss(pending);
      if (result.error !== undefined) {
        toast({ title: result.error.message, tone: 'bad' });
      } else {
        toast({ title: `Saved ${result.data.filename}`, tone: 'ok' });
      }
    });
  }, [dismiss, toast]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      if (typing(event.target)) return;
      const key = event.key.toLowerCase();

      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        togglePalette();
        return;
      }
      if (key === 'f' && !event.shiftKey) {
        event.preventDefault();
        const field = document.querySelector(SEARCH_SELECTOR);
        // No search on this screen: the palette IS the search, so use it rather
        // than swallowing the shortcut.
        if (field instanceof HTMLInputElement) {
          field.focus();
          field.select();
        } else {
          openPalette();
        }
        return;
      }
      if (key === 'e' && event.shiftKey) {
        event.preventDefault();
        runExport();
        return;
      }
      if (!event.shiftKey && (key === '1' || key === '2' || key === '3')) {
        event.preventDefault();
        const target = key === '1' ? '/inbox' : key === '2' ? '/repository' : '/expiring';
        router.push(target);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router, runExport]);

  return (
    <div data-app-shell className="flex h-full w-full overflow-hidden">
      <GlassPrewarm />
      <Sidebar onExport={runExport} />
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        <Titlebar title={title} slotRef={setSlot} />
        <HaltBanner />
        <TitlebarSlotProvider value={slot}>
          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</main>
        </TitlebarSlotProvider>
      </div>
      <CommandPalette />
    </div>
  );
}

/**
 * The window: 240px of chrome, then the recessed content plane. The pane itself
 * is canvas and stays that way -- each screen raises its own `surface` container
 * on top of it, so depth comes from two planes rather than from stacked boxes.
 * Nothing scrolls at the page level; each pane owns its own scroller, the way a
 * document window behaves.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Onboarding is a full-window wizard: no sidebar to navigate away with, and
  // nothing to count in a badge until it finishes.
  if (pathname.startsWith('/onboarding')) {
    return (
      <ToastProvider>
        <div data-app-shell className="h-full w-full overflow-hidden bg-canvas">
          <GlassPrewarm />
          {children}
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <TooltipProvider>
        <Shell>{children}</Shell>
      </TooltipProvider>
    </ToastProvider>
  );
}
