import { describe, expect, it } from 'vitest';

import {
  citationCounts,
  citationSummary,
  citationVerdict,
  provenanceNotices,
  type CitationCountInput,
  type ProvenanceInput,
} from '../src/lib/client/provenance';

/**
 * These are regression tests for the defect the audit called the worst one: a
 * field nobody had checked rendered exactly like a citation-verified one. Every
 * assertion below is about a claim the UI makes, so a change that makes one of
 * them fail is a change that lets the product overstate what it knows.
 */

function field(over: Partial<CitationCountInput> = {}): CitationCountInput {
  return { value: 'Delaware', method: 'model', citationVerified: true, ...over };
}

describe('citationVerdict', () => {
  it('keeps all three states apart', () => {
    expect(citationVerdict({ method: 'model', citationVerified: true })).toBe(true);
    expect(citationVerdict({ method: 'model', citationVerified: false })).toBe(false);
    // The regression. `!== false` collapsed this one into true.
    expect(citationVerdict({ method: 'model', citationVerified: null })).toBe(null);
  });

  it('does not spend the warning on a rule hit', () => {
    // A rule quote is the span the regex matched, so it is in the document by
    // construction even though nothing verified it afterwards.
    expect(citationVerdict({ method: 'rule', citationVerified: null })).toBe(true);
  });
});

describe('citationCounts', () => {
  it('counts a vision read, where every citation is null', () => {
    const vision = [
      field({ citationVerified: null }),
      field({ citationVerified: null }),
      field({ citationVerified: null }),
    ];
    // The old detail sheet tested `=== false` and so reported zero here.
    expect(citationCounts(vision)).toEqual({ unverified: 0, unchecked: 3 });
    expect(citationSummary(citationCounts(vision))).toBe(
      '3 values were never checked against the document.',
    );
  });

  it('separates searched-and-not-found from never-checked', () => {
    const counts = citationCounts([
      field({ citationVerified: false }),
      field({ citationVerified: null }),
      field({ citationVerified: true }),
    ]);
    expect(counts).toEqual({ unverified: 1, unchecked: 1 });
    expect(citationSummary(counts)).toBe(
      '1 value could not be traced back to the document, and 1 more was never checked.',
    );
  });

  it('says nothing about values that are not claiming to be quoted', () => {
    // A value she typed, a date we computed, an explicit gap and a rule hit make
    // no citation claim, so none of them belongs in a warning about citations.
    const counts = citationCounts([
      field({ method: 'manual', citationVerified: null }),
      field({ method: 'computed', citationVerified: null }),
      field({ method: 'na', value: null, citationVerified: null }),
      field({ method: 'rule', citationVerified: null }),
      field({ method: 'missing', value: null, citationVerified: null }),
    ]);
    expect(counts).toEqual({ unverified: 0, unchecked: 0 });
    expect(citationSummary(counts)).toBe(null);
  });

  it('ignores a field with no value at all', () => {
    expect(citationCounts([field({ value: null, citationVerified: false })])).toEqual({
      unverified: 0,
      unchecked: 0,
    });
  });
});

describe('citationSummary', () => {
  it('is singular for one', () => {
    expect(citationSummary({ unverified: 1, unchecked: 0 })).toBe(
      '1 value could not be traced back to the document.',
    );
    expect(citationSummary({ unverified: 0, unchecked: 1 })).toBe(
      '1 value was never checked against the document.',
    );
  });
});

describe('provenanceNotices', () => {
  const scan: ProvenanceInput = { pageCount: 4, pagesRead: 4 };

  it('says nothing about a digital PDF read whole', () => {
    expect(provenanceNotices({ ...scan, textSource: 'pdf', ocrConfidence: null })).toEqual([]);
  });

  it('says nothing when the provenance columns are absent', () => {
    // A document read before those columns existed must degrade to silence, not
    // to a guess about how it was read.
    expect(provenanceNotices({ pageCount: 4 })).toEqual([]);
  });

  it('warns that a vision read was never checked, and names the rejected score', () => {
    // rejectedOcrConfidence, not ocrConfidence. The pipeline stores null in the latter on
    // this path by design -- it describes the read we kept, and on vision we kept none --
    // so a test that fed it there was proving a sentence the app could never print.
    const notices = provenanceNotices({
      ...scan,
      textSource: 'vision',
      ocrConfidence: null,
      rejectedOcrConfidence: 0.41,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.id).toBe('vision');
    expect(notices[0]?.tone).toBe('warn');
    expect(notices[0]?.title).toContain('page images');
    expect(notices[0]?.body).toContain('none of them were checked');
    expect(notices[0]?.body).toContain('41%');
  });

  it('discloses an OCR read against the machine-read text, not the page', () => {
    const notices = provenanceNotices({ ...scan, textSource: 'ocr', ocrConfidence: 0.87 });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.id).toBe('ocr');
    expect(notices[0]?.body).toContain('machine-read text');
    expect(notices[0]?.body).toContain('not against the page itself');
    expect(notices[0]?.body).toContain('confidence 87%');
  });

  it('reads the confidence as a fraction and clamps a bad one', () => {
    expect(provenanceNotices({ ...scan, textSource: 'ocr', ocrConfidence: 1 })[0]?.body).toContain(
      '100%',
    );
    expect(provenanceNotices({ ...scan, textSource: 'ocr', ocrConfidence: 87 })[0]?.body).toContain(
      '100%',
    );
    expect(
      provenanceNotices({ ...scan, textSource: 'ocr', ocrConfidence: Number.NaN })[0]?.body,
    ).not.toContain('confidence');
  });

  it('banners a scan that was cut short, so "not found" cannot read as "not present"', () => {
    const notices = provenanceNotices({
      textSource: 'ocr',
      ocrConfidence: 0.9,
      pagesRead: 40,
      pagesReadRanges: '1-28, 51-62',
      pageCount: 62,
    });
    const pages = notices.find((n) => n.id === 'pages');
    // Names the pages, and never says "the first 40". selectPages spends the budget on
    // head AND tail, so the unread stretch is the middle -- claiming the tail was missed
    // points the reviewer away from the signature block the cap exists to protect.
    expect(pages?.title).toBe('40 pages of 62 were read: 1-28, 51-62.');
    expect(pages?.title).not.toContain('first');
    expect(pages?.body).toContain('other 22 pages');
    expect(pages?.body).toContain('not found in document');
  });

  it('refuses to imply which pages when the ranges were never stored', () => {
    // Documents read before the ranges column existed. Say how many were missed; do not
    // guess at which, because the only guess available ("the first N") is wrong.
    const pages = provenanceNotices({ textSource: 'ocr', pagesRead: 40, pageCount: 62 }).find(
      (n) => n.id === 'pages',
    );
    expect(pages?.title).toBe('40 pages of 62 were read.');
    expect(pages?.title).not.toContain('first');
    expect(pages?.body).toContain('other 22 pages');
  });

  it('is singular when one page went unread', () => {
    const pages = provenanceNotices({ pagesRead: 1, pagesReadRanges: '1', pageCount: 2 })[0];
    expect(pages?.title).toBe('1 page of 2 was read: 1.');
    expect(pages?.body).toContain('other 1 page');
  });

  it('says nothing when every page was read', () => {
    expect(provenanceNotices({ textSource: 'pdf', pagesRead: 9, pageCount: 9 })).toEqual([]);
  });
});
