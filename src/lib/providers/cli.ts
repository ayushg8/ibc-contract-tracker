/**
 * The Claude subscription engine: shells out to the user's `claude` binary.
 *
 * Everything here exists because a child process on someone else's Mac is the
 * least predictable thing in this app. The binary may not be on PATH, may be too
 * old for the flags we need, may want to ask permission, may be rate limited by a
 * subscription window, may hang, or may print an update notice on top of the JSON.
 * Each of those is a named EngineError with a remedy, never a stack trace.
 *
 * Server-only: imports node:child_process and node:fs.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  describeCli,
  type CliCase,
  type CliDiagnosis,
  type CliFoundVia,
} from '../engine-diagnosis';
import type { DocType, FieldKey } from '../fields';
import { recordedClaudePath } from '../paths';
import { EngineError, redact, toEngineError, type EngineErrorCode } from './errors';
import {
  LIMITS,
  modelFor,
  type ExtractOptions,
  type ExtractionRequest,
  type ExtractionResponse,
  type HealthCheck,
  type Provider,
  type ProviderHealth,
  type RawFieldAnswer,
} from './types';
import {
  buildExtractionPrompt,
  buildRepairInstruction,
  buildSelfTestRequest,
  countVerifiableQuotes,
  extractDocType,
  extractJson,
  hasAnswerKeys,
  sanitiseModelOutput,
  SELF_TEST_FIELDS,
  SELF_TEST_TEXT,
  validateAnswer,
} from './parse';

const execFileAsync = promisify(execFile);

/**
 * The floor is set by the flags we depend on: `-p`, `--output-format json` and
 * `--model`. Every 1.x release has them; nothing before 1.0 reliably does.
 */
export const MIN_CLI_VERSION = '1.0.0';

/** Only ever one at a time. A subscription is not a fleet. */
const MAX_CONCURRENCY = 1;

const SIGKILL_GRACE_MS = 2_000;
const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
const STDERR_CAP_BYTES = 64 * 1024;
const CRASH_DETAIL_BYTES = 2 * 1024;

/* ────────────────────────────── discovery ───────────────────────── */

/**
 * A GUI-launched process inherits a minimal PATH — often just /usr/bin:/bin — so
 * `which claude` alone finds nothing even on a machine where the CLI works fine in
 * Terminal. This is the single most likely support call, so we probe every install
 * location Claude Code actually uses.
 */
export function candidatePaths(): string[] {
  const home = homedir();
  return [
    join(home, '.claude', 'local', 'claude'),
    join(home, '.claude', 'local', 'node_modules', '.bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.local', 'bin', 'claude'),
    join(home, 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
    join(home, '.volta', 'bin', 'claude'),
    join(home, '.asdf', 'shims', 'claude'),
    // npm's default prefix when someone has moved it out of /usr/local.
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.npm-packages', 'bin', 'claude'),
    // pnpm's global bin on macOS, and yarn's.
    join(home, 'Library', 'pnpm', 'claude'),
    join(home, '.yarn', 'bin', 'claude'),
    // Homebrew's node keg, for an install that predates a PATH change.
    '/opt/homebrew/opt/node/bin/claude',
    '/usr/local/opt/node/bin/claude',
    ...versionManagerPaths(),
  ];
}

/**
 * nvm and fnm put the binary under a directory named after a node version, so the
 * path cannot be written down in advance. Both are extremely common on a developer
 * -set-up Mac and both are invisible to a GUI process, so the directory is listed
 * rather than guessed. Never throws: a missing directory is the normal case.
 */
function versionManagerPaths(): string[] {
  const home = homedir();
  const roots: { dir: string; suffix: string[] }[] = [
    { dir: join(home, '.nvm', 'versions', 'node'), suffix: ['bin', 'claude'] },
    { dir: join(home, '.local', 'share', 'fnm', 'node-versions'), suffix: ['installation', 'bin', 'claude'] },
    { dir: join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), suffix: ['installation', 'bin', 'claude'] },
    { dir: join(home, '.asdf', 'installs', 'nodejs'), suffix: ['bin', 'claude'] },
  ];

  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      continue;
    }
    // Newest first: a stale old node install should not win over the current one.
    for (const entry of entries.sort().reverse()) {
      found.push(join(root.dir, entry, ...root.suffix));
    }
  }
  return found;
}

/** Directories worth adding to a child's PATH, for the same minimal-PATH reason. */
function extraPathDirs(): string[] {
  const home = homedir();
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.claude', 'local'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'Library', 'pnpm'),
    '/usr/bin',
    '/bin',
  ];
}

/** PATH additions for the child, for the same minimal-PATH reason. */
function augmentedPath(): string {
  const current = process.env['PATH'] ?? '';
  const seen = new Set(current.split(delimiter).filter((p) => p !== ''));
  for (const dir of extraPathDirs()) {
    if (!seen.has(dir)) seen.add(dir);
  }
  return [...seen].join(delimiter);
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: augmentedPath(),
    // Stop the CLI dressing its output up for a terminal it does not have.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    CI: '1',
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichClaude(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', ['claude'], {
      timeout: 5_000,
      env: childEnv(),
    });
    const first = stdout.split('\n').map((s) => s.trim()).find((s) => s !== '');
    return first && isExecutable(first) ? first : null;
  } catch {
    return null;
  }
}

async function npmGlobalClaude(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('npm', ['config', 'get', 'prefix'], {
      timeout: 10_000,
      env: childEnv(),
    });
    const prefix = stdout.trim();
    if (prefix === '' || prefix === 'undefined') return null;
    const candidate = join(prefix, 'bin', 'claude');
    return isExecutable(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * The last resort, and the one that covers a PATH we could never have guessed.
 *
 * An app launched from the Dock or by a LaunchAgent inherits none of the shell
 * profile, so nvm shims, a custom npm prefix and a hand-edited PATH are all
 * invisible. Asking her actual login shell to resolve the name is the only probe
 * that sees what she sees when she types `which claude`.
 *
 * `-l` sources the login files and `-i` the interactive ones (nvm usually lives in
 * .zshrc, which is interactive-only). stdin is closed immediately so an
 * interactive shell cannot sit waiting for input, and the whole thing is capped.
 */
/**
 * An interactive shell prints whatever her dotfiles print -- "Restored session",
 * a version manager's greeting, a motd. Taking stdout at face value would read
 * that banner as an answer and tell someone with no Claude Code installed that it
 * is installed but unreachable, which is the wrong instruction and an unfindable
 * bug. The sentinel is what separates our answer from her shell's chatter.
 */
const SHELL_MARKER = 'IBC-CLAUDE-PATH:';

/*
 * `command -v` rather than `which`: it is a shell builtin, so it also resolves an
 * alias or a function. That distinction is the whole point -- it separates
 * "installed somewhere this app cannot reach" from "not installed at all".
 */
const SHELL_PROBE = `printf '${SHELL_MARKER}%s\\n' "$(command -v claude 2>/dev/null)"`;

export function parseShellLookup(output: string): string | null {
  for (const line of sanitiseModelOutput(output).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(SHELL_MARKER)) continue;
    const value = trimmed.slice(SHELL_MARKER.length).trim();
    if (value !== '') return value;
  }
  return null;
}

let cachedShellLookup: string | null | undefined;

export async function loginShellLookup(): Promise<string | null> {
  if (cachedShellLookup !== undefined) return cachedShellLookup;
  cachedShellLookup = null;
  if (platform() === 'win32') return null;

  const shells = [process.env['SHELL'], '/bin/zsh', '/bin/bash'].filter(
    (s): s is string => typeof s === 'string' && s.trim() !== '',
  );
  const tried = new Set<string>();

  for (const shell of shells) {
    if (tried.has(shell) || !isExecutable(shell)) continue;
    tried.add(shell);
    const out = await runCapture(shell, ['-lic', SHELL_PROBE], 8_000);
    const answer = out === null ? null : parseShellLookup(out);
    if (answer !== null) {
      cachedShellLookup = answer;
      return cachedShellLookup;
    }
  }
  return cachedShellLookup;
}

/** The login-shell answer, narrowed to something we could actually spawn. */
export async function loginShellClaude(): Promise<string | null> {
  const answer = await loginShellLookup();
  if (answer === null) return null;
  for (const line of answer.split('\n')) {
    const path = line.trim();
    if (path.startsWith('/') && isExecutable(path)) return path;
  }
  return null;
}

/**
 * execFile, but with the child's stdin closed at once. Returns stdout, or null on
 * any failure. A probe must never be the thing that hangs the health check.
 */
function runCapture(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const child = execFile(
        bin,
        args,
        { timeout: timeoutMs, env: childEnv(), maxBuffer: 256 * 1024, killSignal: 'SIGKILL' },
        (err, stdout) => finish(err && stdout.trim() === '' ? null : stdout),
      );
      child.on('error', () => finish(null));
      child.stdin?.end();
    } catch {
      finish(null);
    }
  });
}

let cachedBin: string | null = null;
let cachedFoundVia: CliFoundVia = 'none';

/** Resolve the binary, caching the hit. `health()` clears the cache first. */
export async function resolveClaudeBinary(): Promise<string | null> {
  if (cachedBin !== null && isExecutable(cachedBin)) return cachedBin;
  cachedBin = null;
  cachedFoundVia = 'none';

  // Ahead of every discovery probe: the installer wrote down where it put the
  // binary, and a path we were told beats a path we went looking for. This is what
  // removes the not-on-path case, which is the one that actually happens.
  const recorded = recordedClaudePath();
  if (recorded !== null) {
    cachedBin = recorded;
    cachedFoundVia = 'recorded';
    return cachedBin;
  }
  const viaWhich = await whichClaude();
  if (viaWhich) {
    cachedBin = viaWhich;
    cachedFoundVia = 'which';
    return cachedBin;
  }
  for (const candidate of candidatePaths()) {
    if (isExecutable(candidate)) {
      cachedBin = candidate;
      cachedFoundVia = 'known-location';
      return cachedBin;
    }
  }
  const viaNpm = await npmGlobalClaude();
  if (viaNpm) {
    cachedBin = viaNpm;
    cachedFoundVia = 'npm-prefix';
    return cachedBin;
  }
  const viaShell = await loginShellClaude();
  if (viaShell) {
    cachedBin = viaShell;
    cachedFoundVia = 'login-shell';
    return cachedBin;
  }
  return null;
}

/** How the cached binary was found. Meaningless before `resolveClaudeBinary()`. */
export function claudeFoundVia(): CliFoundVia {
  return cachedBin === null ? 'none' : cachedFoundVia;
}

/**
 * Clears what we discovered about the machine, NOT what we learned from a real
 * run: a plan or usage-limit verdict can only come from an extraction, and
 * forgetting it on every health check would leave Diagnostics unable to explain
 * the failure she is looking at.
 */
export function resetCliProbes(): void {
  cachedBin = null;
  cachedFoundVia = 'none';
  cachedFlags = null;
  cachedVersion = undefined;
  cachedShellLookup = undefined;
  // Must be cleared here, or signing in would not be visible until a restart.
  cachedAuth = undefined;
}

/* ─────────────────────────────── auth ───────────────────────────── */

/**
 * What `claude auth status --json` said, or `unknown`.
 *
 * `unknown` is a refusal, not a default. Anything this cannot positively account
 * for must never come back as signed in: claiming an account exists when it does
 * not sends her to an engine that fails on the first real contract, with every
 * setup screen having told her it was fine.
 */
export type AuthStatus =
  | { state: 'signed-in'; email: string | null; orgName: string | null; plan: string | null }
  | { state: 'signed-out' }
  | { state: 'unknown' };

/**
 * The first balanced JSON object in the text, or null.
 *
 * Not `JSON.parse(stdout)`: her dotfiles print their own banner, and reading that
 * as the answer is the same mistake `parseShellLookup` exists to avoid. String
 * contents are skipped so a brace inside an org name cannot end the scan early.
 */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseAuthStatus(stdout: string): AuthStatus {
  const parsed = firstJsonObject(stdout);
  if (!isRecord(parsed)) return { state: 'unknown' };
  const loggedIn = parsed['loggedIn'];
  if (loggedIn === false) return { state: 'signed-out' };
  // Strictly `true`. A truthy 1 or "yes" is output this does not understand.
  if (loggedIn !== true) return { state: 'unknown' };
  return {
    state: 'signed-in',
    email: stringOrNull(parsed['email']),
    orgName: stringOrNull(parsed['orgName']),
    plan: stringOrNull(parsed['subscriptionType']),
  };
}

const PLANS_WITH_CLI = new Set(['pro', 'max', 'team', 'enterprise']);
const PLANS_WITHOUT_CLI = new Set(['free']);

/**
 * Closed on both sides, and asymmetric on purpose.
 *
 * A tier nobody here has heard of is `unknown`, so the verdict falls through to
 * what a real run says. Telling someone whose plan works that it never will is the
 * worse of the two mistakes, and the set of plan names is Anthropic's to change.
 */
export function planSupportsCli(plan: string | null): 'yes' | 'no' | 'unknown' {
  if (plan === null) return 'unknown';
  const key = plan.trim().toLowerCase();
  if (PLANS_WITH_CLI.has(key)) return 'yes';
  if (PLANS_WITHOUT_CLI.has(key)) return 'no';
  return 'unknown';
}

/* ───────────────────────────── version ──────────────────────────── */

export function parseCliVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(sanitiseModelOutput(output));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** -1 / 0 / 1. Non-numeric segments are treated as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10));
  const pb = b.split('.').map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? (pa[i] ?? 0) : 0;
    const y = Number.isFinite(pb[i]) ? (pb[i] ?? 0) : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

let cachedVersion: string | null | undefined;

async function readVersion(bin: string): Promise<string | null> {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
      timeout: 15_000,
      env: childEnv(),
      maxBuffer: 256 * 1024,
    });
    cachedVersion = parseCliVersion(`${stdout}\n${stderr}`);
  } catch {
    // A version we cannot read is a warning, not a failure — an install that
    // refuses `--version` may still extract perfectly well.
    cachedVersion = null;
  }
  return cachedVersion;
}

/* ────────────────────────────── flags ──────────────────────────── */

export interface CliFlagSupport {
  allowedToolsKebab: boolean;
  allowedToolsCamel: boolean;
  disallowedTools: boolean;
  permissionMode: boolean;
  dangerouslySkipPermissions: boolean;
  outputFormat: boolean;
  model: boolean;
  /** True when at least one flag exists that can switch tools off. */
  canDisableTools: boolean;
}

export function parseFlagSupport(helpText: string): CliFlagSupport {
  const help = sanitiseModelOutput(helpText);
  const has = (flag: string): boolean => help.includes(flag);

  const allowedToolsKebab = has('--allowed-tools');
  const allowedToolsCamel = has('--allowedTools');
  const disallowedTools = has('--disallowed-tools') || has('--disallowedTools');

  return {
    allowedToolsKebab,
    allowedToolsCamel,
    disallowedTools,
    permissionMode: has('--permission-mode'),
    dangerouslySkipPermissions: has('--dangerously-skip-permissions'),
    outputFormat: has('--output-format'),
    model: has('--model'),
    canDisableTools: allowedToolsKebab || allowedToolsCamel || disallowedTools,
  };
}

/** What the tracker would never ask for anyway. Belt to the allow-list's braces. */
const ALL_TOOL_NAMES = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
].join(',');

let cachedFlags: CliFlagSupport | null = null;

async function probeFlags(bin: string): Promise<CliFlagSupport> {
  if (cachedFlags) return cachedFlags;
  let help = '';
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--help'], {
      timeout: 15_000,
      env: childEnv(),
      maxBuffer: 1024 * 1024,
    });
    help = `${stdout}\n${stderr}`;
  } catch (e) {
    // Some builds exit non-zero after printing help. Salvage whatever came out.
    if (typeof e === 'object' && e !== null) {
      const stdout = 'stdout' in e && typeof e.stdout === 'string' ? e.stdout : '';
      const stderr = 'stderr' in e && typeof e.stderr === 'string' ? e.stderr : '';
      help = `${stdout}\n${stderr}`;
    }
  }
  cachedFlags = parseFlagSupport(help);
  return cachedFlags;
}

export interface CliArgvOptions {
  modelId: string;
  flags: CliFlagSupport;
  /**
   * Explicitly-labelled last resort. Off by default: with no tools requested it is
   * unnecessary, it reads as alarming on a CFO's machine, and some managed Macs
   * refuse it outright.
   */
  dangerouslySkipPermissions?: boolean;
}

/**
 * `-p` with the prompt on **stdin**. Never as an argv argument: a 100KB contract
 * blows past ARG_MAX and fails with E2BIG, which looks like a crash.
 */
export function buildCliArgv(opts: CliArgvOptions): string[] {
  const argv = ['-p'];
  if (opts.flags.outputFormat) argv.push('--output-format', 'json');
  if (opts.flags.model) argv.push('--model', opts.modelId);

  if (opts.flags.allowedToolsKebab) argv.push('--allowed-tools', '');
  else if (opts.flags.allowedToolsCamel) argv.push('--allowedTools', '');

  if (opts.flags.disallowedTools) argv.push('--disallowed-tools', ALL_TOOL_NAMES);

  if (opts.dangerouslySkipPermissions === true && opts.flags.dangerouslySkipPermissions) {
    argv.push('--dangerously-skip-permissions');
  }
  return argv;
}

/* ──────────────────────── envelope unwrapping ──────────────────── */

export interface CliEnvelope {
  /** The model's own text. Falls back to raw stdout when no envelope was found. */
  text: string;
  /** True when the envelope itself reports a failure. */
  isError: boolean;
  /** The parsed envelope, or null when the CLI printed bare text (older builds). */
  raw: Record<string, unknown> | null;
}

const ENVELOPE_RESULT_KEYS = ['result', 'text', 'content', 'response'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function envelopeFrom(parsed: unknown): CliEnvelope | null {
  if (!isRecord(parsed)) return null;
  const isError = parsed['is_error'] === true || parsed['subtype'] === 'error';
  for (const key of ENVELOPE_RESULT_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string') return { text: value, isError, raw: parsed };
  }
  // An envelope with no textual payload is still an envelope; report it as such so
  // the caller does not go hunting for JSON in a status object.
  if ('type' in parsed || 'subtype' in parsed || 'session_id' in parsed) {
    return { text: '', isError, raw: parsed };
  }
  return null;
}

/**
 * `--output-format json` wraps the model's text in a field (commonly `result`).
 * Older builds print the text bare, and some builds emit newline-delimited JSON.
 * All three are handled; the caller then runs extractJson on `text`.
 */
export function unwrapCliEnvelope(stdout: string): CliEnvelope {
  const clean = sanitiseModelOutput(stdout).trim();
  if (clean === '') return { text: '', isError: false, raw: null };

  try {
    const direct = envelopeFrom(JSON.parse(clean));
    if (direct) return direct;
  } catch {
    // Not a single JSON document. Try newline-delimited, newest first.
  }

  const lines = clean.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || !line.startsWith('{')) continue;
    try {
      const env = envelopeFrom(JSON.parse(line));
      if (env && (env.text !== '' || env.isError)) return env;
    } catch {
      continue;
    }
  }

  return { text: clean, isError: false, raw: null };
}

/* ─────────────────────── output classification ─────────────────── */

/** Everything the classifier is allowed to look at. Pure input, pure output. */
export interface CliRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** False when no flag existed to switch tools off — changes how a hang is read. */
  toolsDisabled: boolean;
}

export type CliClassification =
  | { kind: 'ok'; text: string; json: Record<string, unknown> }
  | {
      kind: 'error';
      code: EngineErrorCode;
      detail: string;
      retryAfterMs?: number;
      limitResetsAt?: string;
    };

const PERMISSION_PATTERNS: RegExp[] = [
  /\bdo you want to (?:allow|proceed|continue)\b/i,
  /\bwould you like to allow\b/i,
  /\bpermission (?:request|required|prompt)\b/i,
  /\brequested permission(?:s)? to\b/i,
  /\bapprove this (?:tool|action|request)\b/i,
  /\btool use requires (?:approval|permission)\b/i,
  /\bpress enter to (?:continue|confirm)\b/i,
  /\b1\)\s*yes\b[\s\S]{0,80}\b2\)\s*no\b/i,
  /\bawaiting (?:your )?approval\b/i,
  /\brequires interactive (?:approval|confirmation)\b/i,
];

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /\busage limit\b/i,
  /\brate limit(?:ed|ing)?\b/i,
  /\blimit reached\b/i,
  /\bquota (?:exceeded|reached)\b/i,
  /\b\d+\s*-?\s*hour limit\b/i,
  /\bweekly limit\b/i,
  /\bresets? at\b/i,
  /\btry again (?:at|later|in)\b/i,
  /\byou(?:'ve| have) (?:reached|hit) your\b/i,
  /\bupgrade to (?:a )?higher (?:plan|tier)\b/i,
];

/**
 * Case 4: signed in, on a plan that does not include this. Distinct from a usage
 * limit because it never resets -- telling her to wait would be a lie -- and
 * distinct from "not signed in" because signing in again cannot help either.
 *
 * Every pattern here names a PLAN or a SUBSCRIPTION explicitly. Generic upgrade
 * wording is deliberately absent: "upgrade to a higher plan" also appears at the
 * end of ordinary limit messages, and is matched as a limit below.
 */
const PLAN_PATTERNS: RegExp[] = [
  /\bnot available (?:on|with|for) (?:your|this|the) (?:current )?(?:plan|subscription|account|tier)\b/i,
  /\b(?:your|this) (?:current )?(?:plan|subscription|account|tier) (?:does not|doesn't|does'nt) (?:include|support|allow|cover)\b/i,
  /\bnot included (?:in|with) (?:your|this) (?:plan|subscription)\b/i,
  /\brequires? (?:a )?claude (?:pro|max|team|enterprise)\b/i,
  /\brequires? (?:an? )?(?:paid|higher) (?:plan|subscription|tier)\b/i,
  /\bclaude code (?:is )?(?:not|isn't) (?:available|supported|enabled) (?:on|for)\b/i,
  /\bupgrade (?:your plan )?to (?:claude )?(?:pro|max)\b/i,
  /\bnot entitled\b/i,
  /\bno (?:claude )?(?:pro|max) subscription\b/i,
];

/**
 * A real cap, which resets. Checked to veto a plan match: a limit message that
 * also invites an upgrade is still a limit, and saying "your plan will never work"
 * to someone who only has to wait until 3pm is the worse of the two mistakes.
 */
const LIMIT_OVERRIDES_PLAN: RegExp[] = [
  /\busage limit\b/i,
  /\blimit reached\b/i,
  /\bresets? at\b/i,
  /\b\d+\s*-?\s*hour limit\b/i,
  /\bweekly limit\b/i,
  /\bquota (?:exceeded|reached)\b/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /\bnot logged ?in\b/i,
  /\bplease (?:run )?\/?login\b/i,
  /\brun `?claude login`?\b/i,
  /\bsign(?: |-)?in (?:required|to continue)\b/i,
  /\bsession (?:expired|has expired)\b/i,
  /\bauthenticat(?:e|ion) (?:required|failed|error)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\binvalid (?:api key|credentials|token)\b/i,
  /\bcredentials (?:not found|missing|invalid)\b/i,
  /\bno active (?:session|account|subscription)\b/i,
  /\boauth (?:token )?(?:expired|invalid)\b/i,
];

const UNKNOWN_FLAG_PATTERNS: RegExp[] = [
  /\bunknown (?:option|argument|flag)\b/i,
  /\bunrecogni[sz]ed (?:option|argument|flag)\b/i,
  /\bbad option\b/i,
  /\binvalid option\b/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/**
 * Pull the reset moment out of whatever phrasing the CLI used. Bonnie needs to know
 * when she can resume, so this tries hard: ISO timestamps, unix seconds, 12- and
 * 24-hour clock times, and "in 45 minutes".
 *
 * Returns an ISO string plus the wait in ms, or null. Never throws.
 */
export function parseResetAt(text: string, now: number = Date.now()): { at: string; ms: number } | null {
  const clean = text.replace(/\s+/g, ' ');

  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(
    clean,
  );
  if (iso?.[1]) {
    const at = Date.parse(iso[1].replace(' ', 'T'));
    if (Number.isFinite(at)) return finish(at, now);
  }

  // Claude Code has historically appended `|<unix seconds>` to limit messages.
  const epoch = /\b(1[6-9]\d{8}|2[0-9]\d{8})\b/.exec(clean);
  if (epoch?.[1]) {
    const at = Number.parseInt(epoch[1], 10) * 1000;
    if (Number.isFinite(at)) return finish(at, now);
  }

  const relative = /\bin (?:about )?(\d{1,4})\s*(second|sec|minute|min|hour|hr)s?\b/i.exec(clean);
  if (relative?.[1] && relative[2]) {
    const n = Number.parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith('s') ? n * 1_000 : unit.startsWith('m') ? n * 60_000 : n * 3_600_000;
    return finish(now + ms, now);
  }

  const clock =
    /\b(?:resets?|reset|available|try again|again)\s*(?:at|after)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(
      clean,
    );
  if (clock?.[1]) {
    const hour12 = Number.parseInt(clock[1], 10);
    const minute = clock[2] ? Number.parseInt(clock[2], 10) : 0;
    const meridiem = clock[3]?.toLowerCase();
    if (hour12 <= 24 && minute < 60) {
      let hour = hour12;
      if (meridiem === 'pm' && hour12 < 12) hour = hour12 + 12;
      if (meridiem === 'am' && hour12 === 12) hour = 0;
      const target = new Date(now);
      target.setHours(hour, minute, 0, 0);
      let at = target.getTime();
      // "resets at 3pm" said at 4pm means tomorrow.
      if (at <= now) at += 24 * 3_600_000;
      return finish(at, now);
    }
  }

  const dated =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,)?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(
      clean,
    );
  if (dated?.[1] && dated[2] && dated[3]) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    const day = Number.parseInt(dated[2], 10);
    let hour = Number.parseInt(dated[3], 10);
    const minute = dated[4] ? Number.parseInt(dated[4], 10) : 0;
    const meridiem = dated[5]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (month >= 0 && day >= 1 && day <= 31) {
      const ref = new Date(now);
      const target = new Date(ref.getFullYear(), month, day, hour, minute, 0, 0);
      let at = target.getTime();
      if (at <= now - 30 * 24 * 3_600_000) {
        at = new Date(ref.getFullYear() + 1, month, day, hour, minute, 0, 0).getTime();
      }
      return finish(at, now);
    }
  }

  return null;
}

function finish(at: number, now: number): { at: string; ms: number } | null {
  if (!Number.isFinite(at)) return null;
  // A reset more than a fortnight out is a misparse, not a subscription window.
  if (at - now > 14 * 24 * 3_600_000) return null;
  return { at: new Date(at).toISOString(), ms: Math.max(0, at - now) };
}

function tailBytes(text: string, max: number): string {
  return text.length <= max ? text : `...${text.slice(text.length - max)}`;
}

/**
 * Turn a finished child process into either an answer or a named failure.
 *
 * Pure, so every branch is testable against real CLI output samples.
 *
 * Ordering matters: we try to read an answer FIRST. The model's reply quotes
 * contract language, and a confidentiality clause can easily contain phrases like
 * "permission to use" or "limit". Pattern-matching before parsing would classify a
 * perfectly good extraction as a permission prompt.
 */
export function classifyCliOutput(
  outcome: CliRunOutcome,
  now: number = Date.now(),
): CliClassification {
  const stdout = sanitiseModelOutput(outcome.stdout);
  const stderr = sanitiseModelOutput(outcome.stderr);

  if (outcome.aborted) {
    return { kind: 'error', code: 'CLI_TIMEOUT', detail: 'Cancelled before it finished.' };
  }

  if (outcome.timedOut) {
    // Nothing at all on stdout, and we could not prove tools were off: the most
    // likely explanation is a blocked interactive approval, not a slow model.
    if (stdout.trim() === '' && !outcome.toolsDisabled) {
      return {
        kind: 'error',
        code: 'CLI_PERMISSION_PROMPT',
        detail: 'No output before the deadline and no flag was available to disable tools.',
      };
    }
    return {
      kind: 'error',
      code: 'CLI_TIMEOUT',
      detail: `No usable output within ${LIMITS.cliTimeoutMs}ms.`,
    };
  }

  const envelope = unwrapCliEnvelope(stdout);
  if (!envelope.isError && envelope.text.trim() !== '') {
    const json = extractJson(envelope.text);
    if (json && hasAnswerKeys(json)) {
      // A non-zero exit alongside a usable answer is a CLI quirk, not a failure.
      return { kind: 'ok', text: envelope.text, json };
    }
  }

  const combined = `${envelope.isError ? envelope.text : stdout}\n${stderr}`;

  const permission = firstMatch(combined, PERMISSION_PATTERNS);
  if (permission) {
    return {
      kind: 'error',
      code: 'CLI_PERMISSION_PROMPT',
      detail: `Claude Code asked for approval: "${permission}".`,
    };
  }

  // A plan problem is checked before a limit, because a plan message usually ends
  // with upgrade wording that the limit patterns also match. The veto keeps a real
  // limit from being misread as a plan she can never use.
  const plan = firstMatch(combined, PLAN_PATTERNS);
  if (plan !== null && firstMatch(combined, LIMIT_OVERRIDES_PLAN) === null) {
    return {
      kind: 'error',
      code: 'CLI_PLAN_UNSUPPORTED',
      detail: `This Claude plan lacks the access the tracker needs: "${plan}".`,
    };
  }

  // Usage limits are checked before auth: a limit message often invites the user to
  // upgrade, which reads like a sign-in problem if auth is matched first.
  const limit = firstMatch(combined, USAGE_LIMIT_PATTERNS);
  if (limit) {
    const reset = parseResetAt(combined, now);
    const base: CliClassification = {
      kind: 'error',
      code: 'CLI_USAGE_LIMIT',
      detail: `Subscription limit: "${limit}".`,
    };
    return reset ? { ...base, retryAfterMs: reset.ms, limitResetsAt: reset.at } : base;
  }

  const auth = firstMatch(combined, AUTH_PATTERNS);
  if (auth) {
    return {
      kind: 'error',
      code: 'CLI_NOT_AUTHENTICATED',
      detail: `Claude Code is not signed in: "${auth}".`,
    };
  }

  const badFlag = firstMatch(combined, UNKNOWN_FLAG_PATTERNS);
  if (badFlag) {
    return {
      kind: 'error',
      code: 'CLI_VERSION_UNSUPPORTED',
      detail: `Installed Claude Code rejected a required flag: "${badFlag}".`,
    };
  }

  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const how = outcome.signal !== null ? `signal ${outcome.signal}` : `exit ${outcome.exitCode}`;
    return {
      kind: 'error',
      code: 'CLI_CRASHED',
      detail: `Claude Code ended with ${how}. ${redact(tailBytes(stderr, CRASH_DETAIL_BYTES)) ?? ''}`.trim(),
    };
  }

  return {
    kind: 'error',
    code: 'CLI_BAD_OUTPUT',
    detail:
      stdout.trim() === ''
        ? 'Claude Code exited cleanly but printed nothing.'
        : `No JSON object found in ${stdout.length} characters of output.`,
  };
}

/* ────────────────────────────── spawning ───────────────────────── */

interface SpawnRequest {
  bin: string;
  argv: string[];
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  toolsDisabled: boolean;
}

/**
 * Run the child to completion. Guarantees: the prompt goes in on stdin, the child
 * is SIGTERMed at the deadline and SIGKILLed 2s later, an abort kills it too, and
 * no listener or timer outlives the call. An orphaned `claude` process holding a
 * subscription slot is worse than a failed extraction.
 */
function runClaude(req: SpawnRequest): Promise<CliRunOutcome> {
  return new Promise<CliRunOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(req.bin, req.argv, { env: childEnv() });

    let killTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      hardKill();
    }, req.timeoutMs);

    function hardKill(): void {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      killTimer ??= setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, SIGKILL_GRACE_MS);
    }

    const onAbort = (): void => {
      aborted = true;
      hardKill();
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    function cleanup(): void {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      req.signal?.removeEventListener('abort', onAbort);
    }

    function settle(exitCode: number | null, signalName: string | null): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: signalName,
        timedOut,
        aborted,
        toolsDisabled: req.toolsDisabled,
      });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_CAP_BYTES) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_CAP_BYTES) stderr = stderr.slice(-STDERR_CAP_BYTES);
    });

    child.on('error', (err: Error) => {
      // ENOENT here means the binary vanished between probe and spawn.
      stderr += `\nspawn failed: ${err.message}`;
      settle(null, null);
    });
    child.on('close', (code, signalName) => settle(code, signalName));

    // The prompt must go in on stdin, then stdin must be closed: an open stdin is
    // what lets the CLI believe it can ask a question.
    child.stdin.on('error', () => {
      // EPIPE when the child died early. The close handler reports the real reason.
    });
    child.stdin.end(req.stdin, 'utf8');

    if (req.signal?.aborted === true) onAbort();
  });
}

/* ──────────────────────────── credentials ──────────────────────── */

/**
 * A cheap, side-effect-free guess at whether Claude Code is signed in. It is only a
 * guess — `--version` works fine when logged out — so health() reports `unknown`
 * rather than claiming a green tick it cannot back up. selfTest() is the real proof.
 */
/**
 * The authoritative answer to "is it signed in, and to what", and it spends nothing.
 *
 * This replaced a probe that looked for a credentials file and inferred a login
 * from its existence. That could not tell a stale file from a live session, knew
 * nothing about the plan, and produced `unverified` on a perfectly working install.
 *
 * A binary that does not answer, times out, or prints something unrecognisable is
 * `unknown`. It is never read as signed in.
 */
let cachedAuth: AuthStatus | undefined;

async function readAuthStatus(bin: string): Promise<AuthStatus> {
  /*
   * Cached with the other probes, and for a sharper reason than speed.
   *
   * `diagnoseCli` runs on every engine health check, and this app has already been
   * taken down once by exactly that shape: polling a health endpoint that spawns
   * the CLI piled up fifteen concurrent `claude` processes and wedged the server,
   * which is why the installer's liveness check is a static file. Adding an
   * unconditional spawn to the same path would be walking back into it.
   *
   * It does NOT make the answer stale. `health()` calls `resetCliProbes()` at the
   * top of every request and `diagnoseCli({fresh:true})` does the same, so the
   * cache lives for one request: `health()` and the `diagnoseCli()` that follows it
   * on the same endpoint share one spawn instead of making two. Signing in is
   * visible on the very next Recheck.
   */
  if (cachedAuth !== undefined) return cachedAuth;
  const out = await runCapture(bin, ['auth', 'status', '--json'], 10_000);
  cachedAuth = out === null ? { state: 'unknown' } : parseAuthStatus(out);
  return cachedAuth;
}

/**
 * "Claude Pro, bonnie@ibcbatt.com". Safe to show and safe to put in a support
 * bundle: an account name and a plan tier, never a token.
 */
export function describeAccount(auth: AuthStatus): string {
  if (auth.state !== 'signed-in') return 'Not signed in.';
  const plan = auth.plan === null ? 'Claude' : `Claude ${titleCase(auth.plan)}`;
  return auth.email === null ? plan : `${plan}, ${auth.email}`;
}

function titleCase(s: string): string {
  const t = s.trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1).toLowerCase();
}

/* ───────────────────────────── diagnosis ───────────────────────── */

/**
 * One verdict, in her language, for the Engine step and for Diagnostics.
 *
 * The order below is the order the questions actually have to be asked in, and it
 * is what turns five failures that look identical into five different sentences:
 *
 *   1. Nothing runnable anywhere            -> not-installed
 *   2. ...but the login shell knows the name -> not-on-path  (the GUI-launch case)
 *   3. Runs, but too old to accept our flags -> too-old
 *   4. A real run said plan / limit / login  -> that verdict, replayed
 *   5. No way to switch its tools off        -> blocked
 *   6. `claude auth status` answered      -> working / not-signed-in / plan
 *
 * Steps 1-3, 5 and 6 look at the machine. Step 4 is the only one that needs a real
 * extraction to have happened, which is exactly why the Test step exists.
 */
export async function diagnoseCli(opts: { fresh?: boolean } = {}): Promise<CliDiagnosis> {
  if (opts.fresh === true) resetCliProbes();

  const bin = await resolveClaudeBinary();
  if (bin === null) {
    // The distinction that decides which sentence she reads: if her own shell can
    // resolve the name, this is a PATH problem, not a missing install, and telling
    // her to install something she already has is how trust in the app dies.
    const known = await loginShellLookup();
    return describeCli(known === null ? 'not-installed' : 'not-on-path');
  }

  const version = await readVersion(bin);
  const facts = {
    binPath: bin,
    foundVia: claudeFoundVia(),
    version,
    limitResetsAt: lastLimitResetsAt ?? null,
  };

  if (version !== null && compareVersions(version, MIN_CLI_VERSION) < 0) {
    return describeCli('too-old', facts);
  }

  // What a real run told us outranks anything we can infer from the filesystem.
  // CLI_NOT_FOUND is excluded: we are holding the binary, so that verdict is stale.
  const remembered = recentFailure();
  const fromRun: CliCase | null =
    remembered === 'CLI_NOT_AUTHENTICATED'
      ? 'not-signed-in'
      : remembered === 'CLI_PLAN_UNSUPPORTED'
        ? 'plan-unsupported'
        : remembered === 'CLI_USAGE_LIMIT'
          ? 'usage-limit'
          : remembered === 'CLI_PERMISSION_PROMPT'
            ? 'blocked'
            : null;
  if (fromRun !== null) return describeCli(fromRun, facts);

  const flags = await probeFlags(bin);
  if (!flags.canDisableTools) return describeCli('blocked', facts);

  // Ask it, rather than inferring a login from a file on disk. This costs nothing
  // and answers two questions the filesystem never could: whether the session is
  // live, and which account and plan it belongs to.
  const auth = await readAuthStatus(bin);
  if (auth.state === 'signed-out') return describeCli('not-signed-in', facts);
  if (auth.state === 'unknown') return describeCli('unverified', facts);

  const account = { email: auth.email, orgName: auth.orgName, plan: auth.plan };
  // Only a plan we positively recognise as lacking CLI access is a verdict here.
  // An unfamiliar tier stays `working` and lets a real run have the final word.
  if (planSupportsCli(auth.plan) === 'no') {
    return describeCli('plan-unsupported', { ...facts, account });
  }
  return describeCli('working', { ...facts, account });
}

/* ───────────────────────────── the engine ──────────────────────── */

let inFlight = 0;
let lastLimitResetsAt: string | undefined;

/**
 * What the last real run said, and when. Two of the five failures -- a plan without
 * the access we need, and a usage cap -- cannot be detected by looking at the
 * machine. They are only knowable from an actual extraction, so the verdict is
 * remembered here and replayed into the diagnosis. That is what lets
 * Settings -> Diagnostics answer "it stopped working" on one screen.
 */
interface RememberedFailure {
  code: EngineErrorCode;
  at: number;
}

let lastFailure: RememberedFailure | null = null;

/** Older than this and it is history, not the current state of the machine. */
const FAILURE_MEMORY_MS = 30 * 60_000;

function noteCliFailure(code: EngineErrorCode, limitResetsAt?: string): void {
  lastFailure = { code, at: Date.now() };
  if (limitResetsAt !== undefined) lastLimitResetsAt = limitResetsAt;
}

function recentFailure(now: number = Date.now()): EngineErrorCode | null {
  if (lastFailure === null) return null;
  return now - lastFailure.at <= FAILURE_MEMORY_MS ? lastFailure.code : null;
}

/** Exposed for tests and for a Recheck that should start from a clean slate. */
export function clearCliFailureMemory(): void {
  lastFailure = null;
  lastLimitResetsAt = undefined;
}

export interface CliProviderConfig {
  /** Off by default, and only ever set from an explicitly-labelled setting. */
  dangerouslySkipPermissions?: boolean;
}

export class CliProvider implements Provider {
  readonly id = 'cli' as const;
  readonly maxConcurrency = MAX_CONCURRENCY;

  /**
   * Reading page images would mean granting file tools to a process we have
   * deliberately stripped of them. A scan fails loudly so the UI can offer the API
   * engine, rather than quietly returning a worse answer.
   */
  readonly supportsVision = false;

  private config: CliProviderConfig;

  constructor(config: CliProviderConfig = {}) {
    this.config = config;
  }

  /** Applied on the next extraction. Settings changes must not need a restart. */
  configure(config: CliProviderConfig): void {
    this.config = config;
  }

  async extract(req: ExtractionRequest, opts: ExtractOptions = {}): Promise<ExtractionResponse> {
    const started = Date.now();

    if (req.images !== null && req.images.length > 0) {
      throw new EngineError('VISION_UNSUPPORTED', {
        detail: 'The Claude subscription engine has no tools with which to read page images.',
      });
    }
    if (req.text === null || req.text.trim() === '') {
      throw new EngineError('PDF_EMPTY', { detail: 'No document text was supplied.' });
    }
    if (req.pageCount > LIMITS.maxPages || req.text.length > LIMITS.maxTextChars) {
      throw new EngineError('PDF_TOO_LARGE', {
        detail: `${req.pageCount} pages / ${req.text.length} characters exceeds the single-pass budget.`,
      });
    }
    if (req.fieldsToFill.length === 0) {
      throw new EngineError('SCHEMA_INVALID', { detail: 'No fields were requested.' });
    }

    const bin = await resolveClaudeBinary();
    if (bin === null) {
      throw new EngineError('CLI_NOT_FOUND', {
        detail: 'No `claude` binary on PATH or in any known install location.',
      });
    }

    const version = await readVersion(bin);
    if (version !== null && compareVersions(version, MIN_CLI_VERSION) < 0) {
      throw new EngineError('CLI_VERSION_UNSUPPORTED', {
        detail: `Found v${version}; the tracker needs v${MIN_CLI_VERSION} or newer.`,
      });
    }

    const flags = await probeFlags(bin);
    const argv = buildCliArgv({
      modelId: modelFor(req.tier).id,
      flags,
      dangerouslySkipPermissions: this.config.dangerouslySkipPermissions === true,
    });

    if (inFlight >= MAX_CONCURRENCY) {
      throw new EngineError('CLI_CONCURRENCY', {
        detail: 'A Claude Code extraction is already running; parallel spawns trip the limit.',
      });
    }

    const basePrompt = buildExtractionPrompt(req);
    const timeoutMs = opts.timeoutMs ?? LIMITS.cliTimeoutMs;

    inFlight += 1;
    try {
      let prompt = basePrompt;
      let repairAttempts = 0;
      let lastResponse = '';
      let lastError: EngineError | null = null;

      for (let attempt = 0; attempt <= LIMITS.maxRepairAttempts; attempt += 1) {
        if (attempt > 0) {
          repairAttempts = attempt;
          opts.onProgress?.('repairing');
        } else {
          opts.onProgress?.('sending');
        }

        const outcome = await runClaude({
          bin,
          argv,
          stdin: prompt,
          timeoutMs,
          signal: opts.signal,
          toolsDisabled: flags.canDisableTools,
        });

        opts.onProgress?.('parsing');
        const classified = classifyCliOutput(outcome);

        if (classified.kind === 'error') {
          const err = new EngineError(classified.code, {
            detail: classified.detail,
            ...(classified.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: classified.retryAfterMs }),
          });
          noteCliFailure(classified.code, classified.limitResetsAt);
          // Only a malformed reply is worth asking again for. Everything else is an
          // environment problem that a second spawn cannot fix.
          if (classified.code !== 'CLI_BAD_OUTPUT' || attempt === LIMITS.maxRepairAttempts) {
            throw err;
          }
          lastError = err;
          lastResponse = sanitiseModelOutput(outcome.stdout);
          prompt = basePrompt + buildRepairInstruction([classified.detail]);
          continue;
        }

        lastResponse = classified.text;
        const validated = validateAnswer(classified.json, req.fieldsToFill);
        if (!validated.ok) {
          if (attempt === LIMITS.maxRepairAttempts) {
            throw new EngineError('SCHEMA_INVALID', {
              detail: validated.issues.join(' '),
            });
          }
          prompt = basePrompt + buildRepairInstruction(validated.issues);
          continue;
        }

        // Proof beats memory: a run that worked retires whatever the last failure
        // was, so Diagnostics cannot keep showing a problem that has been fixed.
        lastFailure = null;
        return this.buildResponse({
          req,
          fields: validated.data,
          docType: extractDocType(classified.json),
          prompt,
          response: lastResponse,
          repairAttempts,
          durationMs: Date.now() - started,
        });
      }

      throw (
        lastError ??
        new EngineError('CLI_BAD_OUTPUT', {
          detail: `Gave up after ${LIMITS.maxRepairAttempts + 1} attempts. Last reply was ${lastResponse.length} characters.`,
        })
      );
    } catch (e) {
      throw toEngineError(e, 'CLI_CRASHED');
    } finally {
      inFlight -= 1;
    }
  }

  private buildResponse(args: {
    req: ExtractionRequest;
    fields: Partial<Record<FieldKey, RawFieldAnswer>>;
    docType: DocType | null;
    prompt: string;
    response: string;
    repairAttempts: number;
    durationMs: number;
  }): ExtractionResponse {
    return {
      fields: args.fields,
      docType: args.docType,
      usage: {
        // The CLI reports no token counts we could bill against, and a subscription
        // has no marginal cost. Reporting zeros beats inventing numbers.
        inputTokens: null,
        outputTokens: null,
        costUsd: 0,
      },
      raw: {
        provider: 'cli',
        model: modelFor(args.req.tier).id,
        promptVersion: args.req.promptVersion,
        prompt: args.prompt,
        // Kept verbatim, NOT redacted: notice_email is a tracker field, and
        // scrubbing it here would destroy the audit trail the reviewer relies on.
        response: args.response,
        repairAttempts: args.repairAttempts,
      },
      durationMs: args.durationMs,
    };
  }

  async health(): Promise<ProviderHealth> {
    // Re-probe every time: a CLI installed since the last check should show up
    // without a restart, and one that was uninstalled should stop showing green.
    resetCliProbes();

    const checks: HealthCheck[] = [];
    const bin = await resolveClaudeBinary();

    if (bin === null) {
      // Two different failures wearing the same face. Her own shell is the only
      // witness that can tell them apart, so it is asked before we accuse the Mac
      // of not having Claude Code on it.
      const known = await loginShellLookup();
      checks.push({
        id: known === null ? 'cli-found' : 'cli-path',
        label: known === null ? 'Claude Code installed' : 'Claude Code reachable',
        state: 'fail',
        detail:
          known === null
            ? 'Not on PATH, not in any known install location, and your shell does not know it either.'
            : 'Your Terminal can find `claude`, but this app cannot run what it points at.',
        errorCode: 'CLI_NOT_FOUND',
      });
      return {
        provider: 'cli',
        state: 'fail',
        summary: known === null ? 'Claude Code not found' : 'Claude Code found, but not runnable here',
        checks,
      };
    }

    checks.push({
      id: 'cli-found',
      label: 'Claude Code installed',
      state: 'ok',
      // Where it was found is the difference between "fine" and "fine by luck":
      // a binary only the login shell knew about is one PATH edit from vanishing.
      detail:
        cachedFoundVia === 'login-shell' || cachedFoundVia === 'npm-prefix'
          ? `${bin} - found only by probing beyond this app's PATH`
          : bin,
    });

    const version = await readVersion(bin);
    if (version === null) {
      checks.push({
        id: 'cli-version',
        label: 'Version',
        state: 'warn',
        detail: 'Could not read `claude --version`. Proceeding anyway.',
      });
    } else if (compareVersions(version, MIN_CLI_VERSION) < 0) {
      checks.push({
        id: 'cli-version',
        label: 'Version',
        state: 'fail',
        detail: `v${version} is older than the required v${MIN_CLI_VERSION}.`,
        errorCode: 'CLI_VERSION_UNSUPPORTED',
      });
    } else {
      checks.push({
        id: 'cli-version',
        label: 'Version',
        state: 'ok',
        detail: `v${version}`,
      });
    }

    const flags = await probeFlags(bin);
    checks.push({
      id: 'cli-tools-off',
      label: 'Tools disabled',
      state: flags.canDisableTools ? 'ok' : 'warn',
      detail: flags.canDisableTools
        ? describeToolFlags(flags)
        : 'This build accepts no tool-restriction flag; an approval prompt could block a run.',
      ...(flags.canDisableTools ? {} : { errorCode: 'CLI_PERMISSION_PROMPT' }),
    });

    const auth = await readAuthStatus(bin);
    const remembered = recentFailure();
    const signedOut = remembered === 'CLI_NOT_AUTHENTICATED' || auth.state === 'signed-out';
    checks.push({
      id: 'cli-auth',
      label: 'Signed in',
      state: signedOut ? 'fail' : auth.state === 'signed-in' ? 'ok' : 'unknown',
      detail: signedOut
        ? remembered === 'CLI_NOT_AUTHENTICATED'
          ? 'The last run was refused for want of a login.'
          : 'Claude Code has no account attached.'
        : auth.state === 'signed-in'
          ? describeAccount(auth)
          : 'Claude Code did not report its sign-in state.',
      ...(signedOut ? { errorCode: 'CLI_NOT_AUTHENTICATED' } : {}),
    });

    // Which account, in the row she reads, because signing into a personal account
    // instead of the work one is otherwise invisible and looks like a broken app.
    if (auth.state === 'signed-in' && planSupportsCli(auth.plan) === 'no') {
      checks.push({
        id: 'cli-plan',
        label: 'Plan',
        state: 'fail',
        detail: `${describeAccount(auth)} does not include reading documents through Claude Code.`,
        errorCode: 'CLI_PLAN_UNSUPPORTED',
      });
    }

    // A plan without the access we need, and a usage cap, are invisible to every
    // probe above: nothing on this Mac knows either. They are only ever learned
    // from a real run, so the run's verdict is shown as its own row rather than
    // left to be rediscovered the next time she drops a document in.
    if (remembered === 'CLI_PLAN_UNSUPPORTED') {
      checks.push({
        id: 'cli-plan',
        label: 'Plan',
        state: 'fail',
        detail: 'This Claude plan does not include reading documents through Claude Code.',
        errorCode: 'CLI_PLAN_UNSUPPORTED',
      });
    } else if (remembered === 'CLI_USAGE_LIMIT') {
      checks.push({
        id: 'cli-limit',
        label: 'Usage limit',
        state: 'warn',
        detail:
          lastLimitResetsAt === undefined
            ? 'The subscription limit was reached. It resets on its own.'
            : `The subscription limit was reached. It resets around ${lastLimitResetsAt}.`,
        errorCode: 'CLI_USAGE_LIMIT',
      });
    }

    const failed = checks.some((c) => c.state === 'fail');
    const warned = checks.some((c) => c.state === 'warn');
    const state = failed ? 'fail' : warned ? 'warn' : 'ok';

    return {
      provider: 'cli',
      state,
      summary: `Claude Code${version === null ? '' : ` v${version}`}${
        auth.state === 'signed-in'
          ? ` - ${describeAccount(auth)}`
          : auth.state === 'signed-out'
            ? ' - not signed in'
            : ' - sign-in unverified'
      }`,
      checks,
      ...(version === null ? {} : { version }),
      ...(lastLimitResetsAt === undefined ? {} : { limitResetsAt: lastLimitResetsAt }),
    };
  }

  async selfTest(opts: ExtractOptions = {}): Promise<{
    ok: boolean;
    durationMs: number;
    fieldsFound: number;
    fieldsTotal: number;
    costUsd: number | null;
    error?: EngineError;
  }> {
    const started = Date.now();
    const req = buildSelfTestRequest({ promptVersion: 'selftest', tier: 'fast' });
    try {
      const res = await this.extract(req, opts);
      const fieldsFound = countVerifiableQuotes(SELF_TEST_TEXT, res.fields);
      return {
        ok: fieldsFound > 0,
        durationMs: Date.now() - started,
        fieldsFound,
        fieldsTotal: SELF_TEST_FIELDS.length,
        costUsd: 0,
      };
    } catch (e) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        fieldsFound: 0,
        fieldsTotal: SELF_TEST_FIELDS.length,
        costUsd: 0,
        error: toEngineError(e, 'CLI_CRASHED'),
      };
    }
  }
}

function describeToolFlags(flags: CliFlagSupport): string {
  const used: string[] = [];
  if (flags.allowedToolsKebab) used.push('--allowed-tools');
  else if (flags.allowedToolsCamel) used.push('--allowedTools');
  if (flags.disallowedTools) used.push('--disallowed-tools');
  return `Using ${used.join(' and ')}.`;
}
