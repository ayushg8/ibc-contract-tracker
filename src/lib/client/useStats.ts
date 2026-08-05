'use client';

/**
 * The sidebar counts. One poll for the whole window.
 *
 * Four seconds while the window is focused: the queue moves documents through
 * six states without telling anyone, so the badge has to notice on its own.
 * The store pauses itself when the window is not in front.
 */

import { api, createResourceStore, type StatsResponse } from './api';

const STATS_POLL_MS = 4_000;

const store = createResourceStore<StatsResponse>(() => api.stats(), STATS_POLL_MS);

export const statsStore = store;

export function useStats() {
  return store.use();
}

/** Call after an approve, reject or upload so the badge does not lag the action. */
export function refreshStats(): void {
  void store.refresh();
}
