/**
 * Every way this app can fail, enumerated.
 *
 * Rule: no error reaches the user as a stack trace or a raw string. Every failure
 * is normalised into an EngineError carrying (a) plain English, (b) a concrete
 * remedy the UI renders as a button, and (c) whether retrying could possibly help.
 *
 * If you add a throw site, add its code here first.
 */

export type EngineErrorCode =
  // ── Claude CLI engine ──────────────────────────────────────────────
  | 'CLI_NOT_FOUND' //   `claude` binary is not installed / not on PATH
  | 'CLI_NOT_AUTHENTICATED' // installed but no active login
  | 'CLI_VERSION_UNSUPPORTED' // too old to support the flags we depend on
  | 'CLI_TIMEOUT' //     spawned but produced nothing before the deadline
  | 'CLI_CRASHED' //     non-zero exit with no parseable payload
  | 'CLI_BAD_OUTPUT' //  exited 0 but we could not find JSON in the output
  | 'CLI_PERMISSION_PROMPT' // blocked waiting on an interactive tool approval
  | 'CLI_USAGE_LIMIT' // subscription session/weekly cap reached
  | 'CLI_PLAN_UNSUPPORTED' // signed in, but this Claude plan lacks the access we need
  | 'CLI_CONCURRENCY' // too many simultaneous CLI invocations

  // ── Anthropic API engine ───────────────────────────────────────────
  | 'API_KEY_MISSING'
  | 'API_KEY_INVALID' //  401
  | 'API_FORBIDDEN' //    403 — key lacks access to the requested model
  | 'API_RATE_LIMITED' // 429
  | 'API_CREDIT_EXHAUSTED' // billing failure
  | 'API_OVERLOADED' //   529
  | 'API_SERVER_ERROR' // 5xx
  | 'API_TIMEOUT'
  | 'MODEL_UNAVAILABLE' // 404 on the model id
  | 'MODEL_REFUSED' //    stop_reason: refusal
  | 'OUTPUT_TRUNCATED' // stop_reason: max_tokens

  // ── Transport ──────────────────────────────────────────────────────
  | 'NETWORK_UNAVAILABLE'
  | 'PROXY_BLOCKED' //    TLS interception / corporate egress proxy

  // ── Document handling ──────────────────────────────────────────────
  | 'PDF_UNREADABLE' //   corrupt or not actually a PDF
  | 'PDF_ENCRYPTED' //    password protected
  | 'PDF_NO_TEXT_LAYER' // scanned; needs the vision path
  | 'PDF_TOO_LARGE' //    exceeds the page budget
  | 'PDF_EMPTY' //        zero extractable content
  | 'VISION_UNSUPPORTED' // this engine cannot read page images

  // ── Extraction integrity ───────────────────────────────────────────
  | 'SCHEMA_INVALID' //   model output did not satisfy the schema after repair
  | 'ALL_CITATIONS_FAILED' // every quote failed verification — treat as a bad run
  | 'CONFLICT' // the request was understood and refused: wrong state, not a fault

  // ── Local environment ──────────────────────────────────────────────
  | 'DB_LOCKED'
  | 'DB_CORRUPT'
  | 'DISK_FULL'
  | 'FOLDER_MISSING'
  | 'FOLDER_UNREADABLE'
  | 'KEYCHAIN_UNAVAILABLE'
  | 'UNKNOWN';

/** What the UI should offer the user. Rendered as a button next to the message. */
export type RemedyAction =
  | 'none'
  | 'retry'
  | 'switch-to-api'
  | 'switch-to-cli'
  | 'open-engine-settings'
  | 'open-folder-settings'
  | 'install-cli'
  | 'login-cli'
  | 'update-cli'
  | 'enter-api-key'
  | 'wait-and-retry'
  | 'choose-folder'
  | 'reveal-file'
  | 'enter-manually'
  | 'contact-support';

export interface Remedy {
  action: RemedyAction;
  label: string;
  /** Extra one-line instruction shown under the button when the fix isn't a click. */
  hint?: string;
}

export interface EngineErrorInfo {
  /** Shown as the headline. Plain English, no jargon, no blame. */
  message: string;
  /** Can retrying the exact same request ever succeed? */
  retryable: boolean;
  /** Wait this long before an automatic retry, if retryable. */
  retryAfterMs?: number;
  remedy: Remedy;
  /** True if the queue should stop rather than burn through every document. */
  halt: boolean;
}

const CATALOG: Record<EngineErrorCode, EngineErrorInfo> = {
  /* ── CLI ─────────────────────────────────────────────────────────── */
  CLI_NOT_FOUND: {
    message: "Claude Code isn't installed on this Mac.",
    retryable: false,
    halt: true,
    remedy: {
      action: 'install-cli',
      label: 'How to install',
      hint: 'Or switch to an API key in Settings → Engine.',
    },
  },
  CLI_NOT_AUTHENTICATED: {
    message: 'Claude Code is installed but not signed in.',
    retryable: false,
    halt: true,
    remedy: {
      action: 'login-cli',
      label: 'How to sign in',
      hint: 'Run `claude` once in Terminal and complete the login, then click Recheck.',
    },
  },
  CLI_VERSION_UNSUPPORTED: {
    message: 'This version of Claude Code is too old for the tracker.',
    retryable: false,
    halt: true,
    remedy: { action: 'update-cli', label: 'How to update' },
  },
  CLI_TIMEOUT: {
    message: 'Claude Code took too long and was stopped.',
    retryable: true,
    retryAfterMs: 2_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },
  CLI_CRASHED: {
    message: 'Claude Code exited unexpectedly.',
    retryable: true,
    retryAfterMs: 2_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },
  CLI_BAD_OUTPUT: {
    message: "Claude Code replied, but not in a format the tracker could read.",
    retryable: true,
    retryAfterMs: 1_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },
  CLI_PERMISSION_PROMPT: {
    message: 'Claude Code stopped to ask for permission, which it cannot do here.',
    retryable: false,
    halt: true,
    remedy: {
      action: 'open-engine-settings',
      label: 'Open Engine settings',
      hint: 'The tracker never needs Claude to use tools. Report this if it persists.',
    },
  },
  CLI_USAGE_LIMIT: {
    message: "You've hit your Claude subscription limit.",
    retryable: true,
    retryAfterMs: 15 * 60_000,
    halt: true,
    remedy: {
      action: 'switch-to-api',
      label: 'Use an API key instead',
      hint: 'Or wait for the limit to reset — the queue will resume where it stopped.',
    },
  },
  /*
   * Distinct from CLI_USAGE_LIMIT on purpose. A limit resets; a plan does not.
   * Telling someone to "wait for the limit to reset" when the real answer is
   * "this plan will never work" is the support call this code exists to prevent.
   */
  CLI_PLAN_UNSUPPORTED: {
    message: "This Claude plan doesn't include what the tracker needs.",
    retryable: false,
    halt: true,
    remedy: {
      action: 'switch-to-api',
      label: 'Use an API key instead',
      hint: 'Reading documents through Claude Code needs a Pro or Max plan. An API key works on any plan.',
    },
  },
  CLI_CONCURRENCY: {
    message: 'Too many documents were sent to Claude Code at once.',
    retryable: true,
    retryAfterMs: 5_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },

  /* ── API ─────────────────────────────────────────────────────────── */
  API_KEY_MISSING: {
    message: 'No API key has been entered yet.',
    retryable: false,
    halt: true,
    remedy: { action: 'enter-api-key', label: 'Enter API key' },
  },
  API_KEY_INVALID: {
    message: 'That API key was rejected.',
    retryable: false,
    halt: true,
    remedy: {
      action: 'enter-api-key',
      label: 'Update API key',
      hint: 'Check for a copied space or a revoked key.',
    },
  },
  API_FORBIDDEN: {
    message: "This API key doesn't have access to the selected model.",
    retryable: false,
    halt: true,
    remedy: { action: 'open-engine-settings', label: 'Choose another model' },
  },
  API_RATE_LIMITED: {
    message: 'The API is rate limiting us. Slowing down.',
    retryable: true,
    retryAfterMs: 20_000,
    halt: false,
    remedy: { action: 'wait-and-retry', label: 'Resume' },
  },
  API_CREDIT_EXHAUSTED: {
    message: 'The Anthropic account is out of credit.',
    retryable: false,
    halt: true,
    remedy: {
      action: 'switch-to-cli',
      label: 'Use the Claude subscription',
      hint: 'Or top up the API account at console.anthropic.com.',
    },
  },
  API_OVERLOADED: {
    message: 'Anthropic is overloaded right now.',
    retryable: true,
    retryAfterMs: 30_000,
    halt: false,
    remedy: { action: 'wait-and-retry', label: 'Resume' },
  },
  API_SERVER_ERROR: {
    message: 'Anthropic returned a server error.',
    retryable: true,
    retryAfterMs: 10_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },
  API_TIMEOUT: {
    message: 'The request to Anthropic timed out.',
    retryable: true,
    retryAfterMs: 5_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },
  MODEL_UNAVAILABLE: {
    message: 'The selected model no longer exists.',
    retryable: false,
    halt: true,
    remedy: { action: 'open-engine-settings', label: 'Choose another model' },
  },
  MODEL_REFUSED: {
    message: 'Claude declined to read this document.',
    retryable: false,
    halt: false,
    remedy: {
      action: 'enter-manually',
      label: 'Fill in manually',
      hint: 'Unusual for an NDA. The raw response is saved on the record.',
    },
  },
  OUTPUT_TRUNCATED: {
    message: "Claude's answer was cut off before it finished.",
    retryable: true,
    retryAfterMs: 1_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },

  /* ── Transport ───────────────────────────────────────────────────── */
  NETWORK_UNAVAILABLE: {
    message: 'No internet connection.',
    retryable: true,
    retryAfterMs: 15_000,
    halt: true,
    remedy: { action: 'wait-and-retry', label: 'Resume' },
  },
  PROXY_BLOCKED: {
    message: 'A network proxy blocked the connection to Anthropic.',
    retryable: false,
    halt: true,
    remedy: {
      action: 'switch-to-cli',
      label: 'Use the Claude subscription',
      hint: "IBC's network may be inspecting or blocking api.anthropic.com.",
    },
  },

  /* ── Documents ───────────────────────────────────────────────────── */
  PDF_UNREADABLE: {
    message: "This file isn't a readable PDF.",
    retryable: false,
    halt: false,
    remedy: { action: 'reveal-file', label: 'Show file' },
  },
  PDF_ENCRYPTED: {
    message: 'This PDF is password protected.',
    retryable: false,
    halt: false,
    remedy: {
      action: 'reveal-file',
      label: 'Show file',
      hint: 'Save an unlocked copy and drop that in instead.',
    },
  },
  PDF_NO_TEXT_LAYER: {
    message: 'This PDF is a scan with no selectable text.',
    retryable: false,
    halt: false,
    remedy: {
      action: 'switch-to-api',
      label: 'Use an API key to read scans',
      hint: 'Reading scanned pages needs the API engine.',
    },
  },
  PDF_TOO_LARGE: {
    message: 'This document is longer than the tracker will read in one pass.',
    retryable: false,
    halt: false,
    remedy: {
      action: 'enter-manually',
      label: 'Fill in manually',
      hint: 'Or split out the pages that contain the terms.',
    },
  },
  PDF_EMPTY: {
    message: 'No text could be pulled out of this PDF.',
    retryable: false,
    halt: false,
    remedy: { action: 'reveal-file', label: 'Show file' },
  },
  VISION_UNSUPPORTED: {
    message: 'The Claude subscription engine cannot read scanned pages.',
    retryable: false,
    halt: false,
    remedy: { action: 'switch-to-api', label: 'Use an API key' },
  },

  /* ── Integrity ───────────────────────────────────────────────────── */
  SCHEMA_INVALID: {
    message: "Claude's answer didn't match the expected shape, twice.",
    retryable: true,
    retryAfterMs: 1_000,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },
  CONFLICT: {
    /*
     * The generic sentence is a fallback that should rarely be seen: every caller
     * passes the specific one ("That document was set aside", "already approved").
     * It exists as a code at all so a refusal we fully understand does not land in
     * the support bundle as UNKNOWN, next to the failures we genuinely do not.
     */
    message: 'That is not possible right now.',
    retryable: false,
    halt: false,
    remedy: { action: 'none', label: 'OK' },
  },

  ALL_CITATIONS_FAILED: {
    message: 'None of the quotes Claude gave could be found in the document.',
    retryable: true,
    retryAfterMs: 1_000,
    halt: false,
    remedy: {
      action: 'retry',
      label: 'Try again',
      hint: 'Nothing was saved. This is the hallucination guard doing its job.',
    },
  },

  /* ── Local ───────────────────────────────────────────────────────── */
  DB_LOCKED: {
    message: 'The database was busy. Nothing was lost.',
    retryable: true,
    retryAfterMs: 500,
    halt: false,
    remedy: { action: 'retry', label: 'Try again' },
  },
  DB_CORRUPT: {
    message: 'The database file is damaged.',
    retryable: false,
    halt: true,
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
  },
  DISK_FULL: {
    message: 'This Mac is out of disk space.',
    retryable: true,
    retryAfterMs: 30_000,
    halt: true,
    remedy: { action: 'wait-and-retry', label: 'Resume' },
  },
  FOLDER_MISSING: {
    message: 'The watched folder no longer exists.',
    retryable: false,
    halt: true,
    remedy: { action: 'choose-folder', label: 'Choose a folder' },
  },
  FOLDER_UNREADABLE: {
    message: "The tracker doesn't have permission to read that folder.",
    retryable: false,
    halt: true,
    remedy: { action: 'choose-folder', label: 'Choose a folder' },
  },
  KEYCHAIN_UNAVAILABLE: {
    message: 'The API key could not be stored securely.',
    retryable: false,
    halt: true,
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
  },
  UNKNOWN: {
    message: 'Something unexpected went wrong.',
    retryable: true,
    retryAfterMs: 2_000,
    halt: false,
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
  },
};

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly info: EngineErrorInfo;
  /** Technical detail for the log and the support bundle. Never shown as the headline. */
  readonly detail: string | undefined;
  readonly cause: unknown;

  constructor(
    code: EngineErrorCode,
    opts: { detail?: string; cause?: unknown; retryAfterMs?: number } = {},
  ) {
    const info = CATALOG[code] ?? CATALOG.UNKNOWN;
    super(`${code}: ${info.message}`);
    this.name = 'EngineError';
    this.code = code;
    this.info = opts.retryAfterMs ? { ...info, retryAfterMs: opts.retryAfterMs } : info;
    this.detail = opts.detail;
    this.cause = opts.cause;
  }

  /** Safe to send to the renderer — never contains a key or a file path. */
  toJSON() {
    return {
      code: this.code,
      message: this.info.message,
      retryable: this.info.retryable,
      retryAfterMs: this.info.retryAfterMs ?? null,
      remedy: this.info.remedy,
      halt: this.info.halt,
      detail: redact(this.detail),
    };
  }
}

export type SerialisedEngineError = ReturnType<EngineError['toJSON']>;

export function errorInfo(code: EngineErrorCode): EngineErrorInfo {
  return CATALOG[code] ?? CATALOG.UNKNOWN;
}

/** Wrap anything thrown into an EngineError. Never let a raw error escape. */
export function toEngineError(e: unknown, fallback: EngineErrorCode = 'UNKNOWN'): EngineError {
  if (e instanceof EngineError) return e;
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new EngineError(fallback, { detail, cause: e });
}

/**
 * Strip anything that looks like a credential before a string is logged, shown,
 * or put in a support bundle.
 */
export function redact(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/sk-ant-[A-Za-z0-9_\-]{10,}/g, 'sk-ant-***REDACTED***')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) =>
      m.length > 4 ? `${m.slice(0, 2)}***@***` : '***',
    )
    .replace(/(Authorization|x-api-key)\s*[:=]\s*\S+/gi, '$1: ***REDACTED***');
}
