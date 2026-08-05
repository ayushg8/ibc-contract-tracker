/**
 * The deterministic pass, judged on precision first.
 *
 * A rule hit arrives in the UI as a green dot, and a green dot tells the reviewer not to
 * look. So the standard here is asymmetric on purpose: a rule that stays silent costs a
 * reviewer thirty seconds, and a rule that fires with a wrong value costs IBC a wrong
 * expiry date nobody ever questions. Every hit is checked three ways - the value is right,
 * the quote it cites is really in the document, and the value is clean enough to store.
 *
 * Recall is asserted only for the two fields PLAN.md section 13 puts in the rules pass and
 * that no fixture leaves ambiguous: the effective date and the governing law.
 */

import { FIELD_KEYS, FIELDS, type FieldKey } from '../../src/lib/fields';
import { ALL_FIXTURES, fieldMatches, normalise, type Fixture } from '../fixtures/index';
import { CaseRun, show, type CaseContext, type CaseResult } from '../report';
import { load } from './_modules';

/** Rule values are stored and shown verbatim, so this is what "clean" means. */
const DIRTY_EDGE = /^[\s:;,.\-|]|[\s:;,\-|]$/;

export async function runCase(_ctx: CaseContext): Promise<CaseResult> {
  const run = new CaseRun('rules', 'The deterministic pass: precision, then recall');
  const { mod: rules, reason } = await load('rules');
  if (!rules) {
    run.skipCase(reason ?? 'rules module unavailable');
    return run.finish();
  }

  for (const f of ALL_FIXTURES) {
    let hits: Partial<Record<FieldKey, { value: string; quote: string; page: number; method: 'rule' }>>;
    try {
      hits = rules.runRules(f.pages);
    } catch (e) {
      run.ok(
        `${f.id}.does-not-throw`,
        false,
        () => `runRules threw on ${f.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    const answered = FIELD_KEYS.filter((k) => hits[k] !== undefined);

    for (const key of answered) {
      const hit = hits[key];
      if (!hit) continue;

      // Precision. This is the assertion the whole file exists for.
      run.ok(
        `${f.id}.value.${key}`,
        fieldMatches(f, key, hit.value, { allowAcceptable: true }),
        () =>
          `${f.id}: rule answered ${key} with ${show(hit.value)}, expected ${show(f.expected[key])}`,
        { field: true },
      );

      // A rule's own citation has to hold up, or the review pane shows a quote that is
      // not in the PDF and the reviewer stops trusting every green dot.
      const page = f.pages[hit.page - 1];
      run.ok(
        `${f.id}.page-in-range.${key}`,
        page !== undefined,
        () => `${f.id}: rule cited page ${hit.page} of a ${f.pages.length}-page document`,
      );
      if (page !== undefined) {
        run.ok(
          `${f.id}.quote-real.${key}`,
          normalise(page).includes(normalise(hit.quote)),
          () =>
            `${f.id}: the quote cited for ${key} is not on page ${hit.page}: ${show(hit.quote)}`,
        );
      }

      run.ok(
        `${f.id}.clean.${key}`,
        !DIRTY_EDGE.test(hit.value),
        () => `${f.id}: rule value for ${key} has punctuation or space on an edge: ${show(hit.value)}`,
      );
      run.eq(`${f.id}.method.${key}`, hit.method, 'rule');

      // A field the model must never be asked for must not arrive from a rule either.
      run.ok(
        `${f.id}.not-computed.${key}`,
        FIELDS[key].source !== 'computed',
        () => `${f.id}: ${key} is a computed field and must not be produced by a rule`,
      );
    }

    // Recall, only where silence would be inexcusable.
    for (const key of f.rulesMustFind) {
      if (hits[key] !== undefined) continue;
      run.ok(
        `${f.id}.found.${key}`,
        false,
        () =>
          `${f.id}: no rule fired for ${key}, and this document states it unambiguously (${show(f.expected[key])})`,
        { field: true },
      );
    }

    // Abstention, where guessing would be worse than an empty field.
    for (const key of f.rulesMustNotFind) {
      const hit = hits[key];
      run.ok(
        `${f.id}.abstains.${key}`,
        hit === undefined,
        () =>
          `${f.id}: a rule answered ${key} with ${show(hit?.value ?? null)} where the document does not support a deterministic answer (${abstainWhy(f, key)})`,
      );
    }
  }

  return run.finish();
}

function abstainWhy(f: Fixture, key: FieldKey): string {
  if (key === 'effective_date') return 'the date form is ambiguous';
  if (key === 'notice_email') return 'no email is designated for notices';
  if (key === 'term') return 'the document gives an end date, not a duration';
  if (key === 'party_c') return 'there is no third party';
  return `see fixture ${f.id}`;
}
