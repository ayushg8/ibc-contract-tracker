/**
 * Invoking Claude Code to fix the app, unattended, on her Mac.
 *
 * Three things are reused rather than reinvented, because a second dialect for
 * any of them is a second thing to keep true:
 *
 *   * `resolveClaudeBinary()` from providers/cli.ts finds the binary, including
 *     the GUI-launch case where ~/.local/bin and Homebrew are invisible.
 *   * `parseFlagSupport()` reads what this installed build actually accepts, so
 *     a flag it does not have is never passed.
 *   * `classifyCliOutput()` turns the finished process into a named failure --
 *     which is how a usage limit here becomes the same CLI_USAGE_LIMIT, with the
 *     same reset time, that the extraction queue already knows how to wait out.
 *
 * What is NOT reused is the spawn: extraction runs with every tool switched off,
 * and this cannot -- a repair that may not edit a file is not a repair. The
 * permission grant is therefore built here, explicitly, and narrowly:
 *
 *   * the working directory is a scratch copy, never the live install
 *   * edits are auto-accepted only inside that directory
 *   * the tool list is an allow-list: read, search, edit, and three named test
 *     commands. No web access, no subagents, no arbitrary shell.
 *   * a wall clock, and a turn cap
 *   * `--dangerously-skip-permissions` is never passed
 *
 * If the model tries anything outside the grant, the CLI asks for approval;
 * stdin is closed, so it cannot be answered, and classifyCliOutput reports
 * CLI_PERMISSION_PROMPT. An attempt that overreaches fails loudly instead of
 * hanging or, worse, being allowed.
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  classifyCliOutput,
  parseFlagSupport,
  resolveClaudeBinary,
  unwrapCliEnvelope,
  type CliClassification,
  type CliFlagSupport,
} from '@/lib/providers/cli';
import { EngineError, redact } from '@/lib/providers/errors';
import { modelFor } from '@/lib/providers/types';

import { protectedPathsForPrompt } from './protected';
import {
  CLAUDE_MAX_TURNS,
  CLAUDE_TIMEOUT_MS,
  MAX_PROMPT_DIFF_BYTES,
  MAX_PROMPT_LOG_BYTES,
  type RepairRequest,
} from './types';

const execFileAsync = promisify(execFile);
const SIGKILL_GRACE_MS = 5_000;
const STDOUT_CAP_BYTES = 4 * 1024 * 1024;
const STDERR_CAP_BYTES = 64 * 1024;

/* ──────────────────────── the permission grant ──────────────────────── */

/**
 * Everything the repair is allowed to do.
 *
 * Read/Glob/Grep so it can find the fault. Edit/Write so it can fix it. Three
 * Bash specifiers so it can check its own work before we do -- each pinned to a
 * command, not to `Bash`, and each one a read-only verification step.
 *
 * The gates run again afterwards regardless of what Claude reports, so these
 * exist to help it converge, not to be believed.
 */
export const REPAIR_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'MultiEdit',
  'Bash(node node_modules/typescript/bin/tsc:*)',
  'Bash(node node_modules/vitest/vitest.mjs:*)',
  'Bash(node --experimental-strip-types evals/run.ts:*)',
];

/**
 * Refused outright, so a build whose allow-list is advisory still cannot reach
 * the network, spawn subagents, or run a shell command that was not named.
 */
export const REPAIR_DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
];

/** Flags beyond what providers/cli.ts probes for. Absent ones are simply not used. */
export interface RepairFlagSupport extends CliFlagSupport {
  maxTurns: boolean;
  resume: boolean;
  addDir: boolean;
}

export function parseRepairFlagSupport(helpText: string): RepairFlagSupport {
  const base = parseFlagSupport(helpText);
  return {
    ...base,
    maxTurns: helpText.includes('--max-turns'),
    resume: helpText.includes('--resume'),
    addDir: helpText.includes('--add-dir'),
  };
}

export interface RepairArgvOptions {
  flags: RepairFlagSupport;
  modelId: string;
  /** Continue a session that stopped on a usage limit, when the build allows it. */
  resumeSessionId?: string | null;
}

/**
 * The argv, built from what this build supports.
 *
 * `--permission-mode acceptEdits` is the narrowest mode that lets an unattended
 * session edit at all: it accepts file edits in the working directory and still
 * asks about everything else. `bypassPermissions` would accept everything, which
 * is precisely what must not happen on her Mac, and is never passed here.
 */
export function buildRepairArgv(opts: RepairArgvOptions): string[] {
  const argv = ['-p'];
  if (opts.flags.outputFormat) argv.push('--output-format', 'json');
  if (opts.flags.model) argv.push('--model', opts.modelId);
  if (opts.flags.permissionMode) argv.push('--permission-mode', 'acceptEdits');

  const allowed = REPAIR_ALLOWED_TOOLS.join(',');
  if (opts.flags.allowedToolsKebab) argv.push('--allowed-tools', allowed);
  else if (opts.flags.allowedToolsCamel) argv.push('--allowedTools', allowed);

  if (opts.flags.disallowedTools) argv.push('--disallowed-tools', REPAIR_DISALLOWED_TOOLS.join(','));
  if (opts.flags.maxTurns) argv.push('--max-turns', String(CLAUDE_MAX_TURNS));

  if (opts.flags.resume && opts.resumeSessionId != null && opts.resumeSessionId !== '') {
    argv.push('--resume', opts.resumeSessionId);
  }
  return argv;
}

/**
 * True when this build can be trusted to keep the session inside the grant.
 *
 * Without any tool-restriction flag the CLI would run with its defaults, which
 * is a wider grant than was authorised. Repair refuses rather than proceeding
 * with permissions nobody agreed to.
 */
export function grantIsEnforceable(flags: RepairFlagSupport): boolean {
  return flags.canDisableTools;
}

/**
 * The grant, in one line, for the audit trail.
 *
 * `flags` is optional because this is also written before the binary is probed;
 * without it the line describes what was asked for rather than what this build
 * accepted, which is the honest reading either way.
 */
export function describeGrant(flags?: RepairFlagSupport): string {
  const parts = [
    `tools=${REPAIR_ALLOWED_TOOLS.join(' ')}`,
    `denied=${REPAIR_DISALLOWED_TOOLS.join(' ')}`,
    flags === undefined || flags.permissionMode ? 'mode=acceptEdits' : 'mode=default',
    flags === undefined || flags.maxTurns ? `maxTurns=${CLAUDE_MAX_TURNS}` : 'maxTurns=unsupported',
    `timeoutMs=${CLAUDE_TIMEOUT_MS}`,
    'cwd=workspace-clone',
    'skipPermissions=never',
  ];
  return parts.join(' ');
}

/* ───────────────────────────── the prompt ───────────────────────────── */

function clip(text: string, max: number): string {
  const clean = redact(text) ?? '';
  if (clean.length <= max) return clean;
  return `...(${clean.length - max} characters omitted)...\n${clean.slice(clean.length - max)}`;
}

export interface PromptContext {
  request: RepairRequest;
  /** Gate output from the previous attempt, if any. */
  previousGateDetail?: string;
  /** What the previous attempt changed, if any. */
  previousDiff?: string;
  /** Which attempt this is, 1-based, and the cap. */
  attempt: number;
  cap: number;
}

/**
 * What Claude is told.
 *
 * The protected list is in here as well as being enforced afterwards. Both, on
 * purpose: telling it makes a good outcome more likely, checking it makes a bad
 * one impossible.
 */
export function buildRepairPrompt(ctx: PromptContext): string {
  const { request } = ctx;
  const sections: string[] = [];

  sections.push(
    [
      'You are repairing an installed macOS application, unattended, on its user\'s Mac.',
      'She is a CFO, she is not technical, and this app is her record of every NDA the',
      'company has signed. She is not watching. Nobody will answer a question.',
      '',
      'An update failed. The app has ALREADY been rolled back to the previous working',
      'version and that version has been health-checked, so nothing is broken right now.',
      'Your job is to fix the update so it can be applied later, not to restore service.',
      '',
      `This is attempt ${ctx.attempt} of ${ctx.cap} for this failure. After ${ctx.cap} the`,
      'repair stops permanently and a human is told.',
    ].join('\n'),
  );

  sections.push(
    [
      '## The failure',
      `stage:   ${request.failure.stage}`,
      `code:    ${request.failure.code}`,
      `message: ${request.failure.message}`,
      request.failure.detail === undefined ? '' : `detail:  ${clip(request.failure.detail, 4_000)}`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );

  if (request.failure.logExcerpt !== undefined && request.failure.logExcerpt.trim() !== '') {
    sections.push(`## Logs\n\`\`\`\n${clip(request.failure.logExcerpt, MAX_PROMPT_LOG_BYTES)}\n\`\`\``);
  }

  sections.push(
    [
      '## What the update changed',
      `from ${request.update.fromVersion ?? 'unknown'} to ${request.update.toVersion ?? 'unknown'}`,
      '```diff',
      clip(request.update.diff, MAX_PROMPT_DIFF_BYTES),
      '```',
    ].join('\n'),
  );

  if (ctx.previousDiff !== undefined && ctx.previousDiff.trim() !== '') {
    sections.push(
      [
        '## Your previous attempt changed this, and it was rejected',
        '```diff',
        clip(ctx.previousDiff, MAX_PROMPT_DIFF_BYTES),
        '```',
      ].join('\n'),
    );
  }

  if (ctx.previousGateDetail !== undefined && ctx.previousGateDetail.trim() !== '') {
    sections.push(
      `## Why the previous attempt was rejected\n\`\`\`\n${clip(ctx.previousGateDetail, MAX_PROMPT_LOG_BYTES)}\n\`\`\``,
    );
  }

  sections.push(
    [
      '## Files you must not touch',
      '',
      'A change to any of these is detected by diffing the working tree afterwards and',
      'the whole repair is discarded. This is checked mechanically; it is not a request.',
      '',
      protectedPathsForPrompt(),
      '',
      'If the only correct fix would touch one of these, do not write it. Explain why in',
      'your final message and change nothing. That answer is genuinely useful; a fix that',
      'edits the tests it has to pass, or the citation guard, is not.',
    ].join('\n'),
  );

  sections.push(
    [
      '## What to do',
      '',
      '1. Read enough of the tree to understand the failure above.',
      '2. Make the SMALLEST change that fixes it. Not a refactor, not a cleanup, not a',
      '   rename, not a dependency change. If you find three other things wrong, leave',
      '   them; someone is reviewing this diff and its size is how they judge it.',
      '3. Check your own work. You may run exactly these, and nothing else:',
      '     node node_modules/typescript/bin/tsc --noEmit',
      '     node node_modules/vitest/vitest.mjs run',
      '     node --experimental-strip-types evals/run.ts',
      '4. Finish with a short plain-English account of what was wrong and what you changed.',
      '',
      'Constraints that are checked after you finish:',
      '  - TypeScript is strict with noUncheckedIndexedAccess. No `any`, no `@ts-ignore`.',
      '  - Throw only EngineError, with a code that already exists in the taxonomy.',
      '  - ASCII only. Comments explain WHY, not what.',
      '  - No new dependencies: package.json and package-lock.json are protected.',
      '  - Everything must pass tsc, the full test suite, the offline evals and a build.',
      '    Anything less and your change is discarded and never reaches her Mac.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/* ──────────────────────────── the invocation ────────────────────────── */

export interface RepairRunOutcome {
  /** ok means the session finished without a named failure. Not that it fixed anything. */
  ok: boolean;
  classification: CliClassification;
  /** The session, for --resume after a usage limit. */
  sessionId: string | null;
  /** The model's closing message, capped. For the audit trail. */
  text: string;
  durationMs: number;
  timedOut: boolean;
}

async function readHelp(bin: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--help'], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (e) {
    // Some builds exit non-zero after printing help. Salvage whatever came out.
    if (typeof e === 'object' && e !== null) {
      const stdout = 'stdout' in e && typeof e.stdout === 'string' ? e.stdout : '';
      const stderr = 'stderr' in e && typeof e.stderr === 'string' ? e.stderr : '';
      return `${stdout}\n${stderr}`;
    }
    return '';
  }
}

export async function probeRepairFlags(bin: string): Promise<RepairFlagSupport> {
  return parseRepairFlagSupport(await readHelp(bin));
}

export interface InvokeOptions {
  /** The scratch copy. The CLI's working directory, and the edit boundary. */
  cwd: string;
  prompt: string;
  resumeSessionId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Extract the session id from whichever envelope shape this build emitted. */
export function sessionIdFrom(stdout: string): string | null {
  const envelope = unwrapCliEnvelope(stdout);
  const raw = envelope.raw;
  if (raw === null) return null;
  const id = raw['session_id'];
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Run one repair session to completion.
 *
 * The environment is deliberately narrow: no IBC_DATA_DIR (the session must not
 * be able to reach her database through a test it writes), and the terminal
 * variables the CLI uses to decide it is talking to a human are switched off.
 */
export async function invokeRepair(opts: InvokeOptions): Promise<RepairRunOutcome> {
  const started = Date.now();
  const bin = await resolveClaudeBinary();
  if (bin === null) {
    throw new EngineError('CLI_NOT_FOUND', {
      detail: 'No `claude` binary on PATH or in any known install location.',
    });
  }

  const flags = await probeRepairFlags(bin);
  if (!grantIsEnforceable(flags)) {
    throw new EngineError('CLI_PERMISSION_PROMPT', {
      detail:
        'This build of Claude Code accepts no tool-restriction flag, so the repair grant could not be enforced.',
    });
  }

  const argv = buildRepairArgv({
    flags,
    modelId: modelFor('deep').id,
    resumeSessionId: opts.resumeSessionId ?? null,
  });
  const timeoutMs = opts.timeoutMs ?? CLAUDE_TIMEOUT_MS;

  const outcome = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    aborted: boolean;
  }>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
        CI: '1',
        // The session must not be able to reach the real data directory, whatever
        // it decides to run.
        IBC_DATA_DIR: `${opts.cwd}/.repair-scratch-data`,
      },
    });

    let killTimer: NodeJS.Timeout | undefined;
    const hardKill = (): void => {
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
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      hardKill();
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      hardKill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (exitCode: number | null, signalName: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode, signal: signalName, timedOut, aborted });
    };

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
      stderr += `\nspawn failed: ${err.message}`;
      settle(null, null);
    });
    child.on('close', (code, signalName) => settle(code, signalName));
    child.stdin.on('error', () => {
      // EPIPE when the child died early.
    });
    // The prompt goes in on stdin and stdin is then CLOSED. An open stdin is what
    // lets the CLI believe it can ask a question, and there is nobody here to answer.
    child.stdin.end(opts.prompt, 'utf8');

    if (opts.signal?.aborted === true) onAbort();
  });

  const classification = classifyCliOutput({
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    aborted: outcome.aborted,
    // We passed an allow-list, so the classifier should read a silent timeout as a
    // slow session rather than as a blocked approval prompt.
    toolsDisabled: true,
  });

  return {
    ok: isRepairSessionOk(classification, outcome.exitCode),
    classification,
    sessionId: sessionIdFrom(outcome.stdout),
    text: clip(unwrapCliEnvelope(outcome.stdout).text, 8_000),
    durationMs: Date.now() - started,
    timedOut: outcome.timedOut,
  };
}

/**
 * Did the session end cleanly?
 *
 * classifyCliOutput is built for extraction, where the answer is JSON and its
 * absence is CLI_BAD_OUTPUT. A repair's answer is prose, so that one code means
 * "it talked instead of returning a document", which for us is the normal ending.
 * Every other code is a real failure and is passed straight through.
 *
 * Note what this does NOT claim: a clean ending is not a fix. The evidence of a
 * fix is the diff and the gates, which are computed regardless of what happened
 * here.
 */
export function isRepairSessionOk(
  classification: CliClassification,
  exitCode: number | null,
): boolean {
  if (classification.kind === 'ok') return true;
  return classification.code === 'CLI_BAD_OUTPUT' && exitCode === 0;
}
