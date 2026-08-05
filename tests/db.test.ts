/**
 * The database layer, end to end against a real SQLite file in a temp dir.
 *
 * IBC_DATA_DIR is set before the module is imported, because paths.ts reads it at
 * call time and client.ts opens on first use -- a static import would race the
 * env var and write into the user's real Application Support folder.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ibc-db-'));
process.env['IBC_DATA_DIR'] = dir;

const q = await import('@/lib/db');
// The constant, not a literal: pinning the number here means every future migration
// fails a test that has nothing to do with what it changed.
const { SCHEMA_VERSION } = await import('@/lib/db/migrate');

afterAll(() => { try { q.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const FIELDS_A = [
  { key: 'party_a' as const, value: 'International Battery Company, Inc.', method: 'model' as const, quote: 'between International Battery Company, Inc.', page: 1 },
  { key: 'party_b' as const, value: 'Octillion Power Supply, Inc.', method: 'model' as const, quote: 'and Octillion Power Supply, Inc.', page: 1 },
  { key: 'party_a_signer' as const, value: 'Priya Raman', method: 'model' as const },
  { key: 'party_b_signer' as const, value: 'Dale Whitcomb', method: 'model' as const },
  { key: 'contract_name' as const, value: 'Evaluation Agreement', method: 'rule' as const },
  { key: 'effective_date' as const, value: '2026-07-02', method: 'rule' as const },
  { key: 'term' as const, value: '90 days', method: 'rule' as const },
  { key: 'confidentiality_term' as const, value: 'five (5) years', method: 'model' as const },
  { key: 'governing_law' as const, value: 'Delaware', method: 'rule' as const },
];

describe('db layer', () => {
  let docId = '';
  let contractId = '';

  it('migrates and reports a version', () => {
    expect(q.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(q.tableCounts().find((t) => t.table === 'documents')?.rows).toBe(0);
  });

  it('creates a document and dedupes by hash', () => {
    const a = q.createDocument({ fileHash: 'h1', filename: 'Octillion_Eval.pdf', byteSize: 1234 });
    docId = a.id;
    expect(a.duplicate).toBe(false);
    const b = q.createDocument({ fileHash: 'h1', filename: 'Octillion_Eval copy.pdf' });
    expect(b).toEqual({ id: docId, duplicate: true });
    expect(q.findDocumentByHash('h1')?.id).toBe(docId);
    expect(q.getDocumentByHash('nope')).toBeNull();
  });

  it('patches a document generically', () => {
    q.updateDocument(docId, { pageCount: 5, hasTextLayer: 1, status: 'extracting', docType: 'evaluation', archivePath: '/a/b.pdf', thumbnailPath: 't.png' });
    const d = q.getDocument(docId);
    expect(d?.pageCount).toBe(5);
    expect(d?.hasTextLayer).toBe(true);
    expect(d?.archivePath).toBe('/a/b.pdf');
    expect(d?.thumbnailUrl).toBe(`/api/documents/${docId}/thumbnail`);
    expect(d?.pdfUrl).toBe(`/api/documents/${docId}/pdf`);
    expect(q.getDocumentFiles(docId)?.archivePath).toBe('/a/b.pdf');
  });

  it('writes fields and computes termination', () => {
    q.replaceDocumentFields(docId, FIELDS_A);
    const fields = q.getDocumentFields(docId);
    expect(fields).toHaveLength(16);
    const term = fields.find((f) => f.key === 'termination_date');
    expect(term?.value).toBe('2026-09-30');
    expect(term?.method).toBe('computed');
    expect(term?.readOnly).toBe(true);
    expect(fields.find((f) => f.key === 'notice_email')?.method).toBe('missing');
    expect(fields.find((f) => f.key === 'party_a')?.confidence).toBe('medium');
    expect(fields.find((f) => f.key === 'term')?.confidence).toBe('high');
  });

  it('counts confidence for the inbox card', () => {
    const s = q.getDocumentSummary(docId);
    expect(s?.counterparty).toBe('Octillion Power Supply, Inc.');
    const { high, medium, none } = s!.counts;
    expect(high + medium + none).toBe(16);
    expect(medium).toBe(5);
  });

  it('blocks approve until required fields are resolved', () => {
    q.updateDocument(docId, { status: 'ready' });
    expect(q.unresolvedRequiredFields(docId)).toEqual([]);
    const d2 = q.createDocument({ fileHash: 'h2', filename: 'blank.pdf' });
    expect(q.unresolvedRequiredFields(d2.id).sort()).toEqual(
      ['contract_name', 'effective_date', 'governing_law', 'party_a', 'party_b', 'term'].sort(),
    );
    // 'ready' first: the status gate fires before the field gate, so a queued
    // document would be refused for the wrong reason.
    q.updateDocument(d2.id, { status: 'ready' });
    try { q.approveDocument(d2.id); throw new Error('should have thrown'); }
    catch (e) { expect(String((e as { detail?: string }).detail)).toMatch(/approve blocked/); }
    expect(q.getDocument(d2.id)?.status).toBe('ready');
  });

  it('edits a field and recomputes derived values', () => {
    const fields = q.setDocumentField(docId, 'term', '2 years');
    expect(fields.find((f) => f.key === 'termination_date')?.value).toBe('2028-07-02');
    expect(q.getDocumentAudit(docId).some((a) => a.action === 'edited' && a.fieldKey === 'term')).toBe(true);
    q.setDocumentField(docId, 'term', '90 days');
    expect(q.getDocumentFields(docId).find((f) => f.key === 'termination_date')?.value).toBe('2026-09-30');
  });

  it('marks a field explicitly not-in-document', () => {
    const fields = q.setDocumentField(docId, 'notice_email', null, 'na');
    expect(fields.find((f) => f.key === 'notice_email')?.method).toBe('na');
  });

  it('approves in one transaction', () => {
    contractId = q.approveDocument(docId, { actor: 'bonnie' });
    expect(q.getDocument(docId)?.status).toBe('approved');
    const c = q.getContractDetail(contractId);
    expect(c?.counterparty).toBe('Octillion Power Supply, Inc.');
    expect(c?.docType).toBe('evaluation');
    expect(c?.effectiveDate).toBe('2026-07-02');
    expect(c?.terminationDate).toBe('2026-09-30');
    expect(c?.confidentialityEnd).toBe('2031-07-02');
    expect(c?.termDays).toBe(90);
    expect(c?.governingLaw).toBe('Delaware');
    expect(c?.filename).toBe('Octillion_Eval.pdf');
    expect(c?.parties.map((p) => [p.role, p.isIbc])).toEqual([['a', true], ['b', false]]);
    expect(q.getContractFields(contractId)).toHaveLength(16);
    expect(q.getContractForDocument(docId)?.id).toBe(contractId);
    // idempotent
    expect(q.approveDocument(docId)).toBe(contractId);
  });

  it('computes both statuses at read time', () => {
    const page = q.listContracts({ today: '2026-10-01' });
    expect(page.total).toBe(1);
    const row = page.rows[0]!;
    expect(row.agreementStatus).toBe('expired');
    expect(row.confidentialityStatus).toBe('active');
    expect(q.listContracts({ today: '2026-08-15' }).rows[0]!.agreementStatus).toBe('expiring');
  });

  /**
   * The 90-day evaluation agreement with a five-year duty of confidence: by
   * 2026-10-01 the agreement has lapsed and the obligation has not. Filtering on
   * agreementStatus alone put this record under Expired, which answers "is it
   * still in effect?" with a flat no while something is still binding. The filter
   * reads whichever clock runs longest, the way the Expiring view already does.
   */
  it('filters on the clock that binds longest, not on the agreement alone', () => {
    expect(q.listContracts({ filter: 'expired', today: '2026-10-01' }).total).toBe(0);
    expect(q.listContracts({ filter: 'active', today: '2026-10-01' }).total).toBe(1);
    // Inside the confidentiality window, the record is what the Expiring view says.
    expect(q.listContracts({ filter: 'expiring', today: '2031-05-01' }).total).toBe(1);
    // Both clocks done: now, and only now, it is expired.
    expect(q.listContracts({ filter: 'expired', today: '2032-01-01' }).total).toBe(1);
    expect(q.listContracts({ filter: 'active', today: '2032-01-01' }).total).toBe(0);
  });

  it('audits the approve and shows the extraction above it', () => {
    const trail = q.getContractAudit(contractId).map((a) => a.action);
    expect(trail).toContain('approved');
    expect(trail).toContain('edited');
  });

  it('searches by FTS, by LIKE, and fuzzily', () => {
    expect(q.listContracts({ search: 'octillion' }).total).toBe(1);
    expect(q.listContracts({ search: 'Whitcomb' }).total).toBe(1);
    expect(q.listContracts({ search: 'delaware' }).total).toBe(1);
    expect(q.listContracts({ search: 'evaluation' }).total).toBe(1);
    expect(q.listContracts({ search: 'oc' }).total).toBe(1);          // LIKE, under 3 chars
    expect(q.listContracts({ search: 'octilion' }).total).toBe(1);    // fuzzy, typo
    expect(q.listContracts({ search: 'ntrium' }).total).toBe(0);
    expect(q.listContracts({ search: 'octillion*"' }).total).toBe(1); // FTS syntax as data
  });

  it('keeps the index in sync when a party changes', () => {
    q.setContractField(contractId, 'party_b', 'Ntrium, Inc.', 'bonnie');
    expect(q.listContracts({ search: 'ntrium' }).total).toBe(1);
    expect(q.listContracts({ search: 'octillion' }).total).toBe(0);
    expect(q.getContractDetail(contractId)?.counterparty).toBe('Ntrium, Inc.');
    q.setContractField(contractId, 'party_b', 'Octillion Power Supply, Inc.', 'bonnie');
  });

  it('recomputes and audits a post-approval edit', () => {
    const after = q.setContractField(contractId, 'effective_date', 'November 5, 2022', 'bonnie');
    expect(after.effectiveDate).toBe('2022-11-05');
    expect(after.terminationDate).toBe('2023-02-03');
    expect(after.confidentialityEnd).toBe('2027-11-05');
    expect(after.editedAt).not.toBeNull();
    const entry = q.getContractAudit(contractId).find((a) => a.fieldKey === 'effective_date');
    expect(entry?.oldValue).toBe('2026-07-02');
    expect(entry?.newValue).toBe('November 5, 2022');
  });

  it('honours a manual termination override', () => {
    const after = q.setContractField(contractId, 'termination_date', '2030-01-01', 'bonnie');
    expect(after.terminationOverride).toBe(true);
    expect(after.terminationDate).toBe('2030-01-01');
    const still = q.setContractField(contractId, 'term', '1 year', 'bonnie');
    expect(still.terminationDate).toBe('2030-01-01');
  });

  it('sorts and pages', () => {
    for (const [h, name] of [['h3', 'Acme Cells GmbH'], ['h4', 'Zeta Materials Ltd']] as const) {
      const d = q.createDocument({ fileHash: h, filename: `${name}.pdf` });
      q.updateDocument(d.id, { docType: 'nda', status: 'ready' });
      q.replaceDocumentFields(d.id, [
        { key: 'party_a', value: 'International Battery Company, Inc.', method: 'rule' },
        { key: 'party_b', value: name, method: 'rule' },
        { key: 'contract_name', value: 'Mutual Nondisclosure Agreement', method: 'rule' },
        { key: 'effective_date', value: '2024-01-14', method: 'rule' },
        { key: 'term', value: '3 years', method: 'rule' },
        { key: 'governing_law', value: 'California', method: 'rule' },
      ]);
      q.approveDocument(d.id);
    }
    const asc = q.listContracts({ sort: 'counterparty', dir: 'asc' });
    expect(asc.total).toBe(3);
    expect(asc.rows.map((r) => r.counterparty)).toEqual(['Acme Cells GmbH', 'Octillion Power Supply, Inc.', 'Zeta Materials Ltd']);
    expect(q.listContracts({ sort: 'counterparty', dir: 'desc' }).rows[0]!.counterparty).toBe('Zeta Materials Ltd');
    const p1 = q.listContracts({ sort: 'counterparty', limit: 2, offset: 0 });
    const p2 = q.listContracts({ sort: 'counterparty', limit: 2, offset: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows).toHaveLength(1);
    expect(p1.total).toBe(3);
    expect(q.listContracts({ docType: 'nda' }).total).toBe(2);
    expect(q.listContracts({ sort: 'status', today: '2026-10-01' }).rows).toHaveLength(3);
  });

  it('rolls contracts up for export', () => {
    expect(q.contractCountsByDocType()).toEqual({ nda: 2, evaluation: 1, other: 0 });
    expect(q.contractsForExport('nda')).toHaveLength(2);
    expect(q.contractsForExport()).toHaveLength(3);
    const rows = q.contractsForExport('nda');
    expect(rows[0]!.fields).toHaveLength(16);
    q.recordExport(rows.map((r) => r.contract.id));
    expect(q.getSettings().lastExportedAt).not.toBeNull();
  });

  it('reads and writes settings with defaults', () => {
    const s = q.getSettings();
    expect(s.provider).toBe('cli');
    expect(s.tier).toBe('balanced');
    expect(s.hasApiKey).toBe(false);
    expect(s.glassIntensity).toBe(0.8);
    expect(s.onboardingComplete).toBe(false);
    q.updateSettings({ provider: 'api', tier: 'deep', glassIntensity: 0.25, watchFolder: '/x/y', onboardingComplete: true, hasApiKey: true });
    const t = q.getSettings({ hasApiKey: true, apiKeySource: 'keychain' });
    expect(t.provider).toBe('api');
    expect(t.tier).toBe('deep');
    expect(t.glassIntensity).toBe(0.25);
    expect(t.watchFolder).toBe('/x/y');
    expect(t.onboardingComplete).toBe(true);
    expect(t.apiKeySource).toBe('keychain');
    // hasApiKey is never persisted
    expect(q.getSettings().hasApiKey).toBe(false);
    expect(q.getSetting('escalateOnLowYield')).toBeNull();
    q.updateSettings({ escalateOnLowYield: true });
    expect(q.getSetting('escalateOnLowYield')).toBe('true');
  });

  it('logs usage and rolls up the month', () => {
    const month = new Date().toISOString().slice(0, 7);
    q.insertUsageLog({ documentId: docId, provider: 'api', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 200, costUsd: 0.006, cached: 0, ok: 1, errorCode: null });
    q.insertUsageLog({ documentId: docId, provider: 'api', model: 'claude-sonnet-5', inputTokens: 0, outputTokens: 0, costUsd: 0, cached: 1, ok: true, errorCode: null });
    const r = q.usageRollup();
    expect(r.month).toBe(month);
    expect(r.calls).toBe(2);
    expect(r.documents).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.006, 6);
    expect(r.daily).toHaveLength(1);
    expect(q.usageRollup('1999-01').calls).toBe(0);
  });

  it('caches an extraction and counts hits', () => {
    expect(q.getCachedExtraction('k1')).toBeNull();
    q.putCachedExtraction({ cacheKey: 'k1', fileHash: 'h1', model: 'm', promptVersion: 'v1', responseJson: '{"ok":true}' });
    const hit = q.getCachedExtraction('k1');
    expect(hit?.responseJson).toBe('{"ok":true}');
    expect(q.getCachedExtraction('k1')?.hits).toBe(1);
    q.clearCache('h1');
    expect(q.getCachedExtraction('k1')).toBeNull();
  });

  it('surfaces recent errors in plain English with the key redacted', () => {
    const d = q.createDocument({ fileHash: 'h9', filename: 'scan.pdf' });
    q.failDocument(d.id, 'PDF_NO_TEXT_LAYER', 'x-api-key: sk-ant-abcdefghijklmnop failed');
    const errs = q.recentErrors();
    expect(errs[0]?.code).toBe('PDF_NO_TEXT_LAYER');
    expect(errs[0]?.message).toBe('This PDF is a scan with no selectable text.');
    expect(errs[0]?.detail).not.toContain('sk-ant-abcdefghijklmnop');
    expect(q.getDocumentSummary(d.id)?.errorMessage).toBe('This PDF is a scan with no selectable text.');
    q.clearDocumentError(d.id);
    expect(q.getDocumentSummary(d.id)?.errorCode).toBeNull();
    q.setDocumentStatus(d.id, 'queued');
    expect(q.markDocumentQueued(d.id)?.status).toBe('queued');
    expect(q.markDocumentQueued('nope')).toBeNull();
  });

  it('reports stats for the sidebar', () => {
    const s = q.getStats('2026-10-01');
    expect(s.contracts).toBe(3);
    expect(s.expired).toBeGreaterThanOrEqual(0);
    expect(s.inbox).toBeGreaterThanOrEqual(1);
    expect(typeof s.monthCostUsd).toBe('number');
    expect(q.listDocumentIdsByStatus(['queued']).length).toBeGreaterThanOrEqual(1);
    expect(q.listInboxDocuments().length).toBeGreaterThanOrEqual(1);
  });

  it('rejects and unapproves as states, not deletes', () => {
    const d = q.createDocument({ fileHash: 'h10', filename: 'nope.pdf' });
    q.rejectDocument(d.id, { actor: 'bonnie', reason: 'superseded' });
    expect(q.getDocument(d.id)?.status).toBe('rejected');

    const backTo = q.unapproveContract(contractId, { actor: 'bonnie' });
    expect(backTo).toBe(docId);
    expect(q.getDocument(docId)?.status).toBe('ready');
    expect(q.getContractDetail(contractId)).toBeNull();
    expect(q.listContracts({ search: 'octillion' }).total).toBe(0);
    // The document's own evidence survived, so Review comes back intact.
    expect(q.getDocumentFields(docId).find((f) => f.key === 'party_b')?.value).toBe('Octillion Power Supply, Inc.');
    const again = q.approveDocument(docId);
    expect(again).not.toBe(contractId);
    contractId = again;
  });

  it('archives a contract without losing the audit trail', () => {
    q.archiveContract(contractId, { actor: 'bonnie' });
    expect(q.getContractDetail(contractId)).toBeNull();
    expect(q.listContracts({}).total).toBe(2);
    expect(q.getContractAudit(contractId).some((a) => a.action === 'archived')).toBe(true);
  });

  it('rolls back a failed transaction whole', () => {
    const before = q.tableCounts();
    expect(() =>
      q.tx(() => {
        q.createDocument({ fileHash: 'h11', filename: 'rollback.pdf' });
        throw new Error('boom');
      }),
    ).toThrow();
    expect(q.tableCounts()).toEqual(before);
    expect(q.getDocumentByHash('h11')).toBeNull();
  });

  it('joins a nested transaction instead of nesting BEGIN', () => {
    const id = q.tx(() => q.tx(() => q.createDocument({ fileHash: 'h12', filename: 'nested.pdf' }).id));
    expect(q.getDocument(id)).not.toBeNull();
    expect(q.inTransaction()).toBe(false);
  });

  it('refuses to commit when a nested failure was swallowed', () => {
    expect(() =>
      q.tx(() => {
        try {
          q.tx(() => {
            q.createDocument({ fileHash: 'h13', filename: 'poison.pdf' });
            throw new Error('inner');
          });
        } catch {
          /* swallowed on purpose */
        }
      }),
    ).toThrow(/UNKNOWN/);
    expect(q.getDocumentByHash('h13')).toBeNull();
  });

  it('rebuilds the search index from scratch', () => {
    expect(q.rebuildSearchIndex(q.db())).toBe(3); // includes the archived row; listContracts filters it
    expect(q.listContracts({ search: 'acme' }).total).toBe(1);
  });

  it('refuses to delete a document a contract points at', () => {
    const live = q.listContracts({}).rows[0]!;
    expect(() => q.deleteDocument(live.documentId)).toThrow();
    const d = q.createDocument({ fileHash: 'h14', filename: 'gone.pdf' });
    q.deleteDocument(d.id);
    expect(q.getDocument(d.id)).toBeNull();
  });

  /**
   * Crash recovery, at its only real call site.
   *
   * `extracting` is a claim the previous process made, and a claim does not
   * survive a restart. ExtractionQueue.recover() has always known that; nothing
   * called it, so a document caught mid-flight stayed "extracting" in the Inbox
   * indefinitely. The assertion is on register(), not on recover(), because the
   * defect was never in the method.
   *
   * The queue is paused first: this is a database test and it must not reach an
   * engine. Pausing does not touch the re-queue, which is a synchronous write.
   */
  it('re-queues a document the last process left mid-flight', async () => {
    const stranded = q.createDocument({ fileHash: 'h15', filename: 'mid-flight.pdf' });
    q.updateDocument(stranded.id, { status: 'extracting' });

    const { extractionQueue } = await import('@/lib/extraction/queue');
    extractionQueue.pause();

    const runtime = process.env['NEXT_RUNTIME'];
    process.env['NEXT_RUNTIME'] = 'nodejs';
    try {
      const { register } = await import('@/instrumentation');
      await register();
      expect(q.getDocument(stranded.id)?.status).toBe('queued');
    } finally {
      if (runtime === undefined) delete process.env['NEXT_RUNTIME'];
      else process.env['NEXT_RUNTIME'] = runtime;
      // register() also starts the folder poll loop; nothing here wants a timer.
      const { folderWatcher } = await import('@/lib/watch');
      folderWatcher().stop();
    }
  });
});
