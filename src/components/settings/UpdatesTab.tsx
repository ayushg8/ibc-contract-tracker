'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ArrowUUpLeft,
  CheckCircle,
  Circle,
  CloudArrowDown,
  Warning,
  Wrench,
} from '@phosphor-icons/react';
import { motion } from 'motion/react';

import { SettingsRow } from '@/components/settings/SettingsRow';
import {
  Button,
  Card,
  DataList,
  Pill,
  ProgressBar,
  SectionHeader,
  SPRING_SNAPPY,
  useToast,
} from '@/components/ui';
// Types only, from two modules that import nothing from node:. `import type` is
// erased at compile time, so coding against the real unions costs the browser
// bundle nothing -- and a phase added upstream breaks this file's exhaustive
// maps at build time instead of printing a slug at Bonnie.
import type { DeferReason, UpdatePhase } from '@/lib/update/types';
import type { RepairPhase } from '@/lib/repair/types';

/* ────────────────────────────── the contract ──────────────────────────── */

/*
 * GET  /api/update                     -> UpdateStatus
 * POST /api/update {action:'check'}    -> { accepted, deferred, status }
 * POST /api/update {action:'apply'}    -> same
 * POST /api/update {action:'rollback'} -> same
 * GET  /api/repair                     -> RepairStatus, or 404 while unbuilt
 *
 * Read into the local shapes below rather than cast into the upstream ones.
 * Two agents own the two ends of this, the answer arrives over a wire, and a
 * field that is missing or the wrong type has to read as "not known" -- never
 * as a screen that throws while an update is installing.
 */

export interface AvailableView {
  version: string;
  publishedAt: string | null;
  sizeBytes: number | null;
  notes: string | null;
  critical: boolean;
  /** False when this copy is too old to take it directly. */
  applicable: boolean;
  blockedReason: string | null;
}

export interface ProgressView {
  phase: UpdatePhase;
  version: string | null;
  note: string | null;
  /** False once the process doing the work has gone. */
  alive: boolean;
}

export interface ResultView {
  ok: boolean;
  /** The version that was being installed, not necessarily the one running. */
  version: string;
  fromVersion: string | null;
  finishedAt: string | null;
  failure: {
    message: string;
    detail: string | null;
    /** The version put back. Null means no rollback was attempted. */
    rolledBackTo: string | null;
    rollbackOk: boolean;
  } | null;
}

export interface UpdateView {
  currentVersion: string;
  /** False in a development checkout, or an install we cannot write to. */
  supported: boolean;
  unsupportedReason: string | null;
  source: {
    configured: boolean;
    label: string;
    /** Whether this Mac is allowed to apply an update without being asked. */
    autoApply: boolean;
    checkIntervalHours: number;
  };
  available: AvailableView | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  phase: UpdatePhase;
  progress: ProgressView | null;
  lastResult: ResultView | null;
  previousVersion: string | null;
  canRollback: boolean;
  busy: { reason: DeferReason; detail: string } | null;
}

export interface RepairView {
  phase: RepairPhase;
  /** When a run paused on Claude's usage limit picks up again. */
  resumeAt: string | null;
  scheduled: boolean;
  attemptsUsed: number;
  attemptCap: number;
  emergency: boolean;
}

/* ─────────────────────────── reading the wire ─────────────────────────── */

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function flag(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function count(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Every phase the updater can report. Exhaustive by construction: the key type
 * is the upstream union, so a phase added there fails the build here rather
 * than reaching her as the word "swapping".
 */
const PHASE_WORDS: Record<UpdatePhase, string> = {
  idle: 'Working',
  checking: 'Looking for a new version',
  starting: 'Getting ready',
  downloading: 'Downloading',
  verifying: 'Checking the download is genuine',
  unpacking: 'Unpacking',
  swapping: 'Putting the new version in place',
  restarting: 'Restarting the tracker',
  'health-check': 'Making sure it came back up',
  'rolling-back': 'Putting the previous version back',
  done: 'Finished',
  failed: 'Stopped',
};

/** The phases where something is actually happening and the screen must wait. */
const SETTLED: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>(['idle', 'done', 'failed']);

function toPhase(value: unknown): UpdatePhase {
  return typeof value === 'string' && value in PHASE_WORDS ? (value as UpdatePhase) : 'idle';
}

const DEFER_WORDS: Record<DeferReason, string> = {
  'queue-busy': 'The tracker is in the middle of reading a contract. Try again in a minute.',
  'apply-in-progress': 'An update is already being installed.',
  'nothing-available': 'There is nothing newer to install.',
  'not-applicable': 'This copy needs a fresh install to take that version.',
  unsupported: 'This copy cannot update itself.',
};

function toDeferReason(value: unknown): DeferReason | null {
  return typeof value === 'string' && value in DEFER_WORDS ? (value as DeferReason) : null;
}

const REPAIR_WORDS: Record<RepairPhase, string> = {
  idle: '',
  preparing: 'A fix is being prepared automatically. There is nothing for you to do.',
  consulting: 'A fix is being written automatically. There is nothing for you to do.',
  gating: 'A fix has been written and is being tested before it goes anywhere near this copy.',
  promoting: 'A fix passed its tests and is being put in place.',
  'waiting-limit': 'The fix is paused until Claude is available again. It carries on by itself.',
  succeeded: 'A fix was found and is already in place.',
  failed: 'That attempt at a fix did not work. Another one follows on its own.',
  refused: 'No automatic fix was attempted for this. Ayush will look at it himself.',
  exhausted: 'The automatic fix did not work. Ayush will look at this himself.',
  emergency: 'This one needs Ayush. None of your contracts were touched.',
};

function toRepairPhase(value: unknown): RepairPhase {
  return typeof value === 'string' && value in REPAIR_WORDS ? (value as RepairPhase) : 'idle';
}

export function toUpdateView(value: unknown): UpdateView | null {
  const root = record(value);
  if (root === null) return null;
  const currentVersion = text(root, 'currentVersion');
  if (currentVersion === null) return null;

  const sourceRaw = record(root['source']);
  const kind = sourceRaw === null ? null : text(sourceRaw, 'kind');
  const hours = sourceRaw === null ? null : count(sourceRaw, 'checkIntervalHours');

  const availableRaw = record(root['available']);
  const availableVersion = availableRaw === null ? null : text(availableRaw, 'version');
  const available: AvailableView | null =
    availableRaw === null || availableVersion === null
      ? null
      : {
          version: availableVersion,
          publishedAt: text(availableRaw, 'publishedAt'),
          sizeBytes: count(availableRaw, 'sizeBytes'),
          notes: text(availableRaw, 'notes'),
          critical: flag(availableRaw, 'critical', false),
          // Assume it cannot be applied unless the server says it can. The safe
          // direction: offering a button that cannot work is the worse mistake.
          applicable: flag(availableRaw, 'applicable', false),
          blockedReason: text(availableRaw, 'blockedReason'),
        };

  const progressRaw = record(root['progress']);
  const progress: ProgressView | null =
    progressRaw === null
      ? null
      : {
          phase: toPhase(progressRaw['phase']),
          version: text(progressRaw, 'version'),
          note: text(progressRaw, 'note'),
          alive: flag(progressRaw, 'alive', true),
        };

  const resultRaw = record(root['lastResult']);
  const resultVersion = resultRaw === null ? null : text(resultRaw, 'version');
  const failureRaw = resultRaw === null ? null : record(resultRaw['failure']);
  const failureMessage = failureRaw === null ? null : text(failureRaw, 'message');
  const lastResult: ResultView | null =
    resultRaw === null || resultVersion === null
      ? null
      : {
          ok: flag(resultRaw, 'ok', false),
          version: resultVersion,
          fromVersion: text(resultRaw, 'fromVersion'),
          finishedAt: text(resultRaw, 'finishedAt'),
          failure:
            failureRaw === null || failureMessage === null
              ? null
              : {
                  message: failureMessage,
                  detail: text(failureRaw, 'detail'),
                  rolledBackTo: text(failureRaw, 'rolledBackTo'),
                  rollbackOk: flag(failureRaw, 'rollbackOk', false),
                },
        };

  const versions = root['installedVersions'];
  // Newest first, so the second entry is what a rollback would return to.
  const previous =
    Array.isArray(versions) && typeof versions[1] === 'string' ? versions[1] : null;

  const busyRaw = record(root['busy']);
  const busyReason = busyRaw === null ? null : toDeferReason(busyRaw['reason']);

  const checkErrorRaw = record(root['lastCheckError']);

  return {
    currentVersion,
    supported: flag(root, 'supported', true),
    unsupportedReason: text(root, 'unsupportedReason'),
    source: {
      configured: kind !== null && kind !== 'none',
      label: sourceRaw === null ? 'Not configured' : (text(sourceRaw, 'label') ?? 'Not configured'),
      autoApply: sourceRaw === null ? false : flag(sourceRaw, 'automatic', false),
      checkIntervalHours: hours !== null && hours > 0 ? hours : 24,
    },
    available,
    lastCheckedAt: text(root, 'lastCheckedAt'),
    lastCheckError: checkErrorRaw === null ? null : text(checkErrorRaw, 'message'),
    phase: toPhase(root['phase']),
    progress,
    lastResult,
    previousVersion: previous,
    canRollback: flag(root, 'canRollback', false) && previous !== null,
    busy: busyRaw === null || busyReason === null
      ? null
      : { reason: busyReason, detail: text(busyRaw, 'detail') ?? DEFER_WORDS[busyReason] },
  };
}

export function toRepairView(value: unknown): RepairView | null {
  const root = record(value);
  if (root === null) return null;
  const phase = toRepairPhase(root['phase']);
  if (phase === 'idle') return null;
  const emergency = record(root['emergency']);
  return {
    phase,
    resumeAt: text(root, 'resumeAt'),
    scheduled: flag(root, 'scheduled', false),
    attemptsUsed: count(root, 'attemptsUsed') ?? 0,
    attemptCap: count(root, 'attemptCap') ?? 0,
    emergency: emergency !== null,
  };
}

/* ───────────────────────────── plain words ───────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `now` to `when`. Positive is the future. */
function daysAway(when: Date, now: Date): number {
  return Math.round((startOfDay(when) - startOfDay(now)) / DAY_MS);
}

function clockOf(when: Date): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(when);
}

/**
 * "yesterday at 14:05", "on Monday", "on 11 August". A date on this screen is
 * always an aside -- the answer she wants is "up to date", not a timestamp --
 * so it is written the way it would be said out loud.
 */
export function describeWhen(iso: string | null, now: Date = new Date()): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const when = new Date(ms);
  const days = daysAway(when, now);
  if (days === 0) return `today at ${clockOf(when)}`;
  if (days === -1) return `yesterday at ${clockOf(when)}`;
  if (days === 1) return `tomorrow at ${clockOf(when)}`;
  if (days > 1 && days < 7) {
    return `on ${new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(when)}`;
  }
  return `on ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' }).format(when)}`;
}

/** Same instant, written as an absolute stamp. For the record list only. */
export function describeStamp(iso: string | null): string {
  if (iso === null) return 'Not known';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'Not known';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(ms),
  );
}

export function describeCadence(hours: number): string {
  if (hours % (24 * 7) === 0) {
    const weeks = hours / (24 * 7);
    if (weeks === 1) return 'every week';
    if (weeks === 2) return 'every two weeks';
    return `every ${weeks} weeks`;
  }
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? 'every day' : `every ${days} days`;
  }
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

/**
 * When the next automatic check falls due. Derived rather than read, because
 * the server reports when it last looked and how often it should: the schedule
 * is a floor on the LaunchAgent's weekly wake-up, not a diary entry.
 */
export function describeNextCheck(view: UpdateView, now: Date = new Date()): string {
  const cadence = describeCadence(view.source.checkIntervalHours);
  if (!view.source.configured) {
    return 'Nothing is set up for this copy to check. Ask Ayush.';
  }
  const last = view.lastCheckedAt === null ? null : Date.parse(view.lastCheckedAt);
  if (last === null || Number.isNaN(last)) {
    return `It looks for a new version ${cadence}, starting the next time the tracker is open.`;
  }
  const due = new Date(last + view.source.checkIntervalHours * 60 * 60 * 1000);
  const when = due.getTime() <= now.getTime() ? 'next time you open it' : describeWhen(due.toISOString(), now);
  // The sleep case is said out loud because it is the one that otherwise looks
  // like a missed fortnight: the schedule is a calendar time, and a Mac that
  // was shut at that moment checks once it is awake instead of waiting again.
  return `${cadence.charAt(0).toUpperCase()}${cadence.slice(1)}. Next ${when ?? 'shortly'}. If the Mac is asleep or off at that moment, it checks shortly after it wakes.`;
}

/** Honest progress: the phase, and the version it is working on. */
export function describePhase(progress: ProgressView | null, phase: UpdatePhase): string {
  if (progress?.note !== null && progress?.note !== undefined) return progress.note;
  const words = PHASE_WORDS[progress?.phase ?? phase];
  const version = progress?.version ?? null;
  const named = progress?.phase ?? phase;
  if (version !== null && (named === 'downloading' || named === 'unpacking' || named === 'swapping')) {
    return `${words} version ${version}...`;
  }
  return `${words}...`;
}

/**
 * A failed update, said without alarm. Two facts do the work: she is on the
 * version she was on, and nothing of hers was involved.
 */
export function describeOutcome(result: ResultView, currentVersion: string): string {
  const failure = result.failure;
  if (failure === null) {
    return `You are on version ${currentVersion}. None of your contracts were touched.`;
  }
  if (failure.rolledBackTo !== null && failure.rollbackOk) {
    return `You are back on version ${failure.rolledBackTo}, exactly as it was. None of your contracts were touched.`;
  }
  if (failure.rolledBackTo !== null && !failure.rollbackOk) {
    // The one case that is genuinely not fine. Still no alarm, still no jargon,
    // and still leading with what is true about her contracts.
    return `Putting the previous version back did not finish. None of your contracts were touched, and Ayush needs to look at this.`;
  }
  return `Nothing was installed and nothing changed. You are still on version ${currentVersion}.`;
}

export function describeRepair(repair: RepairView, now: Date = new Date()): string {
  const words = REPAIR_WORDS[repair.phase];
  if (repair.phase !== 'waiting-limit') return words;
  const when = describeWhen(repair.resumeAt, now);
  return when === null
    ? words
    : `The fix is paused until Claude is available again ${when}. It carries on by itself.`;
}

function sizeLabel(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return 'under 1 MB';
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * When this copy arrived. The updater does not record an install date, but a
 * successful result for the version now running is exactly that -- and its
 * absence means this copy came from the installer, which is also an answer.
 */
export function describeInstalled(view: UpdateView): string {
  const result = view.lastResult;
  if (result !== null && result.ok && result.version === view.currentVersion) {
    return describeStamp(result.finishedAt);
  }
  return 'With the app';
}

/* ────────────────────── what the status row may claim ─────────────────── */

/**
 * The four things the status row is allowed to say, most urgent first.
 *
 * 'current' is the ONLY one that earns a green tick, and it is reachable only
 * once a check has actually got through. The shipped state of this app is a copy
 * with no source configured, so pressing "Check for updates" fails -- and this
 * screen answered that with a green CheckCircle reading "Up to date", with the
 * failure admitted in small text underneath. A tick over a check that did not
 * happen is the same unearned claim as a quote that is not in the document, and
 * it is the one she would act on: "Up to date" is the whole answer she reads.
 *
 * So the failure is a state of its own and it beats everything the check could
 * otherwise have told us -- including a version offered by some earlier check,
 * which we can no longer confirm is still the newest.
 */
export type CheckState = 'offline' | 'failed' | 'never' | 'current';

export function checkState(view: UpdateView, offline: boolean): CheckState {
  // The tracker itself is not answering; nothing else on this row can be trusted.
  if (offline) return 'offline';
  if (view.lastCheckError !== null) return 'failed';
  // Never asked the source anything, so "up to date" would be a guess.
  if (view.lastCheckedAt === null) return 'never';
  return 'current';
}

export function describeCheck(
  state: CheckState,
  view: UpdateView,
  now: Date = new Date(),
): { title: string; description: string } {
  switch (state) {
    case 'offline':
      return {
        title: 'Cannot reach the tracker',
        description: 'Open the tracker again from the Dock and come back to this screen.',
      };
    case 'failed':
      return {
        title: 'The check did not get through',
        description:
          view.lastCheckError ??
          'The tracker could not reach where updates come from. Nothing on this Mac has changed.',
      };
    case 'never':
      return {
        title: 'Not checked yet',
        description: 'Press the button to ask whether there is a newer version.',
      };
    case 'current':
      return {
        title: 'Up to date',
        description: `Last checked ${describeWhen(view.lastCheckedAt, now) ?? 'recently'}.`,
      };
  }
}

/* ────────────────────────── talking to the server ─────────────────────── */

/*
 * lib/client/api.ts owns every other call in the app and these would live there
 * too if this pass owned that file. It does not, so they are inlined against
 * the same contract it keeps -- never throw, always resolve to something
 * renderable -- plus one bit this screen cannot do without.
 *
 * That bit is `unreachable`. Installing an update restarts the server under the
 * window, so "the fetch failed" is the expected reading for a minute, not an
 * error to show her. It has to be distinguishable from "the server answered and
 * said no".
 */

type Reply =
  | { data: UpdateView; unreachable?: undefined; message?: undefined; deferred?: string | null }
  | { data?: undefined; unreachable: boolean; message: string; deferred?: undefined };

const UNREADABLE = 'The tracker answered with something this screen could not read.';

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  const root = record(body);
  const error = root === null ? null : record(root['error']);
  const message = error === null ? null : text(error, 'message');
  return message ?? fallback;
}

async function call(init?: RequestInit): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch('/api/update', { cache: 'no-store', ...init });
  } catch {
    return { unreachable: true, message: 'The tracker is not answering.' };
  }
  const body = await readBody(res);
  if (!res.ok) {
    return { unreachable: false, message: errorMessage(body, 'That did not work.') };
  }

  // GET answers with the status; POST wraps it in { accepted, deferred, status }.
  const root = record(body);
  const wrapped = root === null ? null : record(root['status']);
  const view = toUpdateView(wrapped ?? body);
  if (view === null) return { unreachable: false, message: UNREADABLE };

  const deferredRaw = root === null ? null : record(root['deferred']);
  const reason = deferredRaw === null ? null : toDeferReason(deferredRaw['reason']);
  const deferred =
    deferredRaw === null || reason === null
      ? null
      : (text(deferredRaw, 'detail') ?? DEFER_WORDS[reason]);
  return { data: view, deferred };
}

function post(action: 'check' | 'apply' | 'rollback'): Promise<Reply> {
  return call({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

/** Self-repair, when it exists. A 404 is a perfectly good answer here. */
async function readRepair(): Promise<RepairView | null> {
  try {
    const res = await fetch('/api/repair', { cache: 'no-store' });
    if (!res.ok) return null;
    return toRepairView(await readBody(res));
  } catch {
    return null;
  }
}

/* ────────────────────────────── the tab ──────────────────────────────── */

/** While an update is in flight. Fast enough that a phase change is visible. */
const BUSY_POLL_MS = 1_500;
/** Otherwise. This screen is read when it is opened, not watched all day. */
const IDLE_POLL_MS = 60_000;

/**
 * How long the server may be unreachable during a restart before the screen
 * stops calling it normal. Measured against the real thing: a cold start on
 * this machine reaches a window in 19s, so three minutes is generous rather
 * than optimistic.
 */
const RESTART_PATIENCE_MS = 180_000;

/**
 * A wall-clock bound on one attempt. Nothing may sit on "installing" forever:
 * a wait with no end is worse than a failure, because there is nothing on
 * screen to act on.
 */
const ATTEMPT_LIMIT_MS = 15 * 60_000;

/** Clock slack when matching a result to the attempt that produced it. */
const RESULT_SLACK_MS = 60_000;

interface Attempt {
  version: string;
  startedAt: number;
}

export function UpdatesTab() {
  const { toast } = useToast();
  const [view, setView] = useState<UpdateView | null>(null);
  const [repair, setRepair] = useState<RepairView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [unreachableSince, setUnreachableSince] = useState<number | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  // Read by the poll loop, which must see an attempt started after it was
  // scheduled. State alone would hand it a stale closure.
  const attemptRef = useRef<Attempt | null>(null);

  const clearAttempt = useCallback(() => {
    attemptRef.current = null;
    setAttempt(null);
  }, []);

  /**
   * Decide whether the attempt in flight is over.
   *
   * The launcher taught this one: an accepted request is a claim, not evidence.
   * `POST apply` answering `accepted: true` means the work was started, exactly
   * as `launchctl kickstart` returning 0 meant the request was taken. The only
   * evidence that an update happened is the version that answers afterwards, or
   * a recorded result for that exact version. Neither can be forged by a 200.
   */
  const settle = useCallback(
    (next: UpdateView) => {
      const current = attemptRef.current;
      if (current === null) return;

      if (next.currentVersion === current.version) {
        clearAttempt();
        toast({
          title: `Updated to version ${current.version}`,
          description: 'Everything is where you left it.',
          tone: 'ok',
        });
        return;
      }

      const result = next.lastResult;
      const finished = result?.finishedAt === null ? NaN : Date.parse(result?.finishedAt ?? '');
      if (
        result !== null &&
        result.version === current.version &&
        (Number.isNaN(finished) || finished >= current.startedAt - RESULT_SLACK_MS)
      ) {
        clearAttempt();
        if (!result.ok) {
          toast({
            title: 'The update did not finish',
            description: describeOutcome(result, next.currentVersion),
            tone: 'warn',
          });
        }
        return;
      }

      if (Date.now() - current.startedAt > ATTEMPT_LIMIT_MS) {
        clearAttempt();
        toast({
          title: 'The update is taking longer than it should',
          description: 'Nothing on your Mac has changed. Try again in a few minutes.',
          tone: 'warn',
        });
      }
    },
    [clearAttempt, toast],
  );

  const load = useCallback(async () => {
    const reply = await call();
    if (reply.data === undefined) {
      if (reply.unreachable) {
        // Expected during a restart. Keep the last good answer on screen.
        setUnreachableSince((since) => since ?? Date.now());
        return;
      }
      setUnreachableSince(null);
      setFailure(reply.message);
      return;
    }
    setUnreachableSince(null);
    setFailure(null);
    setView(reply.data);
    settle(reply.data);
    setRepair(await readRepair());
  }, [settle]);

  useEffect(() => {
    void load();
  }, [load]);

  const phase = view?.progress?.phase ?? view?.phase ?? 'idle';
  const busy = attempt !== null || !SETTLED.has(phase);

  useEffect(() => {
    const timer = window.setInterval(
      () => {
        // While an update is in flight the poll must not stop when she looks
        // away: the server restarts underneath it, and the outcome has to be
        // waiting for her when she comes back rather than a dead screen. An
        // idle tab still yields to a hidden window.
        if (busy || document.visibilityState === 'visible') void load();
      },
      busy ? BUSY_POLL_MS : IDLE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [busy, load]);

  async function check(): Promise<void> {
    setChecking(true);
    const reply = await post('check');
    setChecking(false);
    if (reply.data === undefined) {
      toast({ title: 'Could not check for updates', description: reply.message, tone: 'bad' });
      return;
    }
    setView(reply.data);
    setFailure(null);
    setUnreachableSince(null);
    if (reply.data.lastCheckError !== null) {
      toast({
        title: 'The check did not get through',
        description: reply.data.lastCheckError,
        tone: 'warn',
      });
      return;
    }
    toast(
      reply.data.available === null
        ? { title: 'This is the newest version', tone: 'ok' }
        : { title: `Version ${reply.data.available.version} is ready to install`, tone: 'ok' },
    );
  }

  async function apply(version: string): Promise<void> {
    setStarting(true);
    const reply = await post('apply');
    setStarting(false);
    if (reply.data === undefined) {
      toast({ title: 'Could not start the update', description: reply.message, tone: 'bad' });
      return;
    }
    setView(reply.data);
    setFailure(null);
    if (reply.deferred !== null && reply.deferred !== undefined) {
      toast({ title: 'Not just now', description: reply.deferred, tone: 'warn' });
      return;
    }
    const started: Attempt = { version, startedAt: Date.now() };
    attemptRef.current = started;
    setAttempt(started);
  }

  async function rollback(version: string): Promise<void> {
    setStarting(true);
    const reply = await post('rollback');
    setStarting(false);
    if (reply.data === undefined) {
      toast({ title: 'Could not go back', description: reply.message, tone: 'bad' });
      return;
    }
    setView(reply.data);
    if (reply.deferred !== null && reply.deferred !== undefined) {
      toast({ title: 'Not just now', description: reply.deferred, tone: 'warn' });
      return;
    }
    const started: Attempt = { version, startedAt: Date.now() };
    attemptRef.current = started;
    setAttempt(started);
  }

  /* ------------------------------ rendering ----------------------------- */

  if (view === null) {
    const stuck = failure !== null || unreachableSince !== null;
    return (
      <div className="flex flex-col gap-[20px]">
        <section>
          <SectionHeader title="Updates" className="mb-[8px] px-[2px]" />
          <Card padding="none" divided>
            <SettingsRow
              label={failure ?? (stuck ? 'The tracker is not answering.' : 'Reading the version...')}
              description={
                stuck ? 'Close this window and open the tracker again from the Dock.' : undefined
              }
              control={
                stuck ? (
                  <Button size="sm" onClick={() => void load()}>
                    Try again
                  </Button>
                ) : undefined
              }
            />
          </Card>
        </section>
      </div>
    );
  }

  const restarting = unreachableSince !== null && attempt !== null;
  const restartingLong =
    unreachableSince !== null && Date.now() - unreachableSince > RESTART_PATIENCE_MS;
  const offline = unreachableSince !== null && attempt === null;
  const result = view.lastResult;
  const showOutcome = result !== null && !result.ok;
  const available = view.available;

  // One decision, made once, for the icon, the headline and the branch order.
  const state = checkState(view, offline);
  const words = describeCheck(state, view);

  /*
   * The tick is bound to `state === 'current'` and to nothing else, which is the
   * whole fix: there is no arrangement of props that draws it while a check is
   * failing, because the only branch that can reach CheckCircle is the one
   * checkState() refuses to return when lastCheckError is set.
   */
  const statusRow = (
    <SettingsRow
      leading={
        state === 'current' ? (
          <CheckCircle size={15} weight="regular" className="text-ok" />
        ) : state === 'never' ? (
          <Circle size={15} weight="regular" className="text-tertiary" />
        ) : (
          <Warning size={15} weight="regular" className="text-warn" />
        )
      }
      label={<span className="text-title-3 font-semibold text-label">{words.title}</span>}
      description={words.description}
      control={
        <Button
          size="lg"
          icon={<ArrowClockwise size={14} />}
          loading={checking}
          onClick={() => void check()}
        >
          Check for updates
        </Button>
      }
    />
  );

  return (
    <div className="flex flex-col gap-[20px]">
      {/* The thing she needs to know before anything else, when there is one.
          Above the version, because "did something go wrong" is the question
          that brought her here. */}
      {(showOutcome || repair !== null) && (
        <motion.section
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING_SNAPPY}
        >
          <SectionHeader title="What happened" className="mb-[8px] px-[2px]" />
          <Card padding="none" divided>
            {showOutcome && result !== null && (
              <SettingsRow
                leading={<Warning size={13} weight="regular" className="text-warn" />}
                label={
                  <span className="font-medium">
                    {result.failure?.rolledBackTo !== null && result.failure?.rollbackOk === true
                      ? 'The last update was undone'
                      : 'The last update did not finish'}
                  </span>
                }
                description={describeOutcome(result, view.currentVersion)}
                control={
                  view.canRollback && view.previousVersion !== null ? (
                    <Button
                      size="sm"
                      icon={<ArrowUUpLeft size={13} />}
                      loading={starting}
                      onClick={() => {
                        const target = view.previousVersion;
                        if (target !== null) void rollback(target);
                      }}
                    >
                      Go back to {view.previousVersion}
                    </Button>
                  ) : undefined
                }
              >
                {result.failure !== null && (
                  <p className="mt-[2px] text-callout text-label-tertiary">
                    {result.failure.message}
                  </p>
                )}
                <p className="mt-[2px] text-footnote text-label-tertiary">
                  {describeStamp(result.finishedAt)}
                </p>
              </SettingsRow>
            )}

            {repair !== null && (
              <SettingsRow
                leading={<Wrench size={13} weight="regular" className="text-label-tertiary" />}
                label={<span className="font-medium">Being looked at</span>}
                description={describeRepair(repair)}
              />
            )}
          </Card>
        </motion.section>
      )}

      {/* ------------------------------ updates ----------------------------- */}
      <section>
        <SectionHeader title="Updates" className="mb-[8px] px-[2px]" />
        <Card padding="none" divided>
          {busy ? (
            <SettingsRow
              label={
                <span className="text-title-3 font-semibold text-label">
                  {restarting ? 'Restarting the tracker...' : describePhase(view.progress, view.phase)}
                </span>
              }
              description={
                restartingLong
                  ? 'This is taking longer than usual. Nothing has been lost either way.'
                  : 'This window comes back on its own. There is no need to close it.'
              }
            >
              <div className="mt-[10px]">
                <ProgressBar size="md" indeterminate label="Update progress" />
              </div>
            </SettingsRow>
          ) : !view.supported ? (
            <SettingsRow
              leading={<Warning size={15} weight="regular" className="text-warn" />}
              label={
                <span className="text-title-3 font-semibold text-label">
                  This copy cannot update itself
                </span>
              }
              description={
                view.unsupportedReason ??
                'It was not installed in a way that can be replaced. Ayush can reinstall it.'
              }
            />
          ) : state === 'offline' || state === 'failed' ? (
            // Ahead of anything the check might once have found. A version
            // offered by an earlier check is not evidence that it is still the
            // newest, and "there is a newer version" over a check that just
            // failed is a claim we no longer hold.
            statusRow
          ) : available !== null && available.applicable ? (
            <SettingsRow
              leading={<CloudArrowDown size={15} weight="regular" className="text-accent" />}
              label={
                <span className="text-title-3 font-semibold text-label">
                  There is a newer version
                </span>
              }
              description={
                available.notes ??
                'A small improvement. Your contracts and settings stay exactly as they are.'
              }
              control={
                <Button
                  size="lg"
                  variant="primary"
                  loading={starting}
                  onClick={() => void apply(available.version)}
                >
                  Install version {available.version}
                </Button>
              }
            >
              <p className="mt-[4px] text-footnote text-label-tertiary">
                {[
                  sizeLabel(available.sizeBytes),
                  describeWhen(available.publishedAt) === null
                    ? null
                    : `published ${describeWhen(available.publishedAt)}`,
                ]
                  .filter((part): part is string => part !== null)
                  .join(', ')}
              </p>
            </SettingsRow>
          ) : available !== null ? (
            <SettingsRow
              leading={<Warning size={15} weight="regular" className="text-warn" />}
              label={
                <span className="text-title-3 font-semibold text-label">
                  Version {available.version} needs Ayush
                </span>
              }
              description={
                available.blockedReason ??
                'This copy is too old to take that version on its own. It needs installing again.'
              }
            />
          ) : (
            statusRow
          )}

          {failure !== null && (
            <SettingsRow
              leading={<Warning size={13} weight="regular" className="text-warn" />}
              label={failure}
              control={
                <Button size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          )}
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          {view.source.autoApply
            ? 'This Mac is set to install updates on its own. Ayush set that, and he can unset it.'
            : 'An update never installs itself. It arrives only when you press the button, and it never changes anything already in the repository.'}
        </p>
      </section>

      {/* --------------------------- automatic ------------------------------ */}
      <section>
        <SectionHeader title="Checking on its own" className="mb-[8px] px-[2px]" />
        <Card padding="none" divided>
          <SettingsRow
            label="Look for new versions automatically"
            description={describeNextCheck(view)}
            control={
              <Pill tone={view.source.configured ? 'ok' : 'neutral'}>
                {view.source.configured ? 'On' : 'Off'}
              </Pill>
            }
          />
        </Card>
        <p className="mt-[6px] px-[2px] text-footnote text-label-tertiary">
          It only ever looks. To stop it looking, ask Ayush: where updates come from is set on
          this Mac rather than in the app, so a web page open in your browser can never point
          it somewhere else.
        </p>
      </section>

      {/* ---------------------------- this copy ----------------------------- */}
      <section>
        <SectionHeader title="This copy" className="mb-[8px] px-[2px]" />
        <Card padding="md">
          <DataList
            labelWidth={132}
            items={[
              { label: 'Version', value: view.currentVersion, mono: true },
              { label: 'Installed', value: describeInstalled(view) },
              {
                label: 'Last checked',
                value: view.lastCheckedAt === null ? 'Never' : describeStamp(view.lastCheckedAt),
                tone: 'quiet',
              },
              { label: 'Updates from', value: view.source.label, tone: 'quiet' },
            ]}
          />
        </Card>
      </section>
    </div>
  );
}
