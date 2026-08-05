/**
 * Every read and every write. Server-only.
 *
 * Rules this file keeps:
 *   - No SQL anywhere else in the app. Route handlers call named functions.
 *   - Status is never selected from a column. It is computed from the dates on
 *     the way out, every time (see status.ts).
 *   - Approve is one transaction. Contract, parties, evidence, audit and the
 *     document's own status either all land or none do.
 *   - Everything that leaves here is a db/types.ts shape, already narrowed.
 *     Callers never see a Record<string, SQLOutputValue>.
 */

import { DOC_TYPES, FIELD_KEYS, FIELDS, confidenceOf } from '../fields';
import type { DocType, ExtractionMethod, FieldKey } from '../fields';
import { EngineError, errorInfo, redact } from '../providers/errors';
import type { EngineErrorCode } from '../providers/errors';
import { DEFAULT_TIER } from '../providers/types';
import type { ModelTier, ProviderId } from '../providers/types';
import { STATUS_ORDER, agreementStatus, confidentialityStatus } from '../status';
import {
  addDuration,
  clockAnchor,
  parseDateIso,
  parseDuration,
  resolveEndDate,
  todayIso,
} from '../util/dates';
import { newContractId, newDocumentId, newPartyId } from '../util/ids';
import { fuzzyScore, normalizeParty, isIbcParty, nullIfBlank } from '../util/normalize';
import { archiveDir, exportDir } from '../paths';
import { db, sqliteError, tx } from './client';
import type {
  AgreementStatus,
  AppSettings,
  AppStats,
  AuditEntry,
  CachedExtraction,
  ContractDetail,
  ContractPage,
  ContractQuery,
  ContractSortKey,
  ContractSummary,
  DocumentDetail,
  DocumentExtractionMeta,
  DocumentFileMeta,
  DocumentFiles,
  DocumentPatch,
  DocumentStatus,
  DocumentSummary,
  ErrorRow,
  FieldRecord,
  FieldValueInput,
  NewDocument,
  PartyRole,
  UsageEntry,
  UsageRollup,
} from './types';

/* ────────────────────────── Row reading helpers ────────────────────────── */

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v: unknown): number {
  return Math.trunc(num(v) ?? 0);
}

function flag(v: unknown): boolean {
  return num(v) === 1;
}

function flagOrNull(v: unknown): boolean | null {
  const n = num(v);
  return n == null ? null : n === 1;
}

/** For NOT NULL columns. A null here means the file is damaged, not that a value is absent. */
function reqStr(v: unknown, what: string): string {
  const s = str(v);
  if (s == null) throw new EngineError('DB_CORRUPT', { detail: `null in NOT NULL column ${what}` });
  return s;
}

/** Booleans are not bindable in node:sqlite. */
function bit(b: boolean | null | undefined): number | null {
  if (b == null) return null;
  return b ? 1 : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ──────────────────────── Enum narrowing (no casts) ────────────────────── */

const DOCUMENT_STATUS_SET: Record<DocumentStatus, true> = {
  queued: true,
  hashing: true,
  reading: true,
  extracting: true,
  ready: true,
  needs_attention: true,
  approved: true,
  failed: true,
  rejected: true,
  duplicate: true,
};

const METHOD_SET: Record<ExtractionMethod, true> = {
  rule: true,
  model: true,
  computed: true,
  manual: true,
  na: true,
  missing: true,
};

const PROVIDER_SET: Record<ProviderId, true> = { cli: true, api: true };
const TEXT_SOURCE_SET: Record<TextSource, true> = { pdf: true, ocr: true, vision: true };
const TIER_SET: Record<ModelTier, true> = { fast: true, balanced: true, deep: true };
const APPEARANCE_SET: Record<AppSettings['appearance'], true> = {
  system: true,
  light: true,
  dark: true,
};
const ROLE_SET: Record<PartyRole, true> = { a: true, b: true, c: true };

/**
 * Membership test as a type predicate. The exhaustive Record above is what makes
 * this sound: a key present in it is, by construction, one of the union members.
 */
function isKeyOf<K extends string>(set: Record<K, true>, v: unknown): v is K {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(set, v);
}

function keyOf<K extends string>(set: Record<K, true>, v: unknown): K | null {
  return isKeyOf(set, v) ? v : null;
}

function docStatus(v: unknown): DocumentStatus {
  const s = keyOf(DOCUMENT_STATUS_SET, v);
  if (s == null) throw new EngineError('DB_CORRUPT', { detail: `unknown document status: ${str(v)}` });
  return s;
}

function method(v: unknown): ExtractionMethod {
  return keyOf(METHOD_SET, v) ?? 'missing';
}

function docType(v: unknown): DocType | null {
  if (typeof v !== 'string') return null;
  return DOC_TYPES.find((t) => t === v) ?? null;
}

function reqDocType(v: unknown): DocType {
  const t = docType(v);
  if (t == null) throw new EngineError('DB_CORRUPT', { detail: `unknown doc_type: ${str(v)}` });
  return t;
}

function role(v: unknown): PartyRole {
  return keyOf(ROLE_SET, v) ?? 'b';
}

function fieldKey(v: unknown): FieldKey | null {
  if (typeof v !== 'string') return null;
  return FIELD_KEYS.find((k) => k === v) ?? null;
}

/* ═══════════════════════ Read provenance (v2 columns) ═══════════════════ */

/**
 * How the text the model actually read was obtained.
 *
 *   'pdf'    -- an embedded text layer, extracted verbatim.
 *   'ocr'    -- rasterised and transcribed. Characters can be wrong.
 *   'vision' -- the page image went to the model; there is no local text at all.
 *
 * This matters to the promise the product makes. A verified citation means "this
 * string appears in the text we read", and when that text came from OCR the string
 * can be a faithful match to a misread date. The reviewer is entitled to see which
 * of the three she is looking at, so it is stored, not inferred.
 */
export type TextSource = 'pdf' | 'ocr' | 'vision';

/**
 * The three v2 columns on documents, as one shape.
 *
 * Declared here rather than in db/types.ts because that file is a frozen contract
 * in this pass. `DocumentSummaryFull` and `DocumentDetailFull` are strict supersets
 * of the shapes in types.ts, so every existing caller keeps compiling.
 */
export interface DocumentReadMeta {
  textSource: TextSource | null;
  /** 0..1. Only meaningful when textSource is 'ocr'; null otherwise. */
  ocrConfidence: number | null;
  /** How many pages of text reached the model. Null until something has read it. */
  pagesRead: number | null;
  /** WHICH pages, e.g. '1-28,49-60'. The count cannot express a head+tail read. */
  pagesReadRanges: string | null;
  /** 0..1. The OCR score that was rejected in favour of vision, when that happened. */
  rejectedOcrConfidence: number | null;
}

export type DocumentSummaryFull = DocumentSummary & DocumentReadMeta;
export type DocumentDetailFull = DocumentDetail & DocumentReadMeta;
/** Everything DocumentPatch accepts, plus the three read-provenance columns. */
export type DocumentPatchFull = DocumentPatch & Partial<DocumentReadMeta>;

function readMeta(r: Row): DocumentReadMeta {
  return {
    textSource: keyOf(TEXT_SOURCE_SET, r['text_source']),
    ocrConfidence: num(r['ocr_confidence']),
    pagesRead: num(r['pages_read']),
    pagesReadRanges: str(r['pages_read_ranges']),
    rejectedOcrConfidence: num(r['rejected_ocr_confidence']),
  };
}

/* ────────────────────────────── URL shapes ─────────────────────────────── */

/**
 * The routes that serve a document's bytes. Centralised so the shape is decided
 * once; the route handlers must match these paths.
 */
export function pdfUrl(documentId: string): string {
  return `/api/documents/${documentId}/pdf`;
}

export function thumbnailUrl(documentId: string): string {
  return `/api/documents/${documentId}/thumbnail`;
}

/* ═══════════════════════════════ Documents ══════════════════════════════ */

const DOC_SUMMARY_SQL = `
  SELECT d.id, d.filename, d.page_count, d.has_text_layer, d.status, d.doc_type,
         d.thumbnail_path, d.error_code, d.error_detail, d.created_at,
         d.text_source, d.ocr_confidence, d.pages_read, d.pages_read_ranges,
         d.rejected_ocr_confidence,
         (SELECT f.value FROM document_fields f
           WHERE f.document_id = d.id AND f.key = 'party_b') AS party_b,
         c.counterparty AS approved_counterparty
  FROM documents d
  LEFT JOIN contracts c ON c.document_id = d.id`;

const DOC_DETAIL_SQL = `
  SELECT d.*,
         (SELECT f.value FROM document_fields f
           WHERE f.document_id = d.id AND f.key = 'party_b') AS party_b,
         c.counterparty AS approved_counterparty
  FROM documents d
  LEFT JOIN contracts c ON c.document_id = d.id`;

/** Documents in the inbox, newest first. `statuses` omitted means everything. */
export function listDocuments(
  opts: { statuses?: DocumentStatus[]; limit?: number } = {},
): DocumentSummaryFull[] {
  const { statuses, limit } = opts;
  const where = statuses?.length ? ` WHERE d.status IN (${placeholders(statuses.length)})` : '';
  const sql = `${DOC_SUMMARY_SQL}${where} ORDER BY d.created_at DESC${limit ? ' LIMIT ?' : ''}`;
  const params: (string | number)[] = [...(statuses ?? [])];
  if (limit) params.push(limit);

  const rows = query(sql, params);
  const counts = fieldCounts(rows.map((r) => reqStr(r['id'], 'documents.id')));
  return rows.map((r) => toDocumentSummary(r, counts));
}

/** The Inbox: everything not yet resolved into a contract. */
export function listInboxDocuments(): DocumentSummaryFull[] {
  return listDocuments({
    statuses: ['queued', 'hashing', 'reading', 'extracting', 'ready', 'needs_attention', 'failed'],
  });
}

export function getDocument(id: string): DocumentDetailFull | null {
  const row = queryOne(`${DOC_DETAIL_SQL} WHERE d.id = ?`, [id]);
  if (!row) return null;
  return toDocumentDetail(row, fieldCounts([id]));
}

export function getDocumentByHash(fileHash: string): DocumentDetailFull | null {
  const row = queryOne(`${DOC_DETAIL_SQL} WHERE d.file_hash = ?`, [fileHash]);
  if (!row) return null;
  const id = reqStr(row['id'], 'documents.id');
  return toDocumentDetail(row, fieldCounts([id]));
}

/**
 * Register a dropped or discovered file.
 *
 * Identity is the SHA-256, so re-dropping a PDF returns the existing record with
 * `duplicate: true` instead of creating a second row -- essential when the watch
 * folder is a shared drive that people re-sync.
 */
export function createDocument(input: NewDocument): { id: string; duplicate: boolean } {
  return tx(() => {
    const existing = queryOne('SELECT id FROM documents WHERE file_hash = ?', [input.fileHash]);
    if (existing) return { id: reqStr(existing['id'], 'documents.id'), duplicate: true };

    const id = input.id ?? newDocumentId();
    const at = nowIso();
    run(
      `INSERT INTO documents
         (id, file_hash, filename, archive_path, origin_path, byte_size, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.fileHash,
        input.filename,
        input.archivePath ?? null,
        input.originPath ?? null,
        input.byteSize ?? 0,
        input.status ?? 'queued',
        at,
        at,
      ],
    );
    return { id, duplicate: false };
  });
}

export function setDocumentStatus(id: string, status: DocumentStatus): void {
  updateDocument(id, { status });
}

/** Clear a previous failure. Called when a retry starts, so the card stops lying. */
export function clearDocumentError(id: string): void {
  updateDocument(id, { errorCode: null, errorDetail: null });
}

/** What the ingest step learns about the file itself, once the bytes are on disk. */
export function setDocumentFileMeta(id: string, meta: DocumentFileMeta): void {
  updateDocument(id, meta);
}

/** Move a document to `failed` with a remedy the Inbox card can render. */
export function failDocument(id: string, code: EngineErrorCode, detail?: string | null): void {
  run(
    `UPDATE documents SET status = 'failed', error_code = ?, error_detail = ?, updated_at = ?
     WHERE id = ?`,
    [code, redact(detail) ?? null, nowIso(), id],
  );
}

/** Provenance of one extraction run, written as a unit with an audit entry. */
export function setDocumentExtraction(id: string, meta: DocumentExtractionMeta): void {
  tx(() => {
    const at = nowIso();
    run(
      `UPDATE documents SET
         provider = ?, model = ?, tier = ?, prompt_version = ?, repair_attempts = ?,
         input_tokens = ?, output_tokens = ?, cost_usd = ?, duration_ms = ?,
         raw_prompt = ?, raw_response = ?, doc_type = coalesce(?, doc_type),
         attempts = attempts + 1, extracted_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        meta.provider,
        meta.model,
        meta.tier,
        meta.promptVersion,
        meta.repairAttempts,
        meta.inputTokens,
        meta.outputTokens,
        meta.costUsd,
        meta.durationMs,
        meta.rawPrompt,
        meta.rawResponse,
        meta.docType,
        at,
        at,
        id,
      ],
    );
    insertAudit({
      documentId: id,
      action: 'extracted',
      detail: `${meta.provider} ${meta.model} prompt ${meta.promptVersion}`,
      at,
    });
  });
}

export function setDocumentType(id: string, type: DocType | null): void {
  run('UPDATE documents SET doc_type = ?, updated_at = ? WHERE id = ?', [type, nowIso(), id]);
}

/**
 * Hard-delete a document and its evidence. Refused by the schema once a contract
 * points at it -- unapprove first. Cache and thumbnails are not our problem here.
 */
export function deleteDocument(id: string): void {
  run('DELETE FROM documents WHERE id = ?', [id]);
}

export function documentCountsByStatus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of query('SELECT status, count(*) AS n FROM documents GROUP BY status', [])) {
    const s = str(r['status']);
    if (s) out[s] = int(r['n']);
  }
  return out;
}

function toDocumentSummary(r: Row, counts: Map<string, MethodCounts>): DocumentSummaryFull {
  const id = reqStr(r['id'], 'documents.id');
  const code = str(r['error_code']);
  const thumb = str(r['thumbnail_path']);
  return {
    ...readMeta(r),
    id,
    filename: reqStr(r['filename'], 'documents.filename'),
    pageCount: int(r['page_count']),
    hasTextLayer: flag(r['has_text_layer']),
    status: docStatus(r['status']),
    docType: docType(r['doc_type']),
    thumbnailUrl: thumb ? thumbnailUrl(id) : null,
    counterparty: str(r['approved_counterparty']) ?? nullIfBlank(str(r['party_b'])),
    counts: countsFor(counts.get(id)),
    errorCode: code,
    // The headline comes from the catalog, never from the stored detail: the
    // detail is technical and may name a path.
    errorMessage: code ? errorMessageFor(code) : null,
    createdAt: reqStr(r['created_at'], 'documents.created_at'),
  };
}

function toDocumentDetail(r: Row, counts: Map<string, MethodCounts>): DocumentDetailFull {
  const summary = toDocumentSummary(r, counts);
  return {
    ...summary,
    byteSize: int(r['byte_size']),
    archivePath: str(r['archive_path']),
    originPath: str(r['origin_path']),
    pdfUrl: pdfUrl(summary.id),
    provider: keyOf(PROVIDER_SET, r['provider']),
    model: str(r['model']),
    tier: keyOf(TIER_SET, r['tier']),
    promptVersion: str(r['prompt_version']),
    repairAttempts: int(r['repair_attempts']),
    inputTokens: num(r['input_tokens']),
    outputTokens: num(r['output_tokens']),
    costUsd: num(r['cost_usd']),
    durationMs: num(r['duration_ms']),
    rawPrompt: str(r['raw_prompt']),
    rawResponse: str(r['raw_response']),
    attempts: int(r['attempts']),
    extractedAt: str(r['extracted_at']),
  };
}

/**
 * The codes that can legitimately sit in documents.error_code, as a runtime set.
 * Keyed by EngineErrorCode so the compiler refuses to build if errors.ts grows a
 * code this file has not been taught about -- which is the point: an unknown code
 * would otherwise render as a blank message in the Inbox.
 */
const ERROR_CODE_SET: Record<EngineErrorCode, true> = {
  // A refused request, never the outcome of a read -- so it can reach a 409 body but
  // must never be written to documents.error_code. Listed to satisfy exhaustiveness.
  CONFLICT: true,
  CLI_NOT_FOUND: true,
  CLI_NOT_AUTHENTICATED: true,
  CLI_VERSION_UNSUPPORTED: true,
  CLI_TIMEOUT: true,
  CLI_CRASHED: true,
  CLI_BAD_OUTPUT: true,
  CLI_PERMISSION_PROMPT: true,
  CLI_USAGE_LIMIT: true,
  CLI_PLAN_UNSUPPORTED: true,
  CLI_CONCURRENCY: true,
  API_KEY_MISSING: true,
  API_KEY_INVALID: true,
  API_FORBIDDEN: true,
  API_RATE_LIMITED: true,
  API_CREDIT_EXHAUSTED: true,
  API_OVERLOADED: true,
  API_SERVER_ERROR: true,
  API_TIMEOUT: true,
  MODEL_UNAVAILABLE: true,
  MODEL_REFUSED: true,
  OUTPUT_TRUNCATED: true,
  NETWORK_UNAVAILABLE: true,
  PROXY_BLOCKED: true,
  PDF_UNREADABLE: true,
  PDF_ENCRYPTED: true,
  PDF_NO_TEXT_LAYER: true,
  PDF_TOO_LARGE: true,
  PDF_EMPTY: true,
  VISION_UNSUPPORTED: true,
  SCHEMA_INVALID: true,
  ALL_CITATIONS_FAILED: true,
  DB_LOCKED: true,
  DB_CORRUPT: true,
  DISK_FULL: true,
  FOLDER_MISSING: true,
  FOLDER_UNREADABLE: true,
  KEYCHAIN_UNAVAILABLE: true,
  UNKNOWN: true,
};

/** Plain-English headline for a stored code. Never the stored technical detail. */
function errorMessageFor(code: string): string {
  return errorInfo(keyOf(ERROR_CODE_SET, code) ?? 'UNKNOWN').message;
}

/* ═════════════════════════════ Field evidence ═══════════════════════════ */

interface MethodCounts {
  high: number;
  medium: number;
  none: number;
  rows: number;
}

function fieldCounts(ids: string[]): Map<string, MethodCounts> {
  const out = new Map<string, MethodCounts>();
  if (!ids.length) return out;
  const rows = query(
    `SELECT document_id, method, count(*) AS n FROM document_fields
      WHERE document_id IN (${placeholders(ids.length)}) GROUP BY document_id, method`,
    ids,
  );
  for (const r of rows) {
    const id = str(r['document_id']);
    if (!id) continue;
    const acc = out.get(id) ?? { high: 0, medium: 0, none: 0, rows: 0 };
    const n = int(r['n']);
    acc[confidenceOf(method(r['method']))] += n;
    acc.rows += n;
    out.set(id, acc);
  }
  return out;
}

/** A field with no row at all is a gap, so it counts as `none`. */
function countsFor(c: MethodCounts | undefined): { high: number; medium: number; none: number } {
  const seen = c?.rows ?? 0;
  const missing = Math.max(0, FIELD_KEYS.length - seen);
  return { high: c?.high ?? 0, medium: c?.medium ?? 0, none: (c?.none ?? 0) + missing };
}

/** All 16 fields for the Review pane, in tracker order, gaps included. */
export function getDocumentFields(documentId: string): FieldRecord[] {
  const rows = query('SELECT * FROM document_fields WHERE document_id = ?', [documentId]);
  return joinFieldDefs(rows);
}

export function getContractFields(contractId: string): FieldRecord[] {
  const rows = query('SELECT * FROM contract_fields WHERE contract_id = ?', [contractId]);
  return joinFieldDefs(rows);
}

function joinFieldDefs(rows: Row[]): FieldRecord[] {
  const byKey = new Map<FieldKey, Row>();
  for (const r of rows) {
    const k = fieldKey(r['key']);
    if (k) byKey.set(k, r);
  }
  return FIELD_KEYS.map((key) => {
    const def = FIELDS[key];
    const r = byKey.get(key);
    const m = r ? method(r['method']) : 'missing';
    return {
      key,
      label: def.label,
      group: def.group,
      type: def.type,
      value: r ? nullIfBlank(str(r['value'])) : null,
      quote: r ? str(r['quote']) : null,
      page: r ? num(r['page']) : null,
      method: m,
      confidence: confidenceOf(m),
      citationVerified: r ? flagOrNull(r['citation_verified']) : null,
      requiredToApprove: def.requiredToApprove,
      readOnly: def.source === 'computed',
    };
  });
}

/** Write the extraction result. One transaction so a half-written pane is impossible. */
export function putDocumentFields(documentId: string, values: FieldValueInput[]): void {
  tx(() => {
    for (const v of values) putOneDocumentField(documentId, v);
    recomputeDocumentDerived(documentId);
  });
}

function putOneDocumentField(documentId: string, v: FieldValueInput): void {
  run(
    `INSERT INTO document_fields (document_id, key, value, quote, page, method, citation_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id, key) DO UPDATE SET
       value = excluded.value, quote = excluded.quote, page = excluded.page,
       method = excluded.method, citation_verified = excluded.citation_verified`,
    [
      documentId,
      v.key,
      nullIfBlank(v.value),
      v.quote ?? null,
      v.page ?? null,
      v.method,
      bit(v.citationVerified ?? null),
    ],
  );
}

/**
 * Recompute the computed fields from their inputs. Called after extraction and
 * after any edit, so the Termination row in Review is never one edit behind.
 */
export function recomputeDocumentDerived(documentId: string): void {
  const rows = query('SELECT key, value, method FROM document_fields WHERE document_id = ?', [
    documentId,
  ]);
  const values = new Map<FieldKey, string | null>();
  let overridden = false;
  for (const r of rows) {
    const k = fieldKey(r['key']);
    if (!k) continue;
    values.set(k, nullIfBlank(str(r['value'])));
    // A human who typed a termination date owns it; do not compute over the top.
    if (k === 'termination_date' && method(r['method']) === 'manual') overridden = true;
  }
  if (overridden) return;

  const end = computeTermination(values.get('effective_date'), values.get('term'));
  putOneDocumentField(documentId, {
    key: 'termination_date',
    value: end,
    method: end ? 'computed' : 'missing',
    quote: null,
    page: null,
    citationVerified: null,
  });
}

function computeTermination(
  effective: string | null | undefined,
  term: string | null | undefined,
): string | null {
  const iso = parseDateIso(effective ?? null);
  if (!iso) return null;
  return addDuration(iso, parseDuration(term ?? null));
}

/**
 * A human edit in Review. `method` defaults to 'manual'; pass 'na' for the
 * "Not in document" button, which is an acknowledged gap rather than a value.
 */
export function editDocumentField(
  documentId: string,
  key: FieldKey,
  value: string | null,
  opts: { method?: ExtractionMethod; actor?: string } = {},
): FieldRecord[] {
  return tx(() => {
    const before = queryOne(
      'SELECT value FROM document_fields WHERE document_id = ? AND key = ?',
      [documentId, key],
    );
    const oldValue = before ? str(before['value']) : null;
    const m: ExtractionMethod = opts.method ?? (value == null ? 'na' : 'manual');

    putOneDocumentField(documentId, {
      key,
      value,
      method: m,
      // A hand-typed value has no quote in the document; keeping the old one
      // would attach the wrong evidence to the new value.
      quote: null,
      page: null,
      citationVerified: null,
    });
    recomputeDocumentDerived(documentId);
    insertAudit({
      documentId,
      action: 'edited',
      fieldKey: key,
      oldValue,
      newValue: value,
      actor: opts.actor,
    });
    run('UPDATE documents SET updated_at = ? WHERE id = ?', [nowIso(), documentId]);
    return getDocumentFields(documentId);
  });
}

/**
 * Required fields that are still neither filled nor explicitly marked N/A.
 * Approve is blocked while this is non-empty (DESIGN.md section 18).
 */
export function approvalBlockers(documentId: string): FieldKey[] {
  return getDocumentFields(documentId)
    .filter((f) => f.requiredToApprove && f.value == null && f.method !== 'na')
    .map((f) => f.key);
}

/* ══════════════════════════════ Approve ═════════════════════════════════ */

/**
 * The only definition of "this document may be approved".
 *
 * It lives here, next to the transaction that enforces it, because the eligibility
 * rule used to exist only in the GET half of /api/documents -- which meant the
 * server was trusting the client's gate. Rejecting a document flips its status and
 * leaves document_fields untouched, so a rejected document has zero blockers and
 * sailed straight through both approve routes.
 *
 * Anything importing this must not re-list the statuses; import the constant.
 */
export const APPROVABLE_STATUSES: readonly DocumentStatus[] = ['ready', 'needs_attention'];

export function isApprovable(status: DocumentStatus): boolean {
  return APPROVABLE_STATUSES.includes(status);
}

/**
 * One sentence per refused status, shared by both approve routes so the single
 * document and the bulk loop cannot drift into saying different things about the
 * same document. Prose in the data layer is a compromise: these two routes are the
 * only callers and there is no other module both of them own.
 */
export function approvalStatusMessage(status: DocumentStatus): string {
  switch (status) {
    case 'rejected':
      return 'That document was set aside. Reopen it and review it before approving.';
    case 'approved':
      return 'That document has already been approved.';
    case 'duplicate':
      return 'That document is a duplicate of one already in the tracker.';
    case 'failed':
      return 'That document could not be read, so there is nothing to approve yet.';
    case 'queued':
    case 'hashing':
    case 'reading':
    case 'extracting':
      return 'That document is still being read. Approve it once the read finishes.';
    case 'ready':
    case 'needs_attention':
      return 'That document is ready to approve.';
  }
}

/**
 * The status standing between this document and approval, or null if none is.
 *
 * Routes call this to build a 409 that names the actual status. It is not the
 * enforcement -- `approveDocument` refuses on its own -- it is how the refusal
 * gets a sentence a human can act on.
 */
export function approvalStatusBlocker(documentId: string): DocumentStatus | null {
  const doc = getDocument(documentId);
  if (!doc) return null;
  // An already-approved document with a live record is the idempotent re-approve
  // the bulk loop depends on, not a refusal.
  if (liveContractIdForDocument(documentId)) return null;
  return isApprovable(doc.status) ? null : doc.status;
}

/** The id of this document's record in the repository, or null if it has none live. */
export function liveContractIdForDocument(documentId: string): string | null {
  const row = queryOne(
    'SELECT id FROM contracts WHERE document_id = ? AND archived_at IS NULL',
    [documentId],
  );
  return row ? reqStr(row['id'], 'contracts.id') : null;
}

/**
 * The approve transaction. Contract + parties + frozen evidence + audit + the
 * document's new status, all or nothing.
 *
 * Returns the new contract id. Callers should render `approvalBlockers()` first;
 * the checks here are invariant guards, not the user-facing validation -- but they
 * are guards no caller can skip, which is the point.
 */
export function approveDocument(documentId: string, opts: { actor?: string } = {}): string {
  return tx(() => {
    const doc = getDocument(documentId);
    if (!doc) throw new EngineError('UNKNOWN', { detail: `no such document ${documentId}` });

    // Idempotent only against a LIVE record. Matching an archived one reported
    // success and handed back a contract id that no read in the app can see, so
    // the approve appeared to work and the record stayed invisible.
    const live = liveContractIdForDocument(documentId);
    if (live) return live;

    // The status gate, before the field gate: a rejected or failed document is not
    // "missing a field", it is not up for approval at all.
    if (!isApprovable(doc.status)) {
      throw new EngineError('UNKNOWN', {
        detail: `approve refused, document status is ${doc.status}`,
      });
    }

    const blockers = approvalBlockers(documentId);
    if (blockers.length) {
      throw new EngineError('UNKNOWN', {
        detail: `approve blocked, unresolved required fields: ${blockers.join(', ')}`,
      });
    }

    const fields = getDocumentFields(documentId);
    const value = (k: FieldKey): string | null => fields.find((f) => f.key === k)?.value ?? null;

    const effective = parseDateIso(value('effective_date'));
    const termText = value('term');
    const term = parseDuration(termText);
    const confText = value('confidentiality_term');
    const conf = parseDuration(confText);

    const manualTermination = fields.find(
      (f) => f.key === 'termination_date' && f.method === 'manual',
    );
    // resolveEndDate, not bare addDuration: it also reads a term stated as an end date,
    // refuses to derive anything from an ambiguous effective date, and returns null
    // rather than the effective date when the term does not parse.
    const quoteOf = (k: FieldKey): string | null =>
      fields.find((f) => f.key === k)?.quote ?? null;
    const effectiveQuote = quoteOf('effective_date');
    const termination = manualTermination
      ? parseDateIso(manualTermination.value)
      : resolveEndDate({ effective, term: termText, effectiveQuote }).iso;

    // The confidentiality clock usually starts at termination, not at signing.
    const confAnchor = clockAnchor(quoteOf('confidentiality_term'));
    const confBase = confAnchor === 'termination' ? termination : effective;
    const confEnd = confText
      ? resolveEndDate({
          effective: confBase,
          term: confText,
          effectiveQuote: confAnchor === 'termination' ? null : effectiveQuote,
        }).iso
      : null;

    const contractId = newContractId();
    const at = nowIso();
    const parties = buildParties(fields);
    const counterparty = parties.find((p) => !p.isIbc && p.role === 'b')?.name
      ?? parties.find((p) => !p.isIbc)?.name
      ?? null;

    run(
      `INSERT INTO contracts (
         id, document_id, doc_type, contract_name, effective_date, term, term_days,
         termination_date, termination_override, confidentiality_term, confidentiality_days,
         confidentiality_end, ibc_form, notice_email, notice_address, governing_law,
         counterparty, approved_by, approved_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        contractId,
        documentId,
        doc.docType ?? 'other',
        value('contract_name'),
        effective,
        termText,
        term?.days ?? null,
        termination,
        manualTermination ? 1 : 0,
        confText,
        conf?.days ?? null,
        confEnd,
        value('ibc_form'),
        value('notice_email'),
        value('notice_address'),
        value('governing_law'),
        counterparty,
        opts.actor ?? 'local',
        at,
        at,
        at,
      ],
    );

    for (const p of parties) {
      run(
        `INSERT INTO parties (id, contract_id, role, name, normalised, signer, address, is_ibc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newPartyId(), contractId, p.role, p.name, normalizeParty(p.name), p.signer, p.address, bit(p.isIbc) ?? 0],
      );
    }

    // Freeze the evidence. The document's own rows stay put so the Review pane
    // still works, but from here the contract carries its own copy.
    for (const f of fields) {
      run(
        `INSERT INTO contract_fields (contract_id, key, value, quote, page, method, citation_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [contractId, f.key, f.value, f.quote, f.page, f.method, bit(f.citationVerified)],
      );
    }

    run("UPDATE documents SET status = 'approved', updated_at = ? WHERE id = ?", [at, documentId]);
    // A document may carry archived records from earlier approvals. Say so in the
    // trail, so a second record against the same PDF is never a surprise later.
    const removed = int(
      queryOne(
        'SELECT count(*) AS n FROM contracts WHERE document_id = ? AND archived_at IS NOT NULL',
        [documentId],
      )?.['n'],
    );
    const subject = counterparty ? `${counterparty} (${doc.docType ?? 'other'})` : null;
    insertAudit({
      contractId,
      documentId,
      action: 'approved',
      actor: opts.actor,
      detail: removed > 0 ? `${subject ?? 'record'}; ${removed} removed record(s) exist` : subject,
      at,
    });

    return contractId;
  });
}

interface PartyInput {
  role: PartyRole;
  name: string;
  signer: string | null;
  address: string | null;
  isIbc: boolean;
}

function buildParties(fields: FieldRecord[]): PartyInput[] {
  const value = (k: FieldKey): string | null => fields.find((f) => f.key === k)?.value ?? null;
  const spec: { role: PartyRole; name: FieldKey; signer?: FieldKey; address?: FieldKey }[] = [
    { role: 'a', name: 'party_a', signer: 'party_a_signer', address: 'party_a_address' },
    { role: 'b', name: 'party_b', signer: 'party_b_signer', address: 'party_b_address' },
    { role: 'c', name: 'party_c' },
  ];
  const out: PartyInput[] = [];
  for (const s of spec) {
    const name = value(s.name);
    if (!name) continue;
    out.push({
      role: s.role,
      name,
      signer: s.signer ? value(s.signer) : null,
      address: s.address ? value(s.address) : null,
      isIbc: isIbcParty(name),
    });
  }
  return out;
}

/** Reject a document. A state, not a delete -- the file stays in the archive. */
export function rejectDocument(documentId: string, opts: { actor?: string; reason?: string } = {}): void {
  tx(() => {
    run("UPDATE documents SET status = 'rejected', updated_at = ? WHERE id = ?", [
      nowIso(),
      documentId,
    ]);
    insertAudit({
      documentId,
      action: 'rejected',
      actor: opts.actor,
      detail: opts.reason ?? null,
    });
  });
}

/**
 * Undo an approve. Drops the contract (parties and frozen evidence cascade) and
 * puts the document back in review. The document's own field rows were never
 * touched, so Review comes back exactly as it was -- and since post-approval edits
 * are now written back to document_fields too, "as it was" includes them.
 *
 * The audit trail survives the DELETE. audit.contract_id is ON DELETE SET NULL as
 * of schema v2, and every audit row carries document_id, so approved/edited/
 * exported rows stay in the table and reappear in the timeline of whatever record
 * this document produces next. Under v1 this call destroyed them.
 */
export function unapproveContract(contractId: string, opts: { actor?: string } = {}): string {
  return tx(() => {
    const row = queryOne('SELECT document_id FROM contracts WHERE id = ?', [contractId]);
    if (!row) throw new EngineError('UNKNOWN', { detail: `no such contract ${contractId}` });
    const documentId = reqStr(row['document_id'], 'contracts.document_id');

    run('DELETE FROM contracts WHERE id = ?', [contractId]);
    run("UPDATE documents SET status = 'ready', updated_at = ? WHERE id = ?", [nowIso(), documentId]);
    // documentId only: contract_id would be nulled by the delete a moment later.
    insertAudit({ documentId, action: 'unapproved', actor: opts.actor });
    return documentId;
  });
}

/* ══════════════════════════════ Contracts ═══════════════════════════════ */

const CONTRACT_SELECT = `
  SELECT c.*, d.filename AS filename
  FROM contracts c
  JOIN documents d ON d.id = c.document_id`;

/** The repository. Archived rows are invisible to every read that uses this. */
const CONTRACT_SQL = `${CONTRACT_SELECT} WHERE c.archived_at IS NULL`;

/** The Removed view. The exact complement, so no record can fall between them. */
const ARCHIVED_CONTRACT_SQL = `${CONTRACT_SELECT} WHERE c.archived_at IS NOT NULL`;

/** A removed record. `archivedAt` is what the Removed view sorts and dates by. */
export interface ArchivedContractSummary extends ContractSummary {
  archivedAt: string;
}

export interface ArchivedContractDetail extends ContractDetail {
  archivedAt: string;
}

export interface ArchivedContractPage {
  rows: ArchivedContractSummary[];
  total: number;
}

/**
 * The repository table.
 *
 * Status filtering and status sorting happen in TypeScript, not SQL, because
 * status is computed. Doing it in SQL would mean a second definition of
 * "expiring" living in a WHERE clause, free to disagree with status.ts. The
 * corpus is hundreds of rows, so the whole set is mapped and then paged.
 */
export function listContracts(q: ContractQuery = {}): ContractPage {
  return pageContracts(CONTRACT_SQL, q, toContractSummary);
}

/**
 * The Removed view: everything archive took out of the repository.
 *
 * Archiving used to be reachable back only through `?undo=1` on a toast that
 * dismisses itself, after which the record existed solely in SQL. This is the
 * read that makes "Remove" a soft delete rather than a hidden one.
 */
export function listArchivedContracts(q: ContractQuery = {}): ArchivedContractPage {
  return pageContracts(ARCHIVED_CONTRACT_SQL, q, toArchivedContractSummary);
}

/**
 * Shared body of both lists. `base` already carries its own archived predicate and
 * is a module constant, never caller text, so the extra clauses append with AND.
 */
function pageContracts<T extends ContractSummary>(
  base: string,
  q: ContractQuery,
  map: (r: Row, today: string) => T,
): { rows: T[]; total: number } {
  const today = q.today ?? todayIso();
  const search = q.search?.trim() ?? '';

  const found = search ? searchContractIds(search) : null;
  if (found && found.ids.length === 0) return { rows: [], total: 0 };

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (q.docType && q.docType !== 'all') {
    clauses.push('c.doc_type = ?');
    params.push(q.docType);
  }
  if (found) {
    clauses.push(`c.id IN (${placeholders(found.ids.length)})`);
    params.push(...found.ids);
  }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';

  let rows = query(`${base}${where}`, params).map((r) => map(r, today));

  const filter = q.filter ?? 'all';
  if (filter !== 'all') rows = rows.filter((r) => recordStatus(r) === filter);

  const total = rows.length;
  sortContracts(rows, q.sort ?? (found ? 'relevance' : 'approvedAt'), q.dir, found?.scores);

  const offset = Math.max(0, q.offset ?? 0);
  const limit = q.limit ?? total;
  return { rows: rows.slice(offset, offset + limit), total };
}

/**
 * How much life a clock has left, for picking between the two of them.
 *
 * 'unknown' outranks 'expired' and nothing else. A confidentiality obligation
 * whose end date we could not compute -- a perpetual clause is the ordinary case
 * -- is not evidence that the obligation has ended, so it must never let a record
 * be filed as Expired. It is not evidence that it is running either, which is why
 * it does not outrank a live clock.
 */
const CLOCK_LIFE: Record<AgreementStatus, number> = {
  active: 3,
  expiring: 2,
  unknown: 1,
  expired: 0,
};

/**
 * The status of the clock that binds longest -- THE answer to "is this still in
 * effect?", which is the question this product exists to answer.
 *
 * The repository filtered on `agreementStatus` alone. Measured on a real corpus,
 * that filed seven of thirty-two records under Expired while their duty of
 * confidence was still running: the agreement had ended, the obligation had not,
 * and the two clocks are the whole insight. ExpiringList.collectExpiring() has
 * always read both; this is the same rule for the main list, so a record cannot
 * be in the Expiring view and outside the Expiring filter at the same time.
 */
function recordStatus(row: ContractSummary): AgreementStatus {
  return CLOCK_LIFE[row.confidentialityStatus] > CLOCK_LIFE[row.agreementStatus]
    ? row.confidentialityStatus
    : row.agreementStatus;
}

export function getContract(id: string): ContractDetail | null {
  const row = queryOne(`${CONTRACT_SQL} AND c.id = ?`, [id]);
  return row ? toContractDetail(row, todayIso()) : null;
}

/** The read the Removed view's detail pane and the restore route need. */
export function getArchivedContract(id: string): ArchivedContractDetail | null {
  const row = queryOne(`${ARCHIVED_CONTRACT_SQL} AND c.id = ?`, [id]);
  if (!row) return null;
  return {
    ...toContractDetail(row, todayIso()),
    archivedAt: reqStr(row['archived_at'], 'contracts.archived_at'),
  };
}

export function getContractByDocument(documentId: string): ContractDetail | null {
  const row = queryOne(`${CONTRACT_SQL} AND c.document_id = ?`, [documentId]);
  return row ? toContractDetail(row, todayIso()) : null;
}

function toContractSummary(r: Row, today: string): ContractSummary {
  const effective = str(r['effective_date']);
  const termination = str(r['termination_date']);
  const confEnd = str(r['confidentiality_end']);
  const agreement = agreementStatus(effective, termination, today);
  const conf = confidentialityStatus(effective, confEnd, today);
  return {
    id: reqStr(r['id'], 'contracts.id'),
    documentId: reqStr(r['document_id'], 'contracts.document_id'),
    counterparty: str(r['counterparty']),
    docType: reqDocType(r['doc_type']),
    contractName: str(r['contract_name']),
    effectiveDate: effective,
    terminationDate: termination,
    termDays: num(r['term_days']),
    agreementStatus: agreement.status,
    daysRemaining: agreement.daysRemaining,
    confidentialityEnd: confEnd,
    confidentialityStatus: conf.status,
    confidentialityDaysRemaining: conf.daysRemaining,
    governingLaw: str(r['governing_law']),
    approvedAt: reqStr(r['approved_at'], 'contracts.approved_at'),
  };
}

function toArchivedContractSummary(r: Row, today: string): ArchivedContractSummary {
  return {
    ...toContractSummary(r, today),
    archivedAt: reqStr(r['archived_at'], 'contracts.archived_at'),
  };
}

function toContractDetail(r: Row, today: string): ContractDetail {
  const summary = toContractSummary(r, today);
  return {
    ...summary,
    parties: listParties(summary.id),
    noticeEmail: str(r['notice_email']),
    noticeAddress: str(r['notice_address']),
    ibcForm: str(r['ibc_form']),
    term: str(r['term']),
    confidentialityTerm: str(r['confidentiality_term']),
    terminationOverride: flag(r['termination_override']),
    filename: reqStr(r['filename'], 'documents.filename'),
    pdfUrl: pdfUrl(summary.documentId),
    editedAt: str(r['edited_at']),
  };
}

function listParties(contractId: string): ContractDetail['parties'] {
  return query(
    `SELECT role, name, signer, address, is_ibc FROM parties
      WHERE contract_id = ? ORDER BY role`,
    [contractId],
  ).map((p) => ({
    role: role(p['role']),
    name: reqStr(p['name'], 'parties.name'),
    signer: str(p['signer']),
    address: str(p['address']),
    isIbc: flag(p['is_ibc']),
  }));
}

/* ───────────────────────────── Sorting ─────────────────────────────────── */

function sortContracts(
  rows: ContractSummary[],
  key: ContractSortKey,
  dir: 'asc' | 'desc' | undefined,
  scores: Map<string, number> | undefined,
): void {
  // Relevance and recency read descending by default; everything else ascending.
  const defaultDesc = key === 'relevance' || key === 'approvedAt';
  const sign = (dir ?? (defaultDesc ? 'desc' : 'asc')) === 'desc' ? -1 : 1;

  rows.sort((a, b) => {
    const d = compareBy(key, a, b, scores);
    if (d !== 0) return d * sign;
    // Stable tiebreak so pagination never repeats or drops a row.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function compareBy(
  key: ContractSortKey,
  a: ContractSummary,
  b: ContractSummary,
  scores: Map<string, number> | undefined,
): number {
  switch (key) {
    case 'relevance':
      return cmpNum(scores?.get(a.id) ?? 0, scores?.get(b.id) ?? 0);
    case 'counterparty':
      return cmpStr(a.counterparty, b.counterparty);
    case 'docType':
      return cmpStr(a.docType, b.docType);
    case 'contractName':
      return cmpStr(a.contractName, b.contractName);
    case 'effectiveDate':
      return cmpStr(a.effectiveDate, b.effectiveDate);
    case 'terminationDate':
      return cmpStr(a.terminationDate, b.terminationDate);
    case 'confidentialityEnd':
      return cmpStr(a.confidentialityEnd, b.confidentialityEnd);
    case 'governingLaw':
      return cmpStr(a.governingLaw, b.governingLaw);
    case 'approvedAt':
      return cmpStr(a.approvedAt, b.approvedAt);
    case 'status':
      return cmpNum(STATUS_ORDER[b.agreementStatus], STATUS_ORDER[a.agreementStatus]);
  }
}

/** Nulls sort last in ascending order -- an empty cell is never the top result. */
function cmpStr(a: string | null, b: string | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ───────────────────────────── Searching ───────────────────────────────── */

/** Below this, a fuzzy hit is noise. Tuned so "octilion" finds Octillion. */
const FUZZY_THRESHOLD = 0.68;

/**
 * Three passes, cheapest first.
 *
 *  1. FTS5 prefix match -- the fast path, handles "ntri" and "delaware".
 *  2. LIKE scan -- for one- and two-character queries FTS cannot tokenise, and
 *     for substrings that are not at a token boundary.
 *  3. Fuzzy scan -- for typos. "octilion" tokenises cleanly and matches nothing,
 *     so only edit distance can save it.
 */
function searchContractIds(search: string): { ids: string[]; scores: Map<string, number> } {
  const scores = new Map<string, number>();

  if (search.length >= 3) {
    const expr = ftsExpression(search);
    if (expr) {
      const rows = query(
        `SELECT contract_id, rank FROM contract_search WHERE contract_search MATCH ? ORDER BY rank`,
        [expr],
      );
      for (const r of rows) {
        const id = str(r['contract_id']);
        // bm25 rank is negative and better when more negative; map into 0..1 so
        // it can sit in the same field as a fuzzy score.
        if (id) scores.set(id, 1 / (1 + Math.abs(num(r['rank']) ?? 0)));
      }
      if (scores.size) return { ids: [...scores.keys()], scores };
    }
  }

  const like = query(
    "SELECT contract_id FROM contract_search WHERE haystack LIKE ? ESCAPE '\\'",
    [`%${escapeLike(search)}%`],
  );
  for (const r of like) {
    const id = str(r['contract_id']);
    if (id) scores.set(id, 0.95);
  }
  if (scores.size) return { ids: [...scores.keys()], scores };

  for (const r of query('SELECT contract_id, haystack FROM contract_search', [])) {
    const id = str(r['contract_id']);
    const hay = str(r['haystack']);
    if (!id || !hay) continue;
    const score = fuzzyScore(search, hay);
    if (score >= FUZZY_THRESHOLD) scores.set(id, score);
  }
  return { ids: [...scores.keys()], scores };
}

/**
 * Build a safe FTS5 expression. Every token is quoted and given a prefix star,
 * so a stray `*`, `-` or `"` in the search box is data, not syntax.
 */
function ftsExpression(search: string): string | null {
  const tokens = search
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/* ────────────────────────── Post-approval edits ────────────────────────── */

const CONTRACT_COLUMNS: Partial<Record<FieldKey, string>> = {
  contract_name: 'contract_name',
  effective_date: 'effective_date',
  term: 'term',
  termination_date: 'termination_date',
  confidentiality_term: 'confidentiality_term',
  ibc_form: 'ibc_form',
  notice_email: 'notice_email',
  notice_address: 'notice_address',
  governing_law: 'governing_law',
};

const PARTY_FIELDS: Partial<Record<FieldKey, { role: PartyRole; column: 'name' | 'signer' | 'address' }>> = {
  party_a: { role: 'a', column: 'name' },
  party_a_signer: { role: 'a', column: 'signer' },
  party_a_address: { role: 'a', column: 'address' },
  party_b: { role: 'b', column: 'name' },
  party_b_signer: { role: 'b', column: 'signer' },
  party_b_address: { role: 'b', column: 'address' },
  party_c: { role: 'c', column: 'name' },
};

/**
 * Edit an approved record. Every change writes an audit row with field, old
 * value, new value and timestamp, flags the contract as edited, and recomputes
 * anything derived -- so fixing an effective date six months later moves the
 * termination date with it.
 *
 * The same value is written back to document_fields. That is not bookkeeping: the
 * document's evidence rows are what a later re-approve rebuilds the record from,
 * so without the write-back, unapprove -> Undo silently resurrected the pre-edit
 * extraction while the toast promised "their fields are exactly as you left them".
 */
export function editContractField(
  contractId: string,
  key: FieldKey,
  value: string | null,
  opts: { actor?: string } = {},
): ContractDetail {
  return tx(() => {
    const before = getContract(contractId);
    if (!before) throw new EngineError('UNKNOWN', { detail: `no such contract ${contractId}` });

    const clean = nullIfBlank(value);
    const oldValue = currentFieldValue(before, key);
    const at = nowIso();

    const partyField = PARTY_FIELDS[key];
    if (partyField) {
      writeParty(contractId, partyField.role, partyField.column, clean);
    } else {
      const column = CONTRACT_COLUMNS[key];
      if (!column) {
        throw new EngineError('UNKNOWN', { detail: `field ${key} is not editable on a contract` });
      }
      run(`UPDATE contracts SET ${column} = ? WHERE id = ?`, [clean, contractId]);
      if (key === 'termination_date') {
        run('UPDATE contracts SET termination_override = 1 WHERE id = ?', [contractId]);
      }
    }

    // Same convention as editDocumentField: a hand-typed value is 'manual', a
    // cleared one is 'na' (an acknowledged gap), and neither keeps the old quote --
    // the evidence belonged to the value that was there before.
    const editMethod: ExtractionMethod = clean == null ? 'na' : 'manual';

    run(
      `INSERT INTO contract_fields (contract_id, key, value, quote, page, method, citation_verified)
       VALUES (?, ?, ?, NULL, NULL, ?, NULL)
       ON CONFLICT(contract_id, key) DO UPDATE SET
         value = excluded.value, quote = NULL, page = NULL,
         method = excluded.method, citation_verified = NULL`,
      [contractId, key, clean, editMethod],
    );

    // The write-back. No second audit row: this is the same edit reaching its other
    // home, and the contract's audit row above already records it once.
    putOneDocumentField(before.documentId, {
      key,
      value: clean,
      method: editMethod,
      quote: null,
      page: null,
      citationVerified: null,
    });
    // Keeps the document's computed termination in step with an effective_date or
    // term edit. Returns early on its own if the document carries a manual
    // termination_date, which is exactly the override the contract just recorded.
    recomputeDocumentDerived(before.documentId);

    recomputeContractDerived(contractId);
    run('UPDATE contracts SET edited_at = ?, updated_at = ? WHERE id = ?', [at, at, contractId]);
    insertAudit({
      contractId,
      documentId: before.documentId,
      action: 'edited',
      fieldKey: key,
      oldValue,
      newValue: clean,
      actor: opts.actor,
      at,
    });

    const after = getContract(contractId);
    if (!after) throw new EngineError('DB_CORRUPT', { detail: 'contract vanished mid-edit' });
    return after;
  });
}

function currentFieldValue(c: ContractDetail, key: FieldKey): string | null {
  const partyField = PARTY_FIELDS[key];
  if (partyField) {
    const p = c.parties.find((x) => x.role === partyField.role);
    if (!p) return null;
    return partyField.column === 'name' ? p.name : partyField.column === 'signer' ? p.signer : p.address;
  }
  switch (key) {
    case 'contract_name':
      return c.contractName;
    case 'effective_date':
      return c.effectiveDate;
    case 'term':
      return c.term;
    case 'termination_date':
      return c.terminationDate;
    case 'confidentiality_term':
      return c.confidentialityTerm;
    case 'ibc_form':
      return c.ibcForm;
    case 'notice_email':
      return c.noticeEmail;
    case 'notice_address':
      return c.noticeAddress;
    case 'governing_law':
      return c.governingLaw;
    default:
      return null;
  }
}

function writeParty(
  contractId: string,
  partyRole: PartyRole,
  column: 'name' | 'signer' | 'address',
  value: string | null,
): void {
  const existing = queryOne('SELECT id, name FROM parties WHERE contract_id = ? AND role = ?', [
    contractId,
    partyRole,
  ]);

  if (!existing) {
    // Only a name can create a party; a signer with no party is not a thing.
    if (column !== 'name' || value == null) return;
    run(
      `INSERT INTO parties (id, contract_id, role, name, normalised, is_ibc)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newPartyId(), contractId, partyRole, value, normalizeParty(value), bit(isIbcParty(value)) ?? 0],
    );
    return;
  }

  const id = reqStr(existing['id'], 'parties.id');
  if (column === 'name') {
    if (value == null) {
      run('DELETE FROM parties WHERE id = ?', [id]);
      return;
    }
    run('UPDATE parties SET name = ?, normalised = ?, is_ibc = ? WHERE id = ?', [
      value,
      normalizeParty(value),
      bit(isIbcParty(value)) ?? 0,
      id,
    ]);
    return;
  }
  run(`UPDATE parties SET ${column} = ? WHERE id = ?`, [value, id]);
}

/**
 * Recompute the denormalised counterparty and both end dates. Runs inside the
 * edit transaction so no reader ever sees the intermediate state.
 */
export function recomputeContractDerived(contractId: string): void {
  const row = queryOne(
    'SELECT effective_date, term, confidentiality_term, termination_override FROM contracts WHERE id = ?',
    [contractId],
  );
  if (!row) return;

  const effective = parseDateIso(str(row['effective_date']));
  const termText = str(row['term']);
  const confText = str(row['confidentiality_term']);
  const term = parseDuration(termText);
  const conf = parseDuration(confText);
  const override = flag(row['termination_override']);

  // The quotes decide two things code cannot infer from the durations alone: whether
  // the effective date was ambiguous, and whether the confidentiality clock runs from
  // signing or from termination. Both live on the evidence rows.
  const quoteOf = (key: string): string | null => {
    const r = queryOne('SELECT quote FROM contract_fields WHERE contract_id = ? AND key = ?', [
      contractId,
      key,
    ]);
    return r ? str(r['quote']) : null;
  };
  const effectiveQuote = quoteOf('effective_date');

  const termination = override
    ? parseDateIso(str(row['termination_date']))
    : resolveEndDate({ effective, term: termText, effectiveQuote }).iso;

  // "survive for 7 years after termination" is seven years from the termination date,
  // not from signing. Computing it from the effective date understated a real Octillion
  // agreement by two years -- on the one field that answers "are we still bound?".
  const confAnchor = clockAnchor(quoteOf('confidentiality_term'));
  const confBase = confAnchor === 'termination' ? termination : effective;
  const confEnd = confText
    ? resolveEndDate({
        effective: confBase,
        term: confText,
        effectiveQuote: confAnchor === 'termination' ? null : effectiveQuote,
      }).iso
    : null;

  const parties = listParties(contractId);
  const counterparty =
    parties.find((p) => !p.isIbc && p.role === 'b')?.name ?? parties.find((p) => !p.isIbc)?.name ?? null;

  const sets = ['term_days = ?', 'confidentiality_days = ?', 'confidentiality_end = ?', 'counterparty = ?'];
  const params: (string | number | null)[] = [
    term?.days ?? null,
    conf?.days ?? null,
    confEnd,
    counterparty,
  ];

  // Normalise a hand-typed date into ISO, but never blank out a value we merely
  // failed to parse -- the reviewer's text stays visible so they can fix it.
  if (effective) {
    sets.push('effective_date = ?');
    params.push(effective);
  }

  // A human override owns the termination date until they clear it.
  if (!override) {
    sets.push('termination_date = ?');
    params.push(termination);
  }

  params.push(contractId);
  run(`UPDATE contracts SET ${sets.join(', ')} WHERE id = ?`, params);
}

/* ─────────────────────────── Archive and restore ───────────────────────── */

/** Archived or not, and whether the contract exists at all. Null means it does not. */
export function contractArchiveState(
  contractId: string,
): { documentId: string; archivedAt: string | null } | null {
  const row = queryOne('SELECT document_id, archived_at FROM contracts WHERE id = ?', [contractId]);
  if (!row) return null;
  return {
    documentId: reqStr(row['document_id'], 'contracts.document_id'),
    archivedAt: str(row['archived_at']),
  };
}

/**
 * Soft delete. The row leaves the repository; nothing is destroyed.
 *
 * The document is moved to 'rejected' as well, and that is the deliberate half.
 * Leaving it 'approved' made the document a dead end: re-dropping its PDF was
 * refused as a duplicate (the upload route's reopen branch only fires for
 * 'rejected'), and opening it showed an "Approved" pill with no way through to a
 * record that no read in the app could find. 'rejected' is the one existing status
 * that is out of the pending Inbox, listed in the Rejected tab with a Reopen
 * action, and understood by the upload route -- so removing a record now leaves
 * the document exactly as recoverable as setting it aside by hand does.
 *
 * Idempotent: archiving an already-archived record changes nothing.
 */
export function archiveContract(contractId: string, opts: { actor?: string } = {}): void {
  tx(() => {
    const state = contractArchiveState(contractId);
    if (!state) throw new EngineError('UNKNOWN', { detail: `no such contract ${contractId}` });
    if (state.archivedAt !== null) return;

    const at = nowIso();
    run('UPDATE contracts SET archived_at = ?, updated_at = ? WHERE id = ?', [at, at, contractId]);
    run("UPDATE documents SET status = 'rejected', updated_at = ? WHERE id = ?", [
      at,
      state.documentId,
    ]);
    insertAudit({ contractId, documentId: state.documentId, action: 'archived', actor: opts.actor, at });
  });
}

/**
 * Undo a soft delete: the record returns to the repository and its document goes
 * back to 'approved'.
 *
 * Refused when the document has since been re-read and approved into a new record.
 * Two live records over one document is what the partial unique index forbids, and
 * a caller deserves to hear which one won rather than a constraint error.
 *
 * Idempotent: restoring a live record is a no-op, so the toast button is safe to
 * press twice.
 */
export function restoreContract(contractId: string, opts: { actor?: string } = {}): void {
  tx(() => {
    const state = contractArchiveState(contractId);
    if (!state) throw new EngineError('UNKNOWN', { detail: `no such contract ${contractId}` });
    if (state.archivedAt === null) return;

    const live = liveContractIdForDocument(state.documentId);
    if (live) {
      throw new EngineError('UNKNOWN', {
        detail: `cannot restore ${contractId}: document ${state.documentId} already has live record ${live}`,
      });
    }

    const at = nowIso();
    run('UPDATE contracts SET archived_at = NULL, updated_at = ? WHERE id = ?', [at, contractId]);
    run("UPDATE documents SET status = 'approved', updated_at = ? WHERE id = ?", [
      at,
      state.documentId,
    ]);
    insertAudit({ contractId, documentId: state.documentId, action: 'restored', actor: opts.actor, at });
  });
}

/* ═════════════════════════════════ Audit ════════════════════════════════ */

/**
 * Every action the trail can record. SQLite has no enum, so this union is the
 * constraint: a typo in a route is a compile error rather than a row the timeline
 * renders as a raw slug.
 *
 * 'unarchived' and 'restored' are the same event under two names. Only 'restored'
 * is written now -- both the Removed view and the toast's Undo go through
 * restoreContract -- but 'unarchived' rows exist in databases already in use and
 * the timeline still has to label them.
 */
export const AUDIT_ACTIONS = [
  'extracted',
  'approved',
  'edited',
  'rejected',
  'unapproved',
  'archived',
  'exported',
  'reextracted',
  'reopened',
  'unarchived',
  'restored',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

interface AuditInput {
  contractId?: string | null;
  documentId?: string | null;
  action: AuditAction;
  fieldKey?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  actor?: string | undefined;
  detail?: string | null;
  at?: string;
}

/**
 * Append-only. The application never updates a row and never deletes one.
 *
 * document_id is filled in from the contract when the caller only had a contract
 * id. It has to be: audit.contract_id is ON DELETE SET NULL, so a row that knew
 * only its contract would become unattributable the moment that contract was
 * dropped -- which is precisely what "Send back to the Inbox" does.
 */
export function insertAudit(e: AuditInput): void {
  let documentId = e.documentId ?? null;
  if (documentId == null && e.contractId != null) {
    const row = queryOne('SELECT document_id FROM contracts WHERE id = ?', [e.contractId]);
    documentId = row ? str(row['document_id']) : null;
  }

  run(
    `INSERT INTO audit (contract_id, document_id, action, field_key, old_value, new_value, actor, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.contractId ?? null,
      documentId,
      e.action,
      e.fieldKey ?? null,
      e.oldValue ?? null,
      e.newValue ?? null,
      e.actor ?? 'local',
      e.detail ?? null,
      e.at ?? nowIso(),
    ],
  );
}

/**
 * The detail sheet's timeline. Includes the document's own history so
 * "extracted" appears above "approved" rather than disappearing at approve.
 */
export function getContractAudit(contractId: string): AuditEntry[] {
  return query(
    `SELECT a.* FROM audit a
      WHERE a.contract_id = ?
         OR a.document_id = (SELECT document_id FROM contracts WHERE id = ?)
      ORDER BY a.at DESC, a.id DESC`,
    [contractId, contractId],
  ).map(toAuditEntry);
}

export function getDocumentAudit(documentId: string): AuditEntry[] {
  return query('SELECT * FROM audit WHERE document_id = ? ORDER BY at DESC, id DESC', [
    documentId,
  ]).map(toAuditEntry);
}

function toAuditEntry(r: Row): AuditEntry {
  return {
    id: int(r['id']),
    action: reqStr(r['action'], 'audit.action'),
    fieldKey: str(r['field_key']),
    oldValue: str(r['old_value']),
    newValue: str(r['new_value']),
    actor: str(r['actor']) ?? 'local',
    detail: str(r['detail']),
    at: reqStr(r['at'], 'audit.at'),
  };
}

/* ════════════════════════════════ Export ════════════════════════════════ */

export interface ExportRow {
  contract: ContractDetail;
  fields: FieldRecord[];
}

/** Everything the workbook writer needs, in one read. */
export function listContractsForExport(today: string = todayIso()): ExportRow[] {
  return query(`${CONTRACT_SQL} ORDER BY c.doc_type, c.approved_at`, [])
    .map((r) => toContractDetail(r, today))
    .map((contract) => ({ contract, fields: getContractFields(contract.id) }));
}

/** Stamp an export, with a note of which sheets it covered. */
export function markExported(
  contractIds: string[],
  opts: { actor?: string; detail?: string } = {},
): void {
  tx(() => {
    const at = nowIso();
    for (const id of contractIds) {
      insertAudit({ contractId: id, action: 'exported', actor: opts.actor, detail: opts.detail ?? null, at });
    }
    writeSetting('lastExportedAt', at);
  });
}

/* ═══════════════════════════════ Settings ═══════════════════════════════ */

/**
 * Defaults live here, not in the UI. A missing row means "never set", which is
 * different from "set to false", and only this file gets to decide the fallback.
 */
function settingDefaults(): Omit<AppSettings, 'hasApiKey' | 'apiKeySource'> {
  return {
    provider: 'cli',
    tier: DEFAULT_TIER,
    // Light, not 'system'. Legal and finance software is light, the content is
    // dense prose, and records get screenshotted into email.
    appearance: 'light',
    watchFolder: null,
    archiveFolder: archiveDir(),
    exportFolder: exportDir(),
    autoExtract: true,
    glassIntensity: 0.8,
    density: 'comfortable',
    escalateOnLowYield: true,
    lastExportedAt: null,
    onboardingComplete: false,
  };
}

/**
 * `keyState` is passed in by the settings route after asking the keychain. The
 * database never stores or infers it, because the database must never be able to
 * imply that a key exists.
 */
export function getSettings(
  keyState: { hasApiKey: boolean; apiKeySource: AppSettings['apiKeySource'] } = {
    hasApiKey: false,
    apiKeySource: 'none',
  },
): AppSettings {
  const stored = new Map<string, string>();
  for (const r of query('SELECT key, value FROM settings', [])) {
    const k = str(r['key']);
    const v = str(r['value']);
    if (k != null && v != null) stored.set(k, v);
  }
  const d = settingDefaults();
  return {
    provider: keyOf(PROVIDER_SET, stored.get('provider')) ?? d.provider,
    tier: keyOf(TIER_SET, stored.get('tier')) ?? d.tier,
    appearance: keyOf(APPEARANCE_SET, stored.get('appearance')) ?? d.appearance,
    hasApiKey: keyState.hasApiKey,
    apiKeySource: keyState.apiKeySource,
    watchFolder: readString(stored, 'watchFolder') ?? d.watchFolder,
    archiveFolder: readString(stored, 'archiveFolder') ?? d.archiveFolder,
    exportFolder: readString(stored, 'exportFolder') ?? d.exportFolder,
    autoExtract: readBool(stored, 'autoExtract') ?? d.autoExtract,
    glassIntensity: clamp01(readNumber(stored, 'glassIntensity') ?? d.glassIntensity),
    density: stored.get('density') === 'compact' ? 'compact' : d.density,
    escalateOnLowYield: readBool(stored, 'escalateOnLowYield') ?? d.escalateOnLowYield,
    lastExportedAt: readString(stored, 'lastExportedAt') ?? d.lastExportedAt,
    onboardingComplete: readBool(stored, 'onboardingComplete') ?? d.onboardingComplete,
  };
}

/** Patch only the keys present. `hasApiKey` and `apiKeySource` are ignored by design. */
export function updateSettings(patch: Partial<AppSettings>): void {
  tx(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'hasApiKey' || key === 'apiKeySource') continue;
      if (value === undefined) continue;
      writeSetting(key, value === null ? '' : String(value));
    }
  });
}

function writeSetting(key: string, value: string): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowIso()],
  );
}

function readString(m: Map<string, string>, key: string): string | null {
  const v = m.get(key);
  if (v === undefined) return null;
  return v === '' ? null : v;
}

function readBool(m: Map<string, string>, key: string): boolean | null {
  const v = m.get(key);
  if (v === undefined) return null;
  return v === 'true' || v === '1';
}

function readNumber(m: Map<string, string>, key: string): number | null {
  const v = m.get(key);
  if (v === undefined) return null;
  return num(v);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/* ════════════════════════════════ Usage ═════════════════════════════════ */

/** One row per billable engine call. Powers the cost meter. */
export function logUsage(u: UsageEntry): void {
  run(
    `INSERT INTO usage_log
       (document_id, provider, model, input_tokens, output_tokens, cost_usd, cached, ok, error_code, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      u.documentId,
      u.provider,
      u.model,
      u.inputTokens,
      u.outputTokens,
      u.costUsd,
      bindable(u.cached) ?? 0,
      bindable(u.ok) ?? 1,
      u.errorCode,
      u.at ?? nowIso(),
    ],
  );
}

/**
 * Month rollup for Settings. `month` is YYYY-MM and defaults to the current one.
 * Cached calls are counted but cost nothing, which is the point of showing them.
 */
export function usageRollup(month: string = nowIso().slice(0, 7)): UsageRollup {
  const totals = queryOne(
    `SELECT count(*) AS calls,
            count(DISTINCT document_id) AS documents,
            coalesce(sum(input_tokens), 0) AS input_tokens,
            coalesce(sum(output_tokens), 0) AS output_tokens,
            coalesce(sum(cost_usd), 0) AS cost
       FROM usage_log WHERE substr(at, 1, 7) = ?`,
    [month],
  );
  const daily = query(
    `SELECT substr(at, 1, 10) AS day, coalesce(sum(cost_usd), 0) AS cost, count(*) AS calls
       FROM usage_log WHERE substr(at, 1, 7) = ?
      GROUP BY day ORDER BY day`,
    [month],
  ).map((r) => ({
    date: reqStr(r['day'], 'usage_log.at'),
    costUsd: num(r['cost']) ?? 0,
    calls: int(r['calls']),
  }));

  return {
    month,
    documents: totals ? int(totals['documents']) : 0,
    calls: totals ? int(totals['calls']) : 0,
    inputTokens: totals ? int(totals['input_tokens']) : 0,
    outputTokens: totals ? int(totals['output_tokens']) : 0,
    costUsd: totals ? (num(totals['cost']) ?? 0) : 0,
    daily,
  };
}

/* ════════════════════════════════ Cache ═════════════════════════════════ */

/**
 * Repeatability: same file + same model + same prompt version returns the stored
 * response, forever, at zero cost. The key is computed by the extraction
 * pipeline, which owns what goes into it.
 */
export function putCachedExtraction(entry: {
  cacheKey: string;
  fileHash: string;
  model: string;
  promptVersion: string;
  responseJson: string;
}): void {
  run(
    `INSERT INTO extraction_cache
       (cache_key, file_hash, model, prompt_version, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json`,
    [entry.cacheKey, entry.fileHash, entry.model, entry.promptVersion, entry.responseJson, nowIso()],
  );
}

/** Cache is the only table we hard-delete. */
export function clearCache(fileHash?: string): void {
  if (fileHash) run('DELETE FROM extraction_cache WHERE file_hash = ?', [fileHash]);
  else run('DELETE FROM extraction_cache', []);
}

/* ════════════════════════════════ Errors ════════════════════════════════ */

/** The Diagnostics list and the support bundle. Detail is already redacted on write. */
export function recentErrors(limit = 20): ErrorRow[] {
  return query(
    `SELECT id, filename, error_code, error_detail, updated_at FROM documents
      WHERE error_code IS NOT NULL ORDER BY updated_at DESC LIMIT ?`,
    [limit],
  ).map((r) => {
    const code = reqStr(r['error_code'], 'documents.error_code');
    return {
      documentId: reqStr(r['id'], 'documents.id'),
      filename: reqStr(r['filename'], 'documents.filename'),
      code,
      message: errorMessageFor(code),
      detail: redact(str(r['error_detail'])) ?? null,
      at: reqStr(r['updated_at'], 'documents.updated_at'),
    };
  });
}

/* ════════════════════════════════ Stats ═════════════════════════════════ */

/** The sidebar badges and the cost meter, in one round trip. */
export function getStats(today: string = todayIso()): AppStats {
  const byStatus = documentCountsByStatus();
  const inbox =
    (byStatus['queued'] ?? 0) +
    (byStatus['hashing'] ?? 0) +
    (byStatus['reading'] ?? 0) +
    (byStatus['extracting'] ?? 0) +
    (byStatus['ready'] ?? 0);

  let expiring = 0;
  let expired = 0;
  let contracts = 0;
  /*
   * Both clocks, the same way recordStatus() and the Expiring page do.
   *
   * This counted the agreement clock alone while the list and the Expiring page
   * counted whichever binds longest, so the sidebar badge and the screen it links to
   * disagreed about the same records -- the badge said 0 expiring where the page
   * listed 1, and called 3 expired where the list called 1. A number in the
   * navigation that contradicts the page behind it is worse than no number: it is
   * the two-clocks distinction, which is the product's whole insight, being told
   * two different ways in one window.
   */
  for (const r of query(
    `SELECT effective_date, termination_date, confidentiality_end
       FROM contracts WHERE archived_at IS NULL`,
    [],
  )) {
    contracts += 1;
    const agreement = agreementStatus(
      str(r['effective_date']),
      str(r['termination_date']),
      today,
    ).status;
    const confidentiality = agreementStatus(
      str(r['effective_date']),
      str(r['confidentiality_end']),
      today,
    ).status;
    const s =
      CLOCK_LIFE[confidentiality] > CLOCK_LIFE[agreement] ? confidentiality : agreement;
    if (s === 'expiring') expiring += 1;
    else if (s === 'expired') expired += 1;
  }

  const usage = usageRollup();
  return {
    inbox,
    needsAttention: byStatus['needs_attention'] ?? 0,
    failed: byStatus['failed'] ?? 0,
    contracts,
    expiring,
    expired,
    monthDocuments: usage.documents,
    monthCostUsd: usage.costUsd,
  };
}

/* ═══════════════════════ Generic document update ════════════════════════ */

/**
 * camelCase field -> column. One table, one map: a patch key with no entry here
 * is a compile error at the call site rather than a silently dropped write.
 */
const DOCUMENT_COLUMNS: Record<keyof DocumentPatchFull, string> = {
  textSource: 'text_source',
  ocrConfidence: 'ocr_confidence',
  pagesRead: 'pages_read',
  pagesReadRanges: 'pages_read_ranges',
  rejectedOcrConfidence: 'rejected_ocr_confidence',
  status: 'status',
  errorCode: 'error_code',
  errorDetail: 'error_detail',
  attempts: 'attempts',
  docType: 'doc_type',
  filename: 'filename',
  fileHash: 'file_hash',
  archivePath: 'archive_path',
  originPath: 'origin_path',
  byteSize: 'byte_size',
  pageCount: 'page_count',
  hasTextLayer: 'has_text_layer',
  thumbnailPath: 'thumbnail_path',
  provider: 'provider',
  model: 'model',
  tier: 'tier',
  promptVersion: 'prompt_version',
  repairAttempts: 'repair_attempts',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  costUsd: 'cost_usd',
  durationMs: 'duration_ms',
  rawPrompt: 'raw_prompt',
  rawResponse: 'raw_response',
  extractedAt: 'extracted_at',
  updatedAt: 'updated_at',
};

/**
 * Patch a documents row. Only the keys present are written, and `updated_at`
 * always moves -- a status change the Inbox cannot see is worse than no change.
 */
export function updateDocument(id: string, patch: DocumentPatchFull): void {
  const sets: string[] = [];
  const params: Param[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = keyOf(DOCUMENT_COLUMN_SET, key);
    if (column == null) continue;
    sets.push(`${DOCUMENT_COLUMNS[column]} = ?`);
    params.push(bindable(value));
  }

  if (!('updatedAt' in patch)) {
    sets.push('updated_at = ?');
    params.push(nowIso());
  }
  if (!sets.length) return;

  params.push(id);
  run(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, params);
}

/** The key set of DOCUMENT_COLUMNS, for narrowing an Object.entries key. */
const DOCUMENT_COLUMN_SET: Record<keyof DocumentPatchFull, true> = {
  textSource: true,
  ocrConfidence: true,
  pagesRead: true,
  pagesReadRanges: true,
  rejectedOcrConfidence: true,
  status: true,
  errorCode: true,
  errorDetail: true,
  attempts: true,
  docType: true,
  filename: true,
  fileHash: true,
  archivePath: true,
  originPath: true,
  byteSize: true,
  pageCount: true,
  hasTextLayer: true,
  thumbnailPath: true,
  provider: true,
  model: true,
  tier: true,
  promptVersion: true,
  repairAttempts: true,
  inputTokens: true,
  outputTokens: true,
  costUsd: true,
  durationMs: true,
  rawPrompt: true,
  rawResponse: true,
  extractedAt: true,
  updatedAt: true,
};

/** node:sqlite binds strings, numbers and null. Booleans become 0/1. */
function bindable(v: unknown): Param {
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

/** Ready for another pass. Clears the previous failure so the card stops lying. */
export function markDocumentQueued(id: string): DocumentDetailFull | null {
  return tx(() => {
    const existing = getDocument(id);
    if (!existing) return null;
    updateDocument(id, { status: 'queued', errorCode: null, errorDetail: null });
    return getDocument(id);
  });
}

export function getDocumentSummary(id: string): DocumentSummaryFull | null {
  const row = queryOne(`${DOC_SUMMARY_SQL} WHERE d.id = ?`, [id]);
  return row ? toDocumentSummary(row, fieldCounts([id])) : null;
}

/** Where the bytes are. Kept separate so no path ever rides along in an API body. */
export function getDocumentFiles(id: string): DocumentFiles | null {
  const row = queryOne(
    'SELECT filename, archive_path, origin_path, thumbnail_path, byte_size FROM documents WHERE id = ?',
    [id],
  );
  if (!row) return null;
  return {
    filename: reqStr(row['filename'], 'documents.filename'),
    archivePath: str(row['archive_path']),
    originPath: str(row['origin_path']),
    thumbnailPath: str(row['thumbnail_path']),
    byteSize: int(row['byte_size']),
  };
}

/** For the queue's crash recovery: anything left mid-flight when we died. */
export function listDocumentIdsByStatus(statuses: DocumentStatus[]): string[] {
  if (!statuses.length) return [];
  return query(
    `SELECT id FROM documents WHERE status IN (${placeholders(statuses.length)})
      ORDER BY created_at`,
    [...statuses],
  ).map((r) => reqStr(r['id'], 'documents.id'));
}

/* ══════════════════════════ Aggregates & meta ═══════════════════════════ */

export function contractCountsByDocType(): Record<DocType, number> {
  const out: Record<DocType, number> = { nda: 0, evaluation: 0, other: 0 };
  for (const r of query(
    'SELECT doc_type, count(*) AS n FROM contracts WHERE archived_at IS NULL GROUP BY doc_type',
    [],
  )) {
    const t = docType(r['doc_type']);
    if (t) out[t] = int(r['n']);
  }
  return out;
}

const COUNTED_TABLES = [
  'documents',
  'document_fields',
  'contracts',
  'parties',
  'contract_fields',
  'audit',
  'extraction_cache',
  'usage_log',
] as const;

/** Row counts per table, for Diagnostics and the support bundle. */
export function tableCounts(): { table: string; rows: number }[] {
  return COUNTED_TABLES.map((table) => {
    // Table names come from the const list above, never from a caller.
    const row = queryOne(`SELECT count(*) AS n FROM ${table}`, []);
    return { table, rows: row ? int(row['n']) : 0 };
  });
}

/** Applied schema version. 0 means the file exists but nothing has been applied. */
export function schemaVersion(): number {
  const row = queryOne('SELECT max(version) AS v FROM schema_meta', []);
  return row ? int(row['v']) : 0;
}

/* ═══════════════════════════════ Aliases ════════════════════════════════ */
/*
 * Second names for functions above, matching how the routes and the pipeline
 * read at their call sites. Aliases, not wrappers: one implementation each.
 */

export const getDocumentDetail = getDocument;
export const findDocumentByHash = getDocumentByHash;
export const getContractDetail = getContract;
export const getContractForDocument = getContractByDocument;
export const unresolvedRequiredFields = approvalBlockers;
export const replaceDocumentFields = putDocumentFields;
export const recomputeDocumentDerivedFields = recomputeDocumentDerived;
export const recomputeContractDerivedFields = recomputeContractDerived;
export const insertUsageLog = logUsage;

/** Edit one field on a document in review. */
export function setDocumentField(
  documentId: string,
  key: FieldKey,
  value: string | null,
  fieldMethod?: ExtractionMethod,
): FieldRecord[] {
  return editDocumentField(documentId, key, value, { method: fieldMethod });
}

/** Edit one field on an approved contract. Always audited. */
export function setContractField(
  contractId: string,
  key: FieldKey,
  value: string | null,
  actor?: string,
): ContractDetail {
  return editContractField(contractId, key, value, { actor });
}

/** Cache read with the row intact, so the caller can see the model it came from. */
export function getCachedExtraction(cacheKey: string): CachedExtraction | null {
  const row = queryOne('SELECT * FROM extraction_cache WHERE cache_key = ?', [cacheKey]);
  if (!row) return null;
  run('UPDATE extraction_cache SET hits = hits + 1 WHERE cache_key = ?', [cacheKey]);
  return {
    cacheKey: reqStr(row['cache_key'], 'extraction_cache.cache_key'),
    fileHash: reqStr(row['file_hash'], 'extraction_cache.file_hash'),
    model: reqStr(row['model'], 'extraction_cache.model'),
    promptVersion: reqStr(row['prompt_version'], 'extraction_cache.prompt_version'),
    responseJson: reqStr(row['response_json'], 'extraction_cache.response_json'),
    createdAt: reqStr(row['created_at'], 'extraction_cache.created_at'),
    hits: int(row['hits']),
  };
}

/** One stored setting, raw. Prefer getSettings() unless you want exactly one key. */
export function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? str(row['value']) : null;
}

/** Export rows for one sheet, or all of them. */
export function contractsForExport(type?: DocType, today: string = todayIso()): ExportRow[] {
  const rows = listContractsForExport(today);
  return type ? rows.filter((r) => r.contract.docType === type) : rows;
}

/** Stamp an export against every contract it covered. */
export function recordExport(contractIds: string[], at?: string): void {
  markExported(contractIds, at ? { detail: `at ${at}` } : {});
}

/* ═════════════════════════ Statement plumbing ═══════════════════════════ */

type Param = string | number | null;

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function query(sql: string, params: Param[]): Row[] {
  try {
    return db().prepare(sql).all(...params);
  } catch (e) {
    throw sqliteError(e);
  }
}

function queryOne(sql: string, params: Param[]): Row | null {
  try {
    return db().prepare(sql).get(...params) ?? null;
  } catch (e) {
    throw sqliteError(e);
  }
}

function run(sql: string, params: Param[]): void {
  try {
    db().prepare(sql).run(...params);
  } catch (e) {
    throw sqliteError(e);
  }
}
