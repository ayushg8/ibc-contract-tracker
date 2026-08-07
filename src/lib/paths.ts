/**
 * Where the app keeps its things. Server-only (node:fs, node:os).
 *
 * One place decides this so nothing anywhere else builds a path by hand. The
 * override exists because tests and the eval harness must never touch the real
 * data directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EngineError } from './providers/errors';

const APP_DIR_DARWIN = 'IBC Contract Tracker';
const APP_DIR_XDG = 'ibc-contract-tracker';

/**
 * Root of everything we write. `IBC_DATA_DIR` wins so a test run, an eval, or a
 * second profile can be pointed somewhere disposable.
 */
export function dataDir(): string {
  const override = process.env.IBC_DATA_DIR;
  if (override && override.trim()) return path.resolve(override.trim());

  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR_DARWIN);
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return path.join(path.resolve(xdg.trim()), APP_DIR_XDG);
  return path.join(home, '.local', 'share', APP_DIR_XDG);
}

export function dbPath(): string {
  return path.join(dataDir(), 'tracker.db');
}

/** Our own copy of every PDF. The originals can be reorganised without us caring. */
export function archiveDir(): string {
  return path.join(dataDir(), 'archive');
}

/** Rendered first-page thumbnails, keyed by document id. */
export function thumbDir(): string {
  return path.join(dataDir(), 'thumbnails');
}

/** Alias of thumbDir(). Both spellings are in use across the app. */
export const thumbnailDir = thumbDir;

export function logDir(): string {
  return path.join(dataDir(), 'logs');
}

/** Default export destination. Settings may point elsewhere. */
export function exportDir(): string {
  return path.join(dataDir(), 'exports');
}

/** Small files the running system writes about itself: the port, the CLI path. */
export function runtimeDir(): string {
  return path.join(dataDir(), 'runtime');
}

/**
 * The absolute path the installer put Claude Code at, when it still runs.
 *
 * An app opened from the Dock or started by a LaunchAgent does not inherit her
 * shell's PATH, so `~/.local/bin`, Homebrew and every version manager are invisible
 * to it. That is why "installed, but this app cannot run it" is the case that
 * actually happens. The installer knows exactly where it wrote the binary, so it
 * writes the path down here and the probe reads it instead of searching.
 *
 * Trusted only while it still runs. A path that has moved or been removed is
 * discarded rather than returned, and `resolveClaudeBinary` falls through to the
 * four discovery probes -- so a moved install degrades to the old behaviour instead
 * of to an engine that cannot start.
 */
export function recordedClaudePath(): string | null {
  try {
    const raw = fs.readFileSync(path.join(runtimeDir(), 'claude-path'), 'utf8').trim();
    if (raw.length === 0) return null;
    fs.accessSync(raw, fs.constants.X_OK);
    return raw;
  } catch {
    return null;
  }
}

/** Default watch folder suggestion for the first-run wizard. Not created. */
export function suggestedWatchDir(): string {
  return path.join(os.homedir(), 'IBC', 'NDAs');
}

/** Absolute path of one archived PDF. */
export function archivedPdfPath(documentId: string, filename: string): string {
  // The id prefixes the name so two "NDA.pdf" files cannot collide, and the
  // human-readable name survives for anyone browsing the folder in Finder.
  return path.join(archiveDir(), `${documentId}-${safeFilename(filename)}`);
}

export function thumbnailPath(documentId: string): string {
  return path.join(thumbDir(), `${documentId}.png`);
}

/** Strip anything that would break a path or confuse Finder. */
export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'document.pdf';
}

/**
 * Create every directory we write to. Idempotent; call it before the first
 * database open and before any archive write.
 */
export function ensureDirs(): void {
  for (const dir of [dataDir(), archiveDir(), thumbDir(), logDir(), exportDir()]) {
    ensureDir(dir);
  }
}

/** mkdir -p with the failures mapped to something the UI can act on. */
export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw fsError(e, dir);
  }
}

/**
 * Readable-and-a-directory check for a user-chosen folder. Returns the
 * EngineError instead of throwing so Diagnostics can render a row per folder
 * without a try/catch per row.
 */
export function checkFolder(dir: string): EngineError | null {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) {
      return new EngineError('FOLDER_MISSING', { detail: `not a directory: ${dir}` });
    }
    fs.accessSync(dir, fs.constants.R_OK);
    return null;
  } catch (e) {
    return fsError(e, dir);
  }
}

/** Same, plus write permission. Used for the archive and export destinations. */
export function checkFolderWritable(dir: string): EngineError | null {
  const readable = checkFolder(dir);
  if (readable) return readable;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return null;
  } catch (e) {
    return fsError(e, dir);
  }
}

/**
 * errno -> EngineError. ENOSPC and EDQUOT are the disk; EACCES/EPERM/EROFS are
 * permission, which on macOS usually means Full Disk Access or an iCloud folder.
 */
export function fsError(e: unknown, target?: string): EngineError {
  const code = errnoOf(e);
  const detail = `${code ?? 'unknown'}${target ? ` at ${target}` : ''}`;
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
    case 'EFBIG':
      return new EngineError('DISK_FULL', { detail, cause: e });
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new EngineError('FOLDER_UNREADABLE', { detail, cause: e });
    case 'ENOENT':
    case 'ENOTDIR':
      return new EngineError('FOLDER_MISSING', { detail, cause: e });
    default:
      return new EngineError('UNKNOWN', { detail, cause: e });
  }
}

function errnoOf(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const code: unknown = Reflect.get(e, 'code');
  return typeof code === 'string' ? code : null;
}
