'use client';

import { useRouter } from 'next/navigation';

import { Dot, Tooltip } from '@/components/ui';
import { useHealth, useSettings } from '@/lib/client/useSettings';
import type { Confidence } from '@/lib/db/types';
import { MODELS } from '@/lib/providers/types';
import type { HealthState, ProviderId } from '@/lib/providers/types';

/** Written as an escape so this file stays ASCII. */
const MIDDOT = '\u00b7';

/** The dot is the confidence indicator, reused: green / amber / red, never animated. */
const DOT: Record<HealthState, Confidence> = {
  ok: 'high',
  warn: 'medium',
  fail: 'none',
  unknown: 'medium',
};

const DOT_LABEL: Record<HealthState, string> = {
  ok: 'Engine ready',
  warn: 'Engine degraded',
  fail: 'Engine not working',
  unknown: 'Checking the engine',
};

/**
 * Typed as the full record so a new engine cannot reach this pill as `undefined`
 * and render an empty chip. "Rules" rather than "None": the pill answers "what is
 * reading my documents", and the honest one-word answer is what it uses, not what
 * it lacks.
 */
const PROVIDER_SHORT: Record<ProviderId, string> = {
  cli: 'Claude',
  api: 'API',
  none: 'Rules',
};

/**
 * The always-visible answer to "what is it using right now". Buried three clicks
 * deep in Settings, that question gets asked out loud instead.
 *
 * A raised surface with a hairline, not a second glass layer: glass over glass
 * on a light ground has almost no tint to work with and reads as a smudge.
 */
export function EnginePill() {
  const router = useRouter();
  const { settings } = useSettings();
  const health = useHealth();

  const provider = settings?.provider ?? null;
  const tier = settings?.tier ?? null;
  const state: HealthState = health.data?.engine.state ?? 'unknown';

  const name = provider === null ? 'Engine' : PROVIDER_SHORT[provider];
  // No model name on the rules-only engine. The stored tier is still whatever she
  // last chose, so this pill read "Rules - Sonnet" and named a model that was not
  // going to be asked anything. The pill's whole job is to answer "what is reading
  // my documents" without being opened, and half of that answer was false.
  const model = tier === null || provider === 'none' ? null : MODELS[tier].label;
  const summary = health.data?.engine.summary ?? DOT_LABEL[state];

  return (
    <Tooltip content={summary} side="top">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Engine: ${name}${model === null ? '' : ` ${MIDDOT} ${model}`}. ${summary}`}
        onClick={() => router.push('/settings?tab=engine')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            router.push('/settings?tab=engine');
          }
        }}
        className="sq mx-[8px] mb-[8px] flex h-[28px] cursor-default select-none items-center gap-[6px] rounded-control border-[0.5px] border-border bg-surface px-[9px] shadow-e1 transition-colors duration-[var(--dur-fast)] ease-fast hover:border-border-strong"
      >
        <Dot confidence={DOT[state]} label={DOT_LABEL[state]} />
        <span className="min-w-0 truncate text-callout font-medium text-label">
          {name}
          {model !== null && (
            <>
              <span className="px-[4px] text-label-tertiary">{MIDDOT}</span>
              {model}
            </>
          )}
        </span>
      </div>
    </Tooltip>
  );
}
