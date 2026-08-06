/**
 * The orchestrator. One document in, sixteen evidenced fields out.
 *
 *   hash -> read -> rules -> cache -> model -> verify -> compute -> persist
 *
 * Design rules this file enforces:
 *   * Software does everything deterministic. The model is asked only for the fields
 *     rules could not find, and is never asked to do arithmetic: both date
 *     computations happen here, in code, from the term it quoted.
 *   * A document never gets stuck. Every path out of here sets a terminal status and
 *     leaves the record retryable, including the ones that throw.
 *   * Nothing silent. An escalation to a bigger model is recorded on the document, so
 *     "why did this one cost more" always has an answer -- and so is HOW the words
 *     were read off the page, because "verified" means something different on a scan.
 *   * A human's work outranks a machine's. A re-read never overwrites a value she
 *     typed or a gap she acknowledged, and it never overwrites a record she has
 *     already approved.
 */

import { readFile } from 'node:fs/promises';

import {
  FIELDS,
  FIELD_KEYS,
  FIELD_LIST,
  MODEL_FIELD_KEYS,
  type DocType,
  type ExtractionMethod,
  type FieldKey,
} from '@/lib/fields';
import { EngineError, redact, toEngineError } from '@/lib/providers/errors';
import {
  LIMITS,
  modelFor,
  type ExtractionRequest,
  type ExtractionResponse,
  type ModelTier,
  type PageImage,
  type Provider,
  type RawFieldAnswer,
} from '@/lib/providers/types';
import { getActiveProvider, getActiveTier } from '@/lib/providers';
import {
  getDocument,
  getDocumentFields,
  getSetting,
  insertAudit,
  insertUsageLog,
  replaceDocumentFields,
  updateDocument,
} from '@/lib/db/queries';
import { tx } from '@/lib/db/client';
import type { DocumentStatus } from '@/lib/db/types';
import { clockAnchor, resolveEndDate, tidyTerm } from '@/lib/util/dates';
import { partiesNeedSwap, swapPartyRoles } from '@/lib/parties';
import { log } from '@/lib/logger';

import { cacheKey, getCached, putCached } from './cache';
import {
  MAX_OCR_PAGES,
  MIN_OCR_CONFIDENCE,
  OCR_TAIL_PAGES,
  formatPageRanges,
  ocrPages,
  selectPages,
  type OcrResult,
  type PageRange,
} from './ocr';
import { PROMPT_VERSION } from './prompt';
import {
  OCR_DPI,
  VISION_DPI,
  joinPages,
  readPdf,
  renderPages,
  sha256,
  type PdfRead,
} from './pdf';
import { runRules } from './rules';
import { applyVerification, type VerifiedFields } from './verify';

/* ──────────────────────────────── types ─────────────────────────────── */

/** One persisted row of evidence. Mirrors document_fields. */
export interface FieldRecord {
  key: FieldKey;
  value: string | null;
  quote: string | null;
  page: number | null;
  method: ExtractionMethod;
  /** null when verification does not apply: a rule hit, a scan, or a computed value. */
  citationVerified: boolean | null;
}

export type ExtractionStage = 'reading' | 'ocr' | 'rules' | 'asking' | 'verifying' | 'saving';

/**
 * How the words the model was given came off the page. Recorded on every document,
 * because the integrity guarantees differ per path and a record that does not say
 * which one it took cannot be audited.
 *
 *   pdf    — the PDF's own text layer. Rules run, citations verified against the page.
 *   ocr    — tesseract read the rasterised pages. Rules run, and citations are
 *            verified against THE MACHINE READ, not against the page. A quote and the
 *            haystack it is checked against are the same machine's guess, so a
 *            mis-read that is consistent on both sides passes. citation_verified = 1
 *            on this path honestly means "found in the scan we made", which is a
 *            weaker claim than the same 1 on a digital PDF -- hence this column.
 *   vision — page images went to the model. No text exists, so no rules and NO
 *            citation checking: every field on this path is stored unverified.
 */
export type TextSource = 'pdf' | 'ocr' | 'vision';

export interface ExtractionOptions {
  /** Defaults to the engine selected in Settings. The queue passes it explicitly. */
  provider?: Provider;
  tier?: ModelTier;
  /** The retry path: ignore the stored answer and ask again. */
  bypassCache?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: ExtractionStage) => void;
}

/** A value the new read produced for a field a human already owns. Offered, not applied. */
export interface ProposedChange {
  key: FieldKey;
  /** What the human has now. */
  current: string | null;
  /** What this run would have written. Null when the run found nothing. */
  proposed: string | null;
}

export interface ExtractionOutcome {
  documentId: string;
  /**
   * 'abandoned' means nothing was written: a human resolved the record while this run
   * was in flight, and her decision wins. Every other field then describes what is
   * already stored, not what this run produced.
   */
  status: 'ready' | 'needs_attention' | 'abandoned';
  /** Set only when status is 'abandoned': the state she had already put it in. */
  abandonedBecause: 'approved' | 'rejected' | null;
  docType: DocType | null;
  fields: FieldRecord[];
  /** Fields that block Approve until a human fills them. */
  missingRequired: FieldKey[];
  cached: boolean;
  tier: ModelTier;
  model: string;
  /**
   * How the document was read. Determines which guarantees applied — see TextSource.
   * Null only on an abandoned run, which never got as far as opening the file.
   */
  textSource: TextSource | null;
  /** Mean OCR confidence 0..100, whenever OCR ran. Null on a digital PDF. */
  ocrConfidence: number | null;
  /** How many pages were actually read. Less than pageCount means the rest were skipped. */
  pagesRead: number;
  /** The pages that were read, as contiguous runs. What the banner and the audit say. */
  pageRanges: PageRange[];
  /** Set when a low-yield first pass was retried on a bigger model. */
  escalatedFrom: ModelTier | null;
  /** Set when the OCR read produced no verifiable quote and the images were sent instead. */
  fellBackToVision: boolean;
  /** Rows a human owned that this run kept instead of overwriting. */
  preservedFields: FieldKey[];
  /** What the run would have written over those rows. Recorded, never applied. */
  proposedChanges: ProposedChange[];
  /**
   * Second confidentiality clock. Computed here but not stored in document_fields:
   * it is not a tracker field, it is a contracts column written at approve time.
   */
  confidentialityEnd: string | null;
  costUsd: number | null;
  durationMs: number;
}

const REQUIRED_KEYS: FieldKey[] = FIELD_LIST.filter((f) => f.requiredToApprove).map((f) => f.key);

/** More than this many empty required fields means the model had a bad day. */
const LOW_YIELD_THRESHOLD = 3;

const TIER_LADDER: ModelTier[] = ['fast', 'balanced', 'deep'];

/**
 * Statuses a human put the record into. Nothing this file computes may overwrite one:
 * a contract frozen from an approved read must not silently acquire values the
 * document no longer claims.
 */
const RESOLVED: Record<string, 'approved' | 'rejected' | undefined> = {
  approved: 'approved',
  rejected: 'rejected',
};

function resolvedBy(status: DocumentStatus): 'approved' | 'rejected' | null {
  return RESOLVED[status] ?? null;
}

function nextTier(tier: ModelTier): ModelTier | null {
  const i = TIER_LADDER.indexOf(tier);
  return i >= 0 && i < TIER_LADDER.length - 1 ? (TIER_LADDER[i + 1] ?? null) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ────────────────────────────── entry point ─────────────────────────── */

/**
 * In-flight guard. Two clicks on Retry, or the queue racing a manual run, must not
 * produce two extractions of one document: the second call joins the first.
 */
const inFlight = new Map<string, Promise<ExtractionOutcome>>();

export function extractDocument(
  documentId: string,
  opts: ExtractionOptions = {},
): Promise<ExtractionOutcome> {
  const running = inFlight.get(documentId);
  if (running) return running;
  const run = runExtraction(documentId, opts);
  const tracked = run.finally(() => {
    inFlight.delete(documentId);
  });
  inFlight.set(documentId, tracked);
  return tracked;
}

export function isExtracting(documentId: string): boolean {
  return inFlight.has(documentId);
}

async function runExtraction(
  documentId: string,
  opts: ExtractionOptions,
): Promise<ExtractionOutcome> {
  const started = Date.now();
  const doc = getDocument(documentId);
  if (!doc) {
    throw new EngineError('UNKNOWN', { detail: `document ${documentId} is not in the database` });
  }

  // The first gate. A queued job can outlive the decision that made it pointless:
  // the Inbox keeps a card ticked after it stops being eligible, so a retry can start
  // on a document that was approved a second ago. Writing 'extracting' over
  // 'approved' would already have broken the record before anything was extracted.
  const resolved = resolvedBy(doc.status);
  if (resolved) {
    log.info('extract.abandoned', { documentId, status: doc.status, when: 'before-start' });
    return abandonedOutcome(documentId, resolved, opts, started);
  }

  updateDocument(documentId, {
    status: 'extracting',
    errorCode: null,
    errorDetail: null,
    attempts: (doc.attempts ?? 0) + 1,
    updatedAt: nowIso(),
  });

  try {
    return await extract(documentId, doc.archivePath ?? doc.originPath, opts);
  } catch (e) {
    const err = toEngineError(e);
    // A record she resolved mid-run must not be marked failed either: the run is
    // irrelevant now, not broken.
    const now = getDocument(documentId);
    const late = now ? resolvedBy(now.status) : null;
    if (late) {
      log.info('extract.abandoned', { documentId, status: now?.status, when: 'after-failure' });
      return abandonedOutcome(documentId, late, opts, started);
    }
    // Terminal, but retryable: the error code is what the Inbox card offers a fix for.
    updateDocument(documentId, {
      status: 'failed',
      errorCode: err.code,
      errorDetail: redact(err.detail) ?? null,
      updatedAt: nowIso(),
    });
    throw err;
  }
}

/**
 * The outcome of a run that wrote nothing. It reports the record as it stands, so a
 * caller that renders the result shows her own values rather than the ones this run
 * was about to impose.
 */
function abandonedOutcome(
  documentId: string,
  because: 'approved' | 'rejected',
  opts: ExtractionOptions,
  started: number,
  read?: DocumentText,
): ExtractionOutcome {
  const stored = getDocumentFields(documentId).map(toFieldRecord);
  const tier = opts.tier ?? getActiveTier();
  return {
    documentId,
    status: 'abandoned',
    abandonedBecause: because,
    docType: getDocument(documentId)?.docType ?? null,
    fields: stored,
    missingRequired: [],
    cached: false,
    tier,
    model: modelFor(tier).id,
    textSource: read?.source ?? null,
    ocrConfidence: read?.ocrConfidence ?? null,
    pagesRead: read?.pagesRead ?? 0,
    pageRanges: read?.ranges ?? [],
    escalatedFrom: null,
    fellBackToVision: false,
    preservedFields: [],
    proposedChanges: [],
    confidentialityEnd: null,
    costUsd: null,
    durationMs: Date.now() - started,
  };
}

/** db FieldRecord (which carries its definition too) -> the evidence half. */
function toFieldRecord(f: {
  key: FieldKey;
  value: string | null;
  quote: string | null;
  page: number | null;
  method: ExtractionMethod;
  citationVerified: boolean | null;
}): FieldRecord {
  return {
    key: f.key,
    value: f.value,
    quote: f.quote,
    page: f.page,
    method: f.method,
    citationVerified: f.citationVerified,
  };
}

/* ─────────────────────────────── the work ───────────────────────────── */

async function extract(
  documentId: string,
  filePath: string | null,
  opts: ExtractionOptions,
): Promise<ExtractionOutcome> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});

  progress('reading');
  const buffer = await loadFile(filePath);
  const fileHash = sha256(buffer);
  const pdf = await readPdf(buffer);

  // Read on every run, so an engine switch in Settings applies to the next document.
  const provider = opts.provider ?? (await getActiveProvider());
  const startTier: ModelTier = opts.tier ?? getActiveTier();

  // Recorded before anything can fail, so a document that turns out to be an
  // unreadable scan still shows its page count on the Inbox card.
  updateDocument(documentId, {
    pageCount: pdf.pageCount,
    hasTextLayer: pdf.hasTextLayer ? 1 : 0,
    updatedAt: nowIso(),
  });

  let read = await readDocument(documentId, provider, buffer, pdf, opts, progress);
  recordHowItWasRead(documentId, read, pdf.pageCount);

  let fellBackToVision = false;
  let pass: PassResult;
  try {
    pass = await runPass(documentId, provider, startTier, {
      fileHash,
      pdf,
      read,
      opts,
      progress,
    });
  } catch (e) {
    const err = toEngineError(e);
    // Every quote failing on an OCR document is evidence about the SCAN, not about
    // the model: a haystack of word salad cannot contain any sentence. Retrying the
    // same machine read cannot produce a different answer, but the images can still
    // be read -- and reaching vision is exactly what the usableOcr gate failed to do
    // when tesseract reported a confident 65 on nonsense.
    const canFallBack =
      err.code === 'ALL_CITATIONS_FAILED' && read.source === 'ocr' && provider.supportsVision;
    if (!canFallBack) throw err;

    log.warn('extract.ocr.unverifiable_fallback_to_vision', {
      documentId,
      confidence: read.ocrConfidence,
      pagesRead: read.pagesRead,
    });
    insertAudit({
      documentId,
      action: 'extracted',
      detail:
        `The OCR text (confidence ${read.ocrConfidence ?? 0}%) contained none of the quotes ` +
        'Claude gave, so the scan was re-read as page images',
    });

    read = await visionRead(buffer, pdf, read.ocrConfidence);
    recordHowItWasRead(documentId, read, pdf.pageCount);
    fellBackToVision = true;
    pass = await runPass(documentId, provider, startTier, {
      fileHash,
      pdf,
      read,
      opts,
      // The cache key is (file, model, prompt, fields) -- it says nothing about
      // whether the model was handed text or images. Without this the vision retry is
      // served the very OCR answers that just failed verification.
      forceBypassCache: true,
      progress,
    });
  }

  const { records, tier } = pass;

  progress('saving');
  const model = modelFor(tier);

  /*
   * One transaction, and it starts by re-reading the status.
   *
   * The check in runExtraction narrows the approve race; only holding the write lock
   * while re-reading removes it, because approveDocument() takes the same lock. The
   * merge with her hand-typed rows is inside for the same reason: reading them and
   * writing them back must not be two separate moments.
   */
  const written = tx((): WriteResult => {
    const current = getDocument(documentId);
    const late = current ? resolvedBy(current.status) : null;
    if (late) return { abandoned: late };

    // A human's row wins over anything this run produced, and the run's answer for
    // that field becomes a proposal on the record rather than an overwrite.
    const preserved = preserveHumanRows(documentId, records);

    // Before the dates, because nothing downstream should ever see IBC in the B slot.
    if (enforcePartyRoles(records)) {
      // Worth a log line: the counterparty drafted the agreement on their own form.
      log.info('parties.swapped', { documentId });
    }
    const confidentialityEnd = computeDates(records);

    const fields = FIELD_KEYS.map(
      (key) =>
        records.get(key) ?? {
          key,
          value: null,
          quote: null,
          page: null,
          method: 'missing' as ExtractionMethod,
          citationVerified: null,
        },
    );

    const missingRequired = REQUIRED_KEYS.filter((key) => {
      const record = records.get(key);
      // "Not in document" is an answer, not a gap. approvalBlockers() agrees, and a
      // disagreement here would show a card as needing attention it does not need.
      if (record && record.method === 'na') return false;
      return !record || record.value === null || record.value.length === 0;
    });
    const status = missingRequired.length > 0 ? 'needs_attention' : 'ready';

    replaceDocumentFields(documentId, fields);
    updateDocument(documentId, {
      status,
      docType: pass.docType,
      provider: provider.id,
      model: model.id,
      tier,
      promptVersion: PROMPT_VERSION,
      costUsd: pass.costUsd,
      durationMs: Date.now() - started,
      extractedAt: nowIso(),
      updatedAt: nowIso(),
      errorCode: null,
      errorDetail: null,
    });
    recordPreservedRows(documentId, preserved);

    return { abandoned: null, fields, missingRequired, status, confidentialityEnd, preserved };
  });

  if (written.abandoned !== null) {
    log.info('extract.abandoned', { documentId, status: written.abandoned, when: 'at-write' });
    return abandonedOutcome(documentId, written.abandoned, opts, started, read);
  }

  return {
    documentId,
    status: written.status,
    abandonedBecause: null,
    docType: pass.docType,
    fields: written.fields,
    missingRequired: written.missingRequired,
    cached: pass.cached,
    tier,
    model: model.id,
    textSource: read.source,
    ocrConfidence: read.ocrConfidence,
    pagesRead: read.pagesRead,
    pageRanges: read.ranges,
    escalatedFrom: pass.escalatedFrom,
    fellBackToVision,
    preservedFields: written.preserved.map((p) => p.key),
    proposedChanges: written.preserved.filter((p) => p.proposed !== p.current),
    confidentialityEnd: written.confidentialityEnd,
    costUsd: pass.costUsd,
    durationMs: Date.now() - started,
  };
}

/** What the write transaction hands back. Discriminated on `abandoned`. */
type WriteResult =
  | { abandoned: 'approved' | 'rejected' }
  | {
      abandoned: null;
      fields: FieldRecord[];
      missingRequired: FieldKey[];
      status: 'ready' | 'needs_attention';
      confidentialityEnd: string | null;
      preserved: PreservedRow[];
    };

/**
 * "Why is this record different" must always have an answer, and a scan read two
 * different ways produces two different integrity stories. The columns carry the
 * machine-readable version (text_source, ocr_confidence, pages_read); this is the
 * sentence a human reads in the timeline, and it is where the page ranges live —
 * there is no column for "pages 1-28 and 49-60".
 */
function recordHowItWasRead(documentId: string, read: DocumentText, pageCount: number): void {
  tx(() => {
    // A record she resolved while this run was reading is not ours to annotate: the
    // provenance of an approved record is the provenance of the read it was approved
    // from, and stamping this run's over it would describe evidence nobody kept.
    const current = getDocument(documentId);
    if (current && resolvedBy(current.status)) return;
    writeHowItWasRead(documentId, read, pageCount);
  });
}

function writeHowItWasRead(documentId: string, read: DocumentText, pageCount: number): void {
  // Written for every path, including a clean digital PDF: a reader has to be able to
  // tell "verified against the page" from "verified against our scan of the page",
  // and an absent value is not that answer.
  updateDocument(documentId, {
    textSource: read.source,
    /*
     * Two conversions in one line, and both are deliberate.
     *
     * Tesseract reports 0..100 and this module keeps that scale (MIN_OCR_CONFIDENCE
     * is 60); the column is declared 0..1, so the boundary is the one place the two
     * conventions meet. And the column is only meaningful for text_source = 'ocr',
     * so a confidence measured on a read we then THREW AWAY is not written next to
     * 'vision' where it would read as a score for the path we actually took. The
     * number survives in the timeline sentence below.
     */
    ocrConfidence:
      read.source === 'ocr' && read.ocrConfidence !== null ? read.ocrConfidence / 100 : null,
    /*
     * The score that lost. When OCR is too poor we fall back to vision, and the
     * reviewer deserves to know that a machine read was attempted and rejected --
     * but it does not belong in ocr_confidence, which describes the read we kept.
     */
    rejectedOcrConfidence:
      read.source === 'vision' && read.ocrConfidence !== null ? read.ocrConfidence / 100 : null,
    pagesRead: read.pagesRead,
    /*
     * WHICH pages, not how many. selectPages() spends its budget on the head and the
     * tail, so a 60-page scan capped at 40 is pages 1-28 and 49-60. A banner built on
     * the count alone said "only the first 40 pages were read" -- which named the
     * signature block as unseen when the tail is precisely what the cap protects.
     */
    pagesReadRanges: formatPageRanges(read.ranges) || null,
    updatedAt: nowIso(),
  });

  if (read.source === 'pdf') return;

  const confidence =
    read.ocrConfidence === null ? 'no usable text' : `OCR confidence ${read.ocrConfidence}%`;
  const coverage =
    read.pagesRead >= pageCount
      ? `all ${pageCount} pages`
      : `pages ${formatPageRanges(read.ranges)} of ${pageCount}`;
  const detail =
    read.source === 'ocr'
      ? `Scan read by OCR (${confidence}); ${coverage}; quotes checked against the machine read, not against the page`
      : `Scan sent to Claude as page images (${confidence}); ${coverage}; quotes could not be checked`;
  insertAudit({ documentId, action: 'extracted', detail });
}

async function loadFile(filePath: string | null): Promise<Uint8Array> {
  if (!filePath) {
    throw new EngineError('PDF_UNREADABLE', { detail: 'the document has no file on disk' });
  }
  try {
    return await readFile(filePath);
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String(e.code) : '';
    if (code === 'EACCES' || code === 'EPERM') {
      throw new EngineError('FOLDER_UNREADABLE', { cause: e });
    }
    if (code === 'ENOSPC') throw new EngineError('DISK_FULL', { cause: e });
    throw new EngineError('PDF_UNREADABLE', { cause: e, detail: code || undefined });
  }
}

/* ──────────────────── keeping what a human already did ──────────────── */

interface PreservedRow {
  key: FieldKey;
  /** The value she owns. Null for a "Not in document" mark. */
  current: string | null;
  /** What this run would have written. Null when it found nothing. */
  proposed: string | null;
}

/**
 * A re-read is a proposal, not a rewrite.
 *
 * The old behaviour upserted all sixteen keys, including the ones this run could not
 * find, so every value a human typed and every gap she had explicitly acknowledged
 * was replaced -- by 'missing', more often than not. That is the single most
 * expensive thing this pipeline could do to her afternoon, and no amount of warning
 * copy makes it acceptable.
 *
 * So rows whose method is 'manual' or 'na' are lifted out of the database and put
 * back over the run's answers before anything is written. What the run found for
 * those fields is returned, and recorded on the timeline, so the new reading is
 * visible without being applied.
 */
function preserveHumanRows(
  documentId: string,
  records: Map<FieldKey, FieldRecord>,
): PreservedRow[] {
  const kept: PreservedRow[] = [];
  for (const stored of getDocumentFields(documentId)) {
    if (stored.method !== 'manual' && stored.method !== 'na') continue;
    const proposed = records.get(stored.key)?.value ?? null;
    kept.push({ key: stored.key, current: stored.value, proposed });
    records.set(stored.key, toFieldRecord(stored));
  }
  return kept;
}

/** One timeline entry, only when there was something to keep. */
function recordPreservedRows(documentId: string, kept: readonly PreservedRow[]): void {
  if (kept.length === 0) return;
  const label = (key: FieldKey): string => FIELDS[key].label;
  const changes = kept.filter((k) => k.proposed !== k.current && k.proposed !== null);
  const parts = [
    `Kept ${kept.length} field${kept.length === 1 ? '' : 's'} you filled in or marked not in the document (${kept
      .map((k) => label(k.key))
      .join(', ')})`,
  ];
  if (changes.length > 0) {
    parts.push(
      `Claude read something different for ${changes
        .map((c) => `${label(c.key)}: ${c.proposed ?? 'nothing'}`)
        .join('; ')}`,
    );
  }
  insertAudit({ documentId, action: 'extracted', detail: parts.join('. ') });
}

/* ─────────────────────────── how a scan is read ─────────────────────── */

/** The words the rest of the pipeline works from, and where they came from. */
interface DocumentText {
  source: TextSource;
  /** Page-delimited text the model is shown. Null only on the vision path. */
  text: string | null;
  /**
   * What rules run over and verify.ts searches. Indexed by REAL page number - 1, with
   * an empty string for a page the budget did not reach: the page a quote is reported
   * on comes from this index, so a dense array would attribute page 55 to page 29.
   * Empty only on the vision path.
   */
  pagesText: string[];
  /** Rendered pages. Non-null only on the vision path. */
  images: PageImage[] | null;
  /** Mean OCR confidence whenever OCR ran, including when we then rejected it. */
  ocrConfidence: number | null;
  /** Can a quote be checked against anything? False only on the vision path. */
  verifiable: boolean;
  /** How many pages were actually read. */
  pagesRead: number;
  /** Which ones, as contiguous runs. */
  ranges: PageRange[];
}

/**
 * The scan flow.
 *
 * OCR is tried first and, when it works, the document behaves almost exactly like a
 * digital PDF from here on: rules run, the model is sent text rather than images, and
 * every quote is checked against that text. The one thing that is NOT the same is what
 * a passing check proves -- the quote and the haystack are both the same machine's
 * reading of the same image, so an error tesseract made is present identically on both
 * sides and survives the comparison. That is why text_source is persisted rather than
 * inferred: the check is real, and it is a check against the scan.
 *
 * Vision is the fallback when the machine read is too poor to be trusted as a
 * haystack. Which path ran is recorded either way; nothing here is allowed to be
 * silent.
 */
async function readDocument(
  documentId: string,
  provider: Provider,
  buffer: Uint8Array,
  pdf: PdfRead,
  opts: ExtractionOptions,
  progress: (stage: ExtractionStage) => void,
): Promise<DocumentText> {
  if (pdf.hasTextLayer) {
    return {
      source: 'pdf',
      text: pdf.text,
      pagesText: pdf.pagesText,
      images: null,
      ocrConfidence: null,
      verifiable: true,
      pagesRead: pdf.pageCount,
      ranges: pdf.pageCount > 0 ? [{ from: 1, to: pdf.pageCount }] : [],
    };
  }

  progress('ocr');
  const selection = selectPages(pdf.pageCount, MAX_OCR_PAGES, OCR_TAIL_PAGES);
  if (selection.truncated) {
    log.warn('extract.ocr.truncated', {
      documentId,
      pageCount: pdf.pageCount,
      reading: formatPageRanges(selection.ranges),
    });
  }
  const ocr = await tryOcr(documentId, buffer, selection.pages, opts.signal);

  if (ocr) {
    const text = ocrText(ocr, pdf.pageCount);
    if (usableOcr(ocr, text.text ?? '')) return text;
  }

  if (provider.supportsVision) {
    log.warn('extract.ocr.fallback_to_vision', {
      documentId,
      confidence: ocr?.confidence ?? null,
    });
    return await visionRead(buffer, pdf, ocr?.confidence ?? null);
  }

  // No vision to fall back to. Poor OCR text still beats refusing the document
  // outright, and unlike vision it can at least be verified against.
  if (ocr && ocr.pages.some((p) => p.text.trim().length > 0)) {
    log.warn('extract.ocr.low_confidence_kept', { documentId, confidence: ocr.confidence });
    return ocrText(ocr, pdf.pageCount);
  }

  // PDF_NO_TEXT_LAYER carries the switch-to-api remedy; VISION_UNSUPPORTED is for
  // an engine asked to read images anyway.
  throw new EngineError('PDF_NO_TEXT_LAYER');
}

/** Rasterise for the model. Same head-and-tail reasoning as OCR, smaller budget. */
async function visionRead(
  buffer: Uint8Array,
  pdf: PdfRead,
  ocrConfidence: number | null,
): Promise<DocumentText> {
  const selection = selectPages(pdf.pageCount, LIMITS.maxVisionPages, visionTail());
  const images = await renderPages(buffer, selection.pages, {
    dpi: VISION_DPI,
    maxPages: LIMITS.maxVisionPages,
  });
  return {
    source: 'vision',
    text: null,
    pagesText: [],
    images,
    ocrConfidence,
    verifiable: false,
    pagesRead: images.length,
    ranges: selection.ranges,
  };
}

/** Proportionally the same share of the budget the OCR path spends on the tail. */
function visionTail(): number {
  return Math.max(1, Math.round((LIMITS.maxVisionPages * OCR_TAIL_PAGES) / MAX_OCR_PAGES));
}

/**
 * The OCR result as the pipeline's text. The array is laid out by real page number,
 * with gaps where the budget did not reach, so a citation on page 55 is reported as
 * page 55 rather than as whatever index it happened to land on.
 */
function ocrText(ocr: OcrResult, pageCount: number): DocumentText {
  const pagesText = new Array<string>(Math.max(pageCount, 0)).fill('');
  for (const page of ocr.pages) {
    const index = page.page - 1;
    if (index >= 0 && index < pagesText.length) pagesText[index] = page.text;
  }
  return {
    source: 'ocr',
    text: joinPages(pagesText),
    pagesText,
    images: null,
    ocrConfidence: ocr.confidence,
    verifiable: true,
    pagesRead: ocr.pages.length,
    ranges: rangesOf(ocr.pages.map((p) => p.page)),
  };
}

function rangesOf(pages: readonly number[]): PageRange[] {
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: PageRange[] = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && page === last.to + 1) last.to = page;
    else ranges.push({ from: page, to: page });
  }
  return ranges;
}

/**
 * OCR failing is not the document failing: the vision path is still there. So this
 * swallows the error, records it, and lets the caller choose. It only ever returns
 * null when there is genuinely nothing to work with.
 */
async function tryOcr(
  documentId: string,
  buffer: Uint8Array,
  pages: number[],
  signal: AbortSignal | undefined,
): Promise<OcrResult | null> {
  try {
    const images = await renderPages(buffer, pages, {
      dpi: OCR_DPI,
      maxPages: MAX_OCR_PAGES,
    });
    const result = await ocrPages(images, { dpi: OCR_DPI, signal });
    if (result.stoppedEarly) {
      log.warn('extract.ocr.budget_exhausted', {
        documentId,
        read: result.pages.length,
        requested: images.length,
      });
    }
    return result;
  } catch (e) {
    const err = toEngineError(e, 'PDF_NO_TEXT_LAYER');
    log.warn('extract.ocr.failed', { documentId, code: err.code, detail: redact(err.detail) });
    return null;
  }
}

/** Same bar readPdf() uses to decide a PDF has a text layer at all. */
const MIN_OCR_CHARS_PER_PAGE = 40;

/**
 * Two gates, because either one alone is fooled.
 *
 * Confidence alone: a page of noise can score well on the six junk words tesseract
 * was willing to commit to, while the clause we needed never made it out.
 * Yield alone: a clean-looking wall of text can still be confidently wrong.
 *
 * Neither is sufficient, and this pair is known to be beatable -- tesseract reports
 * 60-75 on word salad often enough that it happens. The backstop is not a third gate
 * here but the citation guard downstream: if nothing the model quotes can be found in
 * this text, extract() abandons the machine read and sends the images instead.
 *
 * The per-page divisor is the pages actually READ, not the document's page count: a
 * 60-page scan read to 40 pages must not be judged as if it produced a third less
 * text than it did.
 */
function usableOcr(ocr: OcrResult, text: string): boolean {
  if (ocr.pages.length === 0) return false;
  if (ocr.confidence < MIN_OCR_CONFIDENCE) return false;
  const solid = ocr.pages.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0);
  if (solid / ocr.pages.length < MIN_OCR_CHARS_PER_PAGE) return false;
  return text.length <= LIMITS.maxTextChars;
}

/* ──────────────────────────── the model pass ────────────────────────── */

interface PassContext {
  fileHash: string;
  pdf: PdfRead;
  read: DocumentText;
  opts: ExtractionOptions;
  /** Set on the vision retry: the stored answer is the one that just failed. */
  forceBypassCache?: boolean;
  progress: (stage: ExtractionStage) => void;
}

interface PassInput extends PassContext {
  fieldsToFill: FieldKey[];
}

interface PassResult {
  records: Map<FieldKey, FieldRecord>;
  docType: DocType | null;
  cached: boolean;
  costUsd: number | null;
  tier: ModelTier;
  escalatedFrom: ModelTier | null;
}

interface ModelPass {
  fields: VerifiedFields;
  docType: DocType | null;
  cached: boolean;
  costUsd: number | null;
  /** Required fields still empty after this pass, given what rules already found. */
  missingRequired: (found: Map<FieldKey, FieldRecord>) => number;
}

/**
 * Rules, then the model, then the escalation ladder. Separated from extract() because
 * the whole thing runs twice when an OCR read turns out to be unverifiable, and the
 * second run must start from a clean slate: rules that read the bad machine text are
 * no more trustworthy than the quotes that failed against it.
 */
async function runPass(
  documentId: string,
  provider: Provider,
  startTier: ModelTier,
  ctx: PassContext,
): Promise<PassResult> {
  ctx.progress('rules');
  // Rules read text, and OCR produces text, so a scan gets the deterministic pass
  // too. Only the vision path — where there is no text at all — skips it.
  const ruleHits = ctx.read.pagesText.length > 0 ? runRules(ctx.read.pagesText) : {};
  const records = new Map<FieldKey, FieldRecord>();
  for (const key of FIELD_KEYS) {
    const rule = ruleHits[key];
    if (!rule) continue;
    records.set(key, {
      key,
      value: rule.value,
      quote: rule.quote,
      page: rule.page,
      method: 'rule',
      citationVerified: null,
    });
  }

  const fieldsToFill = MODEL_FIELD_KEYS.filter((key) => !records.has(key));
  let tier = startTier;
  let escalatedFrom: ModelTier | null = null;

  if (fieldsToFill.length === 0) {
    return { records, docType: null, cached: false, costUsd: null, tier, escalatedFrom };
  }

  // The rules-only engine, short-circuited here rather than at the provider.
  //
  // NoneProvider.extract() returns an empty answer set and would be harmless to
  // call, but calling it would still write a usage log, a raw prompt/response pair
  // and an escalation decision for an exchange that never happened -- and the raw
  // drawer, which exists so a human can audit what was asked, would show an empty
  // prompt as though one had been sent. Stopping before `ctx.progress('asking')`
  // also means the UI never says "asking Claude" when nothing is being asked.
  //
  // Everything downstream is unchanged: each unfilled field becomes 'missing', both
  // dates are still computed in code from whatever the rules proved, and the
  // document still reaches a terminal status she can review and approve.
  if (provider.id === 'none') {
    return { records, docType: null, cached: false, costUsd: null, tier, escalatedFrom };
  }

  ctx.progress('asking');
  const input: PassInput = { ...ctx, fieldsToFill };
  let pass = await askModel(documentId, provider, tier, input);

  const higher = nextTier(tier);
  if (higher && shouldEscalate(pass.missingRequired(records))) {
    const retried = await tryEscalate(documentId, provider, higher, input);
    if (retried && retried.missingRequired(records) < pass.missingRequired(records)) {
      escalatedFrom = tier;
      tier = higher;
      pass = retried;
    }
  }

  for (const key of FIELD_KEYS) {
    const field = pass.fields[key];
    if (!field) continue;
    records.set(key, {
      key,
      value: field.value,
      quote: field.quote,
      page: field.page,
      method: field.method,
      // Null means "not checked", and it is only honest on the vision path, where
      // there was no text to check against. OCR'd text is text — how strong the
      // check was is answered by text_source, not by faking a null here.
      citationVerified: ctx.read.verifiable ? field.citationVerified : null,
    });
  }

  return {
    records,
    docType: pass.docType,
    cached: pass.cached,
    costUsd: pass.costUsd,
    tier,
    escalatedFrom,
  };
}

async function askModel(
  documentId: string,
  provider: Provider,
  tier: ModelTier,
  input: PassInput,
): Promise<ModelPass> {
  const model = modelFor(tier);
  const request: ExtractionRequest = {
    text: input.read.text,
    images: input.read.images,
    pageCount: input.pdf.pageCount,
    fieldsToFill: input.fieldsToFill,
    promptVersion: PROMPT_VERSION,
    tier,
  };

  const key = cacheKey(input.fileHash, model.id, PROMPT_VERSION, input.fieldsToFill);
  const bypass = input.opts.bypassCache === true || input.forceBypassCache === true;
  const hit = getCached(key, { bypass });

  let response: ExtractionResponse;
  let cached: boolean;
  if (hit) {
    response = hit;
    cached = true;
  } else {
    try {
      response = await provider.extract(request, {
        signal: input.opts.signal,
        timeoutMs: provider.id === 'cli' ? LIMITS.cliTimeoutMs : LIMITS.apiTimeoutMs,
      });
    } catch (e) {
      const err = toEngineError(e);
      insertUsageLog({
        documentId,
        provider: provider.id,
        model: model.id,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        cached: 0,
        ok: 0,
        errorCode: err.code,
        at: nowIso(),
      });
      throw err;
    }
    cached = false;
  }

  insertUsageLog({
    documentId,
    provider: provider.id,
    model: model.id,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: cached ? 0 : response.usage.costUsd,
    cached: cached ? 1 : 0,
    ok: 1,
    errorCode: null,
    at: nowIso(),
  });

  updateDocument(documentId, {
    repairAttempts: response.raw.repairAttempts,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    rawPrompt: response.raw.prompt,
    rawResponse: response.raw.response,
    updatedAt: nowIso(),
  });

  input.progress('verifying');
  const answers = sanitiseAnswers(response.fields, input.fieldsToFill);

  // The guard runs whenever there is text to run it against, which since OCR means
  // scans too. Only the vision path is exempt, because there the model was handed
  // pictures and there is nothing a quote could be compared with; those fields are
  // stored with citation_verified NULL rather than a faked true.
  let fields: VerifiedFields;
  if (input.read.verifiable) {
    const report = applyVerification(answers, input.read.pagesText, {
      ocr: input.read.source === 'ocr',
    });
    fields = report.fields;
    if (report.rejected > 0 || report.flagged > 0) {
      // The per-field reason distinguishes "not in the document" from "could not be
      // checked against the scan", and those are different failures. Nothing else
      // keeps them, so the log is where that distinction survives.
      log.warn('extract.verification', {
        documentId,
        source: input.read.source,
        claimed: report.claimed,
        rejected: report.rejected,
        flagged: report.flagged,
        notes: report.notes,
      });
    }
  } else {
    fields = unverified(answers);
  }

  // Cached only now, after the answer survived verification. Storing it before meant
  // a run that failed the guard was remembered anyway, so every retry replayed the
  // rejected answer from disk and could not possibly end differently.
  if (!cached) {
    putCached(
      key,
      { fileHash: input.fileHash, model: model.id, promptVersion: PROMPT_VERSION },
      response,
    );
  }

  return {
    fields,
    docType: normaliseDocType(response.docType),
    cached,
    costUsd: cached ? 0 : response.usage.costUsd,
    missingRequired: (found) =>
      REQUIRED_KEYS.filter((k) => {
        const rule = found.get(k);
        if (rule && rule.value) return false;
        const answer = fields[k];
        return !answer || answer.value === null;
      }).length,
  };
}

/**
 * The escalation attempt is best-effort. If the bigger model fails or hallucinates,
 * the first pass still stands: a worse answer is better than no answer.
 */
async function tryEscalate(
  documentId: string,
  provider: Provider,
  tier: ModelTier,
  input: PassInput,
): Promise<ModelPass | null> {
  try {
    return await askModel(documentId, provider, tier, input);
  } catch {
    return null;
  }
}

function shouldEscalate(missingCount: number): boolean {
  if (missingCount <= LOW_YIELD_THRESHOLD) return false;
  return getSetting('escalateOnLowYield') === 'true';
}

/** Drop keys nobody asked for, trim, and turn blanks into honest nulls. */
function sanitiseAnswers(
  raw: Partial<Record<FieldKey, RawFieldAnswer>>,
  fieldsToFill: readonly FieldKey[],
): Partial<Record<FieldKey, RawFieldAnswer>> {
  const allowed = new Set(fieldsToFill);
  const out: Partial<Record<FieldKey, RawFieldAnswer>> = {};
  for (const key of FIELD_KEYS) {
    if (!allowed.has(key)) continue;
    const answer = raw[key];
    if (!answer) continue;
    const value = typeof answer.value === 'string' ? answer.value.trim() : '';
    const quote = typeof answer.quote === 'string' ? answer.quote.trim() : '';
    const page =
      typeof answer.page === 'number' && Number.isFinite(answer.page)
        ? Math.trunc(answer.page)
        : null;
    out[key] = {
      value: value.length > 0 ? value : null,
      quote: quote.length > 0 ? quote : null,
      page,
    };
  }
  return out;
}

function unverified(
  answers: Partial<Record<FieldKey, RawFieldAnswer>>,
): VerifiedFields {
  const fields: VerifiedFields = {};
  for (const key of FIELD_KEYS) {
    const answer = answers[key];
    if (!answer) continue;
    fields[key] = {
      value: answer.value,
      quote: answer.quote,
      page: answer.page,
      method: answer.value === null ? 'missing' : 'model',
      citationVerified: null,
    };
  }
  return fields;
}

function normaliseDocType(docType: DocType | null): DocType | null {
  if (docType === 'nda' || docType === 'evaluation' || docType === 'other') return docType;
  return null;
}

/* ─────────────────────────── party role invariant ───────────────────── */

/**
 * IBC is always Party A. The rule and the swap live in @/lib/parties so the eval suite
 * exercises the same code -- when this lived here only, the suite stopped testing it and
 * a regression showed up as model variance instead of a failure.
 */
function enforcePartyRoles(records: Map<FieldKey, FieldRecord>): boolean {
  if (!partiesNeedSwap(records.get('party_a')?.value ?? null, records.get('party_b')?.value ?? null)) {
    return false;
  }
  swapPartyRoles<FieldRecord>({
    get: (k) => records.get(k),
    set: (k, v) => records.set(k, { ...v, key: k }),
    del: (k) => records.delete(k),
  });
  return true;
}

/* ───────────────────────────── computed dates ───────────────────────── */

/**
 * The two clocks, both derived in code. The model is never asked to add a duration to
 * a date, because a model that does arithmetic will occasionally do it wrong and
 * there is no quote that would catch it.
 *
 * Returns confidentiality_end, which has no tracker field of its own.
 */
function computeDates(records: Map<FieldKey, FieldRecord>): string | null {
  const effective = records.get('effective_date')?.value ?? null;
  if (!effective) return null;

  const termRec = records.get('term');
  // A model handed the whole Term clause back on one fixture; a tracker column holds a
  // duration, not a paragraph.
  if (termRec?.value) {
    const tidy = tidyTerm(termRec.value);
    if (tidy !== termRec.value) records.set('term', { ...termRec, value: tidy });
  }

  const term = records.get('term')?.value ?? null;
  const effectiveQuote = records.get('effective_date')?.quote ?? null;
  if (term) {
    const termination = resolveEndDate({ effective, term, effectiveQuote }).iso;
    if (termination) {
      const existing = records.get('termination_date');
      // A date she typed herself is not ours to recompute. recomputeDocumentDerived()
      // makes the same exception on the way into the database.
      if (!existing || existing.method !== 'manual') {
        records.set('termination_date', {
          key: 'termination_date',
          value: termination,
          quote: null,
          page: null,
          method: 'computed',
          citationVerified: null,
        });
      }
    }
  }

  const confRec = records.get('confidentiality_term');
  const confTerm = confRec?.value ?? null;
  if (!confTerm) return null;

  // A confidentiality obligation usually outlives the agreement, and very often runs
  // from TERMINATION rather than from signing. Starting it at the effective date
  // understates it by the entire length of the agreement.
  const anchor = clockAnchor(confRec?.quote ?? null);
  const base =
    anchor === 'termination' ? (records.get('termination_date')?.value ?? null) : effective;
  if (!base) return null;

  return resolveEndDate({
    effective: base,
    term: confTerm,
    // Ambiguity only poisons the chain when the clock starts at the effective date;
    // a termination date we computed ourselves is already gated on it.
    effectiveQuote: anchor === 'termination' ? null : effectiveQuote,
  }).iso;
}
