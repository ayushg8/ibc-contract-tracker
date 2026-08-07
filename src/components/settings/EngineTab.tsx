'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  ClipboardText,
  Play,
  WarningCircle,
} from '@phosphor-icons/react';

import { HealthRow, StateDot } from '@/components/settings/HealthRow';
import { ModelCard } from '@/components/settings/ModelCard';
import { SettingsRow } from '@/components/settings/SettingsRow';
import type { SettingsPatch, SettingsTabId } from '@/components/settings/SettingsTabs';
import {
  Button,
  Card,
  Input,
  Pill,
  SecretInput,
  SectionHeader,
  Segmented,
  Spinner,
  Switch,
  useToast,
} from '@/components/ui';
import type { SecretValidity, SegmentedOption } from '@/components/ui';
import { api, type EngineTestResponse, type HealthResponse } from '@/lib/client/api';
import { useStats } from '@/lib/client/useStats';
import type { AppSettings, ModelTier, ProviderId } from '@/lib/db/types';
import type { RemedyAction, SerialisedEngineError } from '@/lib/providers/errors';
import { MODELS, PROVIDER_IDS, PROVIDER_LABELS } from '@/lib/providers/types';

/**
 * Derived from PROVIDER_IDS, not written out, so an engine cannot exist in the
 * type and be missing from the only control that selects it. PROVIDER_IDS is
 * ordered as the recommendation reads, with `none` last: it is the one you pick
 * knowingly, and it is never picked for her -- see providers/types.ts on failover.
 */
const PROVIDER_OPTIONS: readonly SegmentedOption<ProviderId>[] = PROVIDER_IDS.map((id) => ({
  value: id,
  label: PROVIDER_LABELS[id],
}));

/**
 * One line under the picker, per engine. A record rather than the `? :` that used
 * to live here: that ternary's `else` branch described the API key, so selecting
 * anything that was not the CLI told her it was calling Anthropic with her key.
 */
const PROVIDER_BLURB: Record<ProviderId, string> = {
  cli: 'Runs through the Claude app you are already signed in to. No per-document charge.',
  api: 'Calls Anthropic directly with your own key. Faster, and the only engine that can read scans.',
  none: 'No engine at all. Fills only what a rule can prove and leaves the rest blank for you - about half the fields on our test contracts, and none of them wrong.',
};

const TIERS: readonly ModelTier[] = ['fast', 'balanced', 'deep'];

/**
 * The exact one-liners for the fixes that genuinely need Terminal, keyed by the
 * health check id the engine reports rather than by error code: the code says
 * what is wrong, the id says which line of the status block is wrong.
 */
const COMMANDS: Map<string, { hint: string; command: string }> = new Map([
  [
    'cli-found',
    {
      hint: 'Install Claude Code, then press Recheck.',
      command: 'npm install -g @anthropic-ai/claude-code',
    },
  ],
  [
    'cli-version',
    {
      hint: 'Update Claude Code, then press Recheck.',
      command: 'npm install -g @anthropic-ai/claude-code@latest',
    },
  ],
  [
    'cli-auth',
    {
      hint: 'Sign in once in Terminal, then run a test extraction.',
      command: 'claude',
    },
  ],
]);

/**
 * What the screen honestly knows while a test is in flight: the request has gone,
 * Claude is thinking, and nothing has been verified yet. No fake progress.
 */
const STAGES = [
  'Sending the sample agreement',
  'Waiting for Claude to read it',
  'Checking the quotes against the text',
] as const;

/** A run on the Claude subscription has no marginal cost; "$0.000" reads like a bug. */
function cost(usd: number | null): string {
  if (usd === null) return '';
  return usd === 0 ? ' - no charge' : ` - $${usd.toFixed(3)}`;
}

export interface EngineTabProps {
  settings: AppSettings;
  health: HealthResponse | null;
  healthLoading: boolean;
  /** Re-reads settings and health together. */
  onRefresh: () => void;
  onPatch: (patch: SettingsPatch) => Promise<boolean>;
  onNavigate: (tab: SettingsTabId) => void;
}

export function EngineTab({
  settings,
  health,
  healthLoading,
  onRefresh,
  onPatch,
  onNavigate,
}: EngineTabProps) {
  const { toast } = useToast();
  const { data: stats } = useStats();
  const keyField = useRef<HTMLDivElement>(null);

  const [keyDraft, setKeyDraft] = useState('');
  const [validity, setValidity] = useState<SecretValidity>('unknown');
  const [keyDetail, setKeyDetail] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const [testing, setTesting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<EngineTestResponse | null>(null);
  const [testFailure, setTestFailure] = useState<SerialisedEngineError | null>(null);

  const [advanced, setAdvanced] = useState(false);

  // A live counter, because the honest answer to "is it stuck?" is the seconds.
  useEffect(() => {
    if (!testing) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [testing]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setResult(null);
    setTestFailure(null);
    const outcome = await api.testEngine();
    setTesting(false);
    if (outcome.error !== undefined) setTestFailure(outcome.error);
    else setResult(outcome.data);
  }, []);

  const switchProvider = useCallback(
    async (provider: ProviderId) => {
      if (provider === settings.provider) return;
      setResult(null);
      setTestFailure(null);
      await onPatch({ provider });
    },
    [onPatch, settings.provider],
  );

  const focusKeyField = useCallback(() => {
    keyField.current?.querySelector('input')?.focus();
  }, []);

  async function saveKey() {
    const key = keyDraft.trim();
    if (key.length === 0) return;
    setValidity('checking');
    setKeyDetail(null);
    const outcome = await api.setApiKey(key);
    if (outcome.error !== undefined) {
      setValidity('invalid');
      setKeyDetail(outcome.error.message);
      return;
    }
    setValidity(outcome.data.valid ? 'valid' : 'invalid');
    setKeyDetail(outcome.data.detail);
    if (outcome.data.valid) {
      // The route stores the key only after it has worked once, so there is
      // nothing left worth keeping in the field.
      setKeyDraft('');
      onRefresh();
    }
  }

  async function removeKey() {
    setRemoving(true);
    const outcome = await api.clearApiKey();
    setRemoving(false);
    if (outcome.error !== undefined) {
      toast({
        title: 'The key was not removed',
        description: outcome.error.message,
        tone: 'bad',
      });
      return;
    }
    setValidity('unknown');
    setKeyDetail(null);
    onRefresh();
  }

  /** Turns a remedy from the error taxonomy into something this screen can do. */
  function handlerFor(action: RemedyAction): (() => void) | null {
    switch (action) {
      case 'retry':
      case 'wait-and-retry':
        return () => void runTest();
      case 'switch-to-api':
      case 'enter-api-key':
        return () => void switchProvider('api').then(focusKeyField);
      case 'switch-to-cli':
        return () => void switchProvider('cli');
      case 'open-engine-settings':
        return onRefresh;
      case 'open-folder-settings':
      case 'choose-folder':
        return () => onNavigate('folders');
      case 'contact-support':
        return () => onNavigate('diagnostics');
      // The one Terminal step she is asked to take, turned into a button. It is
      // permanent rather than part of setup: tokens expire and people sign out,
      // and the second time this happens there is no wizard to go back to.
      case 'login-cli':
        return () => void startSignIn();
      case 'install-cli':
      case 'update-cli':
      case 'reveal-file':
      case 'enter-manually':
      case 'none':
        // Nothing to press: the Terminal command below the status block is the fix.
        return null;
    }
  }

  /**
   * Opens the login and returns. It cannot wait for the browser round-trip, so
   * Recheck is what confirms the result -- and Recheck now reads `auth status`
   * rather than spending a request on a real extraction.
   */
  async function startSignIn(): Promise<void> {
    try {
      const res = await fetch('/api/engine/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body: unknown = await res.json();
      const started =
        body !== null && typeof body === 'object' && (body as { started?: unknown }).started === true;
      toast({
        title: started ? 'Finish signing in, then press Recheck' : 'Could not start the sign-in',
        description: started
          ? 'A window has opened. Complete the login in your browser and come back.'
          : body !== null && typeof body === 'object'
            ? String((body as { reason?: unknown }).reason ?? '')
            : '',
        tone: started ? 'ok' : 'bad',
      });
    } catch {
      toast({
        title: 'Could not start the sign-in',
        description: 'The tracker could not open a window. Send Ayush this message.',
        tone: 'bad',
      });
    }
  }

  function fixFor(id: string): { label: string; onClick: () => void } | undefined {
    switch (id) {
      case 'cli-found':
        return { label: 'Use an API key', onClick: () => void switchProvider('api') };
      case 'cli-auth':
        // Sign in, not "run a test extraction". The test used to be the only way
        // to learn whether she was signed in; `auth status` answers that for free
        // now, so the button can be the fix rather than another diagnosis.
        return { label: 'Sign in to Claude', onClick: () => void startSignIn() };
      case 'cli-version':
        return { label: 'Recheck', onClick: onRefresh };
      case 'api-key':
        return { label: 'Enter a key', onClick: focusKeyField };
      case 'api-model':
        return { label: 'Recheck', onClick: onRefresh };
      default:
        return undefined;
    }
  }

  // health.engine and settings.provider come from separate fetches, and switchProvider
  // flips the segmented control the instant onPatch resolves, well before the follow-up
  // health refetch for the NEW provider lands. In between, health.engine still holds the
  // OLD provider's snapshot -- so for one round trip the screen said "API key" while
  // showing "Claude Code v2.1.220, signed in" underneath it, or the reverse. Rendering
  // a health object for a provider nobody selected is worse than showing nothing: treat
  // a mismatch exactly like "no data yet" rather than displaying it.
  const rawEngine = health?.engine ?? null;
  const engine = rawEngine !== null && rawEngine.provider === settings.provider ? rawEngine : null;
  const engineLoading = healthLoading || rawEngine?.provider !== settings.provider;
  const firstProblem = engine?.checks.find((c) => c.state === 'fail' || c.state === 'unknown');
  const command = firstProblem ? COMMANDS.get(firstProblem.id) : undefined;
  const usage = stats?.usage ?? null;

  return (
    <div className="flex flex-col gap-[20px]">
      {/* ------------------------------- engine ------------------------------ */}
      <section>
        <SectionHeader title="Engine" className="mb-[8px] px-[2px]" />
        <Segmented
          options={PROVIDER_OPTIONS}
          value={settings.provider}
          onChange={(next) => void switchProvider(next)}
          ariaLabel="Which engine reads the documents"
          fullWidth
        />
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          {PROVIDER_BLURB[settings.provider]}
        </p>

        <Card padding="none" divided className="mt-[10px]">
          <SettingsRow
            leading={
              engineLoading ? <Spinner size={13} /> : <StateDot state={engine?.state ?? 'unknown'} />
            }
            label={
              <span className="block truncate font-medium">
                {engine?.summary ?? 'Checking the engine...'}
              </span>
            }
            // The version is already in the summary above and in its own check
            // row below; repeating it here was the same string three times.
            description={PROVIDER_LABELS[settings.provider]}
            control={
              <Button size="sm" loading={healthLoading} onClick={onRefresh}>
                Recheck
              </Button>
            }
          />

          {engine?.checks.map((check) => (
            <HealthRow key={check.id} check={check} fix={fixFor(check.id)} />
          ))}

          {command !== undefined && (
            <div className="px-[12px] py-[10px]">
              <p className="mb-[6px] text-callout text-label-secondary">{command.hint}</p>
              <CommandField command={command.command} />
            </div>
          )}
        </Card>

        {settings.provider === 'api' && (
          <Card padding="none" divided className="mt-[10px]">
            <div className="px-[12px] py-[10px]" ref={keyField}>
              <div className="flex items-center gap-[8px]">
                <SecretInput
                  value={keyDraft}
                  onChange={(value) => {
                    setKeyDraft(value);
                    setValidity('unknown');
                    setKeyDetail(null);
                  }}
                  validity={validity}
                  className="flex-1"
                />
                <Button
                  variant="primary"
                  loading={validity === 'checking'}
                  disabled={keyDraft.trim().length === 0}
                  onClick={() => void saveKey()}
                >
                  Check and save
                </Button>
              </div>
              <p
                className={clsx(
                  'mt-[6px] text-callout',
                  validity === 'invalid' ? 'text-bad' : 'text-label-secondary',
                )}
              >
                {keyDetail ??
                  'The key is tried against the model you picked before it is stored, so a bad paste is caught here.'}
              </p>
            </div>

            <SettingsRow
              label={settings.hasApiKey ? 'A key is stored' : 'No key stored yet'}
              description={
                settings.apiKeySource === 'keychain'
                  ? 'Held in the macOS keychain. The database and the logs never see it.'
                  : settings.apiKeySource === 'env'
                    ? 'Coming from the ANTHROPIC_API_KEY environment variable, not the keychain. Remove that variable to manage the key here.'
                    : 'Paste one above to use the API engine.'
              }
              control={
                settings.hasApiKey && settings.apiKeySource === 'keychain' ? (
                  <Button size="sm" loading={removing} onClick={() => void removeKey()}>
                    Remove
                  </Button>
                ) : undefined
              }
            />
          </Card>
        )}
      </section>

      {/* -------------------------------- model ------------------------------ */}
      {/* Hidden, not disabled, on the rules-only engine. A greyed-out model picker
          invites the question "which model is it using then", and the honest answer
          is none -- so the section that would ask it should not be on the screen.
          The stored tier is left untouched, so switching back restores her choice. */}
      {settings.provider !== 'none' && (
      <section>
        <SectionHeader
          title="Model"
          className="mb-[8px] px-[2px]"
          trailing={
            <span className="text-footnote text-label-tertiary">
              {MODELS[settings.tier].label} selected
            </span>
          }
        />
        <div
          role="radiogroup"
          aria-label="Model"
          className="grid grid-cols-1 gap-[8px] sm:grid-cols-3"
        >
          {TIERS.map((tier) => (
            <ModelCard
              key={tier}
              tier={tier}
              selected={settings.tier === tier}
              onSelect={(next) => void onPatch({ tier: next })}
            />
          ))}
        </div>
      </section>
      )}

      {/* ---------------------------- test extraction ------------------------ */}
      <section>
        <SectionHeader title="Proof" className="mb-[8px] px-[2px]" />
        <Card>
          <div className="flex items-start justify-between gap-[10px]">
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-label">Run test extraction</p>
              <p className="mt-[1px] text-callout text-label-secondary">
                Reads a bundled sample agreement end to end and reports what came back.
              </p>
            </div>
            <Button
              variant="primary"
              icon={<Play size={13} weight="fill" />}
              loading={testing}
              onClick={() => void runTest()}
            >
              Run
            </Button>
          </div>

          {testing && (
            <ol className="mt-[12px] flex flex-col gap-[6px]">
              {STAGES.map((label, index) => (
                <li key={label} className="flex items-center gap-[8px] text-callout">
                  {index === 0 ? (
                    <CheckCircle size={14} weight="fill" className="shrink-0 text-ok" />
                  ) : index === 1 ? (
                    <Spinner size={12} />
                  ) : (
                    <span className="size-[12px] shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--label-quaternary)]" />
                  )}
                  <span className={index === 1 ? 'text-label' : 'text-label-secondary'}>
                    {label}
                  </span>
                  {index === 1 && (
                    <span className="tabular text-footnote text-label-tertiary">
                      {(elapsed / 1000).toFixed(1)}s
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}

          {!testing && result !== null && (
            <div className="mt-[12px] flex items-start gap-[8px]">
              {result.ok ? (
                <CheckCircle size={16} weight="fill" className="mt-[1px] shrink-0 text-ok" />
              ) : (
                <WarningCircle size={16} weight="fill" className="mt-[1px] shrink-0 text-bad" />
              )}
              <div className="min-w-0 flex-1">
                <p className="tabular text-body text-label">
                  {result.fieldsFound} of {result.fieldsTotal} fields
                  {` - ${(result.durationMs / 1000).toFixed(1)}s`}
                  {cost(result.costUsd)}
                </p>
                {result.error !== null ? (
                  <>
                    <p className="mt-[2px] text-callout text-label">{result.error.message}</p>
                    <RemedyRow remedy={result.error.remedy} handlerFor={handlerFor} />
                  </>
                ) : (
                  <p className="mt-[2px] text-callout text-label-secondary">
                    {/* Two sentences, because on the rules-only engine the usual
                        one is a small lie: there is no engine and there are no
                        quotes to check, and this panel is the place a person
                        decides whether to believe the app. */}
                    {settings.provider === 'none'
                      ? 'The deterministic rules ran on a sample agreement. No engine was called.'
                      : 'The whole path works: engine, document, quotes.'}
                  </p>
                )}
              </div>
            </div>
          )}

          {!testing && testFailure !== null && (
            <div className="mt-[12px] flex items-start gap-[8px]">
              <WarningCircle size={16} weight="fill" className="mt-[1px] shrink-0 text-bad" />
              <div className="min-w-0 flex-1">
                <p className="text-callout text-label">{testFailure.message}</p>
                <RemedyRow remedy={testFailure.remedy} handlerFor={handlerFor} />
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* -------------------------------- usage ------------------------------ */}
      <section>
        <SectionHeader title="This month" className="mb-[8px] px-[2px]" />
        <Card>
          <div className="flex items-center gap-[20px]">
            <div>
              <p className="tabular text-title-2 font-semibold text-label">
                {usage?.documents ?? 0}
              </p>
              <p className="text-footnote text-label-tertiary">documents</p>
            </div>
            <div>
              <p className="tabular text-title-2 font-semibold text-label">
                ${(usage?.costUsd ?? 0).toFixed(2)}
              </p>
              <p className="text-footnote text-label-tertiary">estimated spend</p>
            </div>
            <div className="flex-1" />
            <Sparkline points={usage?.points ?? []} />
          </div>
          {settings.provider === 'cli' && (
            <p className="mt-[8px] text-footnote text-label-tertiary">
              On the Claude subscription this is what the same work would have cost through the
              API. Nothing is billed per document.
            </p>
          )}
        </Card>
      </section>

      {/* ------------------------------ advanced ----------------------------- */}
      <section>
        <button
          type="button"
          onClick={() => setAdvanced((open) => !open)}
          aria-expanded={advanced}
          className="eyebrow sq flex items-center gap-[4px] rounded-control px-[2px] py-[2px] transition-colors duration-[var(--dur-fast)] ease-fast hover:text-label-secondary"
        >
          {advanced ? (
            <CaretDown size={10} weight="bold" />
          ) : (
            <CaretRight size={10} weight="bold" />
          )}
          Advanced
        </button>

        {advanced && (
          <Card padding="none" divided className="mt-[8px]">
            <SettingsRow
              label="Retry on a deeper model"
              description="When more than three fields come back empty, read the document again one tier up. Costs more, finds more. Not normally needed."
              control={
                <Switch
                  checked={settings.escalateOnLowYield}
                  onCheckedChange={(next) => void onPatch({ escalateOnLowYield: next })}
                  ariaLabel="Retry on a deeper model when little is found"
                />
              }
            />

            <SettingsRow
              label={
                <span className="flex items-center gap-[6px]">
                  Skip Claude Code permission prompts
                  <Pill tone="quiet">not needed</Pill>
                </span>
              }
              description="The tracker never asks Claude to use tools, so there is no prompt to bypass. Left here, and off, so its absence is deliberate rather than forgotten."
              control={
                <Switch checked={false} disabled ariaLabel="Skip Claude Code permission prompts" />
              }
            />
          </Card>
        )}
      </section>
    </div>
  );
}

/* -------------------------------- pieces ---------------------------------- */

function RemedyRow({
  remedy,
  handlerFor,
}: {
  remedy: SerialisedEngineError['remedy'];
  handlerFor: (action: RemedyAction) => (() => void) | null;
}) {
  const handler = handlerFor(remedy.action);
  if (handler === null && remedy.hint === undefined) return null;
  return (
    <div className="mt-[6px] flex items-center gap-[8px]">
      {handler !== null && (
        <Button size="sm" onClick={handler}>
          {remedy.label}
        </Button>
      )}
      {remedy.hint !== undefined && (
        <span className="text-footnote text-label-tertiary">{remedy.hint}</span>
      )}
    </div>
  );
}

function CommandField({ command }: { command: string }) {
  const { toast } = useToast();
  return (
    <Input
      readOnly
      mono
      size="sm"
      value={command}
      aria-label="Terminal command"
      onFocus={(event) => event.currentTarget.select()}
      trailing={
        <Button
          size="sm"
          variant="ghost"
          icon={<ClipboardText size={13} />}
          onClick={() => {
            void navigator.clipboard
              .writeText(command)
              .then(() => toast({ title: 'Command copied', tone: 'ok' }))
              .catch(() =>
                toast({
                  title: 'Could not reach the clipboard',
                  description: 'Select the text and copy it by hand.',
                  tone: 'warn',
                }),
              );
          }}
        >
          Copy
        </Button>
      }
    />
  );
}

function Sparkline({ points }: { points: readonly number[] }) {
  if (points.length === 0) {
    return <span className="text-footnote text-label-tertiary">No activity yet</span>;
  }

  const width = 88;
  const height = 20;
  const max = Math.max(...points);
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const y = (v: number) => height - 1 - (max > 0 ? (v / max) * (height - 2) : 0);

  return (
    <svg
      role="img"
      aria-label={`Daily spend this month across ${points.length} days`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
    >
      {points.length === 1 ? (
        <circle cx={2} cy={y(points[0] ?? 0)} r={2} fill="var(--accent)" />
      ) : (
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={points.map((v, i) => `${i * step},${y(v)}`).join(' ')}
        />
      )}
    </svg>
  );
}
