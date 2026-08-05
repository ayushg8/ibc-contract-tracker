/**
 * Where the update mechanism keeps its own state.
 *
 * All of it lives under `<dataDir>/update/`, and nothing outside that folder is
 * ever written by this subsystem. WHY inside the data directory at all, when the
 * rule is that the data directory is hers: because update state has to OUTLIVE
 * the thing being updated. The app bundle is what gets replaced; anything
 * recorded inside it would be thrown away by the very operation it is recording.
 * The database, the archive, the thumbnails, the exports and the settings are
 * never read and never written from here.
 *
 * Three of these files are the seam with `packaging/app-template/bin/update.sh`.
 * The shell writes `progress` and `result`; this side writes `plan` and
 * `state.json`. The formats are pinned by tests/update.test.ts on both sides.
 */

import { join } from 'node:path';

import { dataDir, logDir } from '@/lib/paths';

/** `IBC_UPDATE_DIR` exists so a test can drive the shell script somewhere disposable. */
export function updateDir(): string {
  const override = process.env['IBC_UPDATE_DIR'];
  if (override !== undefined && override.trim() !== '') return override.trim();
  return join(dataDir(), 'update');
}

/** Check results and the recorded installed version. Written by this side only. */
export function statePath(): string {
  return join(updateDir(), 'state.json');
}

/** Where updates come from. Written by hand or by the installer, never by a route. */
export function sourcePath(): string {
  return join(updateDir(), 'source.json');
}

/** What the shell script is doing right now. Written by the shell only. */
export function progressPath(): string {
  return join(updateDir(), 'progress');
}

/** How the last apply ended. Written by the shell only. */
export function resultPath(): string {
  return join(updateDir(), 'result');
}

/** The instructions handed to the shell script. Written by this side only. */
export function planPath(): string {
  return join(updateDir(), 'plan');
}

/**
 * A curl config file holding an Authorization header for a private repository.
 * A config file rather than an argument because arguments are visible in `ps`.
 * Mode 0600, and deleted by the shell as soon as the download is done.
 */
export function curlConfigPath(): string {
  return join(updateDir(), 'curlrc');
}

/** mkdir-based mutex. The shell owns it; this side only reads it to answer "busy". */
export function lockDir(): string {
  return join(updateDir(), 'apply.lock');
}

export function lockPidPath(): string {
  return join(lockDir(), 'pid');
}

export function downloadDir(): string {
  return join(updateDir(), 'downloads');
}

/**
 * The full narration of the last apply. In the log folder rather than the update
 * folder so it is picked up by whatever collects logs, and so it survives a
 * `rm -rf` of the update folder during recovery.
 */
export function updateLogPath(): string {
  return join(logDir(), 'update.log');
}
