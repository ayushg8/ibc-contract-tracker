/**
 * The update mechanism. Everything the rest of the app is allowed to know about it.
 *
 * Ayush pushes a fix; Bonnie gets it without doing anything. The shape of that
 * promise, in order: fetch a manifest, compare versions, download, verify the
 * SHA256 BEFORE unpacking, unpack beside the current install, flip a symlink,
 * restart, health-check the thing that is actually running, and roll back if it
 * did not come up. The old version stays on disk; that is what makes the last
 * step possible.
 *
 * Two invariants hold everywhere in here:
 *
 *   1. The data directory is hers. The database, the PDF archive, the thumbnails,
 *      the exports and the settings are never read and never written by an
 *      update. Only `<dataDir>/update/` is touched, and only to record state that
 *      has to outlive the bundle being replaced.
 *
 *   2. An exit code is a claim, not evidence. Nothing here concludes an update
 *      worked because a command returned zero. The health check polls the app's
 *      own liveness marker until the NEW version number comes back over HTTP.
 */

export { detectLayout, type Layout, type LayoutKind } from './install';
export { failureInfo, isUpdateFailureCode, UpdateError } from './failures';
export { isAllowedUrl, readSource, safeLabel } from './source';
export { resolveManifest, type ResolvedManifest } from './manifest';
export { readState, writeState, patchState, EMPTY_STATE, type UpdateState } from './state';
export {
  applyLockHolder,
  interruptedResult,
  pidAlive,
  readProgress,
  readResult,
} from './runtime';
export { applyBlocker, queueIsIdle, type ApplyPlan } from './apply';
export { maybeAutoRun, runCheck, startApply, startRollback, updateStatus } from './service';
export * from './types';
export {
  compare,
  compareStrings,
  formatVersion,
  isAtLeast,
  isNewer,
  isVersion,
  parseVersion,
  sortVersionsDescending,
  type SemVer,
} from './version';
