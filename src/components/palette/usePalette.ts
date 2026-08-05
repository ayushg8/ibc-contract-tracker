'use client';

/**
 * Palette state and the keyboard vocabulary, kept outside React so the global
 * shortcut layer in AppFrame and the dialog itself cannot disagree about
 * whether the palette is open.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@/lib/client/api';
import type { ContractSummary } from '@/lib/db/types';
import type { SerialisedEngineError } from '@/lib/providers/errors';

/** Written as escapes so every source file in the app stays ASCII. */
export const KEY = {
  cmd: '\u2318',
  shift: '\u21e7',
  option: '\u2325',
  control: '\u2303',
  enter: '\u21a9',
  up: '\u2191',
  down: '\u2193',
  escape: 'esc',
} as const;

/* ─────────────────────────── open / closed ──────────────────────────── */

let open = false;
const listeners = new Set<() => void>();

function emit(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openPalette(): void {
  emit(true);
}

export function closePalette(): void {
  emit(false);
}

export function togglePalette(): void {
  emit(!open);
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}

/* ───────────────────────────── searching ────────────────────────────── */

const DEBOUNCE_MS = 120;
const RECENT_LIMIT = 6;
const RESULT_LIMIT = 8;

export interface PaletteSearch {
  rows: ContractSummary[];
  loading: boolean;
  error: SerialisedEngineError | null;
}

/**
 * Live contract search. An empty query is not an empty result: it shows the most
 * recently approved records, so opening the palette is already useful.
 */
export function usePaletteSearch(query: string, enabled: boolean): PaletteSearch {
  const [state, setState] = useState<PaletteSearch>({
    rows: [],
    loading: false,
    error: null,
  });
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setState({ rows: [], loading: false, error: null });
      return;
    }
    const trimmed = query.trim();
    const token = ++seq.current;
    setState((prev) => ({ ...prev, loading: true }));

    const timer = window.setTimeout(
      () => {
        void (async () => {
          const result =
            trimmed.length === 0
              ? await api.contracts({ sort: 'approvedAt', dir: 'desc', limit: RECENT_LIMIT })
              : await api.contracts({ q: trimmed, limit: RESULT_LIMIT });
          if (token !== seq.current) return;
          if (result.error !== undefined) {
            setState({ rows: [], loading: false, error: result.error });
          } else {
            setState({ rows: result.data.contracts, loading: false, error: null });
          }
        })();
      },
      trimmed.length === 0 ? 0 : DEBOUNCE_MS,
    );

    return () => window.clearTimeout(timer);
  }, [query, enabled]);

  return state;
}
