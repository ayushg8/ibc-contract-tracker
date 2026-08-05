/**
 * OCR, and the one thing it is for.
 *
 * The claim this file has to hold up is not "tesseract can read a page". It is that a
 * scan now goes through the SAME citation guard a digital PDF goes through. So there
 * are two halves here:
 *
 *   1. A real rasterise -> OCR round trip on a real fixture, asserting that the
 *      strings the tracker actually extracts survive it. Slow (seconds per page) and
 *      tagged accordingly.
 *   2. The tolerance question, which is where the danger is. OCR text is noisy, so the
 *      fuzzy tier is allowed to run looser on it -- and a looser matcher is exactly how
 *      a wrong number gets waved through. Every test below the first describe() is
 *      cheap, and every one of them exists to prove that did not happen.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  MAX_OCR_PAGES,
  MIN_OCR_CONFIDENCE,
  OCR_TAIL_PAGES,
  formatPageRanges,
  ocrPages,
  recallStartFailure,
  selectPages,
  shutdownOcr,
} from '@/lib/extraction/ocr';
import { OCR_DPI, readPdf, renderPages } from '@/lib/extraction/pdf';
import { applyVerification, verifyCitation } from '@/lib/extraction/verify';
import { MODEL_FIELD_KEYS, type FieldKey } from '@/lib/fields';
import type { RawFieldAnswer } from '@/lib/providers/types';

import { stubProvider, useEvalDataDir } from '../evals/cases/_harness';
import { makePdf } from '../evals/fixtures/pdf';
import { ntrium } from '../evals/fixtures/index';

// Before anything can open a connection: this file gets a throwaway database.
useEvalDataDir();

/** Worker start (~1.5s) plus ~3s a page, and the first run may fetch language data. */
const SLOW_MS = 180_000;

afterAll(async () => {
  // A live worker is a live worker_thread; vitest would hang on it.
  await shutdownOcr();
});

/* ────────────────── a real scan, built from a real fixture ───────────── */

/**
 * Turns a text PDF into an image-only one: the pages are rasterised, re-encoded as
 * JPEG and wrapped as /DCTDecode XObjects, leaving a document with no text layer at
 * all. This is the only way to exercise the pipeline's scan branch honestly -- a
 * fixture with a text layer never reaches it, and asserting on a hand-written
 * "pretend scan" would test nothing.
 *
 * @napi-rs/canvas is what pdfjs already rasterises through, so this adds no
 * dependency the app does not already have at runtime.
 */
async function makeScannedPdf(source: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const rendered = await renderPages(source, pages, { dpi: OCR_DPI });

  const jpegs: { bytes: Uint8Array; width: number; height: number }[] = [];
  for (const page of rendered) {
    const image = await loadImage(Buffer.from(page.base64, 'base64'));
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    jpegs.push({
      bytes: canvas.toBuffer('image/jpeg'),
      width: image.width,
      height: image.height,
    });
  }

  const latin1 = (s: string): number[] => [...s].map((c) => c.codePointAt(0) ?? 63);
  const objects: number[][] = [];

  // 1 = catalog, 2 = page tree, then three objects per page.
  const pageIds = jpegs.map((_j, i) => 3 + i * 3);
  objects.push(latin1('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(
    latin1(
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${jpegs.length} >>`,
    ),
  );

  jpegs.forEach((jpeg, i) => {
    const pageId = pageIds[i] ?? 0;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    // Letter at 72dpi, with the raster stretched to fill it.
    const w = 612;
    const h = 792;
    objects.push(
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    objects.push(latin1(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    objects.push([
      ...latin1(
        `<< /Type /XObject /Subtype /Image /Width ${jpeg.width} /Height ${jpeg.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${jpeg.bytes.length} >>\nstream\n`,
      ),
      ...jpeg.bytes,
      ...latin1('\nendstream'),
    ]);
  });

  const out: number[] = [];
  const offsets: number[] = [];
  const write = (s: string): void => {
    for (const b of latin1(s)) out.push(b);
  };

  write('%PDF-1.4\n');
  objects.forEach((body, i) => {
    offsets.push(out.length);
    write(`${i + 1} 0 obj\n`);
    for (const b of body) out.push(b);
    write('\nendobj\n');
  });

  const xrefAt = out.length;
  write(`xref\n0 ${objects.length + 1}\n`);
  write('0000000000 65535 f \n');
  for (const off of offsets) write(`${String(off).padStart(10, '0')} 00000 n \n`);
  write(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );

  return new Uint8Array(out);
}

/* ─────────────────────── 1. the real round trip ──────────────────────── */

describe('ocrPages reads a rasterised contract page', () => {
  it(
    'recovers the strings the tracker extracts',
    { timeout: SLOW_MS },
    async () => {
      const pdf = makePdf(ntrium.pages);
      const images = await renderPages(new Uint8Array(pdf), [1, 2], { dpi: OCR_DPI });
      expect(images).toHaveLength(2);

      const result = await ocrPages(images, { dpi: OCR_DPI });

      expect(result.pagesText).toHaveLength(2);
      expect(result.confidence).toBeGreaterThanOrEqual(MIN_OCR_CONFIDENCE);
      expect(result.pages.every((p) => p.durationMs > 0)).toBe(true);

      const page1 = result.pagesText[0] ?? '';
      const page2 = result.pagesText[1] ?? '';

      // The four extraction targets on these pages, in the words the model must quote.
      expect(page1).toContain('International Battery Company');
      expect(page1).toContain('Ntrium');
      expect(page1).toMatch(/November\s+5,?\s+2022/);
      expect(page2).toMatch(/five\s*\(5\)\s*years/i);
      expect(page2).toContain('Delaware');
    },
  );

  it(
    'verifies a genuine quote against the machine-read text',
    { timeout: SLOW_MS },
    async () => {
      const pdf = makePdf(ntrium.pages);
      const images = await renderPages(new Uint8Array(pdf), [2], { dpi: OCR_DPI });
      const { pagesText } = await ocrPages(images, { dpi: OCR_DPI });

      // This is the guarantee OCR exists to restore: on the vision path there is no
      // text here at all and this check cannot run.
      const cite = verifyCitation(
        'shall remain in force for five (5) years',
        pagesText,
        1,
        { ocr: true },
      );
      expect(cite.found).toBe(true);
      expect(cite.page).toBe(1);
    },
  );

  it('returns an empty read for no pages without starting a worker', async () => {
    const result = await ocrPages([]);
    expect(result).toEqual({
      pagesText: [],
      confidence: 0,
      durationMs: 0,
      pages: [],
      stoppedEarly: false,
    });
  });

  it('stops at the document budget instead of running per-page forever', { timeout: SLOW_MS }, async () => {
    const pdf = makePdf(ntrium.pages);
    const images = await renderPages(new Uint8Array(pdf), [1, 2], { dpi: OCR_DPI });

    // PAGE_TIMEOUT_MS x MAX_OCR_PAGES is forty minutes; the whole-document clock is
    // what makes that a real bound. One millisecond of budget means it stops before
    // the first page rather than after the fortieth.
    const result = await ocrPages(images, { dpi: OCR_DPI, totalTimeoutMs: 1 });

    expect(result.stoppedEarly).toBe(true);
    expect(result.pages.length).toBeLessThan(images.length);
  });

  it('honours an already-aborted signal', { timeout: SLOW_MS }, async () => {
    const pdf = makePdf(ntrium.pages);
    const images = await renderPages(new Uint8Array(pdf), [1], { dpi: OCR_DPI });
    const controller = new AbortController();
    controller.abort();

    await expect(ocrPages(images, { signal: controller.signal })).rejects.toMatchObject({
      code: 'PDF_NO_TEXT_LAYER',
    });
  });
});

/* ──────── 1b. which pages get read when there is not budget for all ──── */

/**
 * The regression: a 60-page scan read as "the first 40" loses the execution block,
 * the notice addresses and the governing law clause -- and a field nobody looked for
 * comes back indistinguishable from a field that is not there. A reviewer then marks
 * a clause she is looking at as absent.
 */
describe('the page budget is spent on the front AND the back', () => {
  it('reads everything when the document fits', () => {
    const selection = selectPages(9, MAX_OCR_PAGES, OCR_TAIL_PAGES);
    expect(selection.truncated).toBe(false);
    expect(selection.pages).toHaveLength(9);
    expect(formatPageRanges(selection.ranges)).toBe('1-9');
  });

  it('keeps the tail when the document does not fit', () => {
    const selection = selectPages(60, MAX_OCR_PAGES, OCR_TAIL_PAGES);

    expect(selection.truncated).toBe(true);
    expect(selection.pages).toHaveLength(MAX_OCR_PAGES);
    // The signature page of a 60-page agreement is page 60, not page 40.
    expect(selection.pages).toContain(60);
    expect(selection.pages).toContain(1);
    expect(selection.pages).not.toContain(29);
    expect(formatPageRanges(selection.ranges)).toBe('1-28, 49-60');
  });

  it('never lets the tail eat the whole budget', () => {
    const selection = selectPages(50, 2, 12);
    expect(selection.pages).toEqual([1, 50]);
    expect(formatPageRanges(selection.ranges)).toBe('1, 50');
  });

  it('is stable at the boundary', () => {
    expect(selectPages(MAX_OCR_PAGES, MAX_OCR_PAGES, OCR_TAIL_PAGES).truncated).toBe(false);
    expect(selectPages(MAX_OCR_PAGES + 1, MAX_OCR_PAGES, OCR_TAIL_PAGES).truncated).toBe(true);
    expect(selectPages(0, MAX_OCR_PAGES, OCR_TAIL_PAGES).pages).toEqual([]);
  });
});

/* ──────── 1c. a start failure is remembered, then forgotten ──────────── */

describe('an unstartable OCR engine fails fast', () => {
  const failure = { detail: 'the OCR engine could not start: no language data', at: 1_000_000 };

  it('answers instantly with the real reason instead of waiting 90 seconds again', () => {
    const recalled = recallStartFailure(failure, failure.at + 1_000);
    expect(recalled?.code).toBe('PDF_NO_TEXT_LAYER');
    expect(recalled?.detail).toContain('no language data');
  });

  it('forgets it once the cooldown passes, so a fixed machine recovers', () => {
    expect(recallStartFailure(failure, failure.at + 6 * 60_000)).toBeNull();
    expect(recallStartFailure(null, Date.now())).toBeNull();
  });
});

/* ────────── 2. the pipeline: a scan behaves like a digital PDF ───────── */

describe('the pipeline reads a scan through OCR', () => {
  it(
    'runs rules and verifies citations on a document with no text layer',
    { timeout: SLOW_MS },
    async () => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const { evalScratchDir } = await import('../evals/cases/_harness');
      const pipeline = await import('@/lib/extraction/pipeline');
      const queries = await import('@/lib/db/queries');

      const digital = makePdf(ntrium.pages.slice(0, 2));
      const scanned = await makeScannedPdf(digital, [1, 2]);

      // The premise: pdfjs finds no text in it, so today this document would have
      // been pushed onto the vision path with the citation guard switched off.
      const read = await readPdf(scanned);
      expect(read.hasTextLayer).toBe(false);
      expect(read.pageCount).toBe(2);

      const path = join(evalScratchDir(), 'ntrium-scanned.pdf');
      writeFileSync(path, scanned);
      const { id } = queries.createDocument({
        fileHash: createHash('sha256').update(scanned).digest('hex'),
        filename: 'Ntrium_NDA_scanned.pdf',
        archivePath: path,
        byteSize: scanned.byteLength,
      });

      // The same canned answers that verify against the digital fixture. If they
      // still verify here, the guard genuinely survived the round trip through paper.
      const stub = stubProvider(ntrium);
      const out = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(out.textSource).toBe('ocr');
      expect(out.ocrConfidence ?? 0).toBeGreaterThanOrEqual(MIN_OCR_CONFIDENCE);

      // The model was sent text, not pictures. That is the whole change.
      expect(stub.requests[0]?.images).toBeNull();
      expect(stub.requests[0]?.text ?? '').toContain('===== PAGE 1 =====');

      // Rules ran, which they never did on a scan before.
      const effective = out.fields.find((f) => f.key === 'effective_date');
      expect(effective?.value).toBe('2022-11-05');
      expect(effective?.method).toBe('rule');

      // And at least one model field came back with a checked citation rather than
      // the null "we did not look" the vision path leaves behind.
      const verified = out.fields.filter((f) => f.citationVerified === true);
      expect(verified.length).toBeGreaterThan(0);
      expect(out.fields.some((f) => f.method === 'model' && f.citationVerified === null)).toBe(
        false,
      );

      // How it was read is on the record, not inferred.
      const history = queries.getDocumentAudit(id).map((e) => e.detail ?? '');
      expect(history.some((d) => d.includes('read by OCR'))).toBe(true);

      /*
       * And it is on the ROW, not only in the timeline. This is the difference the
       * whole feature turns on: citation_verified = 1 here means "found in the text
       * we machined off the scan", and an identical 1 on a digital PDF means "found
       * on the page". Nothing downstream can tell those apart without this column.
       */
      const stored = queries.getDocument(id);
      expect(stored?.textSource).toBe('ocr');
      // Stored 0..1 (see DocumentReadMeta); this module works in tesseract's 0..100.
      expect(stored?.ocrConfidence ?? 0).toBeGreaterThanOrEqual(MIN_OCR_CONFIDENCE / 100);
      expect(stored?.ocrConfidence ?? 0).toBeLessThanOrEqual(1);
      expect(stored?.pagesRead).toBe(2);
    },
  );

  /**
   * THE other regression. tesseract reports 60-75 on word salad often enough that the
   * usableOcr gate lets one through, and once it does there was no way back: every
   * citation failed against the nonsense, ALL_CITATIONS_FAILED came out retryable, and
   * the queue burned two more identical passes against a fresh OCR of the same image.
   * The one thing that could have read the document -- vision -- was never tried.
   */
  it(
    'reads the images when the machine read contains none of the quotes',
    { timeout: SLOW_MS },
    async () => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const { evalScratchDir } = await import('../evals/cases/_harness');
      const pipeline = await import('@/lib/extraction/pipeline');
      const queries = await import('@/lib/db/queries');

      // The reference line has to be on a page that is actually rasterised: identity
      // in this app is the sha256 of the bytes, so a scan of the same two pages IS
      // the same document and would be served from the first test's cache.
      const digital = makePdf([
        ntrium.pages[0] ?? '',
        `${ntrium.pages[1] ?? ''}\n\nDocument reference: unverifiable`,
      ]);
      const scanned = await makeScannedPdf(digital, [1, 2]);
      const path = join(evalScratchDir(), 'ntrium-unverifiable.pdf');
      writeFileSync(path, scanned);
      const created = queries.createDocument({
        fileHash: createHash('sha256').update(scanned).digest('hex'),
        filename: 'Ntrium_NDA_unverifiable.pdf',
        archivePath: path,
        byteSize: scanned.byteLength,
      });
      expect(created.duplicate).toBe(false);
      const id = created.id;

      // Every quote is a sentence the document does not contain, which is what a
      // garbage machine read looks like from the guard's side.
      const stub = stubProvider(ntrium, { fabricate: [...MODEL_FIELD_KEYS] });
      const out = await pipeline.extractDocument(id, { provider: stub, tier: 'balanced' });

      expect(out.fellBackToVision).toBe(true);
      expect(out.textSource).toBe('vision');

      // Two passes, and the second one was genuinely different: text first, then
      // images. A cached replay would have left this at one.
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0]?.images).toBeNull();
      expect(stub.requests[1]?.text).toBeNull();
      expect((stub.requests[1]?.images ?? []).length).toBeGreaterThan(0);

      // Nothing read off a picture may claim a checked citation.
      expect(out.fields.every((f) => f.method !== 'model' || f.citationVerified === null)).toBe(
        true,
      );
      const stored = queries.getDocument(id);
      expect(stored?.textSource).toBe('vision');
      expect(stored?.status).not.toBe('failed');
    },
  );
});

/* ──────────────── 3. the tolerance, which must not slip ──────────────── */

/**
 * Page 2 of the Ntrium fixture as OCR plausibly mangles it: "m" read as "rn", an "l"
 * read as "1", a comma that became a period. Every one of those is cosmetic damage to
 * ordinary prose. Not one of them touches a digit, a month, a modal or a negation --
 * which is exactly the line the tolerance is allowed to sit on.
 */
const OCR_PAGE = `3. Term. This Agreernent shall commence on the Effective Date and shall remain in
force for five (5) years, unless earlier terrninated by either Party upon thirty (30)
days prior wntten notice to the other Party.

4. Survival of Confidentiality. Notwithstanding any expiration or termination of this
Agreernent, the obligations of confidentiality and non-use set out in Section 2 shall
survive for five (5) years from the Effective Date.

9. Governing Law. This Agreernent shall be governed by and construed in accordance
with the laws of the State of De1aware. without regard to its conflict of laws
principIes.`;

const OCR_PAGES = [OCR_PAGE];

function answer(value: string | null, quote: string | null, page: number | null): RawFieldAnswer {
  return { value, quote, page };
}

const CLEAN_CLAUSE =
  'This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware';

/**
 * Substitutes every nth letter, leaving the meaning-bearing tokens alone. A dial for
 * "how badly did the scan go", so the test can find the threshold instead of guessing
 * a magic string that happens to land between two constants.
 */
function corrupt(sentence: string, everyNth: number): string {
  const protectedWords = new Set(['shall']);
  let seen = 0;
  return sentence
    .split(' ')
    .map((word) => {
      if (protectedWords.has(word.toLowerCase())) return word;
      return [...word]
        .map((ch) => {
          if (!/[a-z]/i.test(ch)) return ch;
          seen += 1;
          return seen % everyNth === 0 ? 'x' : ch;
        })
        .join('');
    })
    .join(' ');
}

describe('the OCR tolerance forgives noise', () => {
  it('accepts a clean quote against text the scan mangled', () => {
    // "Agreernent" and "terrninated" in the haystack; the model quotes the printed page.
    const quote =
      'This Agreement shall commence on the Effective Date and shall remain in force for five (5) years';
    expect(verifyCitation(quote, OCR_PAGES, 1, { ocr: true }).found).toBe(true);
  });

  it('is genuinely looser than the digital threshold, and never tighter', () => {
    const disagreements: number[] = [];

    for (let everyNth = 30; everyNth >= 4; everyNth -= 1) {
      const page = [corrupt(CLEAN_CLAUSE, everyNth)];
      const digital = verifyCitation(CLEAN_CLAUSE, page, 1).found;
      const scan = verifyCitation(CLEAN_CLAUSE, page, 1, { ocr: true }).found;

      // The only permitted asymmetry is the scan being more forgiving.
      expect(digital && !scan).toBe(false);
      if (scan && !digital) disagreements.push(everyNth);
    }

    // If the option changed nothing, this would be empty and the OCR path would be
    // rejecting good citations for the scanner's mistakes.
    expect(disagreements.length).toBeGreaterThan(0);
  });
});

describe('the OCR tolerance does NOT forgive a wrong number', () => {
  /**
   * THE regression. A model that reads the right clause and writes down the wrong
   * figure produces a contract record that is wrong in the one way nobody notices,
   * and a noisy haystack is not an excuse to let it through. meaningPreserved() is
   * the gate, and it does not move when opts.ocr is set.
   */
  it('rejects a term with the wrong figure in the parentheses', () => {
    const fabricated = 'shall remain in force for five (7) years';
    expect(verifyCitation(fabricated, OCR_PAGES, 1).found).toBe(false);
    expect(verifyCitation(fabricated, OCR_PAGES, 1, { ocr: true }).found).toBe(false);
  });

  it('rejects a notice period that is off by one digit', () => {
    const fabricated = 'terminated by either Party upon sixty (60) days prior written notice';
    expect(verifyCitation(fabricated, OCR_PAGES, 1, { ocr: true }).found).toBe(false);
  });

  it('rejects a survival period the document does not state', () => {
    const fabricated = 'the obligations of confidentiality and non-use set out in Section 2 shall survive for ten (10) years';
    expect(verifyCitation(fabricated, OCR_PAGES, 1, { ocr: true }).found).toBe(false);
  });

  it('rejects a swapped modal', () => {
    const fabricated =
      'the obligations of confidentiality and non-use set out in Section 2 may survive for five (5) years';
    expect(verifyCitation(fabricated, OCR_PAGES, 1, { ocr: true }).found).toBe(false);
  });

  it('takes the value down with the fabricated quote, through applyVerification', () => {
    const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
      governing_law: answer('Delaware', 'the laws of the State of Delaware', 1),
      term: answer('7 years', 'shall remain in force for five (7) years', 1),
    };

    const report = applyVerification(answers, OCR_PAGES, { ocr: true });

    expect(report.fields.governing_law?.value).toBe('Delaware');
    expect(report.fields.term?.value).toBeNull();
    expect(report.fields.term?.method).toBe('missing');
    expect(report.fields.term?.citationVerified).toBe(false);
  });
});

describe('a scan says why a field could not be checked', () => {
  const answers: Partial<Record<FieldKey, RawFieldAnswer>> = {
    notice_address: answer('1 Nowhere Street', 'This sentence was never printed here.', 1),
    governing_law: answer('Delaware', 'the laws of the State of Delaware', 1),
  };

  /*
   * The digital assertions get a CLEAN page, not the OCR one.
   *
   * These cases are about which haystack the message blames, so the control quote has
   * to verify on whichever path is under test. Running the OCR page down the digital
   * path was always an artificial pairing -- the pipeline derives the flag from
   * `read.source`, so scanned text is never verified as if it were a text layer -- and
   * once per-word edit tolerance became zero on the digital path (it exists to absorb
   * scanner damage, and a text layer has none), `De1aware` correctly stopped matching
   * `Delaware`. The control failed with everything else and the whole report threw.
   */
  const DIGITAL_PAGES = [
    `9. Governing Law. This Agreement shall be governed by and construed in accordance
with the laws of the State of Delaware, without regard to its conflict of laws
principles.`,
  ];

  it('blames the scan, not the document', () => {
    const scanned = applyVerification(answers, OCR_PAGES, { ocr: true });
    expect(scanned.fields.notice_address?.reason).toBe('unverifiable-on-scan');
    expect(scanned.notes.join(' ')).toContain('could not be checked against the scan');
  });

  it('blames the document on a digital PDF', () => {
    const digital = applyVerification(answers, DIGITAL_PAGES);
    expect(digital.fields.notice_address?.reason).toBe('quote-not-found');
    expect(digital.notes.join(' ')).toContain('not in the document');
  });

  it('drops the value on both paths — the guard is the guard', () => {
    for (const [pages, opts] of [
      [OCR_PAGES, { ocr: true }],
      [DIGITAL_PAGES, {}],
    ] as const) {
      const report = applyVerification(answers, pages, opts);
      expect(report.fields.notice_address?.value).toBeNull();
      expect(report.fields.notice_address?.citationVerified).toBe(false);
      expect(report.rejected).toBe(1);
    }
  });
});
