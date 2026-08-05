/**
 * The hallucination guard. The most important case in the suite.
 *
 * Two failure modes, and they pull in opposite directions:
 *
 *   A quote the model invented that we ACCEPT is a wrong answer with a green tick beside
 *   it. Nobody catches it, because the whole point of the citation is that the reviewer
 *   does not have to re-read the contract.
 *
 *   A quote that is really in the document and we REJECT shows "not found in document"
 *   next to a clause that is plainly in the document. Bonnie stops believing the tool, and
 *   the tool is worth nothing after that.
 *
 * So: every mangling a real PDF text layer performs must still verify, and every
 * fabrication must be refused - including the fabrications that differ by one character,
 * because "five (5) years" and "five (7) years" are not the same contract.
 */

import { FIELD_KEYS, type FieldKey } from '../../src/lib/fields';
import type { RawFieldAnswer } from '../../src/lib/providers/types';
import { ALL_FIXTURES, FABRICATORS, MANGLERS, normalise, PRIMARY_FIXTURE_ID } from '../fixtures/index';
import { CaseRun, show, type CaseContext, type CaseResult } from '../report';
import { load } from './_modules';

/** Is this text genuinely absent, by an oracle that is not the module under test? */
function absent(pages: string[], quote: string): boolean {
  const needle = normalise(quote).toLowerCase();
  return !pages.some((p) => normalise(p).toLowerCase().includes(needle));
}

/**
 * A page as a scanner would have read it: "rn" for "m", "1" for "l", "l" for "i", a
 * comma that fell over into a full stop. Every one of those is cosmetic damage to
 * ordinary prose, and not one of them turns a name into a different name -- which is
 * exactly the line the OCR tolerance is allowed to sit on.
 */
function scanned(page: string): string {
  return page
    .replace(/rm/g, 'rrn')
    .replace(/Delaware/g, 'De1aware')
    .replace(/ment,/g, 'rnent.')
    .replace(/tion\b/g, 'tlon');
}

/**
 * One swapped name each, against the primary fixture. `real` is the document's own
 * wording and has to verify; `fake` differs from it in a NAME and nothing else, and has
 * to be refused however long the sentence around it gets.
 */
interface ProperNounCase {
  name: string;
  real: string;
  fake: string;
  /** Why a model would produce this, and what it would cost. */
  why: string;
}

const PROPER_NOUN_CASES: ProperNounCase[] = [
  {
    name: 'jurisdiction.long',
    real: 'This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles.',
    fake: 'This Agreement shall be governed by and construed in accordance with the laws of the State of New York, without regard to its conflict of laws principles.',
    why: 'the governing law of every agreement in the corpus, invented',
  },
  {
    name: 'jurisdiction.medium',
    real: 'governed by and construed in accordance with the laws of the State of Delaware',
    fake: 'governed by and construed in accordance with the laws of the State of New York',
    why: 'the same swap in a shorter sentence, where the edit is a larger share of it',
  },
  {
    name: 'jurisdiction.short',
    real: 'the laws of the State of Delaware, without',
    fake: 'the laws of the State of New York, without',
    why: 'the same swap again, at the length where similarity alone still caught it',
  },
  {
    name: 'counterparty',
    real: 'and Ntrium, Inc., a Delaware corporation with its principal place of business at 2200 Sand Hill Road, Menlo Park, California 94025',
    fake: 'and Octillion, Inc., a Delaware corporation with its principal place of business at 2200 Sand Hill Road, Menlo Park, California 94025',
    why: 'cross-contamination from another document in the same backfill batch',
  },
  {
    name: 'entity-suffix',
    real: 'and Ntrium, Inc., a Delaware corporation with its principal place of business',
    fake: 'and Ntrium, LLC, a Delaware corporation with its principal place of business',
    why: 'the wrong legal entity: a different company, three characters away',
  },
  {
    name: 'signer',
    real: 'INTERNATIONAL BATTERY COMPANY, INC. By: /s/ Anand Krishnan Name: Anand Krishnan Title: Chief Financial Officer',
    fake: 'INTERNATIONAL BATTERY COMPANY, INC. By: /s/ Anand Krishnan Name: Ananya Krishnan Title: Chief Financial Officer',
    why: 'the wrong human being recorded as having signed',
  },
  {
    name: 'city',
    real: 'a Delaware corporation with its principal place of business at 2200 Sand Hill Road, Menlo Park, California 94025',
    fake: 'a Delaware corporation with its principal place of business at 2200 Sand Hill Road, Palo Alto, California 94025',
    why: 'an address that would send a notice to the wrong town',
  },
  {
    name: 'state',
    real: 'principal place of business at 1 Innovation Way, Fremont, California 94538',
    fake: 'principal place of business at 1 Innovation Way, Fremont, Colorado 94538',
    why: 'a state swapped inside an address, where nobody re-reads the postcode',
  },
];

export async function runCase(_ctx: CaseContext): Promise<CaseResult> {
  const run = new CaseRun('verify', 'Citation verification: accept the mangled, refuse the invented');
  const { mod: verify, reason } = await load('verify');
  if (!verify) {
    run.skipCase(reason ?? 'verify module unavailable');
    return run.finish();
  }

  /* ── 1. Real quotes, exactly as the fixture states them ── */
  for (const f of ALL_FIXTURES) {
    for (const [key, quote] of Object.entries(f.quotes)) {
      if (quote === undefined) continue;
      const result = verify.verifyCitation(quote, f.pages);
      run.ok(
        `real.${f.id}.${key}`,
        result.found,
        () => `${f.id}: the real quote for ${key} was rejected: ${show(quote)}`,
      );
      const expectedPage = f.pages.findIndex((p) => p.includes(quote)) + 1;
      if (result.found && expectedPage > 0) {
        run.eq(`page.${f.id}.${key}`, result.page, expectedPage);
      }
    }
  }

  /* ── 2. Mangled quotes. Every one of these must still verify. ── */
  const manglingTargets = ALL_FIXTURES.flatMap((f) =>
    (['effective_date', 'term', 'confidentiality_term', 'governing_law', 'party_b'] as FieldKey[])
      .map((key) => ({ f, key, quote: f.quotes[key] }))
      .filter((t): t is { f: typeof f; key: FieldKey; quote: string } => t.quote !== undefined),
  );

  for (const t of manglingTargets) {
    for (const m of MANGLERS) {
      const mangled = m.apply(t.quote);
      const result = verify.verifyCitation(mangled, t.f.pages);
      run.ok(
        `mangled.${m.name}.${t.f.id}.${t.key}`,
        result.found,
        () =>
          `${t.f.id}/${t.key}: a real quote mangled by ${m.name} (${m.why}) was rejected: ${show(mangled)}`,
      );
    }
  }

  /* ── 3. Fabrications. Every one of these must be refused. ── */
  for (const t of manglingTargets) {
    for (const fab of FABRICATORS) {
      const fake = fab.apply(t.quote);
      if (fake === null) continue;
      if (!absent(t.f.pages, fake)) {
        run.skipAssertion(
          `fabricated.${fab.name}.${t.f.id}.${t.key}`,
          'the fabricated text happens to appear in this document',
        );
        continue;
      }
      const result = verify.verifyCitation(fake, t.f.pages);
      run.ok(
        `fabricated.${fab.name}.${t.f.id}.${t.key}`,
        !result.found,
        () =>
          `${t.f.id}/${t.key}: an invented quote was ACCEPTED via ${result.method} at similarity ${result.similarity.toFixed(3)} (${fab.why}): ${show(fake)}`,
      );
    }
  }

  /* ── 4. Digit integrity, called out separately because it is the dangerous one. ── */
  const digitCases: { quote: string; fake: string; why: string }[] = [
    {
      quote: 'shall survive for five (5) years from the Effective Date',
      fake: 'shall survive for five (7) years from the Effective Date',
      why: 'a term read from the right clause with the wrong number',
    },
    {
      quote: 'shall survive for five (5) years from the Effective Date',
      fake: 'shall survive for fifteen (15) years from the Effective Date',
      why: 'a longer confidentiality tail than the document grants',
    },
    {
      quote: 'shall remain in force for five (5) years',
      fake: 'shall remain in force for six (6) years',
      why: 'one year of extra term, invented',
    },
  ];
  const primary = ALL_FIXTURES.find((f) => f.id === PRIMARY_FIXTURE_ID) ?? ALL_FIXTURES[0];
  if (primary) {
    for (const [i, c] of digitCases.entries()) {
      run.ok(
        `digits.control-quote-is-real.${i}`,
        verify.verifyCitation(c.quote, primary.pages).found,
        () => `the control quote for the digit test is not in ${primary.id}: ${show(c.quote)}`,
      );
      const result = verify.verifyCitation(c.fake, primary.pages);
      run.ok(
        `digits.rejected.${i}`,
        !result.found,
        () =>
          `a quote differing from the document only in its NUMBER was accepted via ${result.method} at ${result.similarity.toFixed(3)} (${c.why}). The fuzzy tier must compare digit runs exactly: ${show(c.fake)}`,
      );
    }
  }

  /* ── 5. Proper nouns. The other dangerous one, and for the same reason. ──
   *
   * The gate that guards the fuzzy tier was built on an ALLOW-LIST of modals, negations
   * and months, so any word it had never heard of was waved through as ordinary prose.
   * "Delaware" and "New York" carry no digit and no listed word, so the check passed
   * VACUOUSLY and the whole guard collapsed to the similarity score -- which one swapped
   * noun in a long sentence barely dents. It got WORSE the longer the quote was.
   *
   * Counterparties, signers, cities, jurisdictions and entity types are precisely the
   * facts a contract tracker exists to record. Every swap below is a different contract.
   */
  if (primary) {
    const scan = primary.pages.map(scanned);

    for (const c of PROPER_NOUN_CASES) {
      // The control first. Whatever happens to the fabrication has to happen because a
      // name changed, not because the sentence was never in the document to begin with.
      run.ok(
        `properNoun.control.${c.name}`,
        verify.verifyCitation(c.real, primary.pages).found,
        () => `the control quote for ${c.name} is not in ${primary.id}: ${show(c.real)}`,
      );

      if (!absent(primary.pages, c.fake)) {
        run.skipAssertion(`properNoun.${c.name}`, 'the swapped text happens to be in this document');
      } else {
        const result = verify.verifyCitation(c.fake, primary.pages);
        run.ok(
          `properNoun.${c.name}.${c.fake.length}chars`,
          !result.found,
          () =>
            `a quote differing from the document only in a NAME was accepted via ${result.method} at ${result.similarity.toFixed(3)} (${c.why}). Every capitalised word of a quote is load-bearing: ${show(c.fake)}`,
        );
      }

      // The same swap read off a scan. OCR may loosen the similarity threshold; it may
      // not loosen this gate, or the looser haystack becomes the way a name gets in.
      run.ok(
        `properNoun.scan.control.${c.name}`,
        verify.verifyCitation(c.real, scan, null, { ocr: true }).found,
        () =>
          `the control quote for ${c.name} stopped verifying against a scan of ${primary.id}, so the swap test below proves nothing: ${show(c.real)}`,
      );
      const onScan = verify.verifyCitation(c.fake, scan, null, { ocr: true });
      run.ok(
        `properNoun.scan.${c.name}`,
        !onScan.found,
        () =>
          `a swapped name was accepted off a SCAN via ${onScan.method} at ${onScan.similarity.toFixed(3)} (${c.why}). The OCR option loosens the similarity threshold and nothing else: ${show(c.fake)}`,
      );
    }

    // And the field goes down with the quote, the way the pipeline sees it.
    const fabricated = PROPER_NOUN_CASES[0];
    if (fabricated) {
      const report = verify.applyVerification(
        {
          governing_law: { value: 'New York', quote: fabricated.fake, page: 2 },
          term: { value: '5 years', quote: primary.quotes.term ?? '', page: 2 },
        },
        primary.pages,
      );
      run.eq('properNoun.apply.value-dropped', report.fields.governing_law?.value ?? null, null);
      run.eq('properNoun.apply.method', report.fields.governing_law?.method ?? null, 'missing');
      run.eq(
        'properNoun.apply.not-verified',
        report.fields.governing_law?.citationVerified ?? null,
        false,
      );
    }
  }

  /* ── 6. Cross-document contamination. ── */
  const a = ALL_FIXTURES[0];
  const b = ALL_FIXTURES.find((f) => f.id === 'octillion');
  if (a && b) {
    const quote = a.quotes.party_b;
    if (quote !== undefined) {
      run.ok(
        'cross-document.party',
        !verify.verifyCitation(quote, b.pages).found,
        () => `a quote from ${a.id} verified against ${b.id}`,
      );
    }
  }

  /* ── 7. Degenerate inputs. ── */
  if (primary) {
    run.eq('degenerate.empty-quote', verify.verifyCitation('', primary.pages).found, false);
    run.eq('degenerate.two-chars', verify.verifyCitation('of', primary.pages).found, false);
    run.eq('degenerate.whitespace', verify.verifyCitation('   \n  ', primary.pages).found, false);
    run.eq('degenerate.no-pages', verify.verifyCitation('Effective Date', []).found, false);

    // The page number comes from where the quote is, never from what the model claimed.
    const onPage2 = primary.quotes.term;
    if (onPage2 !== undefined) {
      const claimed = verify.verifyCitation(onPage2, primary.pages, 3);
      run.eq('page.corrects-the-model', claimed.page, 2);
    }
  }

  /* ── 8. applyVerification: the guard as the pipeline uses it. ── */
  if (primary) {
    const realQuote = primary.quotes.governing_law ?? '';
    const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
      governing_law: { value: 'Delaware', quote: realQuote, page: 2 },
      term: { value: '5 years', quote: 'This Agreement renews annually unless cancelled', page: 2 },
      contract_name: { value: 'Mutual Nondisclosure Agreement', quote: null, page: 1 },
      notice_email: { value: null, quote: null, page: null },
    };
    const report = verify.applyVerification(answers, primary.pages);

    const law = report.fields.governing_law;
    run.eq('apply.real-quote-kept', law?.value ?? null, 'Delaware');
    run.eq('apply.real-quote-method', law?.method ?? null, 'model');
    run.eq('apply.real-quote-page', law?.page ?? null, 2);
    run.eq('apply.real-quote-verified', law?.citationVerified ?? null, true);

    const term = report.fields.term;
    run.eq('apply.fabricated-quote-dropped', term?.value ?? null, null);
    run.eq('apply.fabricated-quote-method', term?.method ?? null, 'missing');
    run.eq('apply.fabricated-quote-flagged', term?.citationVerified ?? null, false);

    const name = report.fields.contract_name;
    run.eq('apply.no-quote-dropped', name?.value ?? null, null);
    run.eq('apply.no-quote-method', name?.method ?? null, 'missing');

    const email = report.fields.notice_email;
    run.eq('apply.null-value-is-missing', email?.method ?? null, 'missing');
    run.eq('apply.null-value-not-a-failed-citation', email?.citationVerified ?? null, null);

    run.eq('apply.counts-claimed', report.claimed, 3);
    run.eq('apply.counts-rejected', report.rejected, 2);

    // Only keys the model answered may appear. Silence is not an answer.
    const unexpected = FIELD_KEYS.filter(
      (k) => report.fields[k] !== undefined && answers[k] === undefined,
    );
    run.ok(
      'apply.invents-no-fields',
      unexpected.length === 0,
      () => `applyVerification returned fields nobody asked about: ${unexpected.join(', ')}`,
    );

    // A run where nothing could be verified is a bad run, not a record with holes.
    let threw: string | null = null;
    try {
      verify.applyVerification(
        {
          governing_law: { value: 'Delaware', quote: 'invented clause one', page: 1 },
          term: { value: '5 years', quote: 'invented clause two', page: 1 },
        },
        primary.pages,
      );
    } catch (e) {
      threw = e instanceof Error && 'code' in e ? String(e.code) : 'unknown';
    }
    run.eq('apply.all-citations-failed', threw, 'ALL_CITATIONS_FAILED');
  }

  /* ── 9. The value has to follow from the quote. ── */
  if (primary) {
    run.eq(
      'value-from-quote.date-matches',
      verify.verifyValueAgainstQuote('effective_date', '2022-11-05', 'effective as of November 5, 2022'),
      true,
    );
    run.eq(
      'value-from-quote.date-mismatch',
      verify.verifyValueAgainstQuote('effective_date', '2022-11-06', 'effective as of November 5, 2022'),
      false,
    );
    run.eq(
      'value-from-quote.duration-matches',
      verify.verifyValueAgainstQuote('term', '5 years', 'shall remain in force for five (5) years'),
      true,
    );
    run.eq(
      'value-from-quote.duration-mismatch',
      verify.verifyValueAgainstQuote('term', '7 years', 'shall remain in force for five (5) years'),
      false,
    );
    run.eq(
      'value-from-quote.email-mismatch',
      verify.verifyValueAgainstQuote('notice_email', 'legal@other.com', 'notices to legal@ntrium.com'),
      false,
    );
  }

  return run.finish();
}
