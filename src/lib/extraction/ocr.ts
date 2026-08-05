/**
 * Machine-read text for scanned PDFs. Server-only: tesseract spawns a worker thread.
 *
 * The reason this exists is not "scans now work" -- the vision path already read them.
 * It is that vision reads page IMAGES, so there is no text for verify.ts to check a
 * quote against, and the citation guard is switched off for the entire document. Every
 * field on a scan came back unverified. Once a scan has machine-read text, its quotes
 * are checked exactly the way a digital PDF's are, and the strongest integrity
 * guarantee in the product stops having a hole in it.
 *
 * Four properties here are load-bearing:
 *
 *  1. ONE worker, created lazily and reused across pages AND across documents. Starting
 *     one costs ~1.5s, which would dominate a 40-page batch, and it holds a WASM heap
 *     that must not be allocated per page.
 *  2. Concurrency 1. The worker is single threaded, so parallel calls only queue -- but
 *     they queue invisibly, and a failure then cannot be attributed to a page.
 *  3. Everything is bounded: a per-page deadline, an abort signal honoured before and
 *     during a page, and an idle timer that frees the heap on a process that stays up.
 *  4. The language data is resolved from disk before the network is considered, so a
 *     scan is still readable on a machine behind a corporate proxy.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { OEM, PSM, createWorker, type Worker } from 'tesseract.js';

import { log } from '@/lib/logger';
import { dataDir } from '@/lib/paths';
import { EngineError, toEngineError } from '@/lib/providers/errors';
import type { PageImage } from '@/lib/providers/types';

/* ─────────────────────────────── budgets ────────────────────────────── */

const LANG = 'eng';
const TRAINEDDATA = `${LANG}.traineddata`;

/**
 * ~2.6s/page measured on a real contract page at OCR_DPI. Anything an order of
 * magnitude past that is a wedged page, not a slow one, and must not take the
 * document down with it.
 */
const PAGE_TIMEOUT_MS = 60_000;

/** The first call may pull ~5MB of language data over a slow link. */
const START_TIMEOUT_MS = 90_000;

/** Free the WASM heap when nothing has been read for this long. */
const IDLE_MS = 60_000;

/**
 * At ~2.6s/page this is a little over 100 seconds of OCR. Past it, a scan is a
 * manual-entry job.
 */
export const MAX_OCR_PAGES = 40;

/**
 * How many of those pages are taken from the END of the document.
 *
 * Reading the first 40 pages of a 60-page agreement is worse than reading 40 pages
 * chosen well: the execution block, the notice addresses and the governing law
 * clause are at the BACK. A field that was never looked at comes back "not found",
 * and a reviewer cannot tell that apart from "not in the document" -- so she marks a
 * clause that is right there as absent. Reading the tail as well is what stops the
 * truncation from turning into a wrong record.
 */
export const OCR_TAIL_PAGES = 12;

/**
 * A whole-document clock, on top of the per-page one.
 *
 * PAGE_TIMEOUT_MS x MAX_OCR_PAGES is forty minutes, which is not a bound anybody
 * would call a bound. Six minutes is ~3x the measured cost of a full 40-page read,
 * so a healthy scan never notices it and a pathological one stops.
 */
const TOTAL_TIMEOUT_MS = 360_000;

/** Below this much remaining budget, starting another page cannot finish it. */
const MIN_PAGE_BUDGET_MS = 5_000;

/**
 * A start failure is remembered for this long.
 *
 * An unresolvable eng.traineddata (no network, no seed copy, unwritable data dir)
 * fails identically every time, and each attempt costs the full START_TIMEOUT_MS.
 * Across a dropped folder of 30 scans that is 45 minutes of waiting to be told the
 * same thing 30 times. Remembering the failure turns every attempt after the first
 * into an instant, honest answer -- and the cooldown means a machine that comes back
 * online recovers on its own.
 */
const START_FAILURE_COOLDOWN_MS = 300_000;

/**
 * Below this the machine read is not trustworthy enough to be the only thing a
 * quote is checked against. The caller decides what to do about it; this module
 * only measures.
 */
export const MIN_OCR_CONFIDENCE = 60;

/** A page that yields less than this is furniture (a logo, a fax header), not prose. */
const MIN_PAGE_CHARS = 40;

/* ──────────────────────────────── types ─────────────────────────────── */

export interface OcrPageResult {
  /** 1-indexed page number, carried through from the PageImage. */
  page: number;
  text: string;
  /** Tesseract's mean word confidence for the page, 0..100. */
  confidence: number;
  durationMs: number;
}

export interface OcrResult {
  /** Index 0 is images[0]. Same contract as PdfRead.pagesText. */
  pagesText: string[];
  /** Character-weighted mean confidence, 0..100. See meanConfidence(). */
  confidence: number;
  durationMs: number;
  pages: OcrPageResult[];
  /**
   * True when the document-level budget ran out and pages were left unread. The
   * caller must treat the read as partial: `pages` then covers fewer pages than it
   * was given, and every page.page says which ones.
   */
  stoppedEarly: boolean;
}

export interface OcrOptions {
  signal?: AbortSignal | undefined;
  /**
   * The dpi the images were rasterised at. Told to tesseract rather than guessed:
   * a wrong dpi makes it mis-size the text and drop small type.
   */
  dpi?: number | undefined;
  perPageTimeoutMs?: number | undefined;
  /** Whole-document clock. Defaults to TOTAL_TIMEOUT_MS. */
  totalTimeoutMs?: number | undefined;
  onPage?: ((done: number, total: number) => void) | undefined;
}

/* ────────────────────────── which pages to read ─────────────────────── */

/** A contiguous run of pages, 1-indexed and inclusive at both ends. */
export interface PageRange {
  from: number;
  to: number;
}

export interface PageSelection {
  /** 1-indexed page numbers, ascending. Never longer than the cap. */
  pages: number[];
  /** The same set, as contiguous runs. What the audit trail and the banner say. */
  ranges: PageRange[];
  /** True when the document was longer than the cap, so the middle was skipped. */
  truncated: boolean;
}

/** Ascending page numbers -> "1-28, 49-60". */
export function formatPageRanges(ranges: readonly PageRange[]): string {
  return ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(', ');
}

function toRanges(pages: readonly number[]): PageRange[] {
  const ranges: PageRange[] = [];
  for (const page of pages) {
    const last = ranges[ranges.length - 1];
    if (last && page === last.to + 1) last.to = page;
    else ranges.push({ from: page, to: page });
  }
  return ranges;
}

/**
 * Head + tail, not the first N.
 *
 * A cap has to skip something, and the only honest question is which part of a
 * contract we can least afford to miss. It is not the middle: recitals and boilerplate
 * live there. It is the end -- signatures, the notice block, governing law. So the
 * budget is spent on the front (where the parties, dates and term are) and the back
 * (where everything else is), and the caller records exactly which pages that was.
 */
export function selectPages(pageCount: number, cap: number, tail: number): PageSelection {
  const total = Math.max(0, Math.trunc(pageCount));
  const limit = Math.max(1, Math.trunc(cap));
  if (total <= limit) {
    const pages = Array.from({ length: total }, (_, i) => i + 1);
    return { pages, ranges: toRanges(pages), truncated: false };
  }

  // Never let the tail eat the head: a cap of 2 must still read page 1.
  const tailCount = Math.min(Math.max(0, Math.trunc(tail)), Math.floor(limit / 2));
  const headCount = limit - tailCount;
  const pages = [
    ...Array.from({ length: headCount }, (_, i) => i + 1),
    ...Array.from({ length: tailCount }, (_, i) => total - tailCount + i + 1),
  ];
  return { pages, ranges: toRanges(pages), truncated: true };
}

/* ─────────────────────────── language data ──────────────────────────── */

/** Where the traineddata lives. Overridable so a packaged build can ship it. */
function ocrDir(): string {
  const override = process.env.IBC_OCR_DIR;
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim());
  return path.join(dataDir(), 'ocr');
}

/**
 * Places a copy may already exist. tesseract's own default cachePath is the process
 * working directory, so a previous run of the app or of the eval suite very often
 * left one there.
 */
function seedCandidates(): string[] {
  const seeds = [process.cwd()];
  const explicit = process.env.IBC_OCR_LANG_PATH;
  if (explicit !== undefined && explicit.trim() !== '') seeds.unshift(path.resolve(explicit.trim()));
  return seeds.map((dir) => path.join(dir, TRAINEDDATA));
}

/**
 * tesseract reads `${cachePath}/eng.traineddata` before it reaches for the network,
 * so seeding that path from a copy we already have is the whole offline story. The
 * CDN is the last resort, and its result is cached in the same place.
 */
function prepareLangData(): { cachePath: string; offline: boolean } {
  const dir = ocrDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Not fatal on its own: tesseract will fall back to the CDN and its own cache.
  }

  const target = path.join(dir, TRAINEDDATA);
  if (existsSync(target)) return { cachePath: dir, offline: true };

  for (const seed of seedCandidates()) {
    if (!existsSync(seed)) continue;
    try {
      copyFileSync(seed, target);
      return { cachePath: dir, offline: true };
    } catch {
      // Unwritable data dir. Keep looking, then let the download path handle it.
    }
  }
  return { cachePath: dir, offline: false };
}

/* ─────────────────────── the worker script itself ───────────────────── */

const require_ = createRequire(import.meta.url);

const WORKER_SCRIPT = path.join('tesseract.js', 'src', 'worker-script', 'node', 'index.js');

/**
 * tesseract.js derives its worker path from its own `__dirname`, which the Next
 * server build bakes into the bundle as a literal that does not exist on disk
 * ("/ROOT/node_modules/..."). OCR would then fail only in production, which is the
 * worst possible place to find out — so the path is resolved here instead.
 *
 * Two attempts, in order of correctness:
 *
 *  1. Normal module resolution. Right for every layout, and what runs under vitest,
 *     the eval CLI and `next dev`. Under a bundler it is not available: Turbopack
 *     rewrites `require.resolve(...)` of a static specifier into a numeric module id,
 *     hence the typeof guard, which is load-bearing and not defensive noise.
 *  2. Walk up from the working directory looking for the file in node_modules. No
 *     bundler can touch this, because there is no specifier in it to rewrite.
 *
 * Returning null is safe: tesseract's own default is correct whenever this module is
 * not running out of a bundle.
 */
function workerScriptPath(): string | null {
  try {
    const resolved: unknown = require_.resolve('tesseract.js/package.json');
    if (typeof resolved === 'string') {
      const script = path.join(path.dirname(resolved), 'src', 'worker-script', 'node', 'index.js');
      if (existsSync(script)) return script;
    }
  } catch {
    // Not resolvable from here. The walk below is the real answer in a bundle anyway.
  }

  let dir = process.cwd();
  for (;;) {
    const script = path.join(dir, 'node_modules', WORKER_SCRIPT);
    if (existsSync(script)) return script;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* ────────────────────────────── the worker ──────────────────────────── */

let workerPromise: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Parameters currently applied to the live worker, so we only re-send on a change. */
let appliedDpi: number | null = null;
/** The last hard start failure, so the next document does not pay for it again. */
let startFailure: { detail: string; at: number } | null = null;

/** A timer that keeps a CLI or a test run alive is a bug, so unref it where we can. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
}

function clearIdle(): void {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function armIdle(): void {
  clearIdle();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void shutdownOcr();
  }, IDLE_MS);
  unref(idleTimer);
}

async function startWorker(): Promise<Worker> {
  const { cachePath, offline } = prepareLangData();
  const workerPath = workerScriptPath();
  log.info('ocr.worker.start', { cachePath, offline, resolvedWorkerPath: workerPath !== null });

  const pending = createWorker(LANG, OEM.LSTM_ONLY, {
    cachePath,
    cacheMethod: 'write',
    // Only override what we could actually resolve; tesseract's own default is right
    // whenever this module is not running out of a bundle.
    ...(workerPath === null ? {} : { workerPath }),
    logger: () => {},
    errorHandler: () => {},
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new EngineError('PDF_NO_TEXT_LAYER', { detail: 'the OCR engine did not start' }));
    }, START_TIMEOUT_MS);
    unref(timer);
  });

  // A worker that arrives after the deadline is still a live thread; terminate it
  // rather than leaving it holding a WASM heap nobody has a handle to.
  pending.then(
    (w) => {
      if (timedOut) void w.terminate().catch(() => {});
    },
    () => {},
  );

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * The remembered start failure, while it is still fresh. Null once the cooldown has
 * passed, which is what lets a machine that has come back online (or had its language
 * data installed) recover without a restart.
 *
 * Pure and exported so the two halves -- fail fast, then forget -- are testable
 * without a broken tesseract install to hand.
 */
export function recallStartFailure(
  failure: { detail: string; at: number } | null,
  now: number,
): EngineError | null {
  if (failure === null) return null;
  if (now - failure.at > START_FAILURE_COOLDOWN_MS) return null;
  return new EngineError('PDF_NO_TEXT_LAYER', {
    detail: `${failure.detail} (already failed once; not retried for a few minutes)`,
  });
}

function rememberedStartFailure(): EngineError | null {
  const recalled = recallStartFailure(startFailure, Date.now());
  if (recalled === null) startFailure = null;
  return recalled;
}

async function getWorker(dpi: number): Promise<Worker> {
  if (workerPromise === null) {
    // Fail in a millisecond with the real reason rather than spending
    // START_TIMEOUT_MS rediscovering it on every document in the batch.
    const remembered = rememberedStartFailure();
    if (remembered) throw remembered;

    appliedDpi = null;
    workerPromise = startWorker().catch((e: unknown) => {
      workerPromise = null;
      const err = ocrError(e, 'the OCR engine could not start');
      startFailure = { detail: err.detail ?? 'the OCR engine could not start', at: Date.now() };
      throw err;
    });
  }
  const worker = await workerPromise;
  // It started, so whatever went wrong before is over.
  startFailure = null;

  if (appliedDpi !== dpi) {
    await worker.setParameters({
      // AUTO segments a page into columns and blocks, which is what a contract is.
      tessedit_pageseg_mode: PSM.AUTO,
      // Contracts indent and tabulate; collapsing runs of spaces loses the structure
      // and glues an address onto the label in front of it.
      preserve_interword_spaces: '1',
      // Never let it infer the resolution. See OcrOptions.dpi.
      user_defined_dpi: String(dpi),
    });
    appliedDpi = dpi;
  }
  return worker;
}

/**
 * Terminate the worker and free the WASM heap. Safe to call at any time and from
 * anywhere: the next ocrPages() simply starts a new one.
 *
 * Clearing the remembered start failure is deliberate. An explicit shutdown is an
 * explicit "start again from nothing", and it is the only reset a test or a Settings
 * action has.
 */
export async function shutdownOcr(): Promise<void> {
  clearIdle();
  const pending = workerPromise;
  workerPromise = null;
  appliedDpi = null;
  startFailure = null;
  if (pending === null) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // A worker that never started, or one already gone. Either way there is nothing
    // left to free and nothing a caller could do about it.
  }
}

/* ───────────────────────────── recognition ──────────────────────────── */

class OcrAborted extends Error {
  constructor() {
    super('cancelled');
    this.name = 'OcrAborted';
  }
}

class OcrPageTimeout extends Error {
  constructor(page: number, ms: number) {
    super(`page ${page} was still being read after ${ms}ms`);
    this.name = 'OcrPageTimeout';
  }
}

/**
 * Every OCR failure lands on PDF_NO_TEXT_LAYER on purpose. Its remedy -- "use an API
 * key to read scans" -- is the correct next step in every case: if we cannot machine
 * read the scan, the vision path is what remains. Adding a code would have meant a
 * second error with the same message and the same button.
 */
function ocrError(e: unknown, what: string): EngineError {
  if (e instanceof EngineError) return e;
  if (e instanceof OcrAborted) {
    return new EngineError('PDF_NO_TEXT_LAYER', { detail: 'Cancelled before it finished.' });
  }
  const detail = e instanceof Error ? `${what}: ${e.message}` : what;
  return toEngineError(new Error(detail), 'PDF_NO_TEXT_LAYER');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OcrAborted();
}

interface PageRead {
  text: string;
  confidence: number;
}

/**
 * One page, bounded. The promise settles on whichever of recognition, the deadline
 * and the abort signal happens first -- and the caller destroys the worker on the
 * last two, because a recognition we walked away from is still running inside it.
 */
function recognisePage(
  worker: Worker,
  image: PageImage,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<PageRead> {
  const bytes = Buffer.from(image.base64, 'base64');
  return new Promise<PageRead>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = (): void => finish(() => reject(new OcrAborted()));
    const timer = setTimeout(
      () => finish(() => reject(new OcrPageTimeout(image.page, timeoutMs))),
      timeoutMs,
    );
    unref(timer);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }

    worker.recognize(bytes).then(
      (result) => {
        const { text, confidence } = result.data;
        finish(() => resolve({ text, confidence: Number.isFinite(confidence) ? confidence : 0 }));
      },
      (e: unknown) => finish(() => reject(ocrError(e, `page ${image.page} could not be read`))),
    );
  });
}

/**
 * Character-weighted, over pages that produced prose.
 *
 * A plain mean lets a near-blank page -- a signature page, an exhibit divider -- that
 * scored 40 on six stray words drag a document of clean 95s below the usability gate.
 * Weighting by the text each page actually contributed makes the number mean "how well
 * was the text we are about to verify against read", which is the question the caller
 * is asking.
 */
function meanConfidence(pages: readonly OcrPageResult[]): number {
  let weight = 0;
  let total = 0;
  for (const page of pages) {
    const chars = page.text.replace(/\s/g, '').length;
    if (chars < MIN_PAGE_CHARS) continue;
    weight += chars;
    total += page.confidence * chars;
  }
  if (weight === 0) return 0;
  return Math.round((total / weight) * 10) / 10;
}

/* ────────────────────────────── entry point ─────────────────────────── */

/** Serialises every caller onto the single worker. See property 2 at the top. */
let chain: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Read rendered pages into text. Never throws anything but EngineError.
 *
 * Pages come back in the order they were given, and `pagesText[i]` corresponds to
 * `images[i]`, so a caller can hand the array straight to verify.ts.
 */
export function ocrPages(images: PageImage[], opts: OcrOptions = {}): Promise<OcrResult> {
  return serialise(() => runOcr(images, opts));
}

async function runOcr(images: PageImage[], opts: OcrOptions): Promise<OcrResult> {
  const started = Date.now();
  if (images.length === 0) {
    return { pagesText: [], confidence: 0, durationMs: 0, pages: [], stoppedEarly: false };
  }

  clearIdle();
  const dpi = opts.dpi ?? 200;
  const timeoutMs = opts.perPageTimeoutMs ?? PAGE_TIMEOUT_MS;
  // The document clock starts before the worker does: a 90-second worker start is
  // part of what this budget is bounding.
  const deadline = started + (opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  let stoppedEarly = false;

  try {
    throwIfAborted(opts.signal);
    const worker = await getWorker(dpi);

    const pages: OcrPageResult[] = [];
    for (const image of images) {
      throwIfAborted(opts.signal);

      // Out of budget: stop and hand back what was actually read. A partial read the
      // caller knows is partial is worth more than no read at all, and the pages that
      // were skipped are on the record rather than silently absent.
      const remaining = deadline - Date.now();
      if (remaining < MIN_PAGE_BUDGET_MS) {
        stoppedEarly = true;
        log.warn('ocr.budget.exhausted', {
          read: pages.length,
          requested: images.length,
          durationMs: Date.now() - started,
        });
        break;
      }

      const at = Date.now();
      let read: PageRead;
      try {
        read = await recognisePage(worker, image, Math.min(timeoutMs, remaining), opts.signal);
      } catch (e) {
        // A page we walked away from leaves the worker mid-recognition. Nothing may
        // reuse it, so it goes -- including on a clean abort, where the next document
        // deserves a worker that is not still chewing on this one.
        await shutdownOcr();
        throw ocrError(e, `page ${image.page} could not be read`);
      }
      pages.push({
        page: image.page,
        text: read.text.trimEnd(),
        confidence: read.confidence,
        durationMs: Date.now() - at,
      });
      opts.onPage?.(pages.length, images.length);
    }

    const confidence = meanConfidence(pages);
    const durationMs = Date.now() - started;
    log.info('ocr.read', {
      pages: pages.length,
      requested: images.length,
      confidence,
      durationMs,
      msPerPage: pages.length > 0 ? Math.round(durationMs / pages.length) : null,
      stoppedEarly,
      dpi,
    });

    return { pagesText: pages.map((p) => p.text), confidence, durationMs, pages, stoppedEarly };
  } catch (e) {
    throw ocrError(e, 'the scan could not be read');
  } finally {
    // Only arm the idle timer if a worker survived; shutdownOcr() already cleared it.
    if (workerPromise !== null) armIdle();
  }
}
