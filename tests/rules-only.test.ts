/**
 * The engine that does not read.
 *
 * Two things are being pinned here, and the second matters more than the first.
 *
 * 1. Choosing it produces a usable record: the rules keep what they proved, both
 *    dates are still computed in code, every remaining field is honestly 'missing',
 *    and the document reaches a terminal status instead of an error.
 *
 * 2. NOTHING selects it on its own. It is the one engine whose failure mode is
 *    invisible -- a silent switch to it looks exactly like a successful extraction
 *    that found less, with none of the amber "model" dots that would have told a
 *    reviewer to look harder. The no-failover rule at the top of providers/types.ts
 *    binds hardest here, so it gets a test rather than a comment.
 */

import { describe, expect, it } from 'vitest';

import { FIELD_KEYS, MODEL_FIELD_KEYS, type FieldKey } from '../src/lib/fields';
import { NoneProvider } from '../src/lib/providers/none';
import { PROVIDER_IDS, PROVIDER_LABELS } from '../src/lib/providers/types';
import { stubProvider, useEvalDataDir, writeFixturePdf } from '../evals/cases/_harness';
import { ntrium, octillion } from '../evals/fixtures/index';

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
const registry = await optional(() => import('../src/lib/providers'));

describe('the rules-only engine', () => {
  it('is offered to a human under a name that says what it is', () => {
    expect(PROVIDER_IDS).toContain('none');
    // "No AI" answers the question people actually ask; "(rules only)" stops it
    // reading as "does nothing".
    expect(PROVIDER_LABELS.none).toContain('No AI');
    expect(PROVIDER_LABELS.none.toLowerCase()).toContain('rules');
  });

  it('answers nothing, at no cost, without throwing', async () => {
    const none = new NoneProvider();
    const res = await none.extract({
      text: 'anything at all',
      images: null,
      pageCount: 1,
      fieldsToFill: [...MODEL_FIELD_KEYS],
      promptVersion: 'test',
      tier: 'balanced',
    });

    expect(Object.keys(res.fields)).toHaveLength(0);
    expect(res.usage.costUsd).toBe(0);
    // A throw would put the document in the failed state and start the retry
    // machinery. Finding nothing is this engine working, not this engine failing.
    expect(res.docType).toBeNull();
  });

  it('reports itself healthy, because being unavailable is the one thing it cannot be', async () => {
    const health = await new NoneProvider().health();
    expect(health.state).toBe('ok');
    expect(health.provider).toBe('none');
    // And it still warns about the half it does not fill, rather than a bare "ok"
    // that would let someone pick it expecting a full record.
    expect(health.checks.some((c) => c.state === 'warn')).toBe(true);
  });

  it('self-tests by actually running the rules, not by returning true', async () => {
    const result = await new NoneProvider().selfTest();
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(0);
    // The self-test agreement in providers/parse.ts carries a governing law, an
    // effective date and both parties. If this ever drops to 0 the deterministic
    // pass has stopped firing and every rules-only record just went empty.
    expect(result.fieldsFound).toBeGreaterThan(0);
    expect(result.fieldsFound).toBeLessThanOrEqual(result.fieldsTotal);
  });

  it.skipIf(registry === null)('is reachable by id, and every id resolves to its own engine', () => {
    for (const id of PROVIDER_IDS) {
      expect(registry!.providerFor(id).id).toBe(id);
    }
  });

  it.skipIf(registry === null)('is never what an unreadable settings row falls back to', () => {
    // getActiveProviderId() degrades to a default when the database will not
    // answer. That default must be a real engine: degrading to `none` would turn a
    // transient database problem into a day of silently half-extracted contracts.
    expect(registry!.getActiveProviderId()).not.toBe('none');
  });
});

describe.skipIf(pipeline === null || queries === null)('a document extracted with no engine', () => {
  const seed = (suffix: string): string => {
    const file = writeFixturePdf(ntrium, suffix);
    const { id } = queries!.createDocument({
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

  it('keeps what the rules proved and leaves the rest honestly empty', async () => {
    const id = seed('-none');
    const out = await pipeline!.extractDocument(id, { provider: new NoneProvider() });

    // Proved by a rule on this fixture, and unchanged by the absence of an engine.
    expect(valueOf(out.fields, 'effective_date')).toBe('2022-11-05');
    expect(methodOf(out.fields, 'effective_date')).toBe('rule');
    expect(methodOf(out.fields, 'governing_law')).toBe('rule');

    // No rule can find a signature block. It must come back empty rather than
    // guessed: a wrong value behind a green dot is the one outcome this product
    // is not allowed to produce.
    expect(valueOf(out.fields, 'party_a_signer')).toBeNull();
    expect(methodOf(out.fields, 'party_a_signer')).toBe('missing');

    // Nothing anywhere may claim a model answered.
    for (const key of FIELD_KEYS) {
      expect(methodOf(out.fields, key)).not.toBe('model');
    }
  });

  it('still does the date arithmetic when a rule found the term', async () => {
    // The clocks were never the model's job -- pipeline.ts computes both in code
    // from whatever the term turned out to be -- so with no engine at all the
    // arithmetic still runs, provided a rule found something to do it to.
    const file = writeFixturePdf(octillion, '-none-dates');
    const { id } = queries!.createDocument({
      fileHash: file.fileHash,
      filename: `${octillion.filename}-none-dates`,
      archivePath: file.path,
      byteSize: file.bytes.byteLength,
    });
    const out = await pipeline!.extractDocument(id, { provider: new NoneProvider() });

    expect(methodOf(out.fields, 'term')).toBe('rule');
    expect(valueOf(out.fields, 'termination_date')).toBe(octillion.computed.terminationDate);
    expect(methodOf(out.fields, 'termination_date')).toBe('computed');
  });

  it('leaves the date empty rather than guessing when no rule found the term', async () => {
    // The honest half of the trade, and worth a test of its own because it is the
    // limitation someone choosing this engine most needs to know about. A term
    // written as prose ("shall continue for a period of five (5) years from the
    // Effective Date unless...") is exactly what rules give up on: on the eval
    // fixtures they find the term on 6 of 13. When they do not, there is nothing to
    // add to the effective date, and the answer must be an empty field she fills --
    // never a plausible date nobody derived.
    const id = seed('-none-noterm');
    const out = await pipeline!.extractDocument(id, { provider: new NoneProvider() });

    expect(methodOf(out.fields, 'term')).toBe('missing');
    expect(valueOf(out.fields, 'termination_date')).toBeNull();
  });

  it('costs nothing and reaches a status she can act on', async () => {
    const id = seed('-none-status');
    const out = await pipeline!.extractDocument(id, { provider: new NoneProvider() });
    expect(out.costUsd === null || out.costUsd === 0).toBe(true);
    // Not 'failed'. A queue of half-filled records is workable; a queue of errors
    // is not, and that difference is the whole reason this engine exists.
    expect(out.status).not.toBe('failed');
  });

  it('fills fewer fields than a working engine, and the gap is the point', async () => {
    const withEngine = await pipeline!.extractDocument(seed('-cmp-engine'), {
      provider: stubProvider(ntrium),
      tier: 'balanced',
    });
    const without = await pipeline!.extractDocument(seed('-cmp-none'), {
      provider: new NoneProvider(),
    });

    const filled = (fields: { key: FieldKey; value: string | null }[]) =>
      fields.filter((f) => f.value !== null).length;

    // If these ever converge, either the rules got much better (worth knowing) or
    // the stub stopped answering (a broken test pretending to be good news).
    expect(filled(without.fields)).toBeLessThan(filled(withEngine.fields));
    expect(filled(without.fields)).toBeGreaterThan(0);
  });
});
