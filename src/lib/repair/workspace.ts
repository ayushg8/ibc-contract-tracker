/**
 * The scratch copy, and the handover that puts a proven fix live.
 *
 * Two rules shape this file.
 *
 * The first: an AI never edits the live install. It works in a clone under
 * Application Support, the clone is gated there, and only a gated clone is
 * promoted. On APFS `cp -c` clones by reference, so a copy of the whole app
 * costs almost nothing and is still a real, isolated copy -- writes in the
 * workspace cannot reach the bundle.
 *
 * The second, and the one that decides the shape of the promote: THIS PROCESS IS
 * THE THING BEING REPLACED. The Next server runs as a child of server.sh; a
 * restart kills it, which means any code here that tried to restart-and-then-
 * verify would be killed exactly at the moment it had to check its work -- and a
 * promotion nobody verified is how a broken update reaches her twice.
 *
 * So Node stages the promotion and hands it to a detached shell script that
 * outlives the server: it stops the agent, copies, restarts, health-checks the
 * port that is actually serving, and puts the backup back if the new version
 * does not answer. Its verdict is written to a file, which the app reconciles
 * into the audit trail the next time it is asked. The promotion is verified by
 * something that cannot be killed by the promotion.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { log } from '@/lib/logger';
import { dataDir } from '@/lib/paths';
import { EngineError } from '@/lib/providers/errors';

import { attemptDir, ensureRepairDirs, repairBinDir, workspacesDir } from './state';

/* ─────────────────────────── where things are ───────────────────────── */

/**
 * The live application source: Contents/Resources/app inside the bundle, or the
 * repo in development.
 *
 * The server is started by server.sh with that directory as its cwd, so cwd is
 * the honest answer -- but it is verified rather than assumed, because a wrong
 * answer here is a promote that copies files into somebody's home directory.
 */
export function resolveLiveAppDir(): string {
  const candidates = [process.env['IBC_APP_DIR'], process.cwd()].filter(
    (c): c is string => typeof c === 'string' && c.trim() !== '',
  );
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (looksLikeAppSource(dir)) return dir;
  }
  throw new EngineError('FOLDER_MISSING', {
    detail: `no IBC Contract Tracker source at ${candidates.join(' or ') || 'any known location'}`,
  });
}

export function looksLikeAppSource(dir: string): boolean {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const name =
      typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'name') : undefined;
    return name === 'ibc-contract-tracker' && existsSync(join(dir, 'src', 'lib', 'fields.ts'));
  } catch {
    return false;
  }
}

/** Contents/Resources, where bin/server.sh and bin/common.sh live. Null in dev. */
export function resolveResourcesDir(appDir: string): string | null {
  const parent = dirname(appDir);
  return existsSync(join(parent, 'bin', 'server.sh')) ? parent : null;
}

/* ──────────────────────────── the clone ─────────────────────────────── */

export interface CloneResult {
  path: string;
  /** True when APFS cloned by reference rather than copying bytes. */
  cloned: boolean;
  durationMs: number;
}

/**
 * Copy a tree into a fresh workspace.
 *
 * `cp -Rc` asks for a clonefile copy; if the source and destination are on
 * different filesystems it fails outright, so a plain recursive copy is the
 * fallback rather than the default. Verified afterwards by looking for files
 * that must be there -- cp's exit code says the command ran, not that the tree
 * arrived.
 */
export function cloneTree(source: string, destination: string): CloneResult {
  const started = Date.now();
  mkdirSync(destination, { recursive: true });

  let cloned = true;
  try {
    execFileSync('/bin/cp', ['-Rc', `${source}/.`, destination], { stdio: 'pipe' });
  } catch {
    cloned = false;
    try {
      execFileSync('/bin/cp', ['-R', `${source}/.`, destination], { stdio: 'pipe' });
    } catch (e) {
      throw new EngineError('DISK_FULL', {
        detail: `could not copy ${source} to ${destination}`,
        cause: e,
      });
    }
  }

  const sentinels = ['package.json', join('src', 'lib', 'fields.ts')];
  const missing = sentinels.filter((rel) => !existsSync(join(destination, rel)));
  if (missing.length > 0) {
    throw new EngineError('FOLDER_MISSING', {
      detail: `the workspace copy is incomplete: missing ${missing.join(', ')}`,
    });
  }

  return { path: destination, cloned, durationMs: Date.now() - started };
}

export function newWorkspacePath(attemptId: string): string {
  ensureRepairDirs();
  return join(workspacesDir(), attemptId);
}

/* ─────────────────────────── the promotion ──────────────────────────── */

export interface PromotionPlan {
  attemptId: string;
  signature: string;
  workspace: string;
  live: string;
  /** POSIX paths relative to the source root. */
  files: string[];
  backup: string;
  resultFile: string;
  serverSh: string | null;
  createdAt: string;
}

/**
 * Write the plan where a shell script can read it without a JSON parser.
 *
 * A key=value file and a list of paths, because the consumer is POSIX sh running
 * after this process is dead. `plan.json` is written too, for the record and for
 * the tests; nothing depends on parsing it in the shell.
 */
export function stagePromotion(plan: PromotionPlan): { envFile: string; listFile: string } {
  const dir = attemptDir(plan.attemptId);
  mkdirSync(dir, { recursive: true });

  const envFile = join(dir, 'promote.env');
  const listFile = join(dir, 'promote-files.txt');

  const lines = [
    `PLAN_ATTEMPT_ID='${shellQuote(plan.attemptId)}'`,
    `PLAN_SIGNATURE='${shellQuote(plan.signature)}'`,
    `PLAN_WORKSPACE='${shellQuote(plan.workspace)}'`,
    `PLAN_LIVE='${shellQuote(plan.live)}'`,
    `PLAN_BACKUP='${shellQuote(plan.backup)}'`,
    `PLAN_FILES='${shellQuote(listFile)}'`,
    `PLAN_RESULT='${shellQuote(plan.resultFile)}'`,
    `PLAN_SERVER_SH='${shellQuote(plan.serverSh ?? '')}'`,
  ];
  writeFileSync(envFile, `${lines.join('\n')}\n`, 'utf8');
  writeFileSync(listFile, `${plan.files.join('\n')}\n`, 'utf8');
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { envFile, listFile };
}

/** Single quotes in a single-quoted shell string. The one escape that matters. */
export function shellQuote(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/**
 * Hand the plan to the detached promoter and return.
 *
 * `detached` plus `unref` plus ignored stdio: the child gets its own process
 * group, so when launchd tears this server down the promoter keeps going. That
 * is the entire point of it.
 */
export function spawnPromoter(scriptPath: string, envFile: string): number | null {
  try {
    const child = spawn('/bin/sh', [scriptPath, 'apply', envFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child.pid ?? null;
  } catch (e) {
    log.error('repair.promote.spawn-failed', { error: e });
    return null;
  }
}

export type PromotionStatus = 'applied' | 'reverted' | 'failed' | 'pending';

export interface PromotionResult {
  status: PromotionStatus;
  attemptId: string;
  detail: string;
  at: string;
}

/**
 * Read the promoter's verdict.
 *
 * The file is `key=value` lines written by the shell script. Absent means it has
 * not finished (or never started) -- which is 'pending', never 'applied'.
 */
export function readPromotionResult(attemptId: string): PromotionResult {
  const file = join(attemptDir(attemptId), 'result.txt');
  const fallback: PromotionResult = {
    status: 'pending',
    attemptId,
    detail: 'the promoter has not reported yet',
    at: '',
  };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const status = values.get('status') ?? '';
  const known: PromotionStatus[] = ['applied', 'reverted', 'failed'];
  return {
    status: known.includes(status as PromotionStatus) ? (status as PromotionStatus) : 'failed',
    attemptId,
    detail: values.get('detail') ?? '',
    at: values.get('at') ?? '',
  };
}

/* ──────────────────────── the promoter script ───────────────────────── */

/**
 * Find repair.sh and copy it, with common.sh, somewhere stable.
 *
 * Stable matters twice over. The bundle is replaced by an update, so a scheduled
 * job pointing inside it is one install away from being a broken calendar entry;
 * and the promoter has to keep running while the bundle's files are being
 * overwritten underneath it. A copy under Application Support is neither.
 */
export function materialisePromoter(appDir: string, alsoLookIn: readonly string[] = []): string | null {
  const resources = resolveResourcesDir(appDir);
  // The order is the order of trustworthiness, and the third entry is the one
  // that bootstraps: install.command excludes packaging/ from the .app, so on a
  // machine installed before self-repair existed the only copy of this script is
  // the one inside the source tree the update brought with it.
  const roots = [
    resources === null ? '' : join(resources, 'bin'),
    join(appDir, 'packaging', 'app-template', 'bin'),
    ...alsoLookIn.map((dir) => join(dir, 'packaging', 'app-template', 'bin')),
  ].filter((dir) => dir !== '');

  const target = join(repairBinDir(), 'repair.sh');
  const from = roots.find((dir) => existsSync(join(dir, 'repair.sh')));
  if (from === undefined) {
    // Already materialised by an earlier run is still a valid answer.
    return existsSync(target) ? target : null;
  }

  try {
    ensureRepairDirs();
    copyFileSync(join(from, 'repair.sh'), target);
    chmodSync(target, 0o755);
    // common.sh comes from the same place, so the pair cannot be mismatched.
    const common = join(from, 'common.sh');
    if (existsSync(common)) copyFileSync(common, join(repairBinDir(), 'common.sh'));
    return target;
  } catch (e) {
    log.error('repair.promoter.copy-failed', { error: e });
    return existsSync(target) ? target : null;
  }
}

/* ────────────────────────── liveness probing ────────────────────────── */

/** Must match common.sh. A marker file Next serves straight off disk. */
export const PING_PATH = '/ibc-ping.txt';
export const PORTS: readonly number[] = [
  47821, 47822, 47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830,
];

export function portFile(): string {
  return join(dataDir(), 'runtime', 'port');
}

function recordedPort(): number | null {
  try {
    const value = Number.parseInt(readFileSync(portFile(), 'utf8').replace(/\D+/g, ''), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function pings(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${PING_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * The port that is actually serving, which is not necessarily the one last
 * written down. Recorded port first, then the range.
 */
export async function runningPort(timeoutMs = 3_000): Promise<number | null> {
  const recorded = recordedPort();
  if (recorded !== null && (await pings(recorded, timeoutMs))) return recorded;
  for (const port of PORTS) {
    if (port === recorded) continue;
    if (await pings(port, 1_000)) return port;
  }
  return null;
}

/** True when something answered the marker before the deadline. */
export async function waitForHealthy(deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if ((await runningPort()) !== null) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/* ───────────────────────────── cleanup ─────────────────────────────── */

export function removeWorkspace(path: string): void {
  try {
    // Refuse to remove anything that is not under our own workspaces directory.
    const root = resolve(workspacesDir());
    const target = resolve(path);
    if (target !== root && !target.startsWith(`${root}/`)) return;
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Disk we do not get back, not a failure.
  }
}

/** Attempt directories, newest first. For the API and for support. */
export function listAttempts(): string[] {
  try {
    return readdirSync(join(dataDir(), 'repair', 'attempts')).sort().reverse();
  } catch {
    return [];
  }
}
