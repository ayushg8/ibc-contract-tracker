'use client';

import clsx from 'clsx';

import { SettingsRow } from '@/components/settings/SettingsRow';
import { Button, Spinner } from '@/components/ui';
import type { HealthCheck, HealthState } from '@/lib/providers/types';

/**
 * Four states, not three: `unknown` means "we could not find out", which has to
 * look different from "fine" and from "broken". Dot only speaks Confidence, so
 * health carries its own indicator.
 */
const STATE_FILL: Record<HealthState, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  fail: 'var(--bad)',
  unknown: 'var(--label-tertiary)',
};

const STATE_LABEL: Record<HealthState, string> = {
  ok: 'Working',
  warn: 'Needs a look',
  fail: 'Broken',
  unknown: 'Not checked',
};

export function StateDot({ state, className }: { state: HealthState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={STATE_LABEL[state]}
      title={STATE_LABEL[state]}
      className={clsx('inline-block size-[7px] shrink-0 rounded-full', className)}
      // The rim keeps a light fill from dissolving into a white surface; it is a
      // border weight, so it comes from --border rather than from the fill.
      style={{ background: STATE_FILL[state], boxShadow: 'inset 0 0 0 0.5px var(--border)' }}
    />
  );
}

export interface HealthRowProps {
  check: HealthCheck;
  /** The remedy button. Offer one only when there is something to press. */
  fix?: { label: string; onClick: () => void };
  busy?: boolean;
}

export function HealthRow({ check, fix, busy = false }: HealthRowProps) {
  const healthy = check.state === 'ok';
  return (
    <SettingsRow
      leading={busy ? <Spinner size={12} /> : <StateDot state={check.state} />}
      label={check.label}
      description={
        <span
          title={check.detail}
          className={clsx('block truncate', healthy ? undefined : 'text-label')}
        >
          {check.detail}
        </span>
      }
      control={
        fix !== undefined && !healthy ? (
          <Button size="sm" onClick={fix.onClick}>
            {fix.label}
          </Button>
        ) : undefined
      }
    />
  );
}
