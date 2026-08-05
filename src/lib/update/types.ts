/**
 * The shapes the UI and the repair tooling code against.
 *
 * Everything in here is serialisable and safe to send to the renderer: no paths
 * outside the app bundle, no tokens, no stack traces. If you add a field, ask
 * whether it could carry a credential before you add it.
 */

import type { EngineErrorCode, Remedy } from '@/lib/providers/errors';

/* ─────────────────────────────── Manifest ─────────────────────────────── */

/**
 * What Ayush publishes. One release, described completely.
 *
 * `url` may be an https URL, a file: URL (a USB stick, an offline install), an
 * http URL to a loopback address (a local test), or the literal form
 * `asset:<name>` which means "the release asset with this name, in the same
 * GitHub release this manifest came from". The last one exists because a private
 * repository's asset download needs the API URL and a token, and neither belongs
 * baked into a published file.
 */
export interface UpdateManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly url: string;
  /** Lowercase hex, 64 chars. Checked before a single byte is unpacked. */
  readonly sha256: string;
  readonly sizeBytes: number | null;
  readonly publishedAt: string | null;
  /**
   * Installations older than this cannot take this payload directly and are told
   * to reinstall. It is the escape hatch for a change that the update mechanism
   * itself cannot carry -- a new Node floor, a different bundle layout.
   */
  readonly minimumSupportedVersion: string | null;
  /** Plain English, shown to Bonnie. Never markdown, never a changelog dump. */
  readonly notes: string | null;
  readonly critical: boolean;
}

/* ──────────────────────────────── Source ──────────────────────────────── */

export type UpdateSourceKind = 'url' | 'github' | 'none';

export interface UpdateSource {
  readonly kind: UpdateSourceKind;
  readonly manifestUrl: string | null;
  readonly githubRepo: string | null;
  /**
   * Path to a file holding a bearer token for a private repository. The token is
   * read at request time and never stored, logged, or serialised.
   */
  readonly tokenFile: string | null;
  /** May the app apply an update on its own once it finds one? */
  readonly automatic: boolean;
  readonly checkIntervalHours: number;
  /** Safe for display. Host and repo only -- never a query string, never a token. */
  readonly label: string;
}

/* ───────────────────────────────  Phases ──────────────────────────────── */

/**
 * Where an apply has got to. The shell writes these strings verbatim, so the
 * union and `packaging/app-template/bin/update.sh` have to agree; the test file
 * pins that.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'starting'
  | 'downloading'
  | 'verifying'
  | 'unpacking'
  | 'swapping'
  | 'restarting'
  | 'health-check'
  | 'rolling-back'
  | 'done'
  | 'failed';

export const UPDATE_PHASES: readonly UpdatePhase[] = [
  'idle',
  'checking',
  'starting',
  'downloading',
  'verifying',
  'unpacking',
  'swapping',
  'restarting',
  'health-check',
  'rolling-back',
  'done',
  'failed',
];

/* ─────────────────────────────── Failures ─────────────────────────────── */

/**
 * Why an update did not happen. Deliberately finer-grained than the engine error
 * taxonomy: "the download was fine but the checksum was wrong" and "the download
 * never finished" are the same EngineError and completely different phone calls.
 * Each one maps to an engine code so the existing error UI keeps working.
 */
export type UpdateFailureCode =
  | 'NO_SOURCE'
  | 'MANIFEST_UNREACHABLE'
  | 'MANIFEST_INVALID'
  | 'NOT_SUPPORTED'
  | 'NOT_WRITABLE'
  | 'TOO_OLD'
  | 'QUEUE_BUSY'
  | 'LOCKED'
  | 'DISK_FULL'
  | 'DOWNLOAD_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'UNPACK_FAILED'
  | 'PAYLOAD_INCOMPLETE'
  | 'SWAP_FAILED'
  | 'RESTART_FAILED'
  | 'HEALTH_FAILED'
  | 'ROLLBACK_FAILED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export interface UpdateFailureInfo {
  /** Plain English. Shown as the headline. */
  readonly message: string;
  readonly engineCode: EngineErrorCode;
  readonly remedy: Remedy;
  /** True when the installation is still on the version it started on. */
  readonly safe: boolean;
}

/* ──────────────────────────────── Results ─────────────────────────────── */

export interface UpdateFailure {
  readonly code: UpdateFailureCode;
  readonly phase: UpdatePhase;
  readonly message: string;
  /** Technical, single line, redacted. For Ayush, never for Bonnie. */
  readonly detail: string | null;
  /** The version now running after the rollback, or null if none was attempted. */
  readonly rolledBackTo: string | null;
  readonly rollbackOk: boolean;
  /** Where the full narration is. Inside the data folder, so it survives. */
  readonly logPath: string;
}

export interface UpdateResult {
  readonly ok: boolean;
  /** The version that was being installed. */
  readonly version: string;
  readonly fromVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly failure: UpdateFailure | null;
}

/* ──────────────────────────────── Status ──────────────────────────────── */

export interface AvailableUpdate {
  readonly version: string;
  readonly publishedAt: string | null;
  readonly sizeBytes: number | null;
  readonly notes: string | null;
  readonly critical: boolean;
  /** False when this installation is too old to take it directly. */
  readonly applicable: boolean;
  readonly blockedReason: string | null;
}

export type DeferReason =
  | 'queue-busy'
  | 'apply-in-progress'
  | 'nothing-available'
  | 'not-applicable'
  | 'unsupported';

export interface UpdateBusy {
  readonly reason: DeferReason;
  readonly detail: string;
}

export interface UpdateProgress {
  readonly phase: UpdatePhase;
  readonly version: string;
  readonly fromVersion: string;
  readonly startedAt: string;
  readonly note: string;
  /** True while the applier process is still alive. */
  readonly alive: boolean;
}

/** The body of GET /api/update, and of `status` on every POST response. */
export interface UpdateStatus {
  readonly currentVersion: string;
  /** False in a development checkout, or an install we cannot write to. */
  readonly supported: boolean;
  readonly unsupportedReason: string | null;
  readonly source: {
    readonly kind: UpdateSourceKind;
    readonly label: string;
    readonly automatic: boolean;
    readonly checkIntervalHours: number;
  };
  readonly available: AvailableUpdate | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckError: {
    readonly code: UpdateFailureCode;
    readonly message: string;
    readonly detail: string | null;
  } | null;
  readonly phase: UpdatePhase;
  readonly progress: UpdateProgress | null;
  readonly lastResult: UpdateResult | null;
  /** Newest first. The second entry is what a rollback would return to. */
  readonly installedVersions: readonly string[];
  readonly canRollback: boolean;
  /** Non-null when an apply cannot start right now. */
  readonly busy: UpdateBusy | null;
}

export interface UpdateActionResponse {
  readonly accepted: boolean;
  readonly deferred: UpdateBusy | null;
  readonly status: UpdateStatus;
}
