/**
 * PDF -> text, page images and hashes. Server-only: pdfjs never reaches the browser.
 *
 * Two things here are load-bearing beyond "get the text out":
 *
 *  1. The text is page-delimited with an unambiguous marker. The model cites a page
 *     number from it and verify.ts maps a quote back to a page from the same array,
 *     so the model and the guard are always looking at identical bytes.
 *  2. Every document is cleaned up and destroyed. pdfjs holds parsed fonts and
 *     images per document; a 200-file batch without this exhausts memory.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EngineError, toEngineError } from '@/lib/providers/errors';
import { LIMITS, type PageImage } from '@/lib/providers/types';

export interface PdfRead {
  pageCount: number;
  /** Page-delimited full text. What the model is shown. */
  text: string;
  /** Index 0 is page 1. What verify.ts searches. */
  pagesText: string[];
  /** False when the file is a scan and needs the vision path. */
  hasTextLayer: boolean;
  /** True when the PDF carries encryption we were able to open anyway. */
  encrypted: boolean;
}

/** Unambiguous, greppable, and impossible to confuse with contract prose. */
export function pageMarker(page: number): string {
  return `\n\n===== PAGE ${page} =====\n\n`;
}

/**
 * Per-page text -> the single string the model is shown.
 *
 * Shared rather than inlined because OCR'd text has to arrive at the model in exactly
 * the shape a digital PDF's does: the page number the model cites and the index
 * verify.ts searches come from the same array either way.
 */
export function joinPages(pagesText: readonly string[]): string {
  return pagesText.map((t, i) => `${pageMarker(i + 1)}${t}`).join('');
}

/**
 * A scan does not yield zero characters — it yields a handful of stray ligatures
 * from a logo or a fax header. Anything below this average is not a text layer.
 */
const MIN_CHARS_PER_PAGE = 40;

const THUMBNAIL_WIDTH = 320;

/** A PDF's user space is 72dpi, so every render scale is a ratio against that. */
const PDF_USER_SPACE_DPI = 72;

/** Legible to the model, and small enough that 20 pages is a reasonable upload. */
export const VISION_DPI = 150;

/**
 * Higher than the vision path on purpose, and measured rather than assumed.
 *
 * Across four fixtures x three pages, character accuracy against the source text and
 * the wall clock per page came out:
 *
 *     150dpi   99.93%   1.29 s/page
 *     200dpi   99.96%   1.55 s/page
 *     300dpi   99.98%   1.97 s/page
 *
 * Accuracy is already saturated by 200 and the remaining gain costs another 27% of
 * the run, so 200 is the knee. Email addresses are the one thing no setting reads
 * reliably -- an "@" in 9pt type surrounded by punctuation is genuinely hard -- and
 * that is deliberately left to the citation guard: a mis-read address fails
 * verification and is dropped rather than stored wrong.
 */
export const OCR_DPI = 200;

export function sha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/* ───────────────────────────── pdfjs plumbing ────────────────────────── */

const require_ = createRequire(import.meta.url);

/** Resolved once. pdfjs reads its CMaps, fonts and wasm from disk in Node. */
const ASSETS = (() => {
  try {
    const root = path.dirname(require_.resolve('pdfjs-dist/package.json'));
    const dirUrl = (name: string) => `${pathToFileURL(path.join(root, name)).href}/`;
    return {
      cMapUrl: dirUrl('cmaps'),
      standardFontDataUrl: dirUrl('standard_fonts'),
      wasmUrl: dirUrl('wasm'),
      iccUrl: dirUrl('iccs'),
    };
  } catch {
    return {};
  }
})();

/**
 * pdfjs takes ownership of the TypedArray it is handed and may detach it, so every
 * call gets its own copy. Callers reuse one buffer for text then images.
 */
function openDocument(buffer: Uint8Array) {
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    ...ASSETS,
    // A local tool reads its assets off disk; it has no reason to hit the network.
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
}

function pdfError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;
  // pdfjs subclasses do not survive bundling reliably; the name always does.
  const name = e instanceof Error ? e.name : '';
  if (name === 'PasswordException') {
    return new EngineError('PDF_ENCRYPTED', { cause: e });
  }
  if (name === 'InvalidPDFException' || name === 'MissingPDFException') {
    return new EngineError('PDF_UNREADABLE', { cause: e });
  }
  return toEngineError(e, 'PDF_UNREADABLE');
}

type OpenDoc = Awaited<ReturnType<typeof openDocument>>;

/**
 * cleanup() frees the parsed fonts and images; destroying the loading task tears
 * down the transport. Skipping either leaks a few MB per document, which is invisible
 * on one file and fatal on a 200-file batch.
 */
async function release(doc: OpenDoc): Promise<void> {
  try {
    await doc.cleanup();
  } catch {
    // A failed cleanup must never mask the caller's real error.
  }
  try {
    await doc.loadingTask.destroy();
  } catch {
    // Same.
  }
}

/* ────────────────────────────────  text  ─────────────────────────────── */

export async function readPdf(buffer: Uint8Array): Promise<PdfRead> {
  let doc: OpenDoc;
  try {
    doc = await openDocument(buffer);
  } catch (e) {
    throw pdfError(e);
  }

  try {
    const pageCount = doc.numPages;
    if (pageCount === 0) throw new EngineError('PDF_EMPTY');
    if (pageCount > LIMITS.maxPages) {
      throw new EngineError('PDF_TOO_LARGE', {
        detail: `${pageCount} pages, limit is ${LIMITS.maxPages}`,
      });
    }

    const pagesText: string[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        pagesText.push(itemsToText(content.items));
      } finally {
        page.cleanup();
      }
    }

    const text = joinPages(pagesText);
    if (text.length > LIMITS.maxTextChars) {
      throw new EngineError('PDF_TOO_LARGE', {
        detail: `${text.length} characters of text, limit is ${LIMITS.maxTextChars}`,
      });
    }

    const solidChars = pagesText.reduce((sum, t) => sum + t.replace(/\s/g, '').length, 0);
    const hasTextLayer = solidChars / pageCount >= MIN_CHARS_PER_PAGE;

    return {
      pageCount,
      text,
      pagesText,
      hasTextLayer,
      encrypted: await isEncrypted(doc),
    };
  } catch (e) {
    throw pdfError(e);
  } finally {
    await release(doc);
  }
}

/**
 * An owner-password PDF opens without a password but still reports permissions.
 * Worth recording: those files often have a mangled text layer.
 */
async function isEncrypted(doc: OpenDoc): Promise<boolean> {
  try {
    return (await doc.getPermissions()) !== null;
  } catch {
    return false;
  }
}

interface TextRun {
  str: string;
  hasEOL: boolean;
}

function isTextRun(item: unknown): item is TextRun {
  return (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof item.str === 'string' &&
    'hasEOL' in item &&
    typeof item.hasEOL === 'boolean'
  );
}

/**
 * Runs are concatenated as pdfjs emits them, with a newline wherever it reports a
 * line break. No space is invented between runs: PDFs routinely split a single word
 * across runs, and inserting a space there would corrupt every quote in that line.
 */
function itemsToText(items: readonly unknown[]): string {
  let out = '';
  for (const item of items) {
    if (!isTextRun(item)) continue;
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').trimEnd();
}

/* ──────────────────────────────  images  ────────────────────────────── */

/**
 * pdfjs exposes its canvas factory as `Object`, so we narrow it structurally rather
 * than casting. In Node it is the @napi-rs/canvas backed factory pdfjs ships with.
 */
interface RenderCanvas {
  width: number;
  height: number;
  toBuffer(mime: 'image/png'): Uint8Array;
}

interface CanvasAndContext {
  canvas: RenderCanvas;
  context: CanvasRenderingContext2D;
}

interface CanvasFactoryLike {
  create(width: number, height: number): CanvasAndContext;
  destroy(canvasAndContext: CanvasAndContext): void;
}

function asCanvasFactory(factory: object): CanvasFactoryLike | null {
  if (!('create' in factory) || typeof factory.create !== 'function') return null;
  if (!('destroy' in factory) || typeof factory.destroy !== 'function') return null;
  const create = factory.create;
  const destroy = factory.destroy;
  return {
    create: (w, h) => {
      const made: unknown = create.call(factory, w, h);
      if (!isCanvasAndContext(made)) {
        throw new EngineError('PDF_UNREADABLE', {
          detail: 'canvas backend produced no PNG-capable canvas',
        });
      }
      return made;
    },
    destroy: (cc) => {
      destroy.call(factory, cc);
    },
  };
}

function isCanvasAndContext(v: unknown): v is CanvasAndContext {
  if (typeof v !== 'object' || v === null) return false;
  if (!('canvas' in v) || !('context' in v)) return false;
  const canvas: unknown = v.canvas;
  return (
    typeof canvas === 'object' &&
    canvas !== null &&
    'toBuffer' in canvas &&
    typeof canvas.toBuffer === 'function'
  );
}

async function renderPage(
  doc: OpenDoc,
  factory: CanvasFactoryLike,
  pageNumber: number,
  scaleFor: (width: number) => number,
): Promise<Uint8Array> {
  const page = await doc.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: scaleFor(unscaled.width) });
  const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    // canvas must be null when rendering through a context pdfjs did not create.
    await page.render({ canvas: null, canvasContext: target.context, viewport }).promise;
    return target.canvas.toBuffer('image/png');
  } finally {
    factory.destroy(target);
    page.cleanup();
  }
}

export interface RenderOptions {
  /** Defaults to VISION_DPI. Pass OCR_DPI when the images are going to tesseract. */
  dpi?: number | undefined;
  /**
   * Defaults to LIMITS.maxVisionPages, which is a budget on what we upload to a model
   * — not on what we may rasterise. OCR runs locally and reads further into a document.
   */
  maxPages?: number | undefined;
}

/**
 * Base64 PNGs. Requested pages are de-duplicated, sorted, clamped to the document and
 * capped — a scan of a 90-page agreement is a manual-entry job, not a bigger request.
 */
export async function renderPages(
  buffer: Uint8Array,
  pages: number[],
  opts: RenderOptions = {},
): Promise<PageImage[]> {
  let doc: OpenDoc;
  try {
    doc = await openDocument(buffer);
  } catch (e) {
    throw pdfError(e);
  }

  const scale = (opts.dpi ?? VISION_DPI) / PDF_USER_SPACE_DPI;

  try {
    const wanted = [...new Set(pages)]
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= doc.numPages)
      .sort((a, b) => a - b)
      .slice(0, opts.maxPages ?? LIMITS.maxVisionPages);

    const factory = asCanvasFactory(doc.canvasFactory);
    if (!factory) {
      throw new EngineError('PDF_UNREADABLE', {
        detail: 'no canvas backend available to rasterise pages',
      });
    }

    const images: PageImage[] = [];
    for (const page of wanted) {
      const png = await renderPage(doc, factory, page, () => scale);
      images.push({
        page,
        base64: Buffer.from(png).toString('base64'),
        mediaType: 'image/png',
      });
    }
    return images;
  } catch (e) {
    throw pdfError(e);
  } finally {
    await release(doc);
  }
}

/** Page 1 at ~320px wide, for the inbox card. */
export async function renderThumbnail(buffer: Uint8Array): Promise<Uint8Array> {
  let doc: OpenDoc;
  try {
    doc = await openDocument(buffer);
  } catch (e) {
    throw pdfError(e);
  }

  try {
    if (doc.numPages === 0) throw new EngineError('PDF_EMPTY');
    const factory = asCanvasFactory(doc.canvasFactory);
    if (!factory) {
      throw new EngineError('PDF_UNREADABLE', {
        detail: 'no canvas backend available to rasterise pages',
      });
    }
    return await renderPage(doc, factory, 1, (width) => THUMBNAIL_WIDTH / width);
  } catch (e) {
    throw pdfError(e);
  } finally {
    await release(doc);
  }
}
