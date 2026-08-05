'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { WarningCircle } from '@phosphor-icons/react';

import { SettingsTabs } from '@/components/settings/SettingsTabs';
import type { SettingsPatch, SettingsTabId } from '@/components/settings/SettingsTabs';
import { Button, Card, Spinner, useToast } from '@/components/ui';
import { toSettingsTab } from '@/lib/client/settingsTab';
import { refreshHealth, refreshSettings, useHealth, useSettings } from '@/lib/client/useSettings';

/**
 * Settings.
 *
 * useSearchParams needs a Suspense boundary above it or the route cannot be
 * prerendered, so the screen itself is a child and this is the boundary.
 */
export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <Centred>
          <Reading />
        </Centred>
      }
    >
      <SettingsScreen />
    </Suspense>
  );
}

function SettingsScreen() {
  const { toast } = useToast();
  const { settings, loading, error, save } = useSettings();
  const health = useHealth();

  const params = useSearchParams();

  const [tab, setTab] = useState<SettingsTabId>(() => toSettingsTab(params.get('tab')) ?? 'engine');
  /**
   * Bumped on every arrival carrying a tab after the first, and part of the key
   * below, so a second remedy press lands on its pane even when the screen is
   * already open on another one. Without it the key would be unchanged and the
   * tab bar would quietly ignore the request -- which is the bug this whole
   * screen had, one level up.
   */
  const [arrival, setArrival] = useState(0);
  /** The first request is already in `tab` above, so it costs no remount. */
  const firstRender = useRef(true);

  // Keyed on the params object rather than on the parsed tab: two presses of the
  // same remedy hand back the same string, and an effect that only watches the
  // value would sit out the second one.
  useEffect(() => {
    const requested = toSettingsTab(params.get('tab'));
    const first = firstRender.current;
    firstRender.current = false;
    if (requested === null) return;
    if (!first) {
      setTab(requested);
      setArrival((n) => n + 1);
    }
    // The query string is an instruction, not state: it is consumed on arrival
    // so the URL can never go on claiming a pane she has since switched away
    // from. replaceState rather than router.replace so that Back leaves Settings
    // instead of walking her through every remedy that opened it, and so the
    // route is not re-run to change a parameter it has already read.
    window.history.replaceState(null, '', '/settings');
  }, [params]);

  // The module-level refreshers rather than the hook's: the hook returns a new
  // object each render, so a callback bound to it would change identity every time.
  const onRefresh = useCallback(() => {
    refreshSettings();
    refreshHealth();
  }, []);

  /**
   * One place decides how a rejected setting is reported. The routes validate
   * folders before they store them, so "that folder is not readable" arrives here
   * as plain English with a remedy attached.
   */
  const onPatch = useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      const failure = await save(patch);
      if (failure === null) return true;
      toast({
        title: failure.message,
        description: failure.remedy.hint,
        tone: 'bad',
      });
      return false;
    },
    [save, toast],
  );

  if (settings === null) {
    return (
      <Centred>
        {loading ? (
          <Reading />
        ) : (
          <Card className="flex max-w-[420px] items-start gap-[10px]">
            <WarningCircle size={18} className="mt-[1px] shrink-0 text-bad" />
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-label">
                {error?.message ?? 'Settings could not be read.'}
              </p>
              <Button size="sm" className="mt-[8px]" onClick={onRefresh}>
                Try again
              </Button>
            </div>
          </Card>
        )}
      </Centred>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SettingsTabs
        key={`${tab}-${arrival}`}
        initialTab={tab}
        settings={settings}
        health={health.data}
        healthLoading={health.loading}
        onRefresh={onRefresh}
        onPatch={onPatch}
      />
    </div>
  );
}

function Centred({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-[24px]">{children}</div>;
}

function Reading() {
  return (
    <span className="flex items-center gap-[8px] text-callout text-label-secondary">
      <Spinner size={16} />
      Reading your settings...
    </span>
  );
}
