/**
 * The repeatability claim, tested rather than asserted.
 *
 * Bonnie's objection to AI is that it is not repeatable. The answer is not a promise, it
 * is a cache keyed on the file bytes, the model and the prompt version: run the same
 * document twice and the second run reads the stored answer, produces byte-identical
 * output, and costs nothing. This case runs it twice and diffs.
 *
 * The engine here is a stub, deliberately. What is under test is the pipeline's
 * determinism, not the model's - a case that called a real model could never prove
 * byte-identical output, which is precisely why the cache exists.
 */

import { CaseRun, show, type CaseContext, type CaseResult } from '../report';
import { stubProvider, useEvalDataDir, writeFixturePdf } from './_harness';
import { load } from './_modules';
import { fixtureById, PRIMARY_FIXTURE_ID } from '../fixtures/index';

export async function runCase(_ctx: CaseContext): Promise<CaseResult> {
  const run = new CaseRun('determinism', 'Same document twice: identical output, zero cost');
  useEvalDataDir();

  /* ── The cache key. Pure, so it is checked even when the pipeline will not load. ── */
  const { mod: cache, reason: cacheReason } = await load('cache');
  if (!cache) {
    run.skipAssertion('cache-key', cacheReason ?? 'cache module unavailable');
  } else {
    const k = (hash: string, model: string, version: string, fields: string[]) =>
      cache.cacheKey(hash, model, version, fields as Parameters<typeof cache.cacheKey>[3]);
    const base = k('hash-a', 'claude-sonnet-5', '1.0.0', ['party_a', 'party_b']);
    run.eq('cache-key.stable', k('hash-a', 'claude-sonnet-5', '1.0.0', ['party_a', 'party_b']), base);
    run.eq(
      'cache-key.field-order-irrelevant',
      k('hash-a', 'claude-sonnet-5', '1.0.0', ['party_b', 'party_a']),
      base,
    );
    run.ok(
      'cache-key.file-matters',
      k('hash-b', 'claude-sonnet-5', '1.0.0', ['party_a', 'party_b']) !== base,
      () => 'two different files share a cache key',
    );
    run.ok(
      'cache-key.model-matters',
      k('hash-a', 'claude-opus-5', '1.0.0', ['party_a', 'party_b']) !== base,
      () => 'two different models share a cache key',
    );
    run.ok(
      'cache-key.prompt-version-matters',
      k('hash-a', 'claude-sonnet-5', '1.0.1', ['party_a', 'party_b']) !== base,
      () => 'a prompt version bump does not change the cache key, so it would not re-extract',
    );
    run.ok(
      'cache-key.field-list-matters',
      k('hash-a', 'claude-sonnet-5', '1.0.0', ['party_a']) !== base,
      () => 'a run that asked for fewer fields would satisfy a run that asks for more',
    );
  }

  /* ── The double run. ── */
  const { mod: pipeline, reason: pipelineReason } = await load('pipeline');
  const { mod: queries, reason: queriesReason } = await load('queries');
  if (!pipeline || !queries) {
    run.skipCase(pipelineReason ?? queriesReason ?? 'pipeline unavailable');
    return run.finish();
  }

  const fixture = fixtureById(PRIMARY_FIXTURE_ID);
  if (!fixture) {
    run.skipCase('the primary fixture is missing');
    return run.finish();
  }

  const file = writeFixturePdf(fixture, '-determinism');
  const created = queries.createDocument({
    fileHash: file.fileHash,
    filename: fixture.filename,
    archivePath: file.path,
    byteSize: file.bytes.byteLength,
  });
  run.eq('document.created', created.duplicate, false);

  // The same bytes dropped again must open the same record rather than create a second.
  const again = queries.createDocument({
    fileHash: file.fileHash,
    filename: `copy-of-${fixture.filename}`,
    archivePath: file.path,
  });
  run.eq('document.deduplicated-by-hash', again.duplicate, true);
  run.eq('document.same-id', again.id, created.id);

  const stub = stubProvider(fixture);
  const first = await pipeline.extractDocument(created.id, { provider: stub, tier: 'balanced' });
  const second = await pipeline.extractDocument(created.id, { provider: stub, tier: 'balanced' });

  run.eq('engine.called-once', stub.calls, 1);
  run.eq('second-run.cached', second.cached, true);
  run.eq('second-run.free', second.costUsd ?? 0, 0);

  const shape = (o: typeof first) =>
    JSON.stringify({
      status: o.status,
      docType: o.docType,
      fields: o.fields,
      missingRequired: o.missingRequired,
      confidentialityEnd: o.confidentialityEnd,
      tier: o.tier,
      model: o.model,
      escalatedFrom: o.escalatedFrom,
    });
  const a = shape(first);
  const b = shape(second);
  run.ok(
    'output.byte-identical',
    a === b,
    () => `the second run differed.\n    first:  ${show(a)}\n    second: ${show(b)}`,
  );

  // Persisted evidence must match what was returned, or the UI and the export disagree.
  const stored = queries.getDocumentFields(created.id);
  run.eq('persisted.field-count', stored.length, first.fields.length);
  for (const field of first.fields) {
    const row = stored.find((s) => s.key === field.key);
    run.ok(
      `persisted.${field.key}`,
      row !== undefined && (row.value ?? null) === (field.value ?? null),
      () => `${field.key}: returned ${show(field.value)}, database has ${show(row?.value ?? null)}`,
    );
  }

  return run.finish();
}
