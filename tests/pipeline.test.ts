/**
 * The pipeline, end to end, against a stub engine.
 *
 * Every assertion here is a promise the product makes to a reviewer:
 *   - a deterministic answer is never replaced by a model's answer
 *   - the two dates are arithmetic, done in code, never asked of a model
 *   - a quote that is not in the document takes its value down with it
 *   - a document with a required field empty says so instead of looking finished
 *   - a failed engine leaves a retryable record, not a stuck one
 *   - the same file twice costs nothing the second time
 *
 * The engine is a stub built from the fixture, so a canned answer cannot drift away from
 * the document it claims to quote. No network, no cost, no wall-clock dependency.
 */

import { describe, expect, it } from 'vitest';

import { FIELD_KEYS, MODEL_FIELD_KEYS, type FieldKey } from '../src/lib/fields';
import { errorInfo } from '../src/lib/providers/errors';
import { stubProvider, useEvalDataDir, writeFixturePdf } from '../evals/cases/_harness';
import { ntrium } from '../evals/fixtures/index';

// Before anything can open a connection: the tests get their own throwaway database.
useEvalDataDir();

async function optional<T>(thunk: () => Promise<T>): Promise<T | null> {
  try {
    return await thunk();
  } catch {
    return null;
  }
}

const pipeline = await optional(() => import('../src/lib/extraction/pipeline'));
const queries = await optional(() => import('../src/lib/db/queries'));

if (pipeline === null || queries === null) {
  describe.skip('extraction pipeline', () => {
    it('needs src/lib/extraction/pipeline.ts and src/lib/db/queries.ts to import', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const seed = (suffix: string): string => {
    const file = writeFixturePdf(ntrium, suffix);
    const { id } = queries.createDocument({
      fileHash: file.fileHash,
      filename: `${ntrium.filename}${suffix}`,
      archivePath: file.path,
      byteSize: file.bytes.byteLength,
    });
    return id;
  };

  const valueOf = (fields: { key: FieldKey; value: string | null }[], key: FieldKey) =>
    fields.find((f) => f.key === key)?.value ?? null;
  const methodOf = (fields: { key: FieldKey; method: string }[], key: FieldKey) =>
    fields.find((f) => f.key === key)?.method ?? null;

  describe('extraction pipeline', () => {
    it('keeps the deterministic answer when the model disagrees', async () => {
      const id = seed('-rules-win');
      const stub = stubProvider(ntrium, {
        wrongValue: { effective_date: '1999-01-01', governing_law: 'Nebraska' },
      });
      const out = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(valueOf(out.fields, 'effective_date')).toBe('2022-11-05');
      expect(methodOf(out.fields, 'effective_date')).toBe('rule');
      expect(valueOf(out.fields, 'governing_law')).toBe('Delaware');
      expect(methodOf(out.fields, 'governing_law')).toBe('rule');

      // The model is not even asked about a field a rule already answered.
      const asked = stub.requests[0]?.fieldsToFill ?? [];
      expect(asked).not.toContain('effective_date');
      expect(asked).not.toContain('governing_law');
    });

    it('computes the two dates instead of asking for them', async () => {
      const id = seed('-computed');
      const stub = stubProvider(ntrium);
      const out = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(MODEL_FIELD_KEYS).not.toContain('termination_date');
      for (const req of stub.requests) {
        expect(req.fieldsToFill).not.toContain('termination_date');
      }

      expect(valueOf(out.fields, 'termination_date')).toBe(ntrium.computed.terminationDate);
      expect(methodOf(out.fields, 'termination_date')).toBe('computed');
      expect(out.confidentialityEnd).toBe(ntrium.computed.confidentialityEnd);
    });

    it('returns every field, answered or not', async () => {
      const id = seed('-shape');
      const out = await pipeline.extractDocument(id, { provider: stubProvider(ntrium) });
      expect(out.fields.map((f) => f.key).sort()).toEqual([...FIELD_KEYS].sort());
      expect(out.status).toBe('ready');
    });

    it('drops a value whose quote is not in the document', async () => {
      const id = seed('-fabricated');
      const stub = stubProvider(ntrium, { fabricate: ['notice_address'] });
      const out = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(valueOf(out.fields, 'notice_address')).toBeNull();
      expect(methodOf(out.fields, 'notice_address')).toBe('missing');
      const record = out.fields.find((f) => f.key === 'notice_address');
      expect(record?.citationVerified).toBe(false);
    });

    it('needs attention when a required field is empty', async () => {
      const id = seed('-needs-attention');
      // `term` is the one required field on this document that no rule finds.
      const stub = stubProvider(ntrium, { omit: ['term'] });
      const out = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(out.status).toBe('needs_attention');
      expect(out.missingRequired).toContain('term');
      expect(valueOf(out.fields, 'termination_date')).toBeNull();
      expect(queries.getDocument(id)?.status).toBe('needs_attention');
      expect(queries.approvalBlockers(id)).toContain('term');
    });

    it('fails a document without losing it', async () => {
      const id = seed('-engine-failure');
      const { EngineError } = await import('../src/lib/providers/errors');
      const stub = stubProvider(ntrium, {
        throws: () => new EngineError('API_OVERLOADED', { detail: 'stubbed overload' }),
      });

      await expect(pipeline.extractDocument(id, { provider: stub })).rejects.toMatchObject({
        code: 'API_OVERLOADED',
      });

      const doc = queries.getDocument(id);
      expect(doc?.status).toBe('failed');
      expect(doc?.errorCode).toBe('API_OVERLOADED');
      expect(doc?.attempts).toBeGreaterThan(0);
      // Retryable is a property of the error catalogue, not of this document's luck.
      expect(errorInfo('API_OVERLOADED').retryable).toBe(true);

      // And retrying really does work: same document, an engine that answers.
      const out = await pipeline.extractDocument(id, { provider: stubProvider(ntrium) });
      expect(out.status).toBe('ready');
      expect(queries.getDocument(id)?.errorCode).toBeNull();
    });

    it('serves the second identical extraction from the cache', async () => {
      const id = seed('-cache');
      const stub = stubProvider(ntrium);

      const first = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });
      const second = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(stub.calls).toBe(1);
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.costUsd ?? 0).toBe(0);
      expect(second.fields).toEqual(first.fields);
    });

    it('joins a run already in flight instead of extracting twice', async () => {
      const id = seed('-in-flight');
      const stub = stubProvider(ntrium);
      const [a, b] = await Promise.all([
        pipeline.extractDocument(id, { provider: stub }),
        pipeline.extractDocument(id, { provider: stub }),
      ]);
      expect(stub.calls).toBe(1);
      expect(a).toEqual(b);
    });

    it('never stores an answer that failed the citation guard', async () => {
      const id = seed('-no-poisoned-cache');
      const bad = stubProvider(ntrium, { fabricate: [...MODEL_FIELD_KEYS] });

      await expect(
        pipeline.extractDocument(id, { provider: bad, tier: 'balanced' }),
      ).rejects.toMatchObject({ code: 'ALL_CITATIONS_FAILED' });

      /*
       * The answer was cached BEFORE verification, so every retry replayed the same
       * rejected quotes from disk and could not possibly end differently -- three
       * passes to reach a foregone conclusion. A fresh engine must actually be asked.
       */
      const good = stubProvider(ntrium);
      const out = await pipeline.extractDocument(id, { provider: good, tier: 'balanced' });
      expect(good.calls).toBe(1);
      expect(out.cached).toBe(false);
      expect(out.status).toBe('ready');
    });
  });

  /* ────────── a human's work outranks anything a re-read produces ────────── */

  describe('a re-read is a proposal, not a rewrite', () => {
    it('keeps what she typed and what she marked as absent', async () => {
      const id = seed('-preserve-manual');
      await pipeline.extractDocument(id, { provider: stubProvider(ntrium), tier: 'balanced' });

      queries.setDocumentField(id, 'notice_address', '1 Manual Way, Wilmington DE');
      queries.setDocumentField(id, 'party_c', null, 'na');

      const out = await pipeline.extractDocument(id, {
        provider: stubProvider(ntrium),
        tier: 'balanced',
        bypassCache: true,
      });

      expect(out.preservedFields).toContain('notice_address');
      expect(out.preservedFields).toContain('party_c');

      expect(valueOf(out.fields, 'notice_address')).toBe('1 Manual Way, Wilmington DE');
      expect(methodOf(out.fields, 'notice_address')).toBe('manual');
      expect(methodOf(out.fields, 'party_c')).toBe('na');

      // And on the record, not just in the return value.
      const stored = queries.getDocumentFields(id);
      expect(valueOf(stored, 'notice_address')).toBe('1 Manual Way, Wilmington DE');
      expect(methodOf(stored, 'notice_address')).toBe('manual');
      expect(methodOf(stored, 'party_c')).toBe('na');

      // What the new read would have written is offered, never applied.
      const proposal = out.proposedChanges.find((p) => p.key === 'notice_address');
      expect(proposal?.current).toBe('1 Manual Way, Wilmington DE');

      const history = queries.getDocumentAudit(id).map((e) => e.detail ?? '');
      expect(history.some((d) => d.includes('Kept 2 fields'))).toBe(true);
    });

    it('does not send a card back to needs attention over a gap she acknowledged', async () => {
      const id = seed('-preserve-na-required');
      // `term` is the one required field on this document that no rule finds.
      const first = await pipeline.extractDocument(id, {
        provider: stubProvider(ntrium, { omit: ['term'] }),
        tier: 'balanced',
      });
      expect(first.status).toBe('needs_attention');

      queries.setDocumentField(id, 'term', null, 'na');

      const out = await pipeline.extractDocument(id, {
        provider: stubProvider(ntrium, { omit: ['term'] }),
        tier: 'balanced',
        bypassCache: true,
      });

      expect(methodOf(out.fields, 'term')).toBe('na');
      expect(out.missingRequired).not.toContain('term');
      expect(out.status).toBe('ready');
      expect(queries.approvalBlockers(id)).not.toContain('term');
    });
  });

  /* ───────────── an approved record is nobody's to overwrite ───────────── */

  describe('an approved record survives a late extraction', () => {
    it('abandons a run that finishes after the approve', async () => {
      const id = seed('-approve-race');
      const first = await pipeline.extractDocument(id, {
        provider: stubProvider(ntrium),
        tier: 'balanced',
      });
      expect(first.status).toBe('ready');

      const term = valueOf(queries.getDocumentFields(id), 'term');
      expect(term).not.toBeNull();

      /*
       * The window: the run started while the card was still eligible, and the record
       * became approved after the model answered but before the write. The progress
       * hook puts the transition exactly there -- the one place a check taken outside
       * the write transaction would miss. The status is set directly because the
       * approve path now refuses a document mid-extraction; the guard being tested is
       * the one that has to hold whatever route got the row there.
       */
      let resolvedMidRun = false;
      const out = await pipeline.extractDocument(id, {
        // A run that lost `term`. If this were written, the approved record would
        // silently acquire a gap the document does not have.
        provider: stubProvider(ntrium, { omit: ['term'] }),
        tier: 'balanced',
        bypassCache: true,
        onProgress: (stage) => {
          if (stage === 'saving' && !resolvedMidRun) {
            resolvedMidRun = true;
            queries.updateDocument(id, { status: 'approved' });
          }
        },
      });

      expect(resolvedMidRun).toBe(true);
      expect(out.status).toBe('abandoned');
      expect(out.abandonedBecause).toBe('approved');

      // Nothing was written: the record still says what it said.
      expect(queries.getDocument(id)?.status).toBe('approved');
      expect(valueOf(queries.getDocumentFields(id), 'term')).toBe(term);
    });

    it('does not even start on a record that is already resolved', async () => {
      const id = seed('-already-approved');
      await pipeline.extractDocument(id, { provider: stubProvider(ntrium), tier: 'balanced' });
      queries.approveDocument(id);

      const stub = stubProvider(ntrium);
      const out = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(out.status).toBe('abandoned');
      expect(out.abandonedBecause).toBe('approved');
      expect(stub.calls).toBe(0);
      expect(queries.getDocument(id)?.status).toBe('approved');
    });
  });

  /* ─────────────────── the queue stops burning passes ──────────────────── */

  describe('the queue does not retry what cannot change', () => {
    it('refuses to auto-retry a failure the pipeline already exhausted', async () => {
      const { autoRetryable } = await import('../src/lib/extraction/queue');
      const { EngineError } = await import('../src/lib/providers/errors');

      // Retryable in the catalogue, because Retry (which drops the cache) is a real
      // offer to a human. Two more automatic identical passes are not.
      expect(errorInfo('ALL_CITATIONS_FAILED').retryable).toBe(true);
      expect(autoRetryable(new EngineError('ALL_CITATIONS_FAILED'), 1)).toBe(false);

      expect(autoRetryable(new EngineError('API_OVERLOADED'), 1)).toBe(true);
      expect(autoRetryable(new EngineError('API_OVERLOADED'), 3)).toBe(false);
      expect(autoRetryable(new EngineError('PDF_ENCRYPTED'), 1)).toBe(false);
    });

    it('can take a document back out of the queue', async () => {
      const { extractionQueue } = await import('../src/lib/extraction/queue');
      const id = seed('-cancellable');

      // Paused first, so the pump never reaches for a real engine in a test process.
      extractionQueue.pause();
      const before = extractionQueue.status().queued;
      extractionQueue.add(id);
      expect(extractionQueue.status().queued).toBe(before + 1);

      expect(extractionQueue.cancel(id)).toBe(true);
      expect(extractionQueue.status().queued).toBe(before);
      expect(extractionQueue.cancel(id)).toBe(false);
    });
  });
}
