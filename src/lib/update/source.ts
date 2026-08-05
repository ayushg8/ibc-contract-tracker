/**
 * Where updates come from.
 *
 * This is the most security-sensitive setting in the app: whatever it points at
 * gets to decide which code runs on the machine that holds every NDA IBC has
 * signed. So it is deliberately NOT settable over HTTP. The app listens on
 * localhost with no authentication, which means any web page Bonnie has open can
 * POST to it; a route that could repoint the updater would turn that into remote
 * code execution. It is configured by a file on disk or an environment variable,
 * both of which require someone to already be on the machine.
 *
 * Two shapes are supported on purpose. `manifestUrl` is a plain URL and needs no
 * GitHub at all -- a file on a web server, a file: URL on a USB stick. `githubRepo`
 * uses the Releases API and works with a private repository given a token.
 */

import { readFileSync } from 'node:fs';

import { log } from '@/lib/logger';

import { UpdateError } from './failures';
import { sourcePath } from './paths';
import type { UpdateSource } from './types';

/**
 * A fortnight, and it has to be this number.
 *
 * UpdateCheck.plist.in cannot express "every 14 days" -- StartCalendarInterval
 * has no field for it -- so the agent fires WEEKLY and delegates the real
 * interval to this floor: a check that arrives before the interval has elapsed
 * is a no-op. That delegation only works if the floor exists. Nothing writes
 * source.json today, so an installation that has never been configured by hand
 * falls back to this constant on every check, and a 24 here would have turned
 * the documented fortnight into the plist's weekly.
 *
 * Changing it changes what the plist and packaging/README.md promise. The test
 * asserts 336 against the documents, not against whatever is written here.
 */
const DEFAULT_CHECK_HOURS = 14 * 24;
const MIN_CHECK_HOURS = 1;
const MAX_CHECK_HOURS = 24 * 30;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const NO_SOURCE: UpdateSource = {
  kind: 'none',
  manifestUrl: null,
  githubRepo: null,
  tokenFile: null,
  automatic: false,
  checkIntervalHours: DEFAULT_CHECK_HOURS,
  label: 'Not configured',
};

/**
 * https anywhere, file: anywhere, http only to this machine.
 *
 * WHY http is allowed at all: Ayush may not want this repo on GitHub, and a box
 * on IBC's network serving the manifest over plain http is a real deployment. It
 * is confined to loopback because a payload fetched over http from anywhere else
 * can be swapped in flight -- and the SHA256 in the manifest is no defence when
 * the manifest itself came down the same wire.
 */
export function isAllowedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' || url.protocol === 'file:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return false;
}

/** Host and path only. Never a query string, which is where a token would hide. */
export function safeLabel(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') return `file ${url.pathname}`;
    return `${url.host}${url.pathname}`;
  } catch {
    return 'unreadable';
  }
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function readString(raw: object, key: string): string | null {
  const v: unknown = Reflect.get(raw, key);
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function readBool(raw: object, key: string, fallback: boolean): boolean {
  const v: unknown = Reflect.get(raw, key);
  return typeof v === 'boolean' ? v : fallback;
}

function readHours(raw: object, key: string): number {
  const v: unknown = Reflect.get(raw, key);
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_CHECK_HOURS;
  return Math.min(MAX_CHECK_HOURS, Math.max(MIN_CHECK_HOURS, Math.round(v)));
}

function envOverrides(): {
  manifestUrl: string | null;
  githubRepo: string | null;
  tokenFile: string | null;
  automatic: boolean | null;
  hours: number | null;
} {
  const hoursRaw = process.env['IBC_UPDATE_CHECK_HOURS'];
  const hours = hoursRaw === undefined ? null : Number(hoursRaw);
  const auto = process.env['IBC_UPDATE_AUTOMATIC'];
  return {
    manifestUrl: process.env['IBC_UPDATE_MANIFEST_URL']?.trim() || null,
    githubRepo: process.env['IBC_UPDATE_GITHUB_REPO']?.trim() || null,
    tokenFile: process.env['IBC_UPDATE_TOKEN_FILE']?.trim() || null,
    automatic: auto === undefined ? null : auto === '1' || auto.toLowerCase() === 'true',
    hours:
      hours === null || !Number.isFinite(hours)
        ? null
        : Math.min(MAX_CHECK_HOURS, Math.max(MIN_CHECK_HOURS, Math.round(hours))),
  };
}

function fromFile(): object | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sourcePath(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    // A missing file is the normal case for an install that has never been
    // pointed anywhere. Anything else is worth a line in the log.
    const code = e instanceof Error && 'code' in e ? e.code : '';
    if (code !== 'ENOENT') log.warn('update.source.unreadable', { error: e });
    return null;
  }
}

export function readSource(): UpdateSource {
  const file = fromFile();
  const env = envOverrides();

  const manifestUrl = env.manifestUrl ?? (file === null ? null : readString(file, 'manifestUrl'));
  const githubRepo = env.githubRepo ?? (file === null ? null : readString(file, 'githubRepo'));
  const tokenFile = env.tokenFile ?? (file === null ? null : readString(file, 'tokenFile'));
  const automatic = env.automatic ?? (file === null ? false : readBool(file, 'automatic', false));
  const checkIntervalHours =
    env.hours ?? (file === null ? DEFAULT_CHECK_HOURS : readHours(file, 'checkIntervalHours'));

  if (manifestUrl !== null) {
    if (!isAllowedUrl(manifestUrl)) {
      log.warn('update.source.rejected', { reason: 'scheme not allowed' });
      return NO_SOURCE;
    }
    return {
      kind: 'url',
      manifestUrl,
      githubRepo: null,
      tokenFile,
      automatic,
      checkIntervalHours,
      label: safeLabel(manifestUrl),
    };
  }

  if (githubRepo !== null) {
    if (!REPO_PATTERN.test(githubRepo)) {
      log.warn('update.source.rejected', { reason: 'repo is not owner/name' });
      return NO_SOURCE;
    }
    return {
      kind: 'github',
      manifestUrl: null,
      githubRepo,
      tokenFile,
      automatic,
      checkIntervalHours,
      label: `github.com/${githubRepo}`,
    };
  }

  return { ...NO_SOURCE, automatic, checkIntervalHours };
}

/**
 * The bearer token for a private repository, read fresh every time.
 *
 * Never cached, never logged, never returned to a route, and never put on a
 * command line. The only thing that is ever said about it out loud is whether
 * one exists.
 */
export function readToken(source: UpdateSource): string | null {
  const inline = process.env['IBC_UPDATE_TOKEN'];
  if (inline !== undefined && inline.trim() !== '') return inline.trim();
  if (source.tokenFile === null) return null;
  try {
    const token = readFileSync(source.tokenFile, 'utf8').trim();
    return token === '' ? null : token;
  } catch (e) {
    // The path is named; the contents never are.
    throw new UpdateError('NO_SOURCE', {
      detail: `token file could not be read at ${source.tokenFile}`,
      cause: e,
    });
  }
}
