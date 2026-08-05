/**
 * The shapes every screen, route handler and query in the app codes against.
 *
 * One import site on purpose: the types this file needs from fields.ts,
 * providers/types.ts and status.ts are re-exported here, so a component never
 * has to know which of the four files a name came from -- and so those four stay
 * the only places a name is *defined*.
 *
 * Nothing in here is server-only. Client components import it freely.
 */

import type { DocType, FieldGroup, FieldKey, FieldType } from '../fields';
import type { Confidence, ExtractionMethod } from '../fields';
import type { ModelTier, ProviderId } from '../providers/types';
import type { AgreementStatus } from '../status';

export type {
  AgreementStatus,
  Confidence,
  DocType,
  ExtractionMethod,
  FieldGroup,
  FieldKey,
  FieldType,
  ModelTier,
  ProviderId,
};

/* ─────────────────────────────── Documents ─────────────────────────────── */

/**
 * The document lifecycle. The first six are the pipeline; the last four are
 * terminal states the Inbox renders with their own recovery action.
 */
export type DocumentStatus =
  | 'queued'
  | 'hashing'
  | 'reading'
  | 'extracting'
  | 'ready'
  | 'needs_attention'
  | 'approved'
  | 'failed'
  | 'rejected'
  | 'duplicate';

/** What an Inbox card needs. Never carries the raw prompt or response. */
export interface DocumentSummary {
  id: string;
  filename: string;
  pageCount: number;
  hasTextLayer: boolean;
  status: DocumentStatus;
  docType: DocType | null;
  thumbnailUrl: string | null;
  /** Best-known party B, for the card title. Null until extraction finds one. */
  counterparty: string | null;
  counts: { high: number; medium: number; none: number };
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/** Everything about one document, including the audit trail of the extraction. */
export interface DocumentDetail extends DocumentSummary {
  byteSize: number;
  /** Our copy under the archive dir. The pipeline reads this, not the original. */
  archivePath: string | null;
  originPath: string | null;
  pdfUrl: string;
  provider: ProviderId | null;
  model: string | null;
  tier: ModelTier | null;
  promptVersion: string | null;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  rawPrompt: string | null;
  rawResponse: string | null;
  attempts: number;
  extractedAt: string | null;
}

/* ──────────────────────────────── Fields ───────────────────────────────── */

/**
 * One field with its evidence. The definition half (label, group, type,
 * requiredToApprove) is joined in from fields.ts so the UI never has to.
 */
export interface FieldRecord {
  key: FieldKey;
  label: string;
  group: FieldGroup;
  type: FieldType;
  value: string | null;
  quote: string | null;
  page: number | null;
  method: ExtractionMethod;
  confidence: Confidence;
  /** Did the quote actually appear in the document? Null when not applicable. */
  citationVerified: boolean | null;
  requiredToApprove: boolean;
  /** True for computed fields. */
  readOnly: boolean;
}

/* ─────────────────────────────── Contracts ─────────────────────────────── */

/**
 * A repository row. Both statuses and both day counts are computed at read time
 * from the dates -- never read from a column.
 */
export interface ContractRow {
  id: string;
  counterparty: string | null;
  docType: DocType;
  contractName: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  termDays: number | null;
  agreementStatus: AgreementStatus;
  daysRemaining: number | null;
  confidentialityEnd: string | null;
  confidentialityStatus: AgreementStatus;
  confidentialityDaysRemaining: number | null;
  governingLaw: string | null;
  approvedAt: string;
}

export interface ContractSummary extends ContractRow {
  documentId: string;
}

export interface ContractDetail extends ContractSummary {
  parties: {
    role: 'a' | 'b' | 'c';
    name: string;
    signer: string | null;
    address: string | null;
    isIbc: boolean;
  }[];
  noticeEmail: string | null;
  noticeAddress: string | null;
  ibcForm: string | null;
  term: string | null;
  confidentialityTerm: string | null;
  /** True once a human has overridden the computed termination date. */
  terminationOverride: boolean;
  filename: string;
  pdfUrl: string;
  editedAt: string | null;
}

export type PartyRole = 'a' | 'b' | 'c';

/* ──────────────────────────────── Audit ────────────────────────────────── */

export interface AuditEntry {
  id: number;
  action: string;
  fieldKey: string | null;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
  detail: string | null;
  at: string;
}

/* ─────────────────────────────── Settings ──────────────────────────────── */

export interface AppSettings {
  provider: ProviderId;
  tier: ModelTier;
  /** Never the key itself -- that lives in the OS keychain. */
  hasApiKey: boolean;
  apiKeySource: 'keychain' | 'env' | 'none';
  watchFolder: string | null;
  archiveFolder: string;
  exportFolder: string;
  autoExtract: boolean;
  /** 0..1 */
  /** 'light' is the default. 'system' defers to the OS. */
  appearance: 'system' | 'light' | 'dark';
  glassIntensity: number;
  density: 'comfortable' | 'compact';
  /** Retry once on a deeper model if more than three fields come back empty. */
  escalateOnLowYield: boolean;
  lastExportedAt: string | null;
  onboardingComplete: boolean;
}

/* ──────────────────────────────── Errors ───────────────────────────────── */

export interface ErrorRow {
  documentId: string;
  filename: string;
  code: string;
  message: string;
  detail: string | null;
  at: string;
}

/* ──────────────────── Query inputs and derived reads ───────────────────── */

/** Repository filter chips. Matches the four buttons in DESIGN.md section 20. */
export type ContractFilter = 'all' | 'active' | 'expiring' | 'expired' | 'unknown';

export type ContractSortKey =
  /** Search score. Only meaningful while a search is active; the default then. */
  | 'relevance'
  | 'counterparty'
  | 'docType'
  | 'contractName'
  | 'effectiveDate'
  | 'terminationDate'
  | 'confidentialityEnd'
  | 'governingLaw'
  | 'approvedAt'
  | 'status';

export interface ContractQuery {
  /** Free text over party names, signers, contract name and governing law. */
  search?: string;
  filter?: ContractFilter;
  docType?: DocType | 'all';
  sort?: ContractSortKey;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Injectable today, so a status filter is deterministic in tests. */
  today?: string;
}

export interface ContractPage {
  rows: ContractSummary[];
  /** Rows matching the search and filter, before pagination. */
  total: number;
}

/** The sidebar badges and the Settings cost meter. */
export interface AppStats {
  inbox: number;
  needsAttention: number;
  failed: number;
  contracts: number;
  expiring: number;
  expired: number;
  monthDocuments: number;
  monthCostUsd: number;
}

export interface UsageEntry {
  documentId: string | null;
  provider: ProviderId;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** 0/1 accepted as well as a boolean -- the pipeline already has the bit. */
  cached: boolean | number;
  ok: boolean | number;
  errorCode: string | null;
  /** Defaults to now. Set it only when backfilling. */
  at?: string;
}

export interface UsageRollup {
  /** ISO month, YYYY-MM. */
  month: string;
  documents: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** One entry per day that had activity, ascending. Drives the sparkline. */
  daily: { date: string; costUsd: number; calls: number }[];
}

/* ───────────────────────── Write-side payloads ─────────────────────────── */

/** What the ingest pipeline knows before anything has been read. */
export interface NewDocument {
  id?: string;
  fileHash: string;
  filename: string;
  byteSize?: number;
  originPath?: string | null;
  archivePath?: string | null;
  status?: DocumentStatus;
}

/** Everything the ingest step learns about the file itself. */
export interface DocumentFileMeta {
  pageCount?: number;
  hasTextLayer?: boolean | number;
  byteSize?: number;
  archivePath?: string | null;
  thumbnailPath?: string | null;
}

/** Provenance of one extraction run, written as a unit. */
export interface DocumentExtractionMeta {
  provider: ProviderId;
  model: string;
  tier: ModelTier;
  promptVersion: string;
  repairAttempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  rawPrompt: string | null;
  rawResponse: string | null;
  docType: DocType | null;
}

/**
 * A partial update of one documents row, in camelCase. Only the keys present are
 * written. `hasTextLayer` accepts a boolean or the 0/1 the pipeline already has.
 */
export interface DocumentPatch {
  status?: DocumentStatus;
  errorCode?: string | null;
  errorDetail?: string | null;
  attempts?: number;
  docType?: DocType | null;
  filename?: string;
  fileHash?: string;
  archivePath?: string | null;
  originPath?: string | null;
  byteSize?: number;
  pageCount?: number;
  hasTextLayer?: boolean | number;
  thumbnailPath?: string | null;
  provider?: ProviderId | null;
  model?: string | null;
  tier?: ModelTier | null;
  promptVersion?: string | null;
  repairAttempts?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  rawPrompt?: string | null;
  rawResponse?: string | null;
  extractedAt?: string | null;
  updatedAt?: string;
}

/** Where a document's bytes live. For the PDF and thumbnail routes. */
export interface DocumentFiles {
  filename: string;
  archivePath: string | null;
  originPath: string | null;
  thumbnailPath: string | null;
  byteSize: number;
}

export interface CachedExtraction {
  cacheKey: string;
  fileHash: string;
  model: string;
  promptVersion: string;
  responseJson: string;
  createdAt: string;
  hits: number;
}

/** One field value on its way into document_fields or contract_fields. */
export interface FieldValueInput {
  key: FieldKey;
  value: string | null;
  quote?: string | null;
  page?: number | null;
  method: ExtractionMethod;
  citationVerified?: boolean | null;
}
