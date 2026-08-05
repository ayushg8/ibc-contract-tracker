/**
 * Regressions for the four ways the record could lie about itself.
 *
 * Each block here maps to a defect that shipped:
 *   1. unapprove cascade-deleted the append-only audit trail.
 *   2. approve never looked at document.status, so a rejected document -- whose
 *      extracted fields survive rejection, and which therefore has no blockers --
 *      walked straight into the repository.
 *   3. archive was a one-way door with no list, no restore and a document left
 *      stranded on 'approved'.
 *   4. post-approval edits never reached document_fields, so unapprove -> Undo
 *      rebuilt the record from the pre-edit extraction while the toast said
 *      "their fields are exactly as you left them".
 *
 * IBC_DATA_DIR is set before the module is imported: paths.ts reads it at call
 * time and client.ts opens on first use, so a static import would race the env var
 * and write into the user's real Application Support folder.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'ibc-integrity-'));
const mainDir = join(root, 'main');
const legacyDir = join(root, 'legacy');
mkdirSync(mainDir, { recursive: true });
mkdirSync(legacyDir, { recursive: true });

process.env['IBC_DATA_DIR'] = mainDir;

const q = await import('@/lib/db');
// The constant, not a literal: pinning the number here means every future migration
// fails a test that has nothing to do with what it changed.
const { SCHEMA_VERSION } = await import('@/lib/db/migrate');

afterAll(() => {
  try {
    q.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/** Enough of a v1 file to hold a real approval. Copied from schema.sql at v1. */
const V1_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE documents (
  id TEXT PRIMARY KEY, file_hash TEXT NOT NULL, filename TEXT NOT NULL,
  archive_path TEXT, origin_path TEXT, byte_size INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0, has_text_layer INTEGER NOT NULL DEFAULT 1,
  thumbnail_path TEXT, status TEXT NOT NULL, error_code TEXT, error_detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, doc_type TEXT, provider TEXT, model TEXT,
  tier TEXT, prompt_version TEXT, repair_attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, duration_ms INTEGER,
  raw_prompt TEXT, raw_response TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, extracted_at TEXT
);
CREATE UNIQUE INDEX idx_documents_hash ON documents(file_hash);
CREATE TABLE document_fields (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT, quote TEXT, page INTEGER, method TEXT NOT NULL,
  citation_verified INTEGER, PRIMARY KEY (document_id, key)
);
CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  doc_type TEXT NOT NULL, contract_name TEXT, effective_date TEXT, term TEXT,
  term_days INTEGER, termination_date TEXT,
  termination_override INTEGER NOT NULL DEFAULT 0, confidentiality_term TEXT,
  confidentiality_days INTEGER, confidentiality_end TEXT, ibc_form TEXT,
  notice_email TEXT, notice_address TEXT, governing_law TEXT, counterparty TEXT,
  approved_by TEXT NOT NULL DEFAULT 'local', approved_at TEXT NOT NULL,
  edited_at TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- v1: unique over every row, archived or not. This is the index that made a
-- removed record impossible to re-approve.
CREATE UNIQUE INDEX idx_contracts_document ON contracts(document_id);
CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  role TEXT NOT NULL, name TEXT NOT NULL, normalised TEXT NOT NULL, signer TEXT,
  address TEXT, is_ibc INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE contract_fields (
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT, quote TEXT, page INTEGER, method TEXT NOT NULL,
  citation_verified INTEGER, PRIMARY KEY (contract_id, key)
);
-- v1: the cascade that ate the trail.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT REFERENCES contracts(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  action TEXT NOT NULL, field_key TEXT, old_value TEXT, new_value TEXT,
  actor TEXT NOT NULL DEFAULT 'local', detail TEXT, at TEXT NOT NULL
);
CREATE INDEX idx_audit_contract ON audit(contract_id, at DESC);
CREATE INDEX idx_audit_document ON audit(document_id, at DESC);
CREATE TABLE schema_meta (version INTEGER NOT NULL, applied_at TEXT NOT NULL);
INSERT INTO schema_meta (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
`;

/** A v1 database with an approval already in it, written without the app. */
function seedLegacyDatabase(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(V1_SCHEMA);
  db.exec(`
    INSERT INTO documents (id, file_hash, filename, status, created_at, updated_at)
      VALUES ('doc-legacy', 'legacy-hash', 'Legacy_NDA.pdf', 'approved',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO contracts (id, document_id, doc_type, counterparty, approved_at,
                           created_at, updated_at)
      VALUES ('con-legacy', 'doc-legacy', 'nda', 'Legacy Cells Ltd',
              '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
              '2026-01-02T00:00:00.000Z');
    INSERT INTO audit (contract_id, document_id, action, actor, at)
      VALUES (NULL, 'doc-legacy', 'extracted', 'local', '2026-01-01T01:00:00.000Z');
    INSERT INTO audit (contract_id, document_id, action, actor, at)
      VALUES ('con-legacy', 'doc-legacy', 'approved', 'bonnie', '2026-01-02T00:00:00.000Z');
    -- v1 wrote these with a contract id and no document id at all.
    INSERT INTO audit (contract_id, document_id, action, actor, at)
      VALUES ('con-legacy', NULL, 'exported', 'bonnie', '2026-01-03T00:00:00.000Z');
    INSERT INTO audit (contract_id, document_id, action, field_key, old_value,
                       new_value, actor, at)
      VALUES ('con-legacy', NULL, 'edited', 'governing_law', 'Delaware', 'New York',
              'bonnie', '2026-01-04T00:00:00.000Z');
  `);
  // A row pointing at a contract that no longer exists, which a v1 file could
  // accumulate while foreign keys were off. The rebuild must not choke on it.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`INSERT INTO audit (contract_id, document_id, action, actor, at)
      VALUES ('con-vanished', NULL, 'archived', 'bonnie', '2026-01-05T00:00:00.000Z');`);
  db.exec('PRAGMA foreign_keys = ON');
  db.close();
}

/* ═══════════════ CRITICAL 1 -- the trail outlives the contract ══════════ */

describe('v1 -> v2 migration of a database that already has rows', () => {
  beforeAll(() => {
    seedLegacyDatabase(join(legacyDir, 'tracker.db'));
    q.close();
    process.env['IBC_DATA_DIR'] = legacyDir;
  });

  afterAll(() => {
    q.close();
    process.env['IBC_DATA_DIR'] = mainDir;
  });

  it('rebuilds audit without the cascade and keeps every row', () => {
    expect(q.schemaVersion()).toBe(SCHEMA_VERSION);

    const keys = q
      .db()
      .prepare("PRAGMA foreign_key_list('audit')")
      .all()
      .filter((k) => k['from'] === 'contract_id');
    expect(keys).toHaveLength(1);
    expect(keys[0]?.['on_delete']).toBe('SET NULL');

    // Same five rows, same ids: a rebuild that renumbered history would be its
    // own kind of forgery.
    const rows = q.db().prepare('SELECT id, action FROM audit ORDER BY id').all();
    expect(rows.map((r) => r['action'])).toEqual([
      'extracted',
      'approved',
      'exported',
      'edited',
      'archived',
    ]);
    expect(rows.map((r) => r['id'])).toEqual([1, 2, 3, 4, 5]);
  });

  it('backfills document_id so a row that knew only its contract still resolves', () => {
    const rows = q
      .db()
      .prepare("SELECT document_id FROM audit WHERE action IN ('exported', 'edited')")
      .all();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r['document_id']).toBe('doc-legacy');
  });

  it('nulls a reference to a contract that was already gone', () => {
    const row = q.db().prepare("SELECT contract_id FROM audit WHERE action = 'archived'").get();
    expect(row?.['contract_id']).toBeNull();
  });

  it('adds the read-provenance columns to an existing documents table', () => {
    const names = q
      .db()
      .prepare('PRAGMA table_info(documents)')
      .all()
      .map((c) => c['name']);
    expect(names).toContain('text_source');
    expect(names).toContain('ocr_confidence');
    expect(names).toContain('pages_read');
  });

  it('makes idx_contracts_document partial so a removed record can be re-approved', () => {
    const row = q
      .db()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_contracts_document');
    expect(String(row?.['sql'])).toMatch(/archived_at IS NULL/);
  });

  it('keeps the approved, edited and exported rows when the contract is dropped', () => {
    // The exact call three user-visible actions make: "Send back to the Inbox",
    // "Re-read this document", and the Undo on bulk approve.
    q.unapproveContract('con-legacy', { actor: 'bonnie' });

    expect(q.db().prepare('SELECT count(*) AS n FROM contracts').get()?.['n']).toBe(0);

    const trail = q.getDocumentAudit('doc-legacy').map((a) => a.action);
    expect(trail).toContain('approved');
    expect(trail).toContain('edited');
    expect(trail).toContain('exported');
    expect(trail).toContain('unapproved');

    // Nulled, not deleted -- that is the whole difference.
    const orphans = q
      .db()
      .prepare("SELECT count(*) AS n FROM audit WHERE contract_id IS NULL AND action = 'approved'")
      .get();
    expect(orphans?.['n']).toBe(1);
  });

  it('rewrites nothing on a second open', () => {
    const before = q.db().prepare('SELECT count(*) AS n FROM audit').get()?.['n'];
    q.close();
    expect(q.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(q.db().prepare('SELECT count(*) AS n FROM audit').get()?.['n']).toBe(before);
  });
});

/* ══════════════════════════ The rest, on a fresh file ═══════════════════ */

const BASE_FIELDS = [
  { key: 'party_a' as const, value: 'International Battery Company, Inc.', method: 'model' as const },
  { key: 'party_b' as const, value: 'Octillion Power Supply, Inc.', method: 'model' as const },
  { key: 'contract_name' as const, value: 'Mutual Nondisclosure Agreement', method: 'rule' as const },
  { key: 'effective_date' as const, value: '2026-01-14', method: 'rule' as const },
  { key: 'term' as const, value: '3 years', method: 'rule' as const },
  { key: 'governing_law' as const, value: 'Delaware', method: 'rule' as const },
];

/** A document with every required field answered, parked at `status`. */
function readyDocument(hash: string, status: 'ready' | 'needs_attention' = 'ready'): string {
  const { id } = q.createDocument({ fileHash: hash, filename: `${hash}.pdf` });
  q.updateDocument(id, { docType: 'nda', status });
  q.replaceDocumentFields(id, BASE_FIELDS);
  return id;
}

describe('approve is gated on status, not only on fields', () => {
  it('lists the approvable statuses in exactly one place', () => {
    expect([...q.APPROVABLE_STATUSES]).toEqual(['ready', 'needs_attention']);
    expect(q.isApprovable('ready')).toBe(true);
    expect(q.isApprovable('needs_attention')).toBe(true);
    expect(q.isApprovable('rejected')).toBe(false);
    expect(q.isApprovable('failed')).toBe(false);
    expect(q.isApprovable('queued')).toBe(false);
  });

  it('refuses a rejected document even though it has no unresolved fields', () => {
    const id = readyDocument('gate-rejected');
    q.rejectDocument(id, { actor: 'bonnie', reason: 'superseded' });

    // The trap: rejecting only flips the status, so the evidence -- and therefore
    // the field gate both approve routes relied on -- is completely satisfied.
    expect(q.unresolvedRequiredFields(id)).toEqual([]);
    expect(q.approvalStatusBlocker(id)).toBe('rejected');
    expect(q.approvalStatusMessage('rejected')).toMatch(/set aside/i);

    expect(() => q.approveDocument(id)).toThrow();
    try {
      q.approveDocument(id);
    } catch (e) {
      expect(String((e as { detail?: string }).detail)).toContain('status is rejected');
    }
    expect(q.getContractForDocument(id)).toBeNull();
  });

  it('refuses a document still moving through the pipeline', () => {
    const id = readyDocument('gate-extracting');
    q.updateDocument(id, { status: 'extracting' });
    expect(q.approvalStatusBlocker(id)).toBe('extracting');
    expect(() => q.approveDocument(id)).toThrow();
  });

  it('refuses a failed document', () => {
    const id = readyDocument('gate-failed');
    q.failDocument(id, 'PDF_ENCRYPTED', 'locked');
    expect(q.approvalStatusBlocker(id)).toBe('failed');
    expect(() => q.approveDocument(id)).toThrow();
  });

  it('still allows the two approvable statuses, and stays idempotent', () => {
    const ready = readyDocument('gate-ready');
    expect(q.approvalStatusBlocker(ready)).toBeNull();
    const contractId = q.approveDocument(ready);
    expect(q.getContractDetail(contractId)).not.toBeNull();
    // Approved, with a live record: a re-approve is the no-op the bulk loop needs,
    // not a refusal, even though 'approved' is not an approvable status.
    expect(q.approvalStatusBlocker(ready)).toBeNull();
    expect(q.approveDocument(ready)).toBe(contractId);

    const attention = readyDocument('gate-attention', 'needs_attention');
    expect(q.approvalStatusBlocker(attention)).toBeNull();
    expect(q.getContractDetail(q.approveDocument(attention))).not.toBeNull();
  });
});

describe('archive is recoverable and does not strand its document', () => {
  let documentId = '';
  let archivedId = '';

  it('removes the record and leaves the document reachable', () => {
    documentId = readyDocument('archive-1');
    archivedId = q.approveDocument(documentId, { actor: 'bonnie' });
    q.archiveContract(archivedId, { actor: 'bonnie' });

    expect(q.getContractDetail(archivedId)).toBeNull();
    // 'approved' would be a dead end: the upload route refuses a re-drop as a
    // duplicate for every status except 'rejected'.
    expect(q.getDocument(documentId)?.status).toBe('rejected');
  });

  it('lists what was removed', () => {
    const removed = q.listArchivedContracts();
    expect(removed.total).toBe(1);
    expect(removed.rows[0]?.id).toBe(archivedId);
    expect(removed.rows[0]?.archivedAt).not.toBeNull();
    expect(q.getArchivedContract(archivedId)?.counterparty).toBe('Octillion Power Supply, Inc.');
    // The two lists are complements: nothing appears in both, nothing in neither.
    expect(q.listContracts().rows.some((r) => r.id === archivedId)).toBe(false);
  });

  it('restores it, with the document approved again', () => {
    q.restoreContract(archivedId, { actor: 'bonnie' });
    expect(q.getContractDetail(archivedId)).not.toBeNull();
    expect(q.getDocument(documentId)?.status).toBe('approved');
    expect(q.listArchivedContracts().total).toBe(0);
    expect(q.getContractAudit(archivedId).some((a) => a.action === 'restored')).toBe(true);
    // Idempotent: the toast button can be pressed twice.
    q.restoreContract(archivedId);
    expect(q.getContractDetail(archivedId)).not.toBeNull();
  });

  it('lets a removed record be approved again into a visible one', () => {
    q.archiveContract(archivedId);
    // The v1 early-out matched archived contracts too, so this returned the
    // archived id and reported success while the record stayed invisible.
    q.updateDocument(documentId, { status: 'ready' });
    const reapproved = q.approveDocument(documentId);
    expect(reapproved).not.toBe(archivedId);
    expect(q.getContractDetail(reapproved)).not.toBeNull();
    expect(q.listArchivedContracts().total).toBe(1);
  });

  it('refuses to restore over a live record rather than violating the index', () => {
    expect(() => q.restoreContract(archivedId)).toThrow();
    const live = q.liveContractIdForDocument(documentId);
    expect(live).not.toBe(archivedId);
    // Once the live record is gone, the removed one can come back.
    q.unapproveContract(String(live));
    q.restoreContract(archivedId);
    expect(q.getContractDetail(archivedId)).not.toBeNull();
  });

  it('keeps every audit row across all of that', () => {
    const trail = q.getContractAudit(archivedId).map((a) => a.action);
    expect(trail).toContain('approved');
    expect(trail).toContain('archived');
    expect(trail).toContain('restored');
    expect(trail).toContain('unapproved');
  });
});

describe('post-approval edits survive unapprove', () => {
  it('writes contract edits back into the document evidence', () => {
    const documentId = readyDocument('lossless-1');
    const contractId = q.approveDocument(documentId, { actor: 'bonnie' });

    q.setContractField(contractId, 'governing_law', 'New York', 'bonnie');
    q.setContractField(contractId, 'party_b', 'Ntrium, Inc.', 'bonnie');
    q.setContractField(contractId, 'notice_email', 'legal@ntrium.example', 'bonnie');

    const fields = q.getDocumentFields(documentId);
    const valueOf = (key: string): string | null =>
      fields.find((f) => f.key === key)?.value ?? null;
    expect(valueOf('governing_law')).toBe('New York');
    expect(valueOf('party_b')).toBe('Ntrium, Inc.');
    expect(valueOf('notice_email')).toBe('legal@ntrium.example');
    // A hand-typed value is 'manual' and carries no quote: the evidence belonged
    // to the value that was there before.
    expect(fields.find((f) => f.key === 'governing_law')?.method).toBe('manual');
    expect(fields.find((f) => f.key === 'governing_law')?.quote).toBeNull();

    // The Undo path, verbatim: unapprove, then approve again.
    q.unapproveContract(contractId, { actor: 'bonnie' });
    const rebuilt = q.approveDocument(documentId, { actor: 'bonnie' });
    expect(rebuilt).not.toBe(contractId);

    const after = q.getContractDetail(rebuilt);
    expect(after?.governingLaw).toBe('New York');
    expect(after?.counterparty).toBe('Ntrium, Inc.');
    expect(after?.noticeEmail).toBe('legal@ntrium.example');
  });

  it('carries a manual termination override through the round trip', () => {
    const documentId = readyDocument('lossless-2');
    const contractId = q.approveDocument(documentId);
    expect(q.getContractDetail(contractId)?.terminationDate).toBe('2029-01-14');

    const overridden = q.setContractField(contractId, 'termination_date', '2030-06-30', 'bonnie');
    expect(overridden.terminationOverride).toBe(true);

    q.unapproveContract(contractId);
    const rebuilt = q.getContractDetail(q.approveDocument(documentId));
    expect(rebuilt?.terminationDate).toBe('2030-06-30');
    expect(rebuilt?.terminationOverride).toBe(true);
  });

  it('keeps a field cleared after approval cleared', () => {
    const documentId = readyDocument('lossless-3');
    const contractId = q.approveDocument(documentId);
    q.setContractField(contractId, 'governing_law', null, 'bonnie');
    // Cleared is 'na', an acknowledged gap -- so it does not re-block approve.
    expect(q.getDocumentFields(documentId).find((f) => f.key === 'governing_law')?.method).toBe('na');
    expect(q.unresolvedRequiredFields(documentId)).toEqual([]);

    q.unapproveContract(contractId);
    expect(q.getContractDetail(q.approveDocument(documentId))?.governingLaw).toBeNull();
  });
});

describe('read provenance travels with the document', () => {
  it('is settable through updateDocument and readable on both shapes', () => {
    const id = readyDocument('provenance-1');
    expect(q.getDocument(id)?.textSource).toBeNull();
    expect(q.getDocument(id)?.ocrConfidence).toBeNull();
    expect(q.getDocument(id)?.pagesRead).toBeNull();

    q.updateDocument(id, { textSource: 'ocr', ocrConfidence: 0.82, pagesRead: 7 });

    const detail = q.getDocument(id);
    expect(detail?.textSource).toBe('ocr');
    expect(detail?.ocrConfidence).toBeCloseTo(0.82, 6);
    expect(detail?.pagesRead).toBe(7);

    const summary = q.getDocumentSummary(id);
    expect(summary?.textSource).toBe('ocr');
    expect(summary?.pagesRead).toBe(7);

    expect(q.listDocuments({ statuses: ['ready'] }).find((d) => d.id === id)?.textSource).toBe('ocr');
  });

  it('reads an unknown stored source as null rather than inventing one', () => {
    const id = readyDocument('provenance-2');
    q.db().prepare('UPDATE documents SET text_source = ? WHERE id = ?').run('telepathy', id);
    expect(q.getDocument(id)?.textSource).toBeNull();
  });
});

describe('audit actions', () => {
  it('names every action the app writes', () => {
    for (const action of ['reextracted', 'reopened', 'unarchived', 'restored'] as const) {
      expect(q.AUDIT_ACTIONS).toContain(action);
    }
  });

  it('stamps document_id even when the caller only had a contract', () => {
    const documentId = readyDocument('audit-stamp');
    const contractId = q.approveDocument(documentId);
    // markExported passes a contract id and nothing else.
    q.recordExport([contractId]);
    const row = q
      .db()
      .prepare("SELECT document_id FROM audit WHERE contract_id = ? AND action = 'exported'")
      .get(contractId);
    expect(row?.['document_id']).toBe(documentId);
  });
});
