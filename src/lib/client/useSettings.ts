'use client';

/**
 * Settings and engine health, shared by every screen that shows either.
 *
 * Health lives here rather than in its own module because it is engine state:
 * the pill in the sidebar needs the provider and tier from settings *and* the
 * state from health in the same breath, and probing the CLI once a minute is
 * plenty -- each probe spawns a process.
 */

import { api, createResourceStore, type HealthResponse, type SettingsResponse } from './api';
import type { AppSettings } from '@/lib/db/types';
import type { SerialisedEngineError } from '@/lib/providers/errors';

const HEALTH_POLL_MS = 60_000;

const settings = createResourceStore<SettingsResponse>(() => api.settings());
const health = createResourceStore<HealthResponse>(() => api.health(), HEALTH_POLL_MS);

export const settingsStore = settings;
export const healthStore = health;

export interface UseSettings {
  settings: AppSettings | null;
  error: SerialisedEngineError | null;
  loading: boolean;
  refresh: () => void;
  /** Optimistic: the field flips immediately, then the server answer replaces it. */
  save: (patch: Partial<AppSettings>) => Promise<SerialisedEngineError | null>;
}

export function useSettings(): UseSettings {
  const state = settings.use();

  return {
    settings: state.data?.settings ?? null,
    error: state.error,
    loading: state.loading,
    refresh: state.refresh,
    async save(patch) {
      const result = await api.saveSettings(patch);
      if (result.error !== undefined) {
        // The server rejected it, so the truth on screen is whatever is stored.
        void settings.refresh();
        return result.error;
      }
      void settings.refresh();
      // A provider or tier change makes the last health answer stale.
      void health.refresh();
      return null;
    },
  };
}

export function useHealth() {
  return health.use();
}

export function refreshSettings(): void {
  void settings.refresh();
}

export function refreshHealth(): void {
  void health.refresh();
}
