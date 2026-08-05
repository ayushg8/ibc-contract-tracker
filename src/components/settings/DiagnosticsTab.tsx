'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowClockwise, CaretRight, ClipboardText } from '@phosphor-icons/react';
import clsx from 'clsx';

import { HealthRow, StateDot } from '@/components/settings/HealthRow';
import { SettingsRow } from '@/components/settings/SettingsRow';
import type { SettingsTabId } from '@/components/settings/SettingsTabs';
import { Button, Card, Input, SectionHeader, Spinner, useToast } from '@/components/ui';
import { api, copySupportBundle, type HealthResponse } from '@/lib/client/api';
import {
  fetchEngineHealth,
  whereFoundLine,
  type EngineHealthResponse,
} from '@/lib/engine-diagnosis';
import { PROVIDER_LABELS, type HealthCheck, type HealthState } from '@/lib/providers/types';

const OVERALL_LABEL: Record<HealthState, string> = {
  ok: 'Everything is working',
  warn: 'Working, with something worth a look',
  fail: 'Something needs fixing',
  unknown: 'Not checked yet',
};

/**
 * The log lives inside the support bundle rather than behind its own route: the
 * bundle already tails the log file, already redacts every line, and is the one
 * thing support asks for. Two readers of one endpoint beats a second endpoint.
 */
function logSection(contents: string): string {
  const start = contents.search(/^LOG \(last /m);
  if (start < 0) return '';
  const titleEnd = contents.indexOf('\n', start);
  if (titleEnd < 0) return '';
  const ruleEnd = contents.indexOf('\n', titleEnd + 1);
  if (ruleEnd < 0) return '';
  const end = contents.lastIndexOf('\n\nEnd of bundle.');
  const body = end > ruleEnd ? contents.slice(ruleEnd + 1, end) : contents.slice(ruleEnd + 1);
  return body.trim();
}

function stamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(ms));
}

export interface DiagnosticsTabProps {
  health: HealthResponse | null;
  healthLoading: boolean;
  onRefresh: () => void;
  onNavigate: (tab: SettingsTabId) => void;
}

export function DiagnosticsTab({
  health,
  healthLoading,
  onRefresh,
  onNavigate,
}: DiagnosticsTabProps) {
  const { toast } = useToast();
  const [log, setLog] = useState<string | null>(null);
  const [logFailure, setLogFailure] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  /**
   * Closed. This is the screen support sends her to, and it used to open with the
   * structured log rendered verbatim -- JSON, nulls, an HTTP status and an error
   * the app had already recovered from, in front of someone who came here because
   * she was told something was wrong. The log is evidence for whoever she forwards
   * it to, not a message to her, so it lives behind a disclosure and the bundle is
   * the thing this section actually asks her to press.
   */
  const [showLog, setShowLog] = useState(false);
  const [copying, setCopying] = useState(false);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [engine, setEngine] = useState<EngineHealthResponse | null>(null);
  const [engineLoading, setEngineLoading] = useState(false);

  /**
   * The same probe the onboarding Engine step runs, rendered the same way. That is
   * the point of this section: "it stopped working" has to be answerable on one
   * screen, with the same sentence and the same command she saw on day one.
   */
  const loadEngine = useCallback(async () => {
    setEngineLoading(true);
    const outcome = await fetchEngineHealth();
    setEngineLoading(false);
    if (outcome.error === undefined) setEngine(outcome.data);
  }, []);

  useEffect(() => {
    void loadEngine();
  }, [loadEngine]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    const result = await api.supportBundle();
    setLogLoading(false);
    if (result.error !== undefined) {
      setLogFailure(result.error.message);
      return;
    }
    setLog(logSection(result.data.contents));
    setLogFailure(null);
  }, []);

  // Read only once it is asked for: a screen that opens closed has no reason to
  // spend a request tailing a log nobody has looked at.
  function toggleLog() {
    const next = !showLog;
    setShowLog(next);
    if (next && log === null && logFailure === null && !logLoading) void loadLog();
  }

  const copyBundle = useCallback(async () => {
    setCopying(true);
    const result = await copySupportBundle();
    setCopying(false);
    if (result.error !== undefined) {
      toast({
        title: 'The bundle was not copied',
        description: result.error.message,
        tone: 'bad',
      });
      return;
    }
    toast({
      title: 'Support bundle copied',
      description: `${result.data.filename} is on the clipboard. Paste it into an email.`,
      tone: 'ok',
    });
  }, [toast]);

  async function retry(documentId: string) {
    setRetrying((current) => new Set(current).add(documentId));
    const result = await api.retryDocument(documentId);
    setRetrying((current) => {
      const next = new Set(current);
      next.delete(documentId);
      return next;
    });
    if (result.error !== undefined) {
      toast({
        title: 'That document could not be re-read',
        description: result.error.message,
        tone: 'bad',
      });
      return;
    }
    toast({ title: 'Re-reading that document', tone: 'ok' });
    onRefresh();
  }

  function fixFor(id: string): { label: string; onClick: () => void } | undefined {
    switch (id) {
      case 'watch':
      case 'archive':
      case 'export':
        return { label: 'Open Folders', onClick: () => onNavigate('folders') };
      case 'keychain':
      case 'engine':
        return { label: 'Open Engine', onClick: () => onNavigate('engine') };
      // A broken data folder is a backup problem before it is a support problem:
      // Data is the screen that names the folder and can get a copy out of it.
      case 'data':
        return { label: 'Open Data', onClick: () => onNavigate('data') };
      case 'db':
      case 'logs':
        return { label: 'Copy bundle', onClick: () => void copyBundle() };
      default:
        return undefined;
    }
  }

  // The engine's own state belongs in the checklist; its detail lives on the
  // Engine tab, so this row is a summary with a way in.
  const engineCheck: HealthCheck | null =
    health === null
      ? null
      : {
          id: 'engine',
          label: 'Engine',
          state: health.engine.state,
          detail: health.engine.summary,
        };

  const overall = health?.overall ?? 'unknown';

  return (
    <div className="flex flex-col gap-[20px]">
      <section>
        <SectionHeader title="Health" className="mb-[8px] px-[2px]" />
        <Card padding="none" divided>
          <SettingsRow
            leading={
              healthLoading && health === null ? <Spinner size={13} /> : <StateDot state={overall} />
            }
            label={<span className="block truncate font-medium">{OVERALL_LABEL[overall]}</span>}
            control={
              <Button
                size="sm"
                icon={<ArrowClockwise size={13} />}
                loading={healthLoading || engineLoading}
                onClick={() => {
                  onRefresh();
                  void loadEngine();
                }}
              >
                Recheck
              </Button>
            }
          />

          {engineCheck !== null && (
            <HealthRow check={engineCheck} fix={fixFor(engineCheck.id)} />
          )}
          {health?.checks.map((check) => (
            <HealthRow key={check.id} check={check} fix={fixFor(check.id)} />
          ))}
        </Card>
      </section>

      {/* ------------------------------- engine ------------------------------- */}
      <section>
        <SectionHeader
          title="Engine"
          className="mb-[8px] px-[2px]"
          trailing={
            engine === null ? undefined : (
              <span className="text-footnote text-label-tertiary">
                {PROVIDER_LABELS[engine.active]}
              </span>
            )
          }
        />
        <Card padding="none" divided>
          {engine === null ? (
            <p className="px-[12px] py-[14px] text-callout text-label-secondary">
              {engineLoading ? 'Checking both engines...' : 'The engine check did not answer.'}
            </p>
          ) : (
            <>
              <SettingsRow
                leading={<StateDot state={engine.cliDiagnosis.state} />}
                label={
                  <span className="block truncate font-medium">{engine.cliDiagnosis.title}</span>
                }
                description={engine.cliDiagnosis.what}
                control={
                  engine.active !== 'cli' ? undefined : (
                    <Button size="sm" onClick={() => onNavigate('engine')}>
                      Open Engine
                    </Button>
                  )
                }
              >
                {whereFoundLine(engine.cliDiagnosis) !== null && (
                  <p className="mt-[2px] break-all font-mono text-footnote text-label-tertiary">
                    {whereFoundLine(engine.cliDiagnosis)}
                  </p>
                )}
                {engine.cliDiagnosis.command !== null && (
                  <div className="mt-[8px]">
                    <CommandField command={engine.cliDiagnosis.command} />
                    {engine.cliDiagnosis.forward !== null && (
                      <p className="mt-[6px] text-footnote text-label-tertiary">
                        {engine.cliDiagnosis.forward}
                      </p>
                    )}
                  </div>
                )}
              </SettingsRow>

              {/* The engine she is NOT using, so switching is an informed choice
                  rather than a hope. */}
              <HealthRow
                check={{
                  id: 'engine-other',
                  label:
                    engine.active === 'cli'
                      ? `${PROVIDER_LABELS.api} (not in use)`
                      : `${PROVIDER_LABELS.cli} (not in use)`,
                  state: engine.active === 'cli' ? engine.api.state : engine.cli.state,
                  detail: engine.active === 'cli' ? engine.api.summary : engine.cli.summary,
                }}
                fix={{ label: 'Open Engine', onClick: () => onNavigate('engine') }}
              />
            </>
          )}
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          There is no automatic switching between the two. A failed engine says so and stops, so
          the same contract cannot produce a different answer on a different day.
        </p>
      </section>

      <section>
        <SectionHeader
          title="Recent failures"
          className="mb-[8px] px-[2px]"
          trailing={
            (health?.recentErrors.length ?? 0) > 0 ? (
              <span className="tabular text-footnote text-label-tertiary">
                {health?.recentErrors.length}
              </span>
            ) : undefined
          }
        />
        <Card padding="none" divided>
          {(health?.recentErrors.length ?? 0) === 0 ? (
            <p className="px-[12px] py-[14px] text-callout text-label-secondary">
              Nothing has failed. This list stays empty when the engine is behaving.
            </p>
          ) : (
            health?.recentErrors.map((row) => (
              <SettingsRow
                key={`${row.documentId}-${row.at}`}
                label={<span className="block truncate">{row.filename}</span>}
                description={row.message}
                control={
                  <Button
                    size="sm"
                    loading={retrying.has(row.documentId)}
                    onClick={() => void retry(row.documentId)}
                  >
                    Retry
                  </Button>
                }
              >
                <p className="tabular mt-[1px] font-mono text-footnote text-label-tertiary">
                  {row.code} {stamp(row.at)}
                </p>
              </SettingsRow>
            ))
          )}
        </Card>
      </section>

      <section>
        <SectionHeader title="Getting help" className="mb-[8px] px-[2px]" />
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button
            variant="primary"
            size="lg"
            icon={<ClipboardText size={14} />}
            loading={copying}
            onClick={() => void copyBundle()}
          >
            Copy support bundle
          </Button>
          <Button
            size="lg"
            variant="ghost"
            icon={<Archive size={14} />}
            onClick={() => onNavigate('data')}
          >
            Back up the data
          </Button>
        </div>
        {/* The one instruction this screen exists to give. */}
        <p className="mt-[8px] text-callout text-label-secondary">
          Copy the support bundle and paste it into an email to Ayush. It carries everything he
          needs to see what went wrong, so there is nothing else you have to describe.
        </p>
        <p className="mt-[4px] text-footnote text-label-tertiary">
          Environment, settings, engine health, counts, recent failures and the log, with
          anything that looks like a key or an address removed. It is not a backup -- Data is
          where a full copy of the contracts and PDFs comes from.
        </p>

        <div className="mt-[12px]">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showLog}
            aria-controls="diagnostics-log"
            icon={
              <CaretRight
                size={12}
                weight="bold"
                className={clsx(
                  'transition-transform duration-[var(--dur-fast)] ease-fast',
                  showLog && 'rotate-90',
                )}
              />
            }
            onClick={toggleLog}
          >
            Technical detail
          </Button>

          {showLog && (
            <div id="diagnostics-log" className="mt-[8px]">
              {/* The one legitimate well on this screen: a code block is what
                  --surface-sunken exists for. It carries no border of its own, so
                  the card's hairline stays the only edge. */}
              <Card padding="none" className="overflow-hidden">
                <div className="max-h-[280px] overflow-auto bg-sunken">
                  <pre className="whitespace-pre px-[12px] py-[10px] font-mono text-footnote leading-[16px] text-label-secondary">
                    {logFailure ??
                      (log === null
                        ? 'Reading the log...'
                        : log.length > 0
                          ? log
                          : 'The log is empty.')}
                  </pre>
                </div>
              </Card>
              <div className="mt-[6px] flex items-center gap-[6px] px-[2px]">
                <p className="min-w-0 flex-1 text-footnote text-label-tertiary">
                  The last 200 lines, with anything that looks like a key or an address
                  removed. The support bundle already carries these, so there is nothing to
                  copy out of here.
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={logLoading}
                  onClick={() => void loadLog()}
                >
                  Reload
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------- pieces ---------------------------------- */

/**
 * The exact Terminal line with a copy button. Nobody using this screen is expected
 * to run it -- the assumption is that it gets pasted into a message -- so it has to
 * be selectable and complete on its own.
 */
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
