/**
 * The engine contract.
 *
 * Three implementations exist and must be behaviourally interchangeable:
 *   - cli.ts   — spawns the user's `claude` binary, uses their Claude subscription, $0 marginal
 *   - api.ts   — calls the Anthropic API with the user's key, faster and unthrottled
 *   - none.ts  — reads nothing. The deterministic rules keep whatever they find and every
 *                remaining field comes back empty for a human to type.
 *
 * None is ever selected implicitly. There is NO silent fallback between them: a failed
 * engine surfaces its EngineError and the user chooses. Silent failover would make the same
 * document produce different output on different days, which is the one thing this product
 * is not allowed to do — and that rule binds `none` hardest of all, because falling back to
 * it would look like a successful extraction that had quietly stopped extracting.
 *
 * WHAT 'none' COSTS, MEASURED, so the choice is made on a number and not a feeling.
 * Across the 13 eval fixtures there are 180 fields that should carry a value:
 *
 *   rules alone fill  82  (45.6%) and get 0 of them wrong
 *   rules leave blank 98  (54.4%)
 *
 * plus 12 date fields computed in code, which never needed a model. Perfect precision,
 * roughly half the recall. What rules cannot do at all is every signer (0/13), every
 * address (0/13), the notice address (0/13) and the IBC form (0/13) — the parts of a
 * contract that are laid out differently by every firm that drafts one. What they do
 * perfectly is the contract name, the effective date and the governing law (13/13 each).
 */

import type { DocType, FieldKey } from '../fields';
import type { EngineError } from './errors';

/**
 * The one list. `ProviderId` is derived from it and so is the zod enum the settings
 * route validates against, because that route's schema is a `strictObject` and a
 * hand-written copy of this list that fell behind is exactly how choosing Dark used
 * to answer 400. A new engine belongs here and nowhere else.
 */
export const PROVIDER_IDS = ['cli', 'api', 'none'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  cli: 'Claude subscription',
  api: 'API key',
  none: 'No AI (rules only)',
};

/* ───────────────────────────── Models ───────────────────────────── */

export type ModelTier = 'fast' | 'balanced' | 'deep';

export interface ModelDef {
  /** Anthropic model id, used verbatim by the API engine and via --model for the CLI. */
  id: string;
  tier: ModelTier;
  label: string;
  blurb: string;
  /** USD per million tokens, for the cost meter. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Can it read page images (scanned PDFs)? */
  vision: boolean;
}

export const MODELS: Record<ModelTier, ModelDef> = {
  fast: {
    id: 'claude-haiku-4-5',
    tier: 'fast',
    label: 'Haiku',
    blurb: 'Fastest. Good for clean digital PDFs.',
    inputPerMTok: 1,
    outputPerMTok: 5,
    vision: true,
  },
  balanced: {
    id: 'claude-sonnet-5',
    tier: 'balanced',
    label: 'Sonnet',
    blurb: 'Balanced. The default.',
    inputPerMTok: 3,
    outputPerMTok: 15,
    vision: true,
  },
  deep: {
    id: 'claude-opus-5',
    tier: 'deep',
    label: 'Opus',
    blurb: 'Deepest. For messy scans and unusual drafting.',
    inputPerMTok: 5,
    outputPerMTok: 25,
    vision: true,
  },
};

export const DEFAULT_TIER: ModelTier = 'balanced';

export function modelFor(tier: ModelTier): ModelDef {
  return MODELS[tier] ?? MODELS[DEFAULT_TIER];
}

export function estimateCostUsd(
  tier: ModelTier,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (inputTokens == null && outputTokens == null) return null;
  const m = modelFor(tier);
  return (
    ((inputTokens ?? 0) * m.inputPerMTok) / 1e6 + ((outputTokens ?? 0) * m.outputPerMTok) / 1e6
  );
}

/* ─────────────────────────── Extraction ─────────────────────────── */

/** One page of a scanned document, as a base64 PNG. */
export interface PageImage {
  page: number;
  base64: string;
  mediaType: 'image/png';
}

export interface ExtractionRequest {
  /** Full document text, page-delimited. Null only for scans. */
  text: string | null;
  /** Rendered pages. Non-null only when `text` is null (the vision path). */
  images: PageImage[] | null;
  pageCount: number;
  /** Which fields still need answering — rules may already have filled some. */
  fieldsToFill: FieldKey[];
  /** Pinned prompt version. Part of the cache key; changing it is a visible bump. */
  promptVersion: string;
  tier: ModelTier;
}

/** Exactly what the model is permitted to return per field. */
export interface RawFieldAnswer {
  value: string | null;
  /** Verbatim span from the document. Required whenever value is non-null. */
  quote: string | null;
  /** 1-indexed. */
  page: number | null;
}

export interface ExtractionResponse {
  /** Only keys from `fieldsToFill`. Extra keys are dropped by the pipeline. */
  fields: Partial<Record<FieldKey, RawFieldAnswer>>;
  /** The model's read on the document type. Rules may override. */
  docType: DocType | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  };
  /** Kept verbatim on the record so a human can always audit the exchange. */
  raw: {
    provider: ProviderId;
    model: string;
    promptVersion: string;
    prompt: string;
    response: string;
    /** Repair attempts spent getting valid JSON. 0 = clean first pass. */
    repairAttempts: number;
  };
  durationMs: number;
}

/* ──────────────────────────── Health ────────────────────────────── */

export type HealthState = 'ok' | 'warn' | 'fail' | 'unknown';

export interface HealthCheck {
  id: string;
  label: string;
  state: HealthState;
  /** One line. Shown next to the label in Diagnostics. */
  detail: string;
  /** Present when state is warn/fail — the button the UI renders. */
  errorCode?: string;
}

export interface ProviderHealth {
  provider: ProviderId;
  state: HealthState;
  /** e.g. "Claude Code v2.1.4 · signed in" or "Key valid · Sonnet available" */
  summary: string;
  checks: HealthCheck[];
  /** Populated for the CLI engine when we could read it. */
  version?: string;
  /** Populated when the engine reports a usage window. */
  limitResetsAt?: string;
}

/* ─────────────────────────── The engine ─────────────────────────── */

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Hard deadline. The engine must reject with a *_TIMEOUT code, not hang. */
  timeoutMs?: number;
  /** Called on each repair attempt so the UI can show honest progress. */
  onProgress?: (stage: 'sending' | 'waiting' | 'parsing' | 'repairing') => void;
}

export interface Provider {
  readonly id: ProviderId;

  /**
   * Must throw EngineError and nothing else. Must respect timeoutMs.
   * Must never mutate the request.
   */
  extract(req: ExtractionRequest, opts?: ExtractOptions): Promise<ExtractionResponse>;

  /** Cheap, side-effect-free readiness probe. Never throws — returns a fail state. */
  health(): Promise<ProviderHealth>;

  /**
   * A no-cost-if-possible round trip proving the whole path works.
   * Used by the "Run test extraction" button and the onboarding wizard.
   */
  selfTest(opts?: ExtractOptions): Promise<{
    ok: boolean;
    durationMs: number;
    fieldsFound: number;
    fieldsTotal: number;
    costUsd: number | null;
    error?: EngineError;
  }>;

  /** Max simultaneous extractions. CLI is 1 (it is a subscription, not a fleet). */
  readonly maxConcurrency: number;

  /** Whether this engine can accept `images` instead of `text`. */
  readonly supportsVision: boolean;
}

/** Guardrails. Exceeding these is a PDF_TOO_LARGE, not a slow request. */
export const LIMITS = {
  maxPages: 120,
  maxTextChars: 400_000,
  maxVisionPages: 20,
  cliTimeoutMs: 180_000,
  apiTimeoutMs: 120_000,
  maxRepairAttempts: 2,
} as const;
