/**
 * What the app is allowed to claim about where a value came from.
 *
 * The whole product answers one objection: do not tell her about a contract
 * unless you can show her where it says so. Two things decide whether a receipt
 * is real -- the three-state citation flag on a field, and how the words got off
 * the page in the first place -- and both are decided here rather than inside a
 * component, so Review and the repository cannot drift apart and so a test can
 * hold every sentence against the numbers it describes.
 *
 * Pure. No React, no fetch, no db.
 */

import type { ExtractionMethod } from '@/lib/fields';

/**
 * How the words the model was given came off the page. Mirrors the pipeline's
 * own TextSource; the guarantees differ per path:
 *
 *   pdf    - the PDF's own text layer. Rules ran, every quote was checked.
 *   ocr    - a machine read the rasterised pages. Quotes were checked against
 *            that machine-read text, which is not the same as the page.
 *   vision - page images went to the model. There is no text, so nothing was
 *            checked at all.
 */
export type TextSource = 'pdf' | 'ocr' | 'vision';

/**
 * The provenance columns as they arrive on a document row.
 *
 * Every one is optional because a document read before these columns existed
 * has none of them, and a missing column must degrade to "say nothing" rather
 * than to a guess.
 */
export interface ProvenanceInput {
  textSource?: TextSource | null | undefined;
  /** Mean confidence of the machine read, 0..1, whenever OCR ran. */
  ocrConfidence?: number | null | undefined;
  /** Pages actually read. Short of pageCount when a limit cut the read off. */
  pagesRead?: number | null | undefined;
  /**
   * WHICH pages, as "1-28, 49-60". The count cannot express this and must not be
   * used to guess: the reader spends its budget on the head and the tail, so
   * "40 of 60" is never the first 40.
   */
  pagesReadRanges?: string | null | undefined;
  /** 0..1. An OCR score that was rejected as too poor, sending the read to vision. */
  rejectedOcrConfidence?: number | null | undefined;
  pageCount?: number | undefined;
}

/** 'warn' is a caveat about the evidence; 'quiet' is a disclosure. */
export type NoticeTone = 'warn' | 'quiet';

export interface ProvenanceNotice {
  id: 'vision' | 'ocr' | 'pages';
  tone: NoticeTone;
  /** The fact, in one sentence. */
  title: string;
  /** What it means for the evidence underneath it. */
  body: string;
}

/**
 * The column stores a fraction, and the sentence reads as a percentage. Clamped
 * rather than trusted: a stored value outside 0..1 is a bug somewhere else, and
 * "6000%" in a warning about accuracy would be its own small joke.
 */
function percent(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function pages(count: number): string {
  return count === 1 ? '1 page' : `${count} pages`;
}

/**
 * The document-level things that have to be said out loud, in reading order.
 *
 * A per-field marker cannot carry any of these: they are true of every field at
 * once, and sixteen copies of the same caveat is how a caveat stops being read.
 */
export function provenanceNotices(document: ProvenanceInput): ProvenanceNotice[] {
  const notices: ProvenanceNotice[] = [];
  const confidence = percent(document.ocrConfidence);
  const rejected = percent(document.rejectedOcrConfidence);

  if (document.textSource === 'vision') {
    notices.push({
      id: 'vision',
      tone: 'warn',
      title: 'This document was read from page images, not from text.',
      body:
        'There was no text on the page to check the quotes against, so none of them were ' +
        'checked. Every value below is what the model reported seeing' +
        /*
         * The rejected score, not `confidence`. ocr_confidence is null by design on
         * this path -- it describes the read we kept, and we kept none -- so the
         * sentence that named it could never appear. The losing score lives in its
         * own column precisely so it can be said here without being mistaken for a
         * score this read earned.
         */
        (rejected === null
          ? '. '
          : `, after the machine read of this scan scored ${rejected} and was rejected as too poor to use. `) +
        'Read each one against the page before approving it.',
    });
  }

  if (document.textSource === 'ocr') {
    notices.push({
      id: 'ocr',
      tone: 'quiet',
      title: 'This document was a scan, read by machine.',
      body:
        'Quotes were checked against the machine-read text' +
        (confidence === null ? '' : ` (confidence ${confidence})`) +
        ', not against the page itself. A digit the machine got wrong would still pass that ' +
        'check, so read the dates and the numbers against the page.',
    });
  }

  const read = document.pagesRead;
  const total = document.pageCount;
  if (
    typeof read === 'number' &&
    typeof total === 'number' &&
    read > 0 &&
    total > 0 &&
    read < total
  ) {
    /*
     * Name the pages, never the count.
     *
     * The reader deliberately takes the head AND the tail, because the front holds the
     * parties, dates and term and the back holds the signatures, notice block and
     * governing law -- the middle is recitals. Describing that as "the first 40 pages"
     * was worse than vague: it told the reviewer the signature block had not been read
     * when the tail is exactly what the cap exists to protect, and it hid that the gap
     * is in the middle. Only the stored ranges can say this, so with no ranges we say
     * how many were missed and refuse to imply which.
     */
    const ranges = document.pagesReadRanges?.trim();
    notices.push({
      id: 'pages',
      tone: 'warn',
      title: `${pages(read)} of ${total} ${read === 1 ? 'was' : 'were'} read${
        ranges ? `: ${ranges}` : ''
      }.`,
      body:
        `The other ${pages(total - read)} were not seen. A field that reads "not found in ` +
        'document" may still be in there.',
    });
  }

  return notices;
}

/* ─────────────────────────── citations ─────────────────────────── */

export interface CitationInput {
  method: ExtractionMethod;
  citationVerified: boolean | null;
}

/**
 * Three states, kept three states.
 *
 *   true  - the quote was searched for in the document's text and found.
 *   false - it was searched for and not found.
 *   null  - it was never checked, because there was no text to check against.
 *
 * The one null that is not a gap is a rule hit: that quote IS the span a regex
 * matched in the document, so it is in there by construction and there is
 * nothing left to check. Marking it "not checked" would spend the warning on
 * the most deterministic path in the product and teach her to ignore it.
 */
export function citationVerdict(field: CitationInput): boolean | null {
  if (field.citationVerified !== null) return field.citationVerified;
  return field.method === 'rule' ? true : null;
}

export interface CitationCounts {
  /** Searched for and not found. */
  unverified: number;
  /** Never checked at all. */
  unchecked: number;
}

export interface CitationCountInput extends CitationInput {
  value: string | null;
}

/**
 * How many of the values on screen are standing on a receipt that was not
 * proved. Only a model's answer makes a citation claim -- a rule hit is verified
 * by construction, and a value she typed, a date we computed and an explicit
 * "not in this document" are not claiming to be quoted from anywhere.
 */
export function citationCounts(fields: Iterable<CitationCountInput>): CitationCounts {
  const counts: CitationCounts = { unverified: 0, unchecked: 0 };
  for (const field of fields) {
    if (field.value === null || field.method !== 'model') continue;
    const verdict = citationVerdict(field);
    if (verdict === false) counts.unverified += 1;
    else if (verdict === null) counts.unchecked += 1;
  }
  return counts;
}

function values(count: number): string {
  return count === 1 ? '1 value' : `${count} values`;
}

/** The one line a settled record gets about its own evidence. Null when clean. */
export function citationSummary(counts: CitationCounts): string | null {
  const { unverified, unchecked } = counts;
  if (unverified > 0 && unchecked > 0) {
    return `${values(unverified)} could not be traced back to the document, and ${unchecked} more ${
      unchecked === 1 ? 'was' : 'were'
    } never checked.`;
  }
  if (unverified > 0) {
    return `${values(unverified)} could not be traced back to the document.`;
  }
  if (unchecked > 0) {
    return `${values(unchecked)} ${
      unchecked === 1 ? 'was' : 'were'
    } never checked against the document.`;
  }
  return null;
}
