import { describe, expect, it } from 'vitest';

import type { FieldKey } from '@/lib/fields';
import { EngineError } from '@/lib/providers/errors';
import type { RawFieldAnswer } from '@/lib/providers/types';
import {
  applyVerification,
  verifyCitation,
  verifyValueAgainstQuote,
} from '@/lib/extraction/verify';

/**
 * The document as readPdf would produce it: straight quotes, real line breaks, and
 * the occasional hyphenated wrap. Every quote a model returns is checked against
 * exactly this text.
 */
const PAGE_1 = `MUTUAL NON-DISCLOSURE AGREEMENT

This Mutual Non-Disclosure Agreement (this "Agreement") is entered into as of
March 14, 2024 (the "Effective Date"), between International Battery Company,
Inc. and Northwind Cells GmbH.`;

const PAGE_2 = `5. Term. This Agreement shall remain in full force and effect for a period of
three (3) years from the Effective Date.

9. Governing Law. This Agreement shall be governed by and construed in
accordance with the laws of the State of Delaware, without regard to its
conflict of laws principles.

10. Notices. All notices shall be sent to legal@northwindcells.de with a copy to
the confidentiality officer named in Schedule A.`;

const PAGES = [PAGE_1, PAGE_2];

/**
 * A signature block and two addresses, kept apart from PAGES so the page numbers the
 * older tests assert on do not move. Signers, cities and states live here.
 */
const SIGNED_PAGE = `International Battery Company, Inc., a Delaware corporation with its
principal place of business at 1 Innovation Way, Fremont, California 94538,
and Northwind Cells GmbH of Landsberger Strasse 302, 80687 Munich, Germany.

IN WITNESS WHEREOF, the Parties have executed this Agreement.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer`;

const SIGNED_PAGES = [SIGNED_PAGE];

/**
 * The same page as a scanner would have read it: "rn" for "m", "1" for "l", a comma
 * that fell over into a full stop. Cosmetic damage to prose and nothing else -- no
 * digit, no month, no modal, and no name replaced by a different name.
 */
function scanned(page: string): string {
  return page
    .replace(/rm/g, 'rrn')
    .replace(/Delaware/g, 'De1aware')
    .replace(/ment,/g, 'rnent.')
    .replace(/tion\b/g, 'tlon');
}

const SCAN_PAGES = PAGES.map(scanned);
const SCAN_SIGNED_PAGES = SIGNED_PAGES.map(scanned);

function answer(value: string | null, quote: string | null, page: number | null): RawFieldAnswer {
  return { value, quote, page };
}

describe('verifyCitation rejects fabrication', () => {
  it('rejects a plausible sentence that is not in the document', () => {
    const invented =
      'The Receiving Party shall indemnify the Disclosing Party for any breach of this Agreement.';
    const result = verifyCitation(invented, PAGES, 2);
    expect(result.found).toBe(false);
    expect(result.page).toBeNull();
    expect(result.method).toBe('none');
  });

  it('rejects a quote that borrows real words but states something else', () => {
    const invented =
      'This Agreement shall remain in full force and effect for a period of ten (10) years from the Effective Date of the Agreement.';
    expect(verifyCitation(invented, PAGES, 2).found).toBe(false);
  });

  it('rejects an empty or trivial quote', () => {
    expect(verifyCitation('', PAGES).found).toBe(false);
    expect(verifyCitation('  ', PAGES).found).toBe(false);
  });
});

describe('verifyCitation tolerates what PDF extraction does to text', () => {
  it('accepts an exact quote', () => {
    const result = verifyCitation('conflict of laws principles', PAGES, 2);
    expect(result.found).toBe(true);
    expect(result.method).toBe('exact');
    expect(result.page).toBe(2);
  });

  it('accepts a quote whose line wrap became a space', () => {
    const result = verifyCitation(
      'This Agreement shall remain in full force and effect for a period of three (3) years from the Effective Date.',
      PAGES,
      2,
    );
    expect(result.found).toBe(true);
    expect(result.method).toBe('whitespace');
  });

  it('accepts curly quotes, en dashes and non-breaking spaces', () => {
    const mangled =
      'This Mutual Non\u2013Disclosure Agreement (this \u201CAgreement\u201D) is entered\u00A0into as of March 14, 2024';
    const result = verifyCitation(mangled, PAGES, 1);
    expect(result.found).toBe(true);
    expect(result.method).toBe('punctuation');
    expect(result.page).toBe(1);
  });

  it('accepts a soft hyphen and a hyphenated line wrap', () => {
    const mangled = 'the confiden\u00ADtiality officer named in Schedule A';
    expect(verifyCitation(mangled, PAGES, 2).found).toBe(true);
  });

  it('accepts a single extraction artefact through the fuzzy tier', () => {
    const artefact =
      'This Agreement shall be governed by and construed in accordancewith the laws of the State of Delaware';
    const result = verifyCitation(artefact, PAGES, 2);
    expect(result.found).toBe(true);
    expect(result.method).toBe('fuzzy');
    expect(result.similarity).toBeGreaterThanOrEqual(0.92);
  });

  it('does not accept a quote that is only mostly the same idea', () => {
    const paraphrase =
      'This Agreement will be interpreted under the laws of the State of California, without regard to its conflicts rules.';
    expect(verifyCitation(paraphrase, PAGES, 2).found).toBe(false);
  });

  it('corrects the page number instead of trusting the model', () => {
    const result = verifyCitation('conflict of laws principles', PAGES, 1);
    expect(result.found).toBe(true);
    expect(result.page).toBe(2);
  });
});

/**
 * Proper nouns.
 *
 * The gate used to be built on an allow-list of modals, negations and months, so a word
 * it had never heard of was waved through as ordinary prose. "Delaware" and "New York"
 * contain no digit and no listed word, so the check passed VACUOUSLY and the whole guard
 * collapsed to the similarity score -- which one swapped noun in a long sentence barely
 * dents. A fabricated jurisdiction was recorded as verified against a document that says
 * the opposite, and it got easier the longer the quote was.
 *
 * Counterparties, signers, cities, jurisdictions and entity types are the facts this
 * product exists to record. Not one of them may be forgiven.
 */
describe('a swapped proper noun is a fabrication, at every length', () => {
  const swaps: { name: string; real: string; fake: string; pages: string[] }[] = [
    {
      name: 'jurisdiction, 42 characters',
      real: 'the laws of the State of Delaware, without',
      fake: 'the laws of the State of New York, without',
      pages: PAGES,
    },
    {
      name: 'jurisdiction, 78 characters',
      real: 'governed by and construed in accordance with the laws of the State of Delaware',
      fake: 'governed by and construed in accordance with the laws of the State of New York',
      pages: PAGES,
    },
    {
      name: 'jurisdiction, 154 characters',
      real: 'This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles.',
      fake: 'This Agreement shall be governed by and construed in accordance with the laws of the State of New York, without regard to its conflict of laws principles.',
      pages: PAGES,
    },
    {
      name: 'counterparty',
      real: 'is entered into as of March 14, 2024 (the "Effective Date"), between International Battery Company, Inc. and Northwind Cells GmbH.',
      fake: 'is entered into as of March 14, 2024 (the "Effective Date"), between International Battery Company, Inc. and Sunrise Cells GmbH.',
      pages: PAGES,
    },
    {
      name: 'entity suffix',
      real: 'is entered into as of March 14, 2024 (the "Effective Date"), between International Battery Company, Inc. and Northwind Cells GmbH.',
      fake: 'is entered into as of March 14, 2024 (the "Effective Date"), between International Battery Company, Inc. and Northwind Cells Ltd.',
      pages: PAGES,
    },
    {
      name: 'signer',
      real: 'INTERNATIONAL BATTERY COMPANY, INC. By: /s/ Anand Krishnan Name: Anand Krishnan Title: Chief Financial Officer',
      fake: 'INTERNATIONAL BATTERY COMPANY, INC. By: /s/ Anand Krishnan Name: Ananya Krishnan Title: Chief Financial Officer',
      pages: SIGNED_PAGES,
    },
    {
      name: 'city in an address',
      real: 'principal place of business at 1 Innovation Way, Fremont, California 94538',
      fake: 'principal place of business at 1 Innovation Way, Oakland, California 94538',
      pages: SIGNED_PAGES,
    },
    {
      name: 'state in an address',
      real: 'principal place of business at 1 Innovation Way, Fremont, California 94538',
      fake: 'principal place of business at 1 Innovation Way, Fremont, Colorado 94538',
      pages: SIGNED_PAGES,
    },
  ];

  for (const s of swaps) {
    it(`refuses a swapped ${s.name}`, () => {
      // The control first: whatever the guard does to the fabrication, it must be
      // doing it because the name changed, not because the sentence was never there.
      expect(verifyCitation(s.real, s.pages).found).toBe(true);
      expect(verifyCitation(s.fake, s.pages).found).toBe(false);
    });

    it(`refuses a swapped ${s.name} on a scan too`, () => {
      const scan = s.pages.map(scanned);
      expect(verifyCitation(s.real, scan, 1, { ocr: true }).found).toBe(true);
      expect(verifyCitation(s.fake, scan, 1, { ocr: true }).found).toBe(false);
    });
  }

  it('takes the value down with the fabricated jurisdiction', () => {
    const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
      governing_law: answer(
        'New York',
        'This Agreement shall be governed by and construed in accordance with the laws of the State of New York, without regard to its conflict of laws principles.',
        2,
      ),
      effective_date: answer('2024-03-14', 'entered into as of\nMarch 14, 2024', 1),
    };
    const report = applyVerification(answers, PAGES);

    expect(report.fields.governing_law?.value).toBeNull();
    expect(report.fields.governing_law?.method).toBe('missing');
    expect(report.fields.governing_law?.citationVerified).toBe(false);
    expect(report.fields.governing_law?.reason).toBe('quote-not-found');
    expect(report.rejected).toBe(1);
  });
});

/**
 * The other half of the bargain, and the reason the rule above is written the way it is.
 * A guard that refuses a citation that IS in the document is a different bug with the
 * same ending: Bonnie stops believing the tool.
 */
describe('the proper-noun rule still tolerates what a page does to a name', () => {
  it('accepts an ALL CAPS heading through the fuzzy tier', () => {
    // Capitalisation carries no signal in a title, so a heading must not become a wall
    // of names that no extraction artefact is allowed to touch.
    const result = verifyCitation('MUTUAL NONDISCLOSURE AGREEMENT', PAGES, 1);
    expect(result.found).toBe(true);
    expect(result.method).toBe('fuzzy');
  });

  it('accepts a name the scanner mangled', () => {
    // The page says "De1aware"; the model quotes what a human would read off the paper.
    expect(
      verifyCitation('the laws of the State of Delaware, without regard', SCAN_PAGES, 2, {
        ocr: true,
      }).found,
    ).toBe(true);
  });

  it('accepts a signature block off a scan', () => {
    expect(
      verifyCitation(
        'By: /s/ Anand Krishnan Name: Anand Krishnan Title: Chief Financial Officer',
        SCAN_SIGNED_PAGES,
        1,
        { ocr: true },
      ).found,
    ).toBe(true);
  });

  it('accepts a quote whose words the reader ran together across a name', () => {
    const artefact = 'the laws of the Stateof Delaware, without regard to its conflict';
    expect(verifyCitation(artefact, PAGES, 2).found).toBe(true);
  });
});

describe('verifyValueAgainstQuote', () => {
  it('accepts a date that parses to the same day as the quoted date', () => {
    expect(
      verifyValueAgainstQuote('effective_date', '2024-03-14', 'entered into as of March 14, 2024'),
    ).toBe(true);
  });

  it('rejects a date the quote does not contain', () => {
    expect(
      verifyValueAgainstQuote('effective_date', '2024-04-01', 'entered into as of March 14, 2024'),
    ).toBe(false);
  });

  it('accepts a duration written as a word plus a figure', () => {
    expect(verifyValueAgainstQuote('term', '3 years', 'for a period of three (3) years')).toBe(true);
    expect(verifyValueAgainstQuote('term', '5 years', 'for a period of three (3) years')).toBe(
      false,
    );
  });

  it('accepts an email or text value contained in the quote', () => {
    expect(
      verifyValueAgainstQuote('notice_email', 'legal@northwindcells.de', PAGE_2),
    ).toBe(true);
    expect(verifyValueAgainstQuote('governing_law', 'Delaware', 'the laws of the State of Delaware')).toBe(
      true,
    );
    expect(verifyValueAgainstQuote('governing_law', 'California', 'the laws of the State of Delaware')).toBe(
      false,
    );
  });
});

describe('applyVerification', () => {
  it('drops a field whose quote was invented and keeps the rest', () => {
    const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
      governing_law: answer('Delaware', 'the laws of the State of Delaware', 2),
      party_b: answer('Sunrise Batteries LLC', 'between International Battery Company, Inc. and Sunrise Batteries LLC', 1),
    };
    const report = applyVerification(answers, PAGES);

    expect(report.fields.governing_law?.method).toBe('model');
    expect(report.fields.governing_law?.citationVerified).toBe(true);
    expect(report.fields.governing_law?.page).toBe(2);

    expect(report.fields.party_b?.method).toBe('missing');
    expect(report.fields.party_b?.value).toBeNull();
    expect(report.fields.party_b?.quote).toBeNull();
    expect(report.rejected).toBe(1);
  });

  it('flags rather than drops a real quote with a value that does not follow', () => {
    const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
      effective_date: answer('2025-01-01', 'entered into as of\nMarch 14, 2024', 1),
    };
    const report = applyVerification(answers, PAGES);
    const field = report.fields.effective_date;

    expect(field?.method).toBe('model');
    expect(field?.value).toBe('2025-01-01');
    expect(field?.citationVerified).toBe(false);
    expect(report.rejected).toBe(0);
    expect(report.flagged).toBe(1);
  });

  it('drops a value that arrived with no quote at all', () => {
    const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
      governing_law: answer('Delaware', 'the laws of the State of Delaware', 2),
      party_a_signer: answer('Jane Okafor', null, 3),
    };
    const report = applyVerification(answers, PAGES);
    expect(report.fields.party_a_signer?.method).toBe('missing');
    expect(report.fields.party_a_signer?.value).toBeNull();
  });

  it('records a null answer as missing without counting it as a failure', () => {
    const report = applyVerification({ party_c: answer(null, null, null) }, PAGES);
    expect(report.fields.party_c?.method).toBe('missing');
    expect(report.claimed).toBe(0);
    expect(report.rejected).toBe(0);
  });

  it('throws ALL_CITATIONS_FAILED when nothing the model quoted exists', () => {
    const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
      governing_law: answer('New York', 'governed by the laws of the State of New York', 2),
      term: answer('10 years', 'shall continue for a period of ten (10) years thereafter', 2),
    };
    let thrown: unknown;
    try {
      applyVerification(answers, PAGES);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EngineError);
    expect(thrown instanceof EngineError ? thrown.code : null).toBe('ALL_CITATIONS_FAILED');
  });
});
