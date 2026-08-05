'use client';

import { useState } from 'react';
import {
  Archive,
  ArrowCircleUp,
  FolderOpen,
  Lightning,
  PaintBrush,
  Stethoscope,
  Table,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

import { AppearanceTab } from '@/components/settings/AppearanceTab';
import { DataTab } from '@/components/settings/DataTab';
import { DiagnosticsTab } from '@/components/settings/DiagnosticsTab';
import { EngineTab } from '@/components/settings/EngineTab';
import { ExportTab } from '@/components/settings/ExportTab';
import { FoldersTab } from '@/components/settings/FoldersTab';
import { UpdatesTab } from '@/components/settings/UpdatesTab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import type { HealthResponse } from '@/lib/client/api';
import type { AppSettings } from '@/lib/db/types';

export type SettingsTabId =
  | 'engine'
  | 'folders'
  | 'export'
  | 'data'
  | 'appearance'
  | 'updates'
  | 'diagnostics';

/**
 * The keys PATCH /api/settings will accept. hasApiKey, apiKeySource and
 * lastExportedAt are derived, and the route rejects them loudly, so they are kept
 * out of the type rather than out of the caller's memory.
 */
export type SettingsPatch = Partial<
  Pick<
    AppSettings,
    | 'provider'
    | 'tier'
    | 'watchFolder'
    | 'archiveFolder'
    | 'exportFolder'
    | 'autoExtract'
    | 'glassIntensity'
    | 'density'
    | 'appearance'
    | 'escalateOnLowYield'
    | 'onboardingComplete'
  >
>;

const TABS: readonly { id: SettingsTabId; label: string; icon: Icon }[] = [
  { id: 'engine', label: 'Engine', icon: Lightning },
  { id: 'folders', label: 'Folders', icon: FolderOpen },
  { id: 'export', label: 'Export', icon: Table },
  { id: 'data', label: 'Data', icon: Archive },
  { id: 'appearance', label: 'Appearance', icon: PaintBrush },
  // Before Diagnostics on purpose: "am I on the newest version" is a question
  // about the app, and Diagnostics is the last stop, where support starts.
  { id: 'updates', label: 'Updates', icon: ArrowCircleUp },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
];

/** Radix hands back a plain string; this is the way back to the union. */
const BY_ID: Map<string, SettingsTabId> = new Map(TABS.map((t) => [t.id, t.id]));

export interface SettingsTabsProps {
  settings: AppSettings;
  health: HealthResponse | null;
  healthLoading: boolean;
  /** Re-reads settings and health together. */
  onRefresh: () => void;
  onPatch: (patch: SettingsPatch) => Promise<boolean>;
  initialTab?: SettingsTabId;
}

/**
 * Apple's Settings shape: an icon bar at the top, one scrollable pane per tab,
 * content in grouped cards. Each pane is mounted only while it is showing, so a
 * tab pays for its own requests and nothing else.
 */
export function SettingsTabs({
  settings,
  health,
  healthLoading,
  onRefresh,
  onPatch,
  initialTab = 'engine',
}: SettingsTabsProps) {
  const [tab, setTab] = useState<SettingsTabId>(initialTab);

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        const id = BY_ID.get(next);
        if (id) setTab(id);
      }}
      variant="toolbar"
      className="h-full"
    >
      <div className="flex shrink-0 justify-center border-b-[0.5px] border-border px-[16px] py-[6px]">
        <TabsList ariaLabel="Settings sections">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} label={t.label} icon={t.icon} />
          ))}
        </TabsList>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-[24px] py-[20px]">
          <TabsContent value="engine">
            <EngineTab
              settings={settings}
              health={health}
              healthLoading={healthLoading}
              onRefresh={onRefresh}
              onPatch={onPatch}
              onNavigate={setTab}
            />
          </TabsContent>

          <TabsContent value="folders">
            <FoldersTab settings={settings} health={health} onPatch={onPatch} />
          </TabsContent>

          <TabsContent value="export">
            <ExportTab settings={settings} onRefresh={onRefresh} />
          </TabsContent>

          <TabsContent value="data">
            <DataTab />
          </TabsContent>

          <TabsContent value="appearance">
            <AppearanceTab settings={settings} onPatch={onPatch} />
          </TabsContent>

          {/* Mounted only while showing, like every other pane: the update tab
              polls, and a poll behind a tab nobody is looking at is waste. */}
          <TabsContent value="updates">
            <UpdatesTab />
          </TabsContent>

          <TabsContent value="diagnostics">
            <DiagnosticsTab
              health={health}
              healthLoading={healthLoading}
              onRefresh={onRefresh}
              onNavigate={setTab}
            />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
