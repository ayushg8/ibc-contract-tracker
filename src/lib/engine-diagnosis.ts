/**
 * The five ways the Claude CLI can be wrong, named, and what to do about each.
 *
 * This module exists because two screens have to give the SAME answer: the
 * onboarding Engine step and Settings -> Diagnostics. "It stopped working" has
 * to be one screen rather than a phone call, and one screen is only possible if
 * both render the same diagnosis from the same source.
 *
 * Client-safe by construction: no node imports, so a 'use client' component can
 * import it. `cli.ts` (server-only) imports the types and produces the values;
 * the UI only ever renders them.
 *
 * Sentences and remedies are taken from the error taxonomy wherever a code
 * exists, so a message is never written twice. What this module adds on top is
 * the part errors.ts deliberately does not carry: the exact Terminal command and
 * the plain sentence about who to send it to. Bonnie will not run these. She
 * will forward them.
 */

import { errorInfo, type EngineErrorCode, type Remedy, type SerialisedEngineError } from './providers/errors';
import type { HealthState, ProviderHealth, ProviderId } from './providers/types';

/* ─────────────────────────────── the cases ─────────────────────────────── */

/**
 * The five distinct failures from the brief, plus the three states that are not
 * failures. Each one gets a different sentence and a different button; "Claude
 * CLI error" is useless to a non-technical user.
 *
 *  1 not-installed     Claude Code is not on this Mac at all.
 *  2 not-on-path       Installed, but invisible to an app launched from the Dock.
 *  3 not-signed-in     Found and runnable, but no active login.
 *  4 plan-unsupported  Signed in, on a plan without the access this needs.
 *  5 usage-limit       Working, but currently capped.
 */
export type CliCase =
  | 'working'
  | 'unverified'
  | 'not-installed'
  | 'not-on-path'
  | 'not-signed-in'
  | 'too-old'
  | 'plan-unsupported'
  | 'usage-limit'
  | 'blocked';

/** How the binary was found. Which one it was is itself diagnostic. */
export type CliFoundVia =
  | 'which'
  | 'known-location'
  | 'npm-prefix'
  | 'login-shell'
  | 'none';

export interface CliCaseInfo {
  /** The taxonomy code this case reports as, or null when it is not a failure. */
  code: EngineErrorCode | null;
  /** Headline. Falls back to the taxonomy message when a code exists. */
  title: string;
  /** One sentence of what is actually true, in her words. */
  what: string;
  /** The exact Terminal line, or null when there is nothing to type. */
  command: string | null;
  /** Who to send the command to, and why she is not expected to run it. */
  forward: string | null;
  state: HealthState;
  /**
   * Keep `title` instead of taking the taxonomy's sentence for `code`.
   *
   * Only for cases that share a code with another case and need to be told apart.
   * "Installed somewhere this app cannot reach" reports as CLI_NOT_FOUND because
   * that is what the engine will throw, but telling her to install software she
   * already has is precisely the wrong instruction.
   */
  ownTitle?: true;
}

const SEND_IT = 'You do not have to run this yourself - copy it and send it to Ayush.';

/*
 * Written out in full rather than composed, so every case is visible in one place
 * and a new case cannot be added without someone writing its sentence, its
 * command, and the line about who to send it to.
 */
export const CLI_CASES: Record<CliCase, CliCaseInfo> = {
  working: {
    code: null,
    title: 'Claude Code is ready.',
    what: 'Found, recent enough, and signed in. The test on the next step is the proof.',
    command: null,
    forward: null,
    state: 'ok',
  },
  unverified: {
    code: null,
    title: 'Claude Code is installed. Sign-in is unconfirmed.',
    what:
      'Whether it is signed in cannot be checked without asking it to read something, and that would spend a request. The test on the next step settles it.',
    command: null,
    forward: null,
    state: 'unknown',
  },
  'not-installed': {
    code: 'CLI_NOT_FOUND',
    title: "Claude Code isn't installed on this Mac.",
    what:
      'The tracker looked in every place Claude Code installs itself and in your shell, and found nothing to run.',
    command: 'npm install -g @anthropic-ai/claude-code',
    forward: `This has to be typed in Terminal once. ${SEND_IT}`,
    state: 'fail',
  },
  'not-on-path': {
    code: 'CLI_NOT_FOUND',
    title: 'Claude Code is installed, but this app cannot run it.',
    what:
      'Your Terminal knows where `claude` is; an app opened from the Dock does not inherit that. It has to be installed somewhere every program can see.',
    command: 'command -v claude && claude --version',
    forward: `Run this in Terminal and send the two lines it prints. ${SEND_IT}`,
    state: 'fail',
    ownTitle: true,
  },
  'not-signed-in': {
    code: 'CLI_NOT_AUTHENTICATED',
    title: 'Claude Code is installed but not signed in.',
    what:
      'It is there and it runs. It just has no account attached, so it will refuse to read anything.',
    command: 'claude',
    forward: `Run this in Terminal once and finish the login, then press Recheck. ${SEND_IT}`,
    state: 'fail',
  },
  'too-old': {
    code: 'CLI_VERSION_UNSUPPORTED',
    title: 'This version of Claude Code is too old for the tracker.',
    what: 'The tracker asks for options this build does not have. Updating is the whole fix.',
    command: 'npm install -g @anthropic-ai/claude-code@latest',
    forward: `This has to be typed in Terminal once. ${SEND_IT}`,
    state: 'fail',
  },
  'plan-unsupported': {
    code: 'CLI_PLAN_UNSUPPORTED',
    title: "This Claude plan doesn't include what the tracker needs.",
    what:
      'Signed in, but the plan on this account cannot use Claude Code this way. Waiting will not change it. An API key works on any plan, at roughly 1-3 cents a contract.',
    command: null,
    forward: 'Nothing to type. Tell Ayush which Claude plan this account is on.',
    state: 'fail',
  },
  'usage-limit': {
    code: 'CLI_USAGE_LIMIT',
    title: "You've hit your Claude subscription limit.",
    what:
      'Nothing is broken. The limit resets on its own, and the queue picks up where it stopped. An API key has no cap if you need to keep going now.',
    command: null,
    forward: null,
    state: 'warn',
  },
  blocked: {
    code: 'CLI_PERMISSION_PROMPT',
    title: 'Claude Code stops to ask for permission, which it cannot do here.',
    what:
      'This build has no way to switch its tools off, so it can sit waiting for an approval nobody can give. The tracker never needs those tools; a newer build accepts the option to disable them.',
    command: 'npm install -g @anthropic-ai/claude-code@latest',
    forward: `This has to be typed in Terminal once. ${SEND_IT}`,
    state: 'fail',
  },
};

/**
 * The case to show for a failure, preferring a live verdict over the bare code.
 *
 * A code alone cannot name the case: CLI_NOT_FOUND is reported both by a Mac with
 * no Claude Code on it and by a Mac where Claude Code exists but only inside a
 * shell function this app cannot call. `cliCaseForCode` has to guess, and it
 * guesses "not installed" -- which sends her off to install software she already
 * has, one step after the Engine step correctly told her she has it.
 *
 * `diagnosis` is the probe's own verdict, which knows the difference. It wins
 * whenever it is describing the same failure the run reported.
 */
export function cliCaseInfoFor(
  code: EngineErrorCode | string | null | undefined,
  diagnosis: CliDiagnosis | null,
): CliCaseInfo | null {
  if (diagnosis !== null && diagnosis.code !== null && diagnosis.code === code) {
    return {
      code: diagnosis.code,
      title: diagnosis.title,
      what: diagnosis.what,
      command: diagnosis.command,
      forward: diagnosis.forward,
      state: diagnosis.state,
    };
  }
  const fallback = cliCaseForCode(code);
  return fallback === null ? null : CLI_CASES[fallback];
}

/** Which case a taxonomy code represents, or null when it is not an engine-setup fault. */
export function cliCaseForCode(code: EngineErrorCode | string | null | undefined): CliCase | null {
  switch (code) {
    case 'CLI_NOT_FOUND':
      return 'not-installed';
    case 'CLI_NOT_AUTHENTICATED':
      return 'not-signed-in';
    case 'CLI_VERSION_UNSUPPORTED':
      return 'too-old';
    case 'CLI_PLAN_UNSUPPORTED':
      return 'plan-unsupported';
    case 'CLI_USAGE_LIMIT':
      return 'usage-limit';
    case 'CLI_PERMISSION_PROMPT':
      return 'blocked';
    default:
      return null;
  }
}

/* ─────────────────────────────── diagnosis ─────────────────────────────── */

/**
 * Everything the two screens need to render one CLI verdict. Deliberately flat and
 * serialisable: it crosses the wire from the health route.
 *
 * Nothing here can carry a credential. `binPath` is a file path, `version` is three
 * numbers, and `detail` is written by us rather than copied from process output.
 */
export interface CliDiagnosis {
  case: CliCase;
  state: HealthState;
  title: string;
  what: string;
  command: string | null;
  forward: string | null;
  remedy: Remedy | null;
  code: EngineErrorCode | null;
  /** Where the binary was found. Null when nothing was found. */
  binPath: string | null;
  foundVia: CliFoundVia;
  version: string | null;
  /** ISO time the subscription limit is expected to reset, when we could read one. */
  limitResetsAt: string | null;
  /**
   * True when the binary was found somewhere `which` alone would have missed --
   * the GUI-launch case, which is the one that will actually happen.
   */
  neededDeepProbe: boolean;
}

export interface DiagnosisFacts {
  binPath?: string | null;
  foundVia?: CliFoundVia;
  version?: string | null;
  limitResetsAt?: string | null;
}

/** Build the renderable verdict for a case. Pure; the server and the tests share it. */
export function describeCli(kind: CliCase, facts: DiagnosisFacts = {}): CliDiagnosis {
  const info = CLI_CASES[kind];
  const code = info.code;
  const foundVia = facts.foundVia ?? 'none';
  return {
    case: kind,
    state: info.state,
    // The taxonomy owns the sentence wherever it has one, so the headline she sees
    // here is the same headline a failed extraction shows her later. The exception
    // is a case that shares a code with another and would otherwise be told the
    // wrong thing to do -- see `ownTitle`.
    title: code === null || info.ownTitle === true ? info.title : errorInfo(code).message,
    what: info.what,
    command: info.command,
    forward: info.forward,
    remedy: code === null ? null : errorInfo(code).remedy,
    code,
    binPath: facts.binPath ?? null,
    foundVia,
    version: facts.version ?? null,
    limitResetsAt: facts.limitResetsAt ?? null,
    neededDeepProbe: foundVia === 'npm-prefix' || foundVia === 'login-shell',
  };
}

const VIA_LABEL: Record<CliFoundVia, string> = {
  which: 'on the PATH this app inherited',
  'known-location': 'in a known install location',
  'npm-prefix': "in npm's global folder, which this app is not given",
  'login-shell': 'only by asking your login shell, which an app never sees',
  none: 'nowhere',
};

/** One line for the status block. Safe to show: a path and a version, nothing else. */
export function whereFoundLine(d: CliDiagnosis): string | null {
  if (d.binPath === null) return null;
  return `Found ${VIA_LABEL[d.foundVia]}: ${d.binPath}${d.version === null ? '' : ` (v${d.version})`}`;
}

/* ─────────────────────────── the two side doors ────────────────────────── */

/*
 * `@/lib/client/api` is the single place a screen talks to the server, and it is
 * owned elsewhere in this pass. These three calls exist here rather than there so
 * this work does not edit a file it does not own; they return the same
 * `{ data } | { error }` shape so no caller needs a try/catch either way. Fold
 * them into api.ts when the ownership split is over.
 */

export type Fetched<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: SerialisedEngineError };

function isSerialisedError(v: unknown): v is SerialisedEngineError {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['code'] === 'string' && typeof o['message'] === 'string';
}

function localFailure(code: EngineErrorCode, detail: string): SerialisedEngineError {
  const info = errorInfo(code);
  return {
    code,
    message: info.message,
    retryable: info.retryable,
    retryAfterMs: info.retryAfterMs ?? null,
    remedy: info.remedy,
    halt: info.halt,
    detail,
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', ...init });
  } catch (e) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // An aborted request is the user pressing Stop, not a fault worth a red banner.
    if (e instanceof Error && e.name === 'AbortError') {
      return { error: localFailure('CLI_TIMEOUT', 'Stopped before it finished.') };
    }
    return { error: localFailure(offline ? 'NETWORK_UNAVAILABLE' : 'UNKNOWN', detail) };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const raw =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['error']
        : undefined;
    if (isSerialisedError(raw)) return { error: raw };
    return { error: localFailure('UNKNOWN', `HTTP ${res.status} from ${path}`) };
  }
  if (typeof body !== 'object' || body === null) {
    return { error: localFailure('UNKNOWN', `Unreadable body from ${path}`) };
  }
  return { data: body as T };
}

/**
 * One entry per engine, and the screens index it by the active id rather than
 * branching, so an engine that is added here reaches them without anyone editing
 * a ternary whose `else` silently means "API".
 */
export interface EngineHealthResponse extends Record<ProviderId, ProviderHealth> {
  active: ProviderId;
  cliDiagnosis: CliDiagnosis;
}

export function fetchEngineHealth(signal?: AbortSignal): Promise<Fetched<EngineHealthResponse>> {
  return call<EngineHealthResponse>('/api/engine/health', signal ? { signal } : undefined);
}

export interface EngineTestOutcome {
  provider: ProviderId;
  ok: boolean;
  durationMs: number;
  fieldsFound: number;
  fieldsTotal: number;
  costUsd: number | null;
  error: SerialisedEngineError | null;
}

/** Takes a signal, unlike `api.testEngine()`: a spinner she cannot stop is a trap. */
export function runEngineTest(signal?: AbortSignal): Promise<Fetched<EngineTestOutcome>> {
  return call<EngineTestOutcome>('/api/engine/test', {
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
}

/* ───────────────────────────── watch folder ────────────────────────────── */

export interface WatchStatus {
  running: boolean;
  folder: string | null;
  lastScanAt: string | null;
  ingested: number;
  lastError: string | null;
}

/**
 * The watcher is owned elsewhere. This reads its status defensively -- the fields
 * it actually needs, under either the flat or the `{ watch: ... }` shape -- and
 * degrades to "not available yet" on 404 rather than to a broken step. Drag and
 * drop is a complete way to use the app, so the wizard may never block on a
 * folder, and it may never break because the watcher's shape moved.
 */
export type WatchProbe =
  | { available: true; status: WatchStatus }
  | { available: false; message: string };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Tolerant on purpose: an unfinished endpoint may answer with a different shape. */
export function parseWatchStatus(body: unknown): WatchStatus {
  const o: Record<string, unknown> = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};
  const nested = typeof o['watch'] === 'object' && o['watch'] !== null
    ? (o['watch'] as Record<string, unknown>)
    : o;
  const errorValue = nested['error'] ?? nested['lastError'];
  const lastError =
    typeof errorValue === 'string'
      ? errorValue
      : isSerialisedError(errorValue)
        ? errorValue.message
        : null;
  const count = nested['ingested'] ?? nested['count'] ?? nested['ingestedCount'];
  return {
    running: nested['running'] === true || nested['watching'] === true,
    folder: str(nested['folder']) ?? str(nested['watchFolder']),
    lastScanAt: str(nested['lastScanAt']) ?? str(nested['lastScan']),
    ingested: typeof count === 'number' && Number.isFinite(count) ? count : 0,
    lastError,
  };
}

export async function fetchWatchStatus(signal?: AbortSignal): Promise<WatchProbe> {
  let res: Response;
  try {
    res = await fetch('/api/watch', { cache: 'no-store', ...(signal ? { signal } : {}) });
  } catch {
    return { available: false, message: 'The folder watcher is not answering yet.' };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { available: false, message: 'Automatic folder watching is not switched on yet.' };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { available: false, message: 'The folder watcher answered with something unreadable.' };
  }
  if (!res.ok) {
    const raw =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['error']
        : undefined;
    return {
      available: false,
      message: isSerialisedError(raw) ? raw.message : 'The folder watcher reported a problem.',
    };
  }
  return { available: true, status: parseWatchStatus(body) };
}

/* ────────────────────────── folder paths by hand ───────────────────────── */

/*
 * There is no folder picker, and there cannot be one.
 *
 * The shipped .app is this same web UI in Chrome against 127.0.0.1, and a web page
 * is not allowed to learn where a file lives on the disk -- it is handed the bytes,
 * never the path. So both screens that take a folder take TYPED text, and these two
 * helpers exist to make the typed text as forgiving as it can honestly be:
 * everything Finder and Terminal put on a clipboard or a drag ends up as the plain
 * POSIX path the server expects. Nothing here may promise a picker.
 */

/**
 * The plain path behind whatever she pasted or dropped.
 *
 * Handles the three forms that reach this field in practice: a bare path from
 * Finder's "Copy as Pathname", a percent-encoded `file://` URL, and a path dragged
 * into a shell with its spaces backslash-escaped. Deterministic and lossless for a
 * path that was already plain.
 */
export function normalizeFolderPath(raw: string): string {
  let value = raw.trim();

  // A path pasted out of a shell history, or one Finder quoted for us.
  if (
    value.length > 1 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }

  if (value.toLowerCase().startsWith('file://')) {
    const rest = value.slice('file://'.length);
    // file:///Users/... and file://localhost/Users/... both reduce to the path.
    const start = rest.indexOf('/');
    const encoded = start < 0 ? '' : rest.slice(start);
    try {
      value = decodeURIComponent(encoded);
    } catch {
      // A stray '%' that is not an escape. Better her literal text than nothing.
      value = encoded;
    }
  }

  // Spaces and friends arrive escaped when the path came out of Terminal.
  value = value.replace(/\\(?=[ ()&;'"])/g, '');

  value = value.trim();
  // Finder writes a folder URL with a trailing slash; the stored path must not
  // differ from the same folder typed by hand. Root is left alone.
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/**
 * A folder path out of a drop, or null when the browser did not hand one over.
 *
 * Chrome gives a page the CONTENTS of a dragged file and not its location, so a
 * dropped folder usually carries no path at all. When the drag does carry text --
 * a `file://` URL, or a path dragged from Terminal -- this finds it. A null answer
 * is expected and must be answered with the Finder instruction, never treated as a
 * failure: no copy anywhere may promise that dropping a folder works.
 */
export function folderPathFromDrop(data: DataTransfer): string | null {
  for (const type of ['text/uri-list', 'text/plain']) {
    let raw = '';
    try {
      raw = data.getData(type);
    } catch {
      // Some drags expose a type they then refuse to read.
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      // text/uri-list comments start with '#', and are not paths.
      if (line.trim().startsWith('#')) continue;
      const path = normalizeFolderPath(line);
      if (path.startsWith('/')) return path;
    }
  }
  return null;
}

/**
 * The one sentence that always works, shown wherever a path has to be typed.
 * Kept here so the wizard and Settings cannot drift into two different answers.
 */
export const FOLDER_PATH_HINT =
  'To get the path: in Finder, right-click the folder, hold Option, and choose "Copy as Pathname" - then paste it here.';

/* ───────────────────────── onboarding resumability ─────────────────────── */

/**
 * Where she was when the window closed. localStorage rather than the database
 * because it is a per-window position, not a fact about the company's contracts,
 * and because a wizard must still resume when the database is the thing that is
 * broken.
 *
 * It records POSITION only. Nothing here can mark setup complete: that is a
 * server-side setting, so a stale browser can never claim she finished a setup
 * that never happened.
 */
const PROGRESS_KEY = 'ibc.onboarding.progress.v1';

export interface OnboardingProgress {
  step: number;
  /** Whether the sample extraction has already passed, so it is not re-run for free. */
  testPassed: boolean;
  at: string;
}

export function readProgress(maxStep: number): OnboardingProgress | null {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const step = typeof o['step'] === 'number' ? Math.floor(o['step']) : 0;
    if (!Number.isFinite(step) || step < 0) return null;
    return {
      step: Math.min(step, maxStep),
      testPassed: o['testPassed'] === true,
      at: str(o['at']) ?? new Date().toISOString(),
    };
  } catch {
    // Private browsing, a full disk, or a hand-edited value. Start at the beginning.
    return null;
  }
}

export function writeProgress(progress: Omit<OnboardingProgress, 'at'>): void {
  try {
    window.localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({ ...progress, at: new Date().toISOString() }),
    );
  } catch {
    // Losing the position is a worse first run, not a broken one.
  }
}

export function clearProgress(): void {
  try {
    window.localStorage.removeItem(PROGRESS_KEY);
  } catch {
    // Nothing to do, and nothing depends on it.
  }
}
