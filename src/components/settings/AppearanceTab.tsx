'use client';

import { useEffect, useState } from 'react';
import { CircleHalf, Moon, Sun } from '@phosphor-icons/react';

import { SettingsRow } from '@/components/settings/SettingsRow';
import type { SettingsPatch } from '@/components/settings/SettingsTabs';
import { Card, SectionHeader, Segmented, Slider } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import type { AppSettings } from '@/lib/db/types';

type Appearance = AppSettings['appearance'];

/** The key the pre-paint script in layout.tsx reads. Changing it reintroduces the flash. */
const APPEARANCE_KEY = 'ibc-appearance';

const APPEARANCE_OPTIONS: readonly SegmentedOption<Appearance>[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: CircleHalf },
];

const DENSITY_OPTIONS: readonly SegmentedOption<AppSettings['density']>[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

/**
 * Three writes, and all three are load-bearing. The attribute repaints the app
 * now; localStorage is what the pre-paint script in layout.tsx reads on the next
 * launch, so without it a person who chose dark gets a white flash on every
 * open; the database is what survives a cleared browser store.
 */
function applyAppearance(value: Appearance): void {
  document.documentElement.setAttribute('data-theme', value);
  try {
    localStorage.setItem(APPEARANCE_KEY, value);
  } catch {
    // Private windows refuse the write. The attribute is already set, so this
    // session is correct either way.
  }
}

/**
 * The insurance policy from the design system: if the material costs too much on
 * an older Mac, or simply distracts, this dials it out. Off leaves the chrome
 * opaque -- exactly what the reduced-transparency media query does.
 *
 * Both overrides land on the root element and point at *other* tokens, never at
 * the token being overridden: a custom property that references itself resolves
 * to nothing and the glass disappears entirely.
 */
function applyGlass(intensity: number): void {
  const root = document.documentElement;
  const clamped = Math.min(1, Math.max(0, intensity));
  root.style.setProperty('--glass-blur', `${Math.round(clamped * 20)}px`);
  root.style.setProperty('--glass-saturate', `${Math.round(100 + clamped * 80)}%`);
  root.style.setProperty(
    '--glass-tint',
    `color-mix(in srgb, var(--surface-sunken) ${Math.round((1 - clamped) * 100)}%, var(--glass-tint-strong))`,
  );
}

export interface AppearanceTabProps {
  settings: AppSettings;
  onPatch: (patch: SettingsPatch) => Promise<boolean>;
}

export function AppearanceTab({ settings, onPatch }: AppearanceTabProps) {
  const [glass, setGlass] = useState(settings.glassIntensity);

  // The stored intensity is the truth; the slider only leads it while dragging.
  useEffect(() => {
    setGlass(settings.glassIntensity);
    applyGlass(settings.glassIntensity);
  }, [settings.glassIntensity]);

  // The database wins over a stale localStorage value, e.g. after the store was
  // cleared or the setting was changed from another window.
  useEffect(() => {
    applyAppearance(settings.appearance);
  }, [settings.appearance]);

  return (
    <div className="flex flex-col gap-[20px]">
      <section>
        <SectionHeader title="Appearance" className="mb-[8px] px-[2px]" />
        <Card padding="none" divided>
          <SettingsRow
            label="Theme"
            description="Light is the default. System follows your Mac."
            control={
              <Segmented
                options={APPEARANCE_OPTIONS}
                value={settings.appearance}
                onChange={(next) => {
                  applyAppearance(next);
                  void onPatch({ appearance: next });
                }}
                ariaLabel="Theme"
                size="sm"
              />
            }
          />

          <SettingsRow
            label="Density"
            description="Compact fits about a third more rows on screen."
            control={
              <Segmented
                options={DENSITY_OPTIONS}
                value={settings.density}
                onChange={(next) => void onPatch({ density: next })}
                ariaLabel="Row density"
                size="sm"
              />
            }
          />
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          Accent colour, Increase Contrast and Reduce Motion follow System Settings.
        </p>
      </section>

      <section>
        <SectionHeader title="Material" className="mb-[8px] px-[2px]" />
        <Card padding="none">
          <SettingsRow
            label="Glass intensity"
            description="How much the sidebar and panels blur what is behind them. Off makes them plain."
            control={
              <span className="tabular text-callout text-label-secondary">
                {Math.round(glass * 100)}%
              </span>
            }
          >
            <Slider
              className="mt-[10px]"
              ariaLabel="Glass intensity"
              min={0}
              max={1}
              step={0.05}
              ticks={5}
              value={glass}
              onValueChange={(next) => {
                setGlass(next);
                applyGlass(next);
              }}
              onValueCommit={(next) => void onPatch({ glassIntensity: next })}
            />
            <div className="mt-[2px] flex justify-between text-footnote text-label-tertiary">
              <span>Off</span>
              <span>Full</span>
            </div>
          </SettingsRow>
        </Card>
      </section>
    </div>
  );
}
