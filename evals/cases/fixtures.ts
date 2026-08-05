/**
 * The suite checking itself.
 *
 * A fixture whose expected quote is not actually in its own text would silently turn the
 * hallucination guard's positive cases into false failures, and a fixture whose computed
 * termination date was typed wrong would enshrine a wrong answer as the spec. Both are
 * caught here, using the date oracle in fixtures/types.ts rather than src/lib, so this
 * case passes or fails on its own.
 */

import { FIELD_KEYS } from '../../src/lib/fields';
import {
  ALL_FIXTURES,
  addDays,
  addMonths,
  isIso,
  type Fixture,
} from '../fixtures/index';
import { FABRICATORS } from '../fixtures/mangle';
import { CaseRun, type CaseContext, type CaseResult } from '../report';

/** Local, deliberately dumb duration reader. An oracle that shares code is not an oracle. */
function oracleAdd(iso: string, term: string | null): string | null {
  if (term === null) return null;
  const t = term.toLowerCase();
  if (/perpetu|indefinite|forever/.test(t)) return null;
  const m = /(\d+)\s*(day|week|month|year)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'day':
      return addDays(iso, n);
    case 'week':
      return addDays(iso, n * 7);
    case 'month':
      return addMonths(iso, n);
    default:
      return addMonths(iso, n * 12);
  }
}

function checkOne(run: CaseRun, f: Fixture, text: string): void {
  for (const key of FIELD_KEYS) {
    run.ok(
      `${f.id}.has-expected.${key}`,
      key in f.expected,
      () => `fixture ${f.id} is missing an expected value for ${key}`,
    );
  }

  for (const key of FIELD_KEYS) {
    const quote = f.quotes[key];
    if (quote === undefined) continue;
    const page = f.pages.findIndex((p) => p.includes(quote));
    run.ok(
      `${f.id}.quote-present.${key}`,
      page >= 0,
      () => `quote for ${key} is not in the fixture text: ${JSON.stringify(quote.slice(0, 60))}`,
    );
    const claimed = f.pageOf?.[key];
    if (claimed !== undefined && page >= 0) {
      run.eq(`${f.id}.quote-page.${key}`, page + 1, claimed);
    }
  }

  const effective = f.expected.effective_date;
  if (effective !== null) {
    run.ok(`${f.id}.effective-iso`, isIso(effective), () => `${effective} is not an ISO date`);
  }

  // The computed termination date must follow from the effective date and the term, unless
  // the document states an end date outright (sequoia) or has no usable effective date.
  const derived = effective === null ? null : oracleAdd(effective, f.expected.term);
  if (derived !== null) {
    run.eq(`${f.id}.termination-arithmetic`, f.computed.terminationDate, derived);
  }
  run.eq(`${f.id}.termination-field`, f.expected.termination_date, f.computed.terminationDate);

  const confDerived =
    effective === null ? null : oracleAdd(effective, f.expected.confidentiality_term);
  if (confDerived !== null) {
    run.eq(`${f.id}.confidentiality-arithmetic`, f.computed.confidentialityEnd, confDerived);
  }
  if (f.computed.confidentialityPerpetual) {
    run.eq(`${f.id}.perpetual-has-no-end`, f.computed.confidentialityEnd, null);
  }

  // Every invented clause the hallucination guard is fed must be absent from every
  // document, or the fabrication case would be asserting against a real quote.
  for (const fab of FABRICATORS) {
    const invented = fab.apply('shall survive for five (5) years from the Effective Date');
    if (invented === null) continue;
    if (fab.name !== 'invented-clause' && fab.name !== 'plausible-boilerplate') continue;
    run.ok(
      `${f.id}.fabrication-absent.${fab.name}`,
      !text.includes(invented),
      () => `${fab.name} text appears in fixture ${f.id}; the fabrication case would be void`,
    );
  }
}

export async function runCase(_ctx: CaseContext): Promise<CaseResult> {
  const run = new CaseRun('fixtures', 'The fixtures are internally consistent');

  const ids = new Set<string>();
  for (const f of ALL_FIXTURES) {
    run.ok(`${f.id}.unique-id`, !ids.has(f.id), () => `duplicate fixture id ${f.id}`);
    ids.add(f.id);
    run.ok(`${f.id}.has-pages`, f.pages.length > 0, () => `fixture ${f.id} has no pages`);
    checkOne(run, f, f.pages.join('\n'));
  }

  run.ok(
    'count',
    ALL_FIXTURES.length >= 10,
    () => `the suite requires at least 10 fixtures, found ${ALL_FIXTURES.length}`,
  );

  return run.finish();
}
