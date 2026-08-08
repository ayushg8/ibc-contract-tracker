'use client';

import {
  Archive,
  ClockCountdown,
  DownloadSimple,
  FolderOpen,
  GearSix,
  Tray,
} from '@phosphor-icons/react';

import { Glass } from '@/components/ui';
import { EnginePill } from './EnginePill';
import { NavItem } from './NavItem';
import { DRAG_REGION } from './Titlebar';
import { KEY } from '@/components/palette/usePalette';
import { useStats } from '@/lib/client/useStats';

export interface SidebarProps {
  /** Runs the export. Owned by AppFrame so the row and the shortcut share it. */
  onExport: () => void;
}

/**
 * 240px of chrome. The traffic lights float over the top of this pane, so the
 * first 52px are drag region and nothing else.
 *
 * The right edge carries `--border` rather than `--separator`: the sidebar's
 * glass tint and the content pane are both canvas, so a row-divider hairline
 * would leave no edge at all between them.
 */
export function Sidebar({ onExport }: SidebarProps) {
  const { data } = useStats();

  return (
    <Glass
      as="aside"
      radius="none"
      className="flex h-full w-[240px] shrink-0 flex-col border-r-[0.5px] border-border"
      aria-label="Sections"
    >
      <div className="flex h-[52px] shrink-0 items-end px-[16px] pb-[6px]" style={DRAG_REGION}>
        <span className="text-title-3 font-semibold text-label">IBC Contracts</span>
      </div>

      <nav className="flex flex-col gap-[1px] pt-[6px]">
        <NavItem
          href="/inbox"
          label="Inbox"
          icon={Tray}
          count={data?.pending ?? null}
          alert
          keys={[KEY.cmd, '1']}
        />
        <NavItem
          href="/repository"
          label="Repository"
          icon={Archive}
          count={data?.contracts ?? null}
          keys={[KEY.cmd, '2']}
        />
        <NavItem
          href="/expiring"
          label="Expiring"
          icon={ClockCountdown}
          count={data?.expiring ?? null}
          alert
          keys={[KEY.cmd, '3']}
        />
        {/*
          Where the contracts actually sit on disk. A section rather than a
          setting: she opens it to look at her own folders, which is not
          something she does once during setup.
        */}
        <NavItem
          href="/files"
          label="Files"
          icon={FolderOpen}
          count={null}
          keys={[KEY.cmd, '4']}
        />
      </nav>

      <div className="mx-[16px] my-[8px] h-[0.5px] shrink-0 bg-separator" />

      <nav className="flex flex-col gap-[1px]">
        <NavItem
          label="Export"
          icon={DownloadSimple}
          onSelect={onExport}
          keys={[KEY.cmd, KEY.shift, 'E']}
        />
      </nav>

      <div className="flex-1" />

      <nav className="flex flex-col gap-[1px] pb-[6px]">
        <NavItem href="/settings" label="Settings" icon={GearSix} />
      </nav>

      <EnginePill />
    </Glass>
  );
}
