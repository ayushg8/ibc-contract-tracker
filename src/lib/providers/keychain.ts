/**
 * API key storage.
 *
 * The key never touches the database and never appears in a log, an error message,
 * or the support bundle. On macOS it lives in the login keychain; everywhere else
 * (or when the `security` binary is missing) it falls back to a 0600 file in the
 * data directory, and `source` says so honestly so the UI can warn rather than
 * pretend.
 *
 * Server-only: imports node:child_process and node:fs.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { EngineError, toEngineError } from './errors';

const execFileAsync = promisify(execFile);

const SERVICE = 'IBC Contract Tracker';
const ACCOUNT = 'anthropic-api-key';
const FALLBACK_FILE = 'anthropic-api-key';

/** Where a key was found. Surfaced in Diagnostics so nobody has to guess. */
export type ApiKeySource = 'keychain' | 'file' | 'env' | 'none';

export interface KeyLookup {
  key: string | null;
  source: ApiKeySource;
}

export interface KeychainStatus {
  /** True when the macOS `security` CLI is present and usable. */
  keychainAvailable: boolean;
  /** Where a key would be written right now. */
  writeTarget: 'keychain' | 'file';
  /** Human-readable one-liner for Diagnostics. Never contains a key. */
  detail: string;
}

/* ─────────────────────────── data directory ─────────────────────── */

/**
 * ASSUMPTION: no shared path helper existed when this was written. `IBC_DATA_DIR`
 * overrides, so whoever owns app paths can point this at the real directory
 * without touching the rest of the module.
 */
export function dataDir(): string {
  const override = process.env['IBC_DATA_DIR'];
  if (override && override.trim() !== '') return override;
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'IBC Contract Tracker');
  }
  return join(homedir(), '.ibc-contract-tracker');
}

function fallbackPath(): string {
  return join(dataDir(), FALLBACK_FILE);
}

/* ──────────────────────────── key hygiene ───────────────────────── */

/**
 * Trim what a paste brought with it. Rejecting a key on shape would lock the user
 * out of a valid-but-unfamiliar key format, so we only reject the impossible.
 */
export function normaliseKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/** A soft hint for the UI, never a gate. */
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
}

/** Safe to show: last four characters only, so the UI can confirm which key. */
export function keyFingerprint(key: string): string {
  return key.length <= 4 ? '****' : `...${key.slice(-4)}`;
}

/* ───────────────────────────── keychain ─────────────────────────── */

let securityChecked = false;
let securityPresent = false;

async function hasSecurityCli(): Promise<boolean> {
  if (securityChecked) return securityPresent;
  securityChecked = true;
  securityPresent = false;
  if (platform() !== 'darwin') return false;
  try {
    await execFileAsync('/usr/bin/security', ['help'], { timeout: 5_000 });
    securityPresent = true;
  } catch {
    // `security help` exits non-zero on some releases while still working; a
    // missing binary throws ENOENT, which is the case we actually care about.
    securityPresent = await probeSecurityFind();
  }
  return securityPresent;
}

async function probeSecurityFind(): Promise<boolean> {
  try {
    await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', '__ibc_probe_that_does_not_exist__'],
      { timeout: 5_000 },
    );
    return true;
  } catch (e) {
    // Exit 44 (item not found) proves the binary ran. ENOENT proves it is absent.
    return !isEnoent(e);
  }
}

function isEnoent(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e)) return false;
  const code: unknown = e.code;
  return code === 'ENOENT';
}

async function readFromKeychain(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    return normaliseKey(stdout);
  } catch {
    // Not found, locked keychain, or denied. All three mean "no key here"; the
    // reason must never be echoed because stdout could contain the secret.
    return null;
  }
}

async function writeToKeychain(key: string): Promise<void> {
  // The key goes through argv because `security add-generic-password` has no stdin
  // form. execFile (no shell) keeps it out of shell history; it is briefly visible
  // to other processes of the same user, which on a single-user Mac is the same
  // trust boundary as the keychain itself.
  await execFileAsync(
    '/usr/bin/security',
    ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', key],
    { timeout: 10_000 },
  );
}

async function deleteFromKeychain(): Promise<void> {
  try {
    await execFileAsync(
      '/usr/bin/security',
      ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT],
      { timeout: 10_000 },
    );
  } catch {
    // Already absent is success.
  }
}

/* ─────────────────────────── file fallback ──────────────────────── */

function readFromFile(): string | null {
  const path = fallbackPath();
  try {
    if (!existsSync(path)) return null;
    return normaliseKey(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeToFile(key: string): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const path = fallbackPath();
  writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file.
  chmodSync(path, 0o600);
}

function deleteFile(): void {
  try {
    rmSync(fallbackPath(), { force: true });
  } catch {
    // Nothing to remove is success.
  }
}

/** True when the fallback file exists but is readable by more than the owner. */
export function fallbackFileIsLoose(): boolean {
  const path = fallbackPath();
  try {
    if (!existsSync(path)) return false;
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/* ──────────────────────────── public API ────────────────────────── */

/**
 * Precedence: keychain -> file fallback -> ANTHROPIC_API_KEY -> null.
 *
 * The env var comes last so a stale shell export can never silently override the
 * key Bonnie typed into Settings.
 */
export async function getKey(): Promise<KeyLookup> {
  if (await hasSecurityCli()) {
    const fromKeychain = await readFromKeychain();
    if (fromKeychain) return { key: fromKeychain, source: 'keychain' };
  }

  const fromFile = readFromFile();
  if (fromFile) return { key: fromFile, source: 'file' };

  const fromEnv = process.env['ANTHROPIC_API_KEY'];
  const normalised = typeof fromEnv === 'string' ? normaliseKey(fromEnv) : null;
  if (normalised) return { key: normalised, source: 'env' };

  return { key: null, source: 'none' };
}

/** Store the key. Throws KEYCHAIN_UNAVAILABLE if it cannot be persisted at all. */
export async function setKey(raw: string): Promise<ApiKeySource> {
  const key = normaliseKey(raw);
  if (key === null) {
    throw new EngineError('KEYCHAIN_UNAVAILABLE', {
      detail: 'Key was empty or contained whitespace.',
    });
  }

  if (await hasSecurityCli()) {
    try {
      await writeToKeychain(key);
      // A key left in the fallback file would outrank nothing but would linger on
      // disk after the user has moved to the keychain.
      deleteFile();
      return 'keychain';
    } catch (e) {
      const wrapped = toEngineError(e, 'KEYCHAIN_UNAVAILABLE');
      try {
        writeToFile(key);
        return 'file';
      } catch {
        throw wrapped;
      }
    }
  }

  try {
    writeToFile(key);
    return 'file';
  } catch (e) {
    throw toEngineError(e, 'KEYCHAIN_UNAVAILABLE');
  }
}

/** Remove the key from every store we own. The env var is not ours to unset. */
export async function deleteKey(): Promise<void> {
  if (await hasSecurityCli()) await deleteFromKeychain();
  deleteFile();
}

/** For Diagnostics. Does not read or return the key. */
export async function keychainStatus(): Promise<KeychainStatus> {
  const available = await hasSecurityCli();
  if (available) {
    return {
      keychainAvailable: true,
      writeTarget: 'keychain',
      detail: 'Stored in the macOS login keychain.',
    };
  }
  return {
    keychainAvailable: false,
    writeTarget: 'file',
    detail:
      platform() === 'darwin'
        ? 'macOS keychain unavailable; using a permissions-restricted file instead.'
        : 'Not macOS; using a permissions-restricted file instead.',
  };
}

/** Reset the cached `security` probe. Used by Diagnostics -> Recheck. */
export function resetKeychainProbe(): void {
  securityChecked = false;
  securityPresent = false;
}
