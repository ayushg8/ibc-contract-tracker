'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  CheckCircle,
  ClipboardText,
  FolderOpen,
  Play,
  WarningCircle,
} from '@phosphor-icons/react';

import { StateDot } from '@/components/settings/HealthRow';
import { Button, Card, Input, SecretInput, Segmented, Spinner, useToast } from '@/components/ui';
import type { SecretValidity, SegmentedOption } from '@/components/ui';
import { api, copySupportBundle } from '@/lib/client/api';
import { refreshHealth, useSettings } from '@/lib/client/useSettings';
import {
  clearProgress,
  cliCaseForCode,
  cliCaseInfoFor,
  fetchEngineHealth,
  fetchWatchStatus,
  folderPathFromDrop,
  FOLDER_PATH_HINT,
  normalizeFolderPath,
  readProgress,
  runEngineTest,
  whereFoundLine,
  writeProgress,
  type CliDiagnosis,
  type EngineHealthResponse,
  type EngineTestOutcome,
  type WatchProbe,
} from '@/lib/engine-diagnosis';
import type { ProviderId } from '@/lib/db/types';
import type { RemedyAction, SerialisedEngineError } from '@/lib/providers/errors';
import { MODELS, PROVIDER_LABELS } from '@/lib/providers/types';
import type { ProviderHealth } from '@/lib/providers/types';

const PROVIDER_OPTIONS: readonly SegmentedOption<ProviderId>[] = [
  { value: 'cli', label: PROVIDER_LABELS.cli },
  { value: 'api', label: PROVIDER_LABELS.api },
];

/** What is honestly known while the sample is in flight. Mirrors the Engine tab. */
const STAGES = [
  'Sending the sample agreement',
  'Waiting for Claude to read it',
  'Checking the quotes against the text',
] as const;

const STEPS = ['Welcome', 'Engine', 'Test', 'Watch folder', 'Done'] as const;

const STEP_ENGINE = 1;
const STEP_TEST = 2;
const STEP_FOLDER = 3;
const LAST = STEPS.length - 1;

/**
 * Longer than the server's own deadline for a CLI run, so this only ever fires when
 * the request itself is lost. A spinner with no end is the failure mode this step
 * exists to prevent.
 */
const TEST_DEADLINE_MS = 200_000;

/** A run on the Claude subscription has no marginal cost; "$0.000" reads like a bug. */
function cost(usd: number | null): string {
  if (usd === null) return '';
  return usd === 0 ? ' - no charge' : ` - $${usd.toFixed(3)}`;
}

/**
 * Five steps, none of them a wall: every one can be skipped and every one is
 * reachable again from Settings. The wizard's job is to get her to a working
 * first extraction, not to collect a form.
 *
 * Two rules run through all of it. Nothing may leave her holding a failure with no
 * next action -- where the fix is a Terminal command she is given the exact line, a
 * copy button and the sentence about who to send it to. And nothing may leave her
 * stranded: setup can be abandoned at any step, position is remembered so closing
 * the window resumes rather than restarts, and drag-and-drop is a complete way to
 * use the app whether or not a folder is ever chosen.
 */
export function Wizard() {
  const router = useRouter();
  const { settings, save } = useSettings();
  const { toast } = useToast();

  const [step, setStep] = useState(0);
  const [restored, setRestored] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishFailure, setFinishFailure] = useState<string | null>(null);

  const [engine, setEngine] = useState<EngineHealthResponse | null>(null);
  const [engineLoading, setEngineLoading] = useState(false);
  const [engineFailure, setEngineFailure] = useState<SerialisedEngineError | null>(null);

  const [keyDraft, setKeyDraft] = useState('');
  const [validity, setValidity] = useState<SecretValidity>('unknown');
  const [keyDetail, setKeyDetail] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<EngineTestOutcome | null>(null);
  const [testError, setTestError] = useState<SerialisedEngineError | null>(null);
  // The probe's verdict on the failure this run reported, when it had one. Held
  // beside the error because the code alone cannot name the case -- see below.
  const [testDiagnosis, setTestDiagnosis] = useState<CliDiagnosis | null>(null);
  const [testPassed, setTestPassed] = useState(false);
  const autoTested = useRef(false);
  const testAbort = useRef<AbortController | null>(null);

  const [watch, setWatch] = useState<WatchProbe | null>(null);
  const [folderDraft, setFolderDraft] = useState('');
  const [folderSaving, setFolderSaving] = useState(false);
  const [folderFailure, setFolderFailure] = useState<string | null>(null);

  const provider: ProviderId = settings?.provider ?? 'cli';
  const active: ProviderHealth | null =
    engine === null ? null : provider === 'cli' ? engine.cli : engine.api;
  const diagnosis = engine?.cliDiagnosis ?? null;
  const engineOk = active?.state === 'ok';

  /* ---------------------------- resumability ----------------------------- */

  // Restored once, before anything is written back, so a first render cannot
  // overwrite the position with step 0. Position only: whether setup is COMPLETE
  // is a server-side setting, so a stale browser can never claim she finished.
  useEffect(() => {
    const saved = readProgress(LAST);
    if (saved !== null) {
      setStep(saved.step);
      setTestPassed(saved.testPassed);
      // The proof already happened. Re-running it on arrival would spend a request
      // to tell her something she was told before she closed the window.
      if (saved.testPassed) autoTested.current = true;
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    writeProgress({ step, testPassed });
  }, [restored, step, testPassed]);

  useEffect(() => {
    setFolderDraft(settings?.watchFolder ?? '');
  }, [settings?.watchFolder]);

  /* ------------------------------- engine -------------------------------- */

  // Returns what it read as well as storing it: the Test step needs the CLI
  // verdict in the same render as the failure it explains.
  const loadEngine = useCallback(async (): Promise<EngineHealthResponse | null> => {
    setEngineLoading(true);
    const outcome = await fetchEngineHealth();
    setEngineLoading(false);
    if (outcome.error !== undefined) {
      setEngineFailure(outcome.error);
      return null;
    }
    setEngineFailure(null);
    setEngine(outcome.data);
    return outcome.data;
  }, []);

  // Arriving on the engine step is the moment to look, not a minute later.
  useEffect(() => {
    if (!restored || step !== STEP_ENGINE) return;
    void loadEngine();
  }, [restored, step, loadEngine]);

  const chooseProvider = useCallback(
    async (next: ProviderId) => {
      if (next === provider) return;
      setResult(null);
      setTestError(null);
      setTestPassed(false);
      await save({ provider: next });
      // The sidebar pill reads the shared health store, which is now stale.
      refreshHealth();
      void loadEngine();
    },
    [provider, save, loadEngine],
  );

  /* -------------------------------- test --------------------------------- */

  useEffect(() => {
    if (!testing) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [testing]);

  const runTest = useCallback(async () => {
    testAbort.current?.abort();
    const controller = new AbortController();
    testAbort.current = controller;
    // Belt and braces: the route has its own deadline, but a request that never
    // comes back would otherwise leave the stage list spinning for ever.
    const deadline = setTimeout(() => controller.abort(), TEST_DEADLINE_MS);

    setTesting(true);
    setResult(null);
    setTestError(null);
    setTestDiagnosis(null);

    const outcome = await runEngineTest(controller.signal);
    clearTimeout(deadline);
    if (testAbort.current !== controller) return;

    // A run can fail either way round: the route answers with the failure inside a
    // normal reply, or the request itself never lands.
    const failure = outcome.error ?? outcome.data?.error ?? null;

    // Whatever the test just proved or disproved is now the freshest thing known
    // about the engine, and both the status block and the sidebar should say so.
    //
    // It is AWAITED when the failure is a Claude Code setup fault, because then the
    // probe's verdict decides which sentence she is shown. CLI_NOT_FOUND is
    // reported both by a Mac without Claude Code and by one where it exists but
    // this app cannot reach it, and "install it" is the wrong instruction for the
    // second -- one step after the Engine step told her it is installed. Resolving
    // it before anything renders means the wrong sentence is never shown at all.
    let verdict: CliDiagnosis | null = null;
    if (failure !== null && cliCaseForCode(failure.code) !== null) {
      const health = await loadEngine();
      if (testAbort.current !== controller) return;
      const diagnosed = health?.cliDiagnosis ?? null;
      verdict = diagnosed !== null && diagnosed.code === failure.code ? diagnosed : null;
    } else {
      void loadEngine();
    }

    testAbort.current = null;
    setTesting(false);
    setResult(outcome.data ?? null);
    setTestError(failure);
    setTestDiagnosis(verdict);
    setTestPassed(outcome.data?.ok === true);
    refreshHealth();
  }, [loadEngine]);

  // The test runs itself once, because the point of the step is the proof.
  useEffect(() => {
    if (!restored || step !== STEP_TEST || autoTested.current) return;
    autoTested.current = true;
    void runTest();
  }, [restored, step, runTest]);

  // A wizard that is left mid-test must not keep a request alive behind it.
  useEffect(() => () => testAbort.current?.abort(), []);

  function stopTest() {
    testAbort.current?.abort();
    testAbort.current = null;
    setTesting(false);
    setTestError(null);
    setTestDiagnosis(null);
    setResult(null);
  }

  /* ------------------------------ watch folder --------------------------- */

  useEffect(() => {
    if (!restored || step !== STEP_FOLDER) return;
    let live = true;
    void fetchWatchStatus().then((probe) => {
      if (live) setWatch(probe);
    });
    return () => {
      live = false;
    };
  }, [restored, step]);

  /**
   * A drop is offered but never promised: Chrome hands a page the bytes of a
   * dragged file and not its location, so most folder drags carry no path at all.
   * When one does not, she gets the Finder move that always works rather than
   * silence. preventDefault regardless -- a folder dropped on a page that ignores
   * it navigates Chrome away from the app and loses her place in setup.
   */
  function dropFolder(event: DragEvent<HTMLInputElement>) {
    event.preventDefault();
    const dropped = folderPathFromDrop(event.dataTransfer);
    if (dropped === null) {
      toast({
        title: 'That drop did not carry a folder location',
        description: FOLDER_PATH_HINT,
        tone: 'warn',
      });
      return;
    }
    setFolderDraft(dropped);
  }

  async function saveFolder() {
    // Everything Finder and Terminal put on a clipboard reduces to a plain path
    // here, so a pasted file:// URL is not rejected as a folder that does not exist.
    const next = normalizeFolderPath(folderDraft);
    if (next.length === 0) {
      setFolderFailure(null);
      setStep(LAST);
      return;
    }
    setFolderSaving(true);
    const failure = await save({ watchFolder: next });
    setFolderSaving(false);
    if (failure !== null) {
      setFolderFailure(failure.message);
      return;
    }
    setFolderFailure(null);
    setStep(LAST);
  }

  /* --------------------------------- key --------------------------------- */

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
      setKeyDraft('');
      refreshHealth();
      void loadEngine();
    }
  }

  /* -------------------------------- finish -------------------------------- */

  async function finish() {
    setFinishing(true);
    setFinishFailure(null);
    // Recorded even if every step was skipped: she has seen the tour, and the
    // wizard is not a gate she has to pass to use the app.
    const failure = await save({ onboardingComplete: true });
    setFinishing(false);
    if (failure !== null) {
      // Do NOT navigate away pretending this stuck. The position stays saved, so
      // reopening resumes here rather than starting the tour again.
      setFinishFailure(failure.message);
      return;
    }
    clearProgress();
    router.replace('/inbox');
  }

  /** Turns a remedy from the error taxonomy into something this wizard can do. */
  function handlerFor(action: RemedyAction): (() => void) | null {
    switch (action) {
      case 'retry':
      case 'wait-and-retry':
        return () => void runTest();
      case 'switch-to-api':
      case 'enter-api-key':
        return () => {
          void chooseProvider('api');
          setStep(STEP_ENGINE);
        };
      case 'switch-to-cli':
        return () => {
          void chooseProvider('cli');
          setStep(STEP_ENGINE);
        };
      case 'open-engine-settings':
        return () => setStep(STEP_ENGINE);
      case 'open-folder-settings':
      case 'choose-folder':
        return () => setStep(STEP_FOLDER);
      case 'contact-support':
        return () => {
          void copySupportBundle().then((r) =>
            toast({
              title: r.error === undefined ? 'Support bundle copied' : 'The bundle was not copied',
              description:
                r.error === undefined ? 'Paste it into an email to Ayush.' : r.error.message,
              tone: r.error === undefined ? 'ok' : 'bad',
            }),
          );
        };
      case 'install-cli':
      case 'login-cli':
      case 'update-cli':
      case 'reveal-file':
      case 'enter-manually':
      case 'none':
        // Nothing to press: the Terminal command beside it is the whole fix.
        return null;
    }
  }

  /* -------------------------------- render -------------------------------- */

  // The probe's verdict when there is one, the code's best guess when there is not.
  const testCaseInfo = cliCaseInfoFor(testError?.code, testDiagnosis);

  return (
    // A content-layer card on the canvas, not glass: the wizard holds text she
    // has to read and decide on, and the HIG keeps glass out of the content layer.
    <Card
      padding="lg"
      elevated
      className="flex max-h-full w-full max-w-[540px] flex-col gap-[16px] overflow-y-auto"
    >
      <div
        className="flex items-center gap-[6px]"
        role="img"
        aria-label={`Step ${step + 1} of ${STEPS.length}`}
      >
        {STEPS.map((label, index) => (
          <span
            key={label}
            className={clsx(
              'block h-[6px] rounded-full transition-all duration-[var(--dur-fast)] ease-fast',
              index === step ? 'w-[18px]' : 'w-[6px]',
              index <= step ? 'bg-accent' : 'bg-label-quaternary',
            )}
          />
        ))}
        <div className="flex-1" />
        <span className="text-footnote text-label-tertiary">{STEPS[step]}</span>
      </div>

      {step === 0 && (
        <Step
          title="Let's set up your contract tracker"
          body="Drop a signed NDA in, check what Claude read, and it lands in a searchable repository you can export to your workbook."
        >
          <ul className="flex flex-col gap-[6px] text-callout text-label-secondary">
            <Bullet>Nothing is saved until you approve it.</Bullet>
            <Bullet>Every value shows the sentence it came from.</Bullet>
            <Bullet>Two clocks per record: the agreement and the confidentiality duty.</Bullet>
          </ul>
          <p className="text-footnote text-label-tertiary">
            Four short steps. You can stop anywhere and pick up where you left off.
          </p>
        </Step>
      )}

      {step === STEP_ENGINE && (
        <Step
          title="Which engine should read the documents?"
          body="Both read the same way and cite the same way. They differ in what they cost you and what they can open."
        >
          <Segmented
            options={PROVIDER_OPTIONS}
            value={provider}
            onChange={(next) => void chooseProvider(next)}
            ariaLabel="Engine"
            fullWidth
          />

          {/* The choice made legible: what each one needs, costs and cannot do.
              Scans are NOT the difference between them -- see the line below. */}
          <Group>
            <Fact
              label="Claude subscription"
              value="No key to manage. Nothing per document. Needs Claude Code installed and signed in, and it stops when your subscription hits its limit."
              selected={provider === 'cli'}
            />
            <Fact
              label="API key"
              value="Roughly 1-3 cents a contract, billed to the Anthropic account. No usage cap, and it can read a scan too faint to machine-read by looking at the page itself."
              selected={provider === 'api'}
            />
          </Group>

          <p className="text-footnote text-label-tertiary">
            Scanned pages are machine-read here on this Mac before either engine sees them, so a
            scan is not a reason to need the API key. Only a scan too poor to machine-read is.
          </p>

          <p className="text-footnote text-label-tertiary">
            The tracker never switches between these on its own. If the one you pick fails, it
            says so and stops - so the same contract cannot quietly produce a different answer
            on a different day.
          </p>

          <Group>
            <div className="flex items-center gap-[10px] py-[10px]">
              {engineLoading && active === null ? (
                <Spinner size={13} />
              ) : engineOk ? (
                <CheckCircle size={16} weight="fill" className="shrink-0 text-ok" />
              ) : (
                <StateDot state={active?.state ?? 'unknown'} />
              )}
              <p className="min-w-0 flex-1 truncate text-body text-label">
                {engineFailure?.message ?? active?.summary ?? 'Looking for Claude...'}
              </p>
              <Button size="sm" loading={engineLoading} onClick={() => void loadEngine()}>
                Recheck
              </Button>
            </div>

            {active?.checks.map((check) => (
              <div key={check.id} className="flex items-center gap-[10px] py-[8px]">
                <StateDot state={check.state} />
                <span
                  title={`${check.label}: ${check.detail}`}
                  className="min-w-0 flex-1 truncate text-callout text-label-secondary"
                >
                  {check.label}: {check.detail}
                </span>
              </div>
            ))}
          </Group>

          {/* One of five sentences, never "Claude CLI error". */}
          {provider === 'cli' && diagnosis !== null && (
            <div className="flex flex-col gap-[8px]">
              <div>
                <p className="text-callout text-label">{diagnosis.title}</p>
                <p className="mt-[2px] text-callout text-label-secondary">{diagnosis.what}</p>
                {diagnosis.neededDeepProbe && whereFoundLine(diagnosis) !== null && (
                  <p className="mt-[2px] text-footnote text-label-tertiary">
                    {whereFoundLine(diagnosis)}
                  </p>
                )}
              </div>
              {diagnosis.command !== null && (
                <CommandBlock command={diagnosis.command} forward={diagnosis.forward} />
              )}
              {diagnosis.command === null && diagnosis.forward !== null && (
                <p className="text-footnote text-label-tertiary">{diagnosis.forward}</p>
              )}
              {diagnosis.remedy !== null && (
                <RemedyRow remedy={diagnosis.remedy} handlerFor={handlerFor} />
              )}
            </div>
          )}

          {provider === 'api' && (
            <div>
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
                  Check
                </Button>
              </div>
              <p
                className={clsx(
                  'mt-[6px] text-callout',
                  validity === 'invalid' ? 'text-bad' : 'text-label-secondary',
                )}
              >
                {keyDetail ?? 'The key is tried once before it is stored in the keychain.'}
              </p>
            </div>
          )}
        </Step>
      )}

      {step === STEP_TEST && (
        <Step
          title="Let's read one"
          body={`A short sample agreement, end to end, on ${MODELS[settings?.tier ?? 'balanced'].label}. This is the whole pipeline, not a ping.`}
        >
          {testing && (
            <>
              <ol className="flex flex-col gap-[6px]">
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
              <Button size="sm" className="self-start" onClick={stopTest}>
                Stop
              </Button>
            </>
          )}

          {/* The outcome is a line of text with an icon, not a card inside a
              card: the result IS the content of this step. */}
          {!testing && result !== null && (
            <div className="flex items-start gap-[8px]">
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
                {result.ok ? (
                  <p className="mt-[2px] text-callout text-label-secondary">
                    That is the whole path working: engine, document, quotes checked against the
                    text.
                  </p>
                ) : (
                  testError === null && (
                    // It answered and nothing threw, but not one quote could be found
                    // in the sample. Nothing was kept. Saying so is the point: this is
                    // the check that stops a confident wrong answer reaching a record.
                    <p className="mt-[2px] text-callout text-label-secondary">
                      It replied, but none of its quotes could be found in the sample, so nothing
                      was kept. Run it again - if it keeps happening, send the support bundle from
                      Settings.
                    </p>
                  )
                )}
              </div>
            </div>
          )}

          {/* Whatever went wrong, she gets the same five-way answer she got on the
              Engine step - the same sentence, the same command, the same button. */}
          {!testing && testError !== null && (
            <div className="flex items-start gap-[8px]">
              <WarningCircle size={16} weight="fill" className="mt-[1px] shrink-0 text-bad" />
              <div className="min-w-0 flex-1 flex flex-col gap-[8px]">
                <div>
                  {/* The case's own headline, not the code's. They differ exactly
                      where the code is ambiguous, and that is the case that
                      contradicted the previous step. */}
                  <p className="text-callout text-label">
                    {testCaseInfo?.title ?? testError.message}
                  </p>
                  {testCaseInfo !== null && (
                    <p className="mt-[2px] text-callout text-label-secondary">
                      {testCaseInfo.what}
                    </p>
                  )}
                  {testDiagnosis !== null &&
                    testDiagnosis.neededDeepProbe &&
                    whereFoundLine(testDiagnosis) !== null && (
                      <p className="mt-[2px] text-footnote text-label-tertiary">
                        {whereFoundLine(testDiagnosis)}
                      </p>
                    )}
                  {testCaseInfo === null && (
                    <p className="mt-[2px] text-footnote text-label-tertiary">
                      Nothing was saved. You can carry on and sort this out in Settings.
                    </p>
                  )}
                </div>
                {testCaseInfo?.command != null && (
                  <CommandBlock command={testCaseInfo.command} forward={testCaseInfo.forward} />
                )}
                {testCaseInfo !== null &&
                  testCaseInfo.command === null &&
                  testCaseInfo.forward !== null && (
                    <p className="text-footnote text-label-tertiary">{testCaseInfo.forward}</p>
                  )}
                <RemedyRow remedy={testError.remedy} handlerFor={handlerFor} />
              </div>
            </div>
          )}

          {!testing && result === null && testError === null && testPassed && (
            <p className="text-callout text-label-secondary">
              This already passed earlier in setup. Run it again if you want to see it.
            </p>
          )}

          {!testing && (
            <Button
              size="sm"
              className="self-start"
              icon={<Play size={12} weight="fill" />}
              onClick={() => void runTest()}
            >
              {result === null && testError === null ? 'Run the test' : 'Run it again'}
            </Button>
          )}
        </Step>
      )}

      {step === STEP_FOLDER && (
        <Step
          title="Where do the PDFs live?"
          body="Optional. Anything dropped in this folder gets picked up on its own - but dragging files onto the Inbox works just as well, and always will."
        >
          <Input
            mono
            value={folderDraft}
            placeholder="/Users/you/IBC/NDAs"
            aria-label="Watch folder"
            disabled={folderSaving}
            icon={<FolderOpen size={13} />}
            onChange={(event) => setFolderDraft(event.target.value)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={dropFolder}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void saveFolder();
            }}
          />
          {folderFailure !== null && <p className="text-callout text-bad">{folderFailure}</p>}

          {watch !== null && watch.available && (
            <Group>
              <Fact
                label="Watching"
                value={watch.status.running ? 'Running' : 'Not running yet'}
              />
              <Fact label="Folder" value={watch.status.folder ?? 'Not set'} mono />
              <Fact label="Last checked" value={stamp(watch.status.lastScanAt)} />
              <Fact label="Picked up" value={`${watch.status.ingested}`} />
              {watch.status.lastError !== null && (
                <Fact label="Last problem" value={watch.status.lastError} tone="bad" />
              )}
            </Group>
          )}

          {/* No picker is promised here. This app is a page in a browser, and a
              page is handed the bytes of a file, never its location -- so the only
              honest answer is the Finder move that puts a path on the clipboard. */}
          <p className="text-footnote text-label-tertiary">
            {watch !== null && !watch.available
              ? `${watch.message} Set the folder anyway - it will start being watched as soon as that is switched on.`
              : `The folder has to exist and be readable. ${FOLDER_PATH_HINT}`}
          </p>
        </Step>
      )}

      {step === LAST && (
        <Step
          title="You're set up"
          body="Drop a signed NDA into the Inbox and check what comes back."
        >
          <Group>
            <Fact label="Engine" value={PROVIDER_LABELS[provider]} />
            <Fact label="Model" value={MODELS[settings?.tier ?? 'balanced'].label} />
            <Fact label="Watch folder" value={settings?.watchFolder ?? 'Not set'} mono />
            <Fact
              label="Test extraction"
              value={testPassed ? 'Passed' : 'Not proven yet'}
              tone={testPassed ? 'ok' : 'quiet'}
            />
          </Group>

          {!testPassed && (
            <p className="text-callout text-label-secondary">
              The engine has not read anything yet. You can still drag documents in - if the
              engine cannot read them the Inbox will say exactly why, and Settings has this same
              test.
            </p>
          )}

          {finishFailure !== null && (
            <p className="text-callout text-bad">{finishFailure}</p>
          )}

          <p className="text-footnote text-label-tertiary">
            Every one of these steps is in Settings, and the test can be run again any time.
          </p>
        </Step>
      )}

      <footer className="flex items-center gap-[8px] pt-[4px]">
        {step > 0 && (
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </Button>
        )}
        <div className="flex-1" />
        {step < LAST && (
          <Button variant="ghost" onClick={() => setStep(LAST)}>
            Skip setup
          </Button>
        )}
        {step === LAST && finishFailure !== null && (
          <Button variant="ghost" onClick={() => router.replace('/inbox')}>
            Open it anyway
          </Button>
        )}
        {step === STEP_FOLDER ? (
          <Button variant="primary" loading={folderSaving} onClick={() => void saveFolder()}>
            {folderDraft.trim().length > 0 ? 'Use this folder' : 'Continue'}
          </Button>
        ) : step === LAST ? (
          <Button variant="primary" loading={finishing} onClick={() => void finish()}>
            Open the Inbox
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setStep((s) => Math.min(LAST, s + 1))}>
            {step === 0 ? 'Get started' : 'Continue'}
          </Button>
        )}
      </footer>
    </Card>
  );
}

/* -------------------------------- pieces ---------------------------------- */

function stamp(iso: string | null): string {
  if (iso === null) return 'Never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(ms));
}

/**
 * A grouped list INSIDE the wizard card. Rules top and bottom, a rule between
 * rows, and no background, border or radius of its own -- a bordered box inside
 * a bordered card is the nesting this rebuild removed everywhere else.
 */
function Group({ children }: { children: ReactNode }) {
  return <div className="hairline-t hairline-b divide-y-[0.5px] divide-separator">{children}</div>;
}

function Step({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[12px]">
      <div>
        <h1 className="text-title-1 font-semibold text-label">{title}</h1>
        <p className="mt-[4px] text-body text-label-secondary">{body}</p>
      </div>
      {children}
    </div>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-[6px]">
      <CheckCircle size={14} weight="fill" className="mt-[1px] shrink-0 text-ok" />
      <span>{children}</span>
    </li>
  );
}

/**
 * One labelled line. Long values wrap rather than truncate -- these are sentences
 * she has to weigh, not identifiers she has to recognise.
 */
function Fact({
  label,
  value,
  mono,
  tone,
  selected,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'bad' | 'quiet';
  selected?: boolean;
}) {
  return (
    <div className="flex min-h-[36px] items-start gap-[10px] py-[8px]">
      <span
        className={clsx(
          'w-[124px] shrink-0 text-callout',
          selected === true ? 'font-medium text-label' : 'text-label-secondary',
        )}
      >
        {label}
      </span>
      <span
        className={clsx(
          'min-w-0 flex-1 text-callout',
          mono === true && 'break-all font-mono',
          tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'quiet' ? 'text-label-tertiary' : 'text-label',
        )}
      >
        {value}
      </span>
    </div>
  );
}

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
    <div className="flex flex-wrap items-center gap-[8px]">
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

/**
 * The exact line, a copy button, and who to send it to.
 *
 * She will not open Terminal and this pretends otherwise nowhere. The copy button
 * is the actual affordance: the assumption is that the line goes into a message to
 * Ayush, so it has to be selectable, copyable and complete on its own.
 */
function CommandBlock({ command, forward }: { command: string; forward: string | null }) {
  const { toast } = useToast();
  return (
    <div>
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
      {forward !== null && (
        <p className="mt-[6px] text-footnote text-label-tertiary">{forward}</p>
      )}
    </div>
  );
}
