import { describe, expect, it } from 'vitest';

import { runRules } from '@/lib/extraction/rules';

/**
 * Fixtures are written as pagesText arrays, exactly the shape readPdf produces:
 * index 0 is page 1, lines broken where a PDF would break them.
 */

const NDA_PAGE_1 = `MUTUAL NON-DISCLOSURE AGREEMENT

This Mutual Non-Disclosure Agreement (this "Agreement") is entered into as of March 14, 2024 (the "Effective Date"), between International Battery Company, Inc., a Delaware corporation with offices at 1 Battery Way, Fremont, CA 94538 ("IBC"), and Northwind Cells GmbH, a German company with offices at Industriestrasse 4, 80331 Munich, Germany ("Northwind").

1. Confidential Information. Each party may disclose to the other certain non-public technical and business information relating to lithium-ion cell development.`;

const NDA_PAGE_2 = `5. Term. This Agreement shall remain in full force and effect for a period of three (3) years from the Effective Date, unless earlier terminated in accordance with Section 6.

6. Survival. The obligations of confidentiality set forth in Section 2 shall survive the expiration or termination of this Agreement for a period of five (5) years.

7. Return of Materials. Upon written request, each party shall return or destroy all Confidential Information within thirty (30) days.

9. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles.

10. Notices. All notices under this Agreement shall be in writing and sent to legal@northwindcells.de (for Northwind) and legal@intlbattery.com (for IBC).`;

const NDA = [NDA_PAGE_1, NDA_PAGE_2];

const EVALUATION = [
  `EVALUATION AGREEMENT

This Evaluation Agreement (the "Agreement") is effective as of 1 June 2023 (the "Effective Date") between Volta Motors Ltd. and International Battery Company, Inc.

1. Purpose. IBC will supply sample cells to Volta Motors for evaluation and testing.

3. Term. The term of this Agreement is twelve (12) months from the Effective Date.

7. Confidentiality. Each party's confidentiality obligations shall survive for three (3) years following expiration of this Agreement.

12. Governing law. This Agreement is governed by the laws of England and Wales.

13. Notices. Notices shall be sent to procurement@voltamotors.co.uk.`,
];

/** One duration, no wording that says which clock it belongs to. */
const AMBIGUOUS = [
  `CONFIDENTIALITY AGREEMENT

This Confidentiality Agreement is dated as of 2 February 2022 between Acme Robotics Inc. and International Battery Company, Inc.

4. Duration. This Agreement is for a period of two (2) years.`,
];

/** Two different durations both claiming to be the term of the agreement. */
const CONFLICTING = [
  `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement is dated as of 2 February 2022 between Acme Robotics Inc. and International Battery Company, Inc.

5. Term. This Agreement shall remain in full force and effect for a period of three (3) years.

6. Renewal. Following the initial period the term of this Agreement is one (1) year.`,
];

describe('runRules on a mutual NDA', () => {
  const hits = runRules(NDA);

  it('reads the title from page 1', () => {
    expect(hits.contract_name?.value).toBe('MUTUAL NON-DISCLOSURE AGREEMENT');
    expect(hits.contract_name?.page).toBe(1);
  });

  it('prefers the explicit effective-date clause and returns ISO', () => {
    expect(hits.effective_date?.value).toBe('2024-03-14');
    expect(hits.effective_date?.quote).toContain('March 14, 2024');
  });

  it('separates the term of the agreement from the survival period', () => {
    expect(hits.term?.value).toBe('3 years');
    expect(hits.term?.page).toBe(2);
    expect(hits.confidentiality_term?.value).toBe('5 years');
  });

  it('ignores a notice period that is neither clock', () => {
    expect(hits.term?.value).not.toBe('30 days');
    expect(hits.confidentiality_term?.value).not.toBe('30 days');
  });

  it('reads the governing jurisdiction only', () => {
    expect(hits.governing_law?.value).toBe('Delaware');
  });

  it('prefers the counterparty notice email', () => {
    expect(hits.notice_email?.value).toBe('legal@northwindcells.de');
  });

  it('puts IBC in Party A regardless of preamble order', () => {
    expect(hits.party_a?.value).toBe('International Battery Company, Inc.');
    expect(hits.party_b?.value).toBe('Northwind Cells GmbH');
  });

  it('quotes verbatim from the page it cites', () => {
    for (const [key, hit] of Object.entries(hits)) {
      if (!hit) continue;
      const page = NDA[hit.page - 1];
      expect(page, `${key} cites page ${hit.page}`).toBeTypeOf('string');
      expect(page?.includes(hit.quote), `${key} quote is verbatim`).toBe(true);
    }
  });
});

describe('runRules on an evaluation agreement', () => {
  const hits = runRules(EVALUATION);

  it('reads the title, date and both clocks', () => {
    expect(hits.contract_name?.value).toBe('EVALUATION AGREEMENT');
    expect(hits.effective_date?.value).toBe('2023-06-01');
    expect(hits.term?.value).toBe('12 months');
    expect(hits.confidentiality_term?.value).toBe('3 years');
  });

  it('handles a non-US jurisdiction', () => {
    expect(hits.governing_law?.value).toBe('England and Wales');
  });

  it('assigns IBC to Party A when it is named second', () => {
    expect(hits.party_a?.value).toBe('International Battery Company, Inc.');
    expect(hits.party_b?.value).toBe('Volta Motors Ltd.');
  });

  it('finds the notice email', () => {
    expect(hits.notice_email?.value).toBe('procurement@voltamotors.co.uk');
  });

  it('quotes verbatim from the page it cites', () => {
    for (const [key, hit] of Object.entries(hits)) {
      if (!hit) continue;
      expect(EVALUATION[hit.page - 1]?.includes(hit.quote), `${key} quote is verbatim`).toBe(true);
    }
  });
});

describe('runRules stays silent when the document is ambiguous', () => {
  it('emits no duration when the sentence does not say which clock it is', () => {
    const hits = runRules(AMBIGUOUS);
    expect(hits.term).toBeUndefined();
    expect(hits.confidentiality_term).toBeUndefined();
    // The unambiguous fields on the same page are still extracted.
    expect(hits.effective_date?.value).toBe('2022-02-02');
    expect(hits.contract_name?.value).toBe('CONFIDENTIALITY AGREEMENT');
  });

  it('emits nothing when two clauses claim different terms', () => {
    const hits = runRules(CONFLICTING);
    expect(hits.term).toBeUndefined();
  });

  it('keeps a suffix period that belongs to the name and drops one that does not', () => {
    const hits = runRules([
      `MUTUAL NON-DISCLOSURE AGREEMENT

This Agreement is entered into as of March 14, 2024 between International Battery Company, Inc. and Northwind Cells GmbH.`,
    ]);
    // "Inc." keeps its period; the period after "GmbH" is the sentence's, not the name's.
    expect(hits.party_a?.value).toBe('International Battery Company, Inc.');
    expect(hits.party_b?.value).toBe('Northwind Cells GmbH');
  });

  it('returns nothing at all for an empty document', () => {
    expect(runRules([])).toEqual({});
    expect(runRules([''])).toEqual({});
  });
});
