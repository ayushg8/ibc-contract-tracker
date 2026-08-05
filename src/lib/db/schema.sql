-- IBC Contract Tracker — schema v2
-- node:sqlite (Node 22.5+). No native modules, no ORM, no build step.
--
-- Design rules enforced here:
--   * Expiry is NEVER stored. It is computed at read time from effective_date + term.
--     A stored status goes stale the moment nobody opens the app.
--   * Every field value carries its own evidence row (quote, page, method) so the
--     citation trail survives approval and later edits.
--   * Parties live in a child table so three-party agreements are data, not a migration.
--   * Nothing is ever hard-deleted except cache. Rejection and deletion are states.
--   * The audit trail outlives everything it describes. No foreign key on it may
--     cascade a delete: dropping a contract must never take its approvals with it.
--
-- This file is CREATE ... IF NOT EXISTS throughout, so it only ever builds a NEW
-- database. Existing files are brought forward by migrate.ts, which is where the
-- v1 -> v2 changes (audit FK, partial unique index, documents read-provenance
-- columns) are actually applied.

PRAGMA journal_mode = WAL;         -- concurrent readers while one writer commits
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;        -- surfaces as DB_LOCKED instead of an instant throw
PRAGMA synchronous = NORMAL;

-- ─────────────────────────────── documents ───────────────────────────────
-- One row per file that ever entered the inbox. Survives approval; the contract
-- row points back at it.
CREATE TABLE IF NOT EXISTS documents (
  id                TEXT PRIMARY KEY,           -- uuid
  file_hash         TEXT NOT NULL,              -- sha256 of the bytes; the identity of a document
  filename          TEXT NOT NULL,
  archive_path      TEXT,                       -- our copy under the archive dir
  origin_path       TEXT,                       -- where it came from, if watched
  byte_size         INTEGER NOT NULL DEFAULT 0,
  page_count        INTEGER NOT NULL DEFAULT 0,
  has_text_layer    INTEGER NOT NULL DEFAULT 1, -- 0 => scan => vision path
  thumbnail_path    TEXT,

  -- How the text the model actually read was obtained. The reviewer is entitled to
  -- know that a citation was matched against OCR output rather than an embedded
  -- text layer, because OCR can transcribe a date wrong and still "verify".
  text_source       TEXT,                       -- 'pdf' | 'ocr' | 'vision'
  ocr_confidence    REAL,                       -- 0..1, only meaningful when text_source='ocr'
  pages_read        INTEGER,                    -- pages whose text reached the model
  pages_read_ranges TEXT,                       -- WHICH pages, e.g. '1-28,49-60'. the count alone
                                                -- cannot say this: the reader takes head AND tail
  rejected_ocr_confidence REAL,                 -- 0..1. the OCR score that sent us to vision. kept
                                                -- apart from ocr_confidence so a rejected read is
                                                -- never mistaken for the score of the path we took

  status            TEXT NOT NULL,              -- see DocumentStatus in db/types.ts
  error_code        TEXT,                       -- EngineErrorCode when status='failed'
  error_detail      TEXT,                       -- redacted technical detail
  attempts          INTEGER NOT NULL DEFAULT 0,

  doc_type          TEXT,                       -- 'nda' | 'evaluation' | 'other'

  -- provenance of the extraction that produced the current fields
  provider          TEXT,                       -- 'cli' | 'api'
  model             TEXT,
  tier              TEXT,
  prompt_version    TEXT,
  repair_attempts   INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_usd          REAL,
  duration_ms       INTEGER,
  raw_prompt        TEXT,                       -- the exact prompt sent
  raw_response      TEXT,                       -- the exact response received

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  extracted_at      TEXT
);

-- A given file may only be in the inbox once. Re-dropping opens the existing record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status, created_at DESC);

-- ────────────────────────── document_fields ──────────────────────────────
-- Pre-approval evidence. Mutated freely while a document sits in review.
CREATE TABLE IF NOT EXISTS document_fields (
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,              -- FieldKey
  value             TEXT,
  quote             TEXT,                       -- verbatim span from the document
  page              INTEGER,
  method            TEXT NOT NULL,              -- ExtractionMethod
  -- Did the quote actually appear in the document text? The hallucination guard.
  -- 1 = found, 0 = not found (field forced to missing), NULL = not applicable (scan/rule)
  citation_verified INTEGER,
  PRIMARY KEY (document_id, key)
);

-- ─────────────────────────────── contracts ───────────────────────────────
-- Created only on approve, in one transaction with parties + contract_fields + audit.
CREATE TABLE IF NOT EXISTS contracts (
  id                    TEXT PRIMARY KEY,
  document_id           TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  doc_type              TEXT NOT NULL,

  contract_name         TEXT,
  effective_date        TEXT,                   -- ISO YYYY-MM-DD
  term                  TEXT,                   -- verbatim, e.g. '5 years'
  term_days             INTEGER,                -- parsed; NULL if unparseable
  termination_date      TEXT,                   -- computed at approve, recomputed on edit
  termination_override  INTEGER NOT NULL DEFAULT 0,  -- 1 = a human overrode the computation
  confidentiality_term  TEXT,
  confidentiality_days  INTEGER,
  confidentiality_end   TEXT,                   -- computed: the second clock
  ibc_form              TEXT,                   -- 'Yes' | 'No' | NULL
  notice_email          TEXT,
  notice_address        TEXT,
  governing_law         TEXT,

  -- denormalised for search and table sort; always derived from parties
  counterparty          TEXT,

  approved_by           TEXT NOT NULL DEFAULT 'local',
  approved_at           TEXT NOT NULL,
  edited_at             TEXT,
  archived_at           TEXT,                   -- soft delete
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contracts_counterparty ON contracts(counterparty);
CREATE INDEX IF NOT EXISTS idx_contracts_termination ON contracts(termination_date);
CREATE INDEX IF NOT EXISTS idx_contracts_doc_type ON contracts(doc_type);
-- Partial on purpose. A document may own at most one LIVE record, but any number of
-- archived ones: removing a record and later re-approving the re-read document has
-- to be possible, and a plain unique index made that a constraint violation -- which
-- is what turned "Remove" into a dead end for the document behind it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_document
  ON contracts(document_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contracts_archived ON contracts(archived_at);

-- ──────────────────────────────── parties ────────────────────────────────
CREATE TABLE IF NOT EXISTS parties (
  id            TEXT PRIMARY KEY,
  contract_id   TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,                  -- 'a' | 'b' | 'c'
  name          TEXT NOT NULL,
  normalised    TEXT NOT NULL,                  -- casefolded, suffix-stripped, for matching
  signer        TEXT,
  address       TEXT,
  is_ibc        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_parties_contract ON parties(contract_id);
CREATE INDEX IF NOT EXISTS idx_parties_normalised ON parties(normalised);

-- ───────────────────────── contract_fields ───────────────────────────────
-- Evidence frozen at approve, then updated in place on edit (with an audit row).
CREATE TABLE IF NOT EXISTS contract_fields (
  contract_id       TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  value             TEXT,
  quote             TEXT,
  page              INTEGER,
  method            TEXT NOT NULL,
  citation_verified INTEGER,
  PRIMARY KEY (contract_id, key)
);

-- ───────────────────────────────── audit ─────────────────────────────────
-- Append-only. The application never updates a row and never deletes one.
--
-- contract_id is ON DELETE SET NULL, not CASCADE. It used to cascade, which meant
-- "Send back to the Inbox", "Re-read this document" and the Undo on bulk approve
-- each silently destroyed every approved/edited/exported row for that contract --
-- the exact history the record exists to prove. SET NULL is the only mutation
-- SQLite is allowed to perform here, and insertAudit() always stamps document_id
-- as well, so a row whose contract is gone still resolves to its document and
-- still appears in the timeline of whatever record that document produces next.
--
-- Soft-deleting the contract instead was the alternative. It was rejected because
-- the contracts row is the identity of one approval: unapprove is meant to end
-- that approval, and keeping a dead row alive forever would leave every read in
-- the app carrying a second "and not this one either" predicate.
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id   TEXT REFERENCES contracts(id) ON DELETE SET NULL,
  document_id   TEXT REFERENCES documents(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,   -- 'extracted' | 'approved' | 'edited' | 'rejected'
                                 -- | 'unapproved' | 'archived' | 'exported' | 'reextracted'
                                 -- | 'reopened' | 'unarchived' | 'restored'
                                 -- The runtime union is AUDIT_ACTIONS in queries.ts;
                                 -- SQLite has no enum, so that type is the constraint.
  field_key     TEXT,
  old_value     TEXT,
  new_value     TEXT,
  actor         TEXT NOT NULL DEFAULT 'local',
  detail        TEXT,
  at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_contract ON audit(contract_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_document ON audit(document_id, at DESC);

-- ──────────────────────────── search index ───────────────────────────────
-- FTS5 is available in Node's bundled SQLite (verified). Kept in sync by triggers
-- on contracts and parties so it can never drift from the source of truth.
CREATE VIRTUAL TABLE IF NOT EXISTS contract_search USING fts5(
  contract_id UNINDEXED,
  haystack,                -- every party name, signer, contract name, governing law
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ──────────────────────────── settings ───────────────────────────────────
-- Single-row-per-key KV. Never holds secrets — the API key lives in the OS keychain.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ───────────────────────── extraction_cache ──────────────────────────────
-- Guarantees repeatability: same file + same model + same prompt version =>
-- byte-identical result, forever, at zero cost.
CREATE TABLE IF NOT EXISTS extraction_cache (
  cache_key   TEXT PRIMARY KEY,   -- sha256(file_hash | model | promptVersion | fieldsToFill)
  file_hash   TEXT NOT NULL,
  model       TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cache_file ON extraction_cache(file_hash);

-- ──────────────────────────── usage_log ──────────────────────────────────
-- Powers the cost meter. One row per billable engine call.
CREATE TABLE IF NOT EXISTS usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   TEXT,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  cached        INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 1,
  error_code    TEXT,
  at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_log(at DESC);

-- ─────────────────────── schema version marker ───────────────────────────
CREATE TABLE IF NOT EXISTS schema_meta (
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL
);
