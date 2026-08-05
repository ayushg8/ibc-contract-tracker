/**
 * Every way an update can fail, in her words, with the button that fixes it.
 *
 * Same discipline as src/lib/providers/errors.ts, which this defers to for the
 * outward-facing code: an update failure is still an EngineError by the time it
 * leaves a route, so the existing error UI renders it without knowing updates
 * exist. What lives here is the extra precision the taxonomy does not have --
 * "the download finished and the fingerprint was wrong" is a different call from
 * "the download never finished", and both are NETWORK_UNAVAILABLE.
 *
 * `safe` answers the only question that matters when the phone rings: is she
 * still on a working version? It is true for everything up to the swap, and for
 * a failure that rolled back cleanly.
 */

import { EngineError } from '@/lib/providers/errors';

import type { UpdateFailureCode, UpdateFailureInfo } from './types';

const CATALOG: Record<UpdateFailureCode, UpdateFailureInfo> = {
  NO_SOURCE: {
    message: 'This copy of the tracker has not been told where updates come from.',
    engineCode: 'UNKNOWN',
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
    safe: true,
  },
  MANIFEST_UNREACHABLE: {
    message: 'Could not reach the update server.',
    engineCode: 'NETWORK_UNAVAILABLE',
    remedy: { action: 'wait-and-retry', label: 'Check again' },
    safe: true,
  },
  MANIFEST_INVALID: {
    message: 'The update server answered with something the tracker could not read.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'contact-support',
      label: 'Copy support bundle',
      hint: 'Nothing was installed. The tracker is still on the version you were using.',
    },
    safe: true,
  },
  NOT_SUPPORTED: {
    message: 'This copy of the tracker cannot update itself.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'contact-support',
      label: 'Copy support bundle',
      hint: 'It was not installed by the installer, so there is nothing to replace.',
    },
    safe: true,
  },
  NOT_WRITABLE: {
    message: 'The tracker does not have permission to replace its own files.',
    engineCode: 'FOLDER_UNREADABLE',
    remedy: {
      action: 'contact-support',
      label: 'Copy support bundle',
      hint: 'Ask Ayush to run the installer again; it will fix the permissions.',
    },
    safe: true,
  },
  TOO_OLD: {
    message: 'This version is too old to update straight to the new one.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'contact-support',
      label: 'Copy support bundle',
      hint: 'Ask Ayush to run the installer once. Your contracts are not affected.',
    },
    safe: true,
  },
  QUEUE_BUSY: {
    message: 'The tracker is reading documents right now, so the update is waiting.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'none',
      label: 'OK',
      hint: 'It will install itself once the last document has finished.',
    },
    safe: true,
  },
  LOCKED: {
    message: 'An update is already running.',
    engineCode: 'UNKNOWN',
    remedy: { action: 'none', label: 'OK' },
    safe: true,
  },
  DISK_FULL: {
    message: 'There is not enough free space on this Mac to install the update.',
    engineCode: 'DISK_FULL',
    remedy: {
      action: 'wait-and-retry',
      label: 'Try again',
      hint: 'Empty the Trash or move some files off this Mac first.',
    },
    safe: true,
  },
  DOWNLOAD_FAILED: {
    message: 'The update did not finish downloading.',
    engineCode: 'NETWORK_UNAVAILABLE',
    remedy: { action: 'wait-and-retry', label: 'Try again' },
    safe: true,
  },
  CHECKSUM_MISMATCH: {
    /*
     * The single most important message in this file. A payload that does not
     * match its published fingerprint is never unpacked, so this is always safe
     * -- and saying so is what stops it becoming an emergency.
     */
    message: 'The downloaded update did not match its published fingerprint, so it was thrown away.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'retry',
      label: 'Try again',
      hint: 'Nothing was installed. Usually an interrupted download; tell Ayush if it happens twice.',
    },
    safe: true,
  },
  UNPACK_FAILED: {
    message: 'The update could not be unpacked.',
    engineCode: 'UNKNOWN',
    remedy: { action: 'retry', label: 'Try again' },
    safe: true,
  },
  PAYLOAD_INCOMPLETE: {
    message: 'The update was missing parts of the app, so it was not installed.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'contact-support',
      label: 'Copy support bundle',
      hint: 'Nothing changed. This is a fault in the published update, not on this Mac.',
    },
    safe: true,
  },
  SWAP_FAILED: {
    message: 'The update could not be switched on, so the previous version was kept.',
    engineCode: 'UNKNOWN',
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
    safe: true,
  },
  RESTART_FAILED: {
    message: 'The tracker could not be restarted after the update.',
    engineCode: 'UNKNOWN',
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
    safe: false,
  },
  HEALTH_FAILED: {
    message: 'The new version did not start, so the tracker went back to the previous one.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'contact-support',
      label: 'Copy support bundle',
      hint: 'You are back on the version you were using. Nothing has been lost.',
    },
    safe: true,
  },
  ROLLBACK_FAILED: {
    /*
     * The one genuinely bad outcome, and the only place in this file that asks
     * for help rather than describing a tidy stop. Named separately from
     * HEALTH_FAILED precisely so it can never be mistaken for one.
     */
    message: 'The update failed and the tracker could not go back on its own.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'contact-support',
      label: 'Copy support bundle',
      hint: 'Send this to Ayush now. Your contracts are safe -- they are not part of the app.',
    },
    safe: false,
  },
  INTERRUPTED: {
    message: 'The update stopped part way through.',
    engineCode: 'UNKNOWN',
    remedy: {
      action: 'retry',
      label: 'Try again',
      hint: 'Usually the Mac went to sleep or was restarted mid-update.',
    },
    safe: false,
  },
  UNKNOWN: {
    message: 'The update did not finish.',
    engineCode: 'UNKNOWN',
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
    safe: false,
  },
};

export function failureInfo(code: UpdateFailureCode): UpdateFailureInfo {
  return CATALOG[code] ?? CATALOG.UNKNOWN;
}

export function isUpdateFailureCode(value: string): value is UpdateFailureCode {
  return Object.prototype.hasOwnProperty.call(CATALOG, value);
}

/**
 * Turn an update failure into the error every other route already throws. The
 * message and remedy come from the catalog above; the code comes from the fixed
 * engine taxonomy, so nothing downstream needs to learn a second vocabulary.
 */
export class UpdateError extends EngineError {
  readonly updateCode: UpdateFailureCode;
  private readonly presentation: UpdateFailureInfo;

  constructor(code: UpdateFailureCode, opts: { detail?: string; cause?: unknown } = {}) {
    const info = failureInfo(code);
    // The update code is prefixed into detail rather than spread from opts: the
    // engine code alone is too coarse to diagnose from a support bundle.
    super(info.engineCode, {
      detail: `${code}${opts.detail === undefined ? '' : `: ${opts.detail}`}`,
      cause: opts.cause,
    });
    this.name = 'UpdateError';
    this.updateCode = code;
    this.presentation = info;
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      message: this.presentation.message,
      remedy: this.presentation.remedy,
    };
  }
}
