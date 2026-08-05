/**
 * What this installation actually looks like on disk.
 *
 * Nothing here guesses. The bundle is found by walking up from the Node binary
 * that is running this process -- the installer puts that binary inside the
 * bundle on purpose, so `process.execPath` is the one fact about our own
 * location that cannot be wrong. A checkout run with a system Node finds no
 * bundle and reports `development`, which is what makes "this copy cannot update
 * itself" a mechanical answer rather than a guess.
 *
 * Layout, after the first update has run:
 *
 *   Contents/Resources/app          -> symlink to app-<version>
 *   Contents/Resources/app-1.0.0    the version that was installed before
 *   Contents/Resources/app-1.1.0    the version running now
 *   Contents/Resources/bin/         common.sh, server.sh, update.sh
 *   Contents/Resources/node/        the pinned runtime
 *
 * Before the first update, `app` is a real directory -- that is what
 * install.command produces. update.sh migrates it in place the first time, which
 * is why `appLinkIsSymlink` is reported rather than assumed.
 */

import { accessSync, constants, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { readResult } from './runtime';
import { isNewer, isVersion, sortVersionsDescending } from './version';

export type LayoutKind = 'bundle' | 'development';

export interface Layout {
  readonly kind: LayoutKind;
  /** `/Applications/IBC Contracts.app`, or null in a checkout. */
  readonly bundlePath: string | null;
  readonly resourcesDir: string | null;
  readonly appLink: string | null;
  readonly appLinkIsSymlink: boolean;
  /** Resolved directory the app link currently points at. */
  readonly appTarget: string | null;
  readonly currentVersion: string;
  /** Newest first, from the app-<version> directories that exist. */
  readonly installedVersions: readonly string[];
  /**
   * The version a rollback would return to: the newest installed version OLDER
   * than the one running, never merely "the next one in the list". Null when
   * there is nothing older to go back to.
   */
  readonly previousVersion: string | null;
  readonly writable: boolean;
  readonly updateScript: string | null;
  /** Why this installation cannot update itself, or null when it can. */
  readonly unsupportedReason: string | null;
}

const APP_LINK_NAME = 'app';
const VERSION_DIR_PREFIX = 'app-';
const UNKNOWN_VERSION = '0.0.0';

/** How far up from the Node binary we are willing to look for a bundle. */
const MAX_WALK = 8;

function looksLikeBundleContents(dir: string): boolean {
  try {
    // common.sh is the file every part of the packaging agrees on, and it is
    // outside app/, so it survives every update. A directory that has it is our
    // bundle; a directory that merely has an `app` folder is not.
    return statSync(join(dir, 'Resources', 'bin', 'common.sh')).isFile();
  } catch {
    return false;
  }
}

/**
 * Find `<something>.app/Contents` above the running binary.
 *
 * `IBC_APP_BUNDLE` overrides it, pointing at the `.app` directory. That exists so
 * the shell script can be exercised against a disposable fake bundle in a test,
 * and so a second install can be driven by hand during a repair.
 */
function findBundle(): string | null {
  const override = process.env['IBC_APP_BUNDLE'];
  if (override !== undefined && override.trim() !== '') {
    const contents = join(resolve(override.trim()), 'Contents');
    return looksLikeBundleContents(contents) ? contents : null;
  }

  let dir = dirname(process.execPath);
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (basename(dir) === 'Contents' && looksLikeBundleContents(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readInfoPlistVersion(contentsDir: string): string | null {
  try {
    const text = readFileSync(join(contentsDir, 'Info.plist'), 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    const value = m?.[1]?.trim();
    return value !== undefined && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The version marker the installer writes into public/. It is also what the
 * health check reads back over HTTP after a restart, which is what makes
 * "the new code is serving" an observation instead of an assumption.
 */
function readPingVersion(appDir: string): string | null {
  try {
    const text = readFileSync(join(appDir, 'public', 'ibc-ping.txt'), 'utf8');
    const token = text.split('\n')[0]?.trim().split(/\s+/)[1];
    return token !== undefined && token !== '' ? token : null;
  } catch {
    return null;
  }
}

function versionFromLinkTarget(target: string): string | null {
  const name = basename(target);
  if (!name.startsWith(VERSION_DIR_PREFIX)) return null;
  const v = name.slice(VERSION_DIR_PREFIX.length);
  return isVersion(v) ? v : null;
}

function listInstalledVersions(resourcesDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(resourcesDir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(VERSION_DIR_PREFIX)) continue;
    const v = entry.slice(VERSION_DIR_PREFIX.length);
    if (!isVersion(v)) continue;
    try {
      if (statSync(join(resourcesDir, entry)).isDirectory()) found.push(v);
    } catch {
      // A half-removed directory is not an installed version.
    }
  }
  return sortVersionsDescending(found);
}

/**
 * The version a rollback should go back to: the NEWEST installed version that is
 * OLDER than the one running.
 *
 * The obvious answer -- "the first entry that is not us, in a newest-first list"
 * -- assumes the running version is the newest thing on disk. That is true right
 * up until the moment it matters. A failed update leaves `app-<broken>` behind,
 * the symlink is pointed back at the older version, and the newest directory is
 * now the build that just failed: the naive answer makes the recovery from a bad
 * update be reinstalling the bad update.
 *
 * `known` names versions we have positive evidence about. A version the applier
 * recorded as failing is excluded outright even if it is older than us, because
 * a directory we have watched fail to start is never the right place to go.
 */
function chooseRollbackTarget(
  installedVersions: readonly string[],
  currentVersion: string,
  known: { failed: string | null },
): string | null {
  for (const v of installedVersions) {
    if (v === currentVersion) continue;
    if (v === known.failed) continue;
    // Strictly older. An unparseable version compares as neither newer nor
    // older, so it is skipped rather than offered -- the same direction the rest
    // of the version code errs in.
    if (!isNewer(currentVersion, v)) continue;
    return v;
  }
  return null;
}

/**
 * The version the last apply recorded as failing, when it is still on disk.
 *
 * The result file is written by the applier and lives in the data directory, so
 * it survives the bundle being replaced -- which is the whole reason it is a
 * usable memory of "this one does not start".
 */
function lastFailedVersion(): string | null {
  try {
    const result = readResult();
    if (result === null || result.ok) return null;
    return isVersion(result.version) ? result.version : null;
  } catch {
    // A memory we cannot read is no memory. The isNewer filter still holds.
    return null;
  }
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function developmentLayout(reason: string): Layout {
  return {
    kind: 'development',
    bundlePath: null,
    resourcesDir: null,
    appLink: null,
    appLinkIsSymlink: false,
    appTarget: null,
    currentVersion: developmentVersion(),
    installedVersions: [],
    previousVersion: null,
    writable: false,
    updateScript: null,
    unsupportedReason: reason,
  };
}

/**
 * In a checkout there is no installed version, but the number still has to be
 * something a comparison can be run against. package.json is the honest answer.
 */
function developmentVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      const v: unknown = Reflect.get(raw, 'version');
      if (typeof v === 'string' && isVersion(v)) return v;
    }
  } catch {
    // Fall through.
  }
  return UNKNOWN_VERSION;
}

export function detectLayout(): Layout {
  const contents = findBundle();
  if (contents === null) {
    return developmentLayout(
      'The tracker is running from a source checkout, not from an installed app.',
    );
  }

  const resourcesDir = join(contents, 'Resources');
  const appLink = join(resourcesDir, APP_LINK_NAME);

  let appLinkIsSymlink = false;
  let appTarget: string | null = null;
  let linkVersion: string | null = null;
  try {
    const st = lstatSync(appLink);
    if (st.isSymbolicLink()) {
      appLinkIsSymlink = true;
      const raw = readlinkSync(appLink);
      appTarget = isAbsolute(raw) ? raw : join(resourcesDir, raw);
      linkVersion = versionFromLinkTarget(raw);
    } else if (st.isDirectory()) {
      appTarget = appLink;
    }
  } catch {
    appTarget = null;
  }

  const installedVersions = listInstalledVersions(resourcesDir);

  // Order matters and is not arbitrary. The symlink is the only source that is
  // updated by the same operation that changes what runs, so it cannot drift.
  // Info.plist is stamped by the installer and is right until the first update.
  // The ping marker is last because a payload could ship a stale one.
  const currentVersion =
    linkVersion ??
    readInfoPlistVersion(contents) ??
    (appTarget === null ? null : readPingVersion(appTarget)) ??
    UNKNOWN_VERSION;

  const previousVersion = chooseRollbackTarget(installedVersions, currentVersion, {
    failed: lastFailedVersion(),
  });

  const updateScript = join(resourcesDir, 'bin', 'update.sh');
  let hasScript = false;
  try {
    hasScript = statSync(updateScript).isFile();
  } catch {
    hasScript = false;
  }

  const writable = isWritable(resourcesDir);

  let unsupportedReason: string | null = null;
  if (!hasScript) {
    unsupportedReason =
      'This copy of the app was installed before updates existed. Ask Ayush to run the installer once.';
  } else if (!writable) {
    unsupportedReason = 'The app is in a folder the tracker is not allowed to change.';
  } else if (appTarget === null) {
    unsupportedReason = 'The app folder inside the bundle is missing.';
  }

  return {
    kind: 'bundle',
    bundlePath: dirname(contents),
    resourcesDir,
    appLink,
    appLinkIsSymlink,
    appTarget,
    currentVersion,
    installedVersions,
    previousVersion,
    writable,
    updateScript: hasScript ? updateScript : null,
    unsupportedReason,
  };
}

export const UNKNOWN_INSTALLED_VERSION = UNKNOWN_VERSION;
