'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { motion } from 'motion/react';
import {
  ArrowsOutLineHorizontal,
  CaretLeft,
  CaretRight,
  FilePdf,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from '@phosphor-icons/react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { Button, EmptyState, Glass, IconButton, Spinner, Tooltip } from '@/components/ui';

/**
 * pdf.js is loaded in the browser and only in the browser. next.config marks it
 * a server-external package, so a static import would have Node resolve the
 * *browser* build during SSR and die on `DOMMatrix`. The type-only import above
 * is erased, so it costs nothing.
 *
 * The worker is bundled from the package rather than fetched from a CDN -- this
 * app has to work on a laptop with no internet -- which is why the specifier is
 * a literal the bundler can rewrite.
 */
type Pdfjs = typeof import('pdfjs-dist');

let pdfjsOnce: Promise<Pdfjs> | null = null;

/**
 * The worker is served as a static asset from public/, not resolved through the
 * bundler.
 *
 * `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` forced pdfjs-dist
 * out of serverExternalPackages to resolve, which made Turbopack bundle pdfjs for the
 * server too -- and a bundled pdfjs fails on its own dynamic internals, so every
 * server-side read started throwing PDF_UNREADABLE on files it had already read
 * successfully. A plain path keeps the client working and leaves the server copy
 * external.
 *
 * public/pdf.worker.min.mjs is refreshed by `npm run sync-worker` (postinstall), so it
 * cannot drift from the installed pdfjs version.
 */
const WORKER_SRC = '/pdf.worker.min.mjs';

function loadPdfjs(): Promise<Pdfjs> {
  pdfjsOnce ??= import('pdfjs-dist').then((mod) => {
    if (mod.GlobalWorkerOptions.workerSrc === '') {
      mod.GlobalWorkerOptions.workerSrc = WORKER_SRC;
    }
    return mod;
  });
  return pdfjsOnce;
}

export interface PdfCitation {
  /** Opaque to this component. Handed back on click so the panel can focus it. */
  key: string;
  quote: string;
  page: number;
}

export interface PdfPaneHandle {
  scrollToPage: (page: number) => void;
  /** Locate the quote on that page and pulse it. Falls back to a page flash. */
  highlight: (quote: string, page: number) => void;
}

export interface PdfPaneProps {
  url: string;
  /** Every verified citation, drawn as a faint persistent mark. */
  citations?: readonly PdfCitation[];
  onCitationClick?: (key: string) => void;
  className?: string;
}

/* ─────────────────────── geometry, in scale-1 units ─────────────────────── */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextRun extends Rect {
  str: string;
  hasEOL: boolean;
}

interface Mark {
  key: string;
  rects: Rect[];
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.25;
const PAGE_GAP = 16;
const PANE_PAD = 24;
/** Render this far outside the viewport so scrolling never hits a blank page. */
const LAZY_MARGIN = '600px 0px';
/** Pages this far either side of the current one keep their bitmap. */
const KEEP_RENDERED = 4;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((n) => (typeof n === 'number' ? n : 0));
}

/** 2x3 affine multiply, in pdf.js matrix order [a, b, c, d, e, f]. */
function mul(m1: readonly number[], m2: readonly number[]): number[] {
  const [a0 = 1, a1 = 0, a2 = 0, a3 = 1, a4 = 0, a5 = 0] = m1;
  const [b0 = 1, b1 = 0, b2 = 0, b3 = 1, b4 = 0, b5 = 0] = m2;
  return [
    a0 * b0 + a2 * b1,
    a1 * b0 + a3 * b1,
    a0 * b2 + a2 * b3,
    a1 * b2 + a3 * b3,
    a0 * b4 + a2 * b5 + a4,
    a1 * b4 + a3 * b5 + a5,
  ];
}

/**
 * Contract PDFs are full of typographic quotes, en dashes and non-breaking
 * spaces that the model echoes back in its own normalisation. Comparing the two
 * literally fails on wording that is, to a reader, identical.
 */
const FOLD: Record<string, string> = {
  '\u2018': "'", // left single quote
  '\u2019': "'", // right single quote
  '\u201A': "'", // single low-9 quote
  '\u201B': "'", // single high-reversed-9 quote
  '\u201C': '"', // left double quote
  '\u201D': '"', // right double quote
  '\u201E': '"', // double low-9 quote
  '\u2010': '-', // hyphen
  '\u2011': '-', // non-breaking hyphen
  '\u2012': '-', // figure dash
  '\u2013': '-', // en dash
  '\u2014': '-', // em dash
  '\u2015': '-', // horizontal bar
  '\u2212': '-', // minus sign
  '\u00A0': ' ', // no-break space
  '\u2007': ' ', // figure space
  '\u202F': ' ', // narrow no-break space
  '\u2009': ' ', // thin space
  '\uFB01': 'fi', // fi ligature
  '\uFB02': 'fl', // fl ligature
};

function fold(ch: string): string {
  const mapped = FOLD[ch];
  if (mapped !== undefined) return mapped;
  return /\s/.test(ch) ? ' ' : ch.toLowerCase();
}

interface Normalised {
  text: string;
  /** For every character in `text`, its index in the raw string. */
  source: number[];
}

function normalise(raw: string): Normalised {
  const out: string[] = [];
  const source: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i += 1) {
    const folded = fold(raw[i] ?? '');
    if (folded === ' ') {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(' ');
      source.push(i);
      pendingSpace = false;
    }
    out.push(folded);
    // A ligature folds to two characters; both point at the glyph they came from.
    for (let k = 0; k < folded.length; k += 1) source.push(i);
  }
  return { text: out.join(''), source };
}

/** Merge the runs a match covers into one rect per line of text. */
function mergeRects(runs: TextRun[]): Rect[] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Rect[] = [];
  for (const run of sorted) {
    const last = lines[lines.length - 1];
    const sameLine =
      last !== undefined &&
      Math.abs(last.y - run.y) < Math.min(last.h, run.h) * 0.6 &&
      run.x >= last.x - 1;
    if (last !== undefined && sameLine) {
      const right = Math.max(last.x + last.w, run.x + run.w);
      const bottom = Math.max(last.y + last.h, run.y + run.h);
      last.y = Math.min(last.y, run.y);
      last.x = Math.min(last.x, run.x);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else {
      lines.push({ ...run });
    }
  }
  return lines;
}

/** Glyph-run granularity: a quote that starts mid-run highlights that run. */
function locate(quote: string, runs: TextRun[]): Rect[] | null {
  if (runs.length === 0) return null;

  let raw = '';
  const owner: number[] = [];
  runs.forEach((run, index) => {
    for (let i = 0; i < run.str.length; i += 1) {
      raw += run.str[i];
      owner.push(index);
    }
    if (run.hasEOL) {
      raw += '\n';
      owner.push(-1);
    }
  });

  const hay = normalise(raw);
  const needle = normalise(quote).text.trim();
  if (needle.length === 0) return null;

  const attempts = [needle, needle.slice(0, 48), needle.slice(-48)];
  for (const attempt of attempts) {
    if (attempt.length < 8) continue;
    const at = hay.text.indexOf(attempt);
    if (at < 0) continue;

    const from = hay.source[at] ?? 0;
    const to = hay.source[Math.min(at + attempt.length - 1, hay.source.length - 1)] ?? from;
    const covered = new Set<number>();
    for (let i = from; i <= to; i += 1) {
      const index = owner[i];
      if (index !== undefined && index >= 0) covered.add(index);
    }
    const hit = [...covered]
      .map((i) => runs[i])
      .filter((run): run is TextRun => run !== undefined);
    if (hit.length === 0) continue;
    return mergeRects(hit);
  }
  return null;
}

/* ──────────────────────────────── component ─────────────────────────────── */

export const PdfPane = forwardRef<PdfPaneHandle, PdfPaneProps>(function PdfPane(
  { url, citations, onCitationClick, className },
  ref,
) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Rect[]>([]);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [current, setCurrent] = useState(1);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set([1]));
  const [marks, setMarks] = useState<ReadonlyMap<number, Mark[]>>(new Map());
  const [active, setActive] = useState<{ page: number; rects: Rect[]; nonce: number } | null>(
    null,
  );
  const [flash, setFlash] = useState<{ page: number; nonce: number } | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const wrappers = useRef(new Map<number, HTMLDivElement>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const tasks = useRef(new Map<number, RenderTask>());
  const renderedAt = useRef(new Map<number, number>());
  const runsCache = useRef(new Map<number, TextRun[]>());
  const nonce = useRef(0);
  const scrollFrame = useRef<number | null>(null);

  /* ── load ── */
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;

    async function open() {
      setFailure(null);
      setDoc(null);
      setSizes([]);
      runsCache.current.clear();
      renderedAt.current.clear();
      try {
        // Fetched here rather than by pdf.js so a 404 or a permissions failure
        // arrives as the route's plain-English message instead of a codec error.
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          throw new Error(messageOf(body));
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        task = pdfjs.getDocument({ data: bytes });
        const loaded = await task.promise;
        if (cancelled) return;

        // Every page's unscaled size up front: the scroller needs the full
        // document height before a single page has been rasterised, or lazy
        // rendering has nothing to scroll through.
        const dims: Rect[] = [];
        for (let p = 1; p <= loaded.numPages; p += 1) {
          const page = await loaded.getPage(p);
          const viewport = page.getViewport({ scale: 1 });
          dims.push({ x: 0, y: 0, w: viewport.width, h: viewport.height });
        }
        if (cancelled) return;
        setSizes(dims);
        setDoc(loaded);
      } catch {
        if (!cancelled) setFailure('This PDF could not be opened.');
      }
    }

    void open();
    return () => {
      cancelled = true;
      for (const render of tasks.current.values()) render.cancel();
      tasks.current.clear();
      // pdf.js holds parsed fonts and images per document; without this a long
      // review session leaks a document per file opened.
      void task?.destroy();
    };
  }, [url, attempt]);

  /* ── fit width ── */
  useEffect(() => {
    const node = scroller.current;
    if (node === null || sizes.length === 0) return;
    const widest = Math.max(...sizes.map((s) => s.w));
    const apply = () => {
      if (!fitWidth) return;
      const available = node.clientWidth - PANE_PAD * 2;
      if (available > 0) setScale(clampScale(available / widest));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, [sizes, fitWidth]);

  /**
   * The page indicator reads geometry, not intersection ratios: an observer only
   * reports when a threshold is crossed, so its numbers lag a fast scroll and the
   * indicator sticks on the page she just left.
   */
  const trackCurrentPage = useCallback(() => {
    const node = scroller.current;
    if (node === null) return;
    const box = node.getBoundingClientRect();
    const middle = box.top + node.clientHeight / 2;
    let bestPage = 1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [page, wrapper] of wrappers.current) {
      const rect = wrapper.getBoundingClientRect();
      const distance =
        rect.top <= middle && rect.bottom >= middle
          ? 0
          : Math.min(Math.abs(rect.top - middle), Math.abs(rect.bottom - middle));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = page;
      }
      if (distance === 0) break;
    }
    setCurrent((c) => (c === bestPage ? c : bestPage));
  }, []);

  const onScroll = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      trackCurrentPage();
    });
  }, [trackCurrentPage]);

  useEffect(() => {
    if (sizes.length === 0) return;
    trackCurrentPage();
    return () => {
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [sizes, scale, trackCurrentPage]);

  /* ── which pages are worth rendering ── */
  useEffect(() => {
    const node = scroller.current;
    if (node === null || sizes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entered: number[] = [];
        for (const entry of entries) {
          const page = Number(entry.target.getAttribute('data-page'));
          if (Number.isFinite(page) && entry.isIntersecting) entered.push(page);
        }
        if (entered.length === 0) return;
        setVisible((prev) => {
          const next = new Set(prev);
          const before = next.size;
          for (const page of entered) next.add(page);
          return next.size === before ? prev : next;
        });
      },
      { root: node, rootMargin: LAZY_MARGIN, threshold: 0 },
    );
    for (const wrapper of wrappers.current.values()) observer.observe(wrapper);
    return () => observer.disconnect();
  }, [sizes]);

  /* ── draw ── */
  useEffect(() => {
    if (doc === null) return;
    let cancelled = false;

    async function paint(page: number) {
      const canvas = canvases.current.get(page);
      if (doc === null || canvas === null || canvas === undefined) return;
      if (renderedAt.current.get(page) === scale) return;
      tasks.current.get(page)?.cancel();
      try {
        const proxy = await doc.getPage(page);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio, 2);
        const css = proxy.getViewport({ scale });
        const device = proxy.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(device.width);
        canvas.height = Math.floor(device.height);
        canvas.style.width = `${Math.floor(css.width)}px`;
        canvas.style.height = `${Math.floor(css.height)}px`;
        const task = proxy.render({ canvas, viewport: device });
        tasks.current.set(page, task);
        await task.promise;
        renderedAt.current.set(page, scale);
      } catch {
        // A cancelled render is the normal case while zooming. Anything else
        // leaves the page blank rather than taking the screen down.
        renderedAt.current.delete(page);
      }
    }

    for (const page of visible) void paint(page);
    return () => {
      cancelled = true;
    };
  }, [doc, visible, scale]);

  /**
   * Rasterised pages are the memory cost of this component: a 40-page agreement
   * at fit-width is tens of megabytes of bitmap. Anything well outside the
   * viewport gives its bitmap back and re-renders if she scrolls there again.
   */
  useEffect(() => {
    if (visible.size <= KEEP_RENDERED * 2 + 2) return;
    const drop: number[] = [];
    for (const page of visible) {
      if (Math.abs(page - current) > KEEP_RENDERED) drop.push(page);
    }
    if (drop.length === 0) return;
    for (const page of drop) {
      tasks.current.get(page)?.cancel();
      tasks.current.delete(page);
      renderedAt.current.delete(page);
      const canvas = canvases.current.get(page);
      if (canvas !== undefined) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    setVisible((prev) => {
      const next = new Set(prev);
      for (const page of drop) next.delete(page);
      return next;
    });
  }, [current, visible]);

  const runsFor = useCallback(
    async (page: number): Promise<TextRun[]> => {
      const cached = runsCache.current.get(page);
      if (cached !== undefined) return cached;
      if (doc === null) return [];
      const proxy = await doc.getPage(page);
      const viewport = proxy.getViewport({ scale: 1 });
      const content = await proxy.getTextContent();
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str.length === 0) continue;
        const m = mul(viewport.transform, numbers(item.transform));
        const fontHeight = Math.hypot(m[2] ?? 0, m[3] ?? 0);
        const height = Math.max(item.height, fontHeight, 1);
        runs.push({
          str: item.str,
          hasEOL: item.hasEOL,
          x: m[4] ?? 0,
          y: (m[5] ?? 0) - fontHeight,
          w: Math.max(item.width, 1),
          h: height,
        });
      }
      runsCache.current.set(page, runs);
      return runs;
    },
    [doc],
  );

  /* ── persistent citation marks for the pages that are on screen ── */
  useEffect(() => {
    if (doc === null || citations === undefined || citations.length === 0) return;
    let cancelled = false;

    async function resolve() {
      const next = new Map<number, Mark[]>();
      for (const page of visible) {
        const onPage = (citations ?? []).filter((c) => c.page === page);
        if (onPage.length === 0) continue;
        const runs = await runsFor(page);
        if (cancelled) return;
        const found: Mark[] = [];
        for (const citation of onPage) {
          const rects = locate(citation.quote, runs);
          if (rects !== null) found.push({ key: citation.key, rects });
        }
        if (found.length > 0) next.set(page, found);
      }
      if (!cancelled) setMarks(next);
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [doc, citations, visible, runsFor]);

  const scrollToOffset = useCallback((page: number, within: number) => {
    const node = scroller.current;
    const wrapper = wrappers.current.get(page);
    if (node === null || wrapper === undefined) return;
    const top =
      wrapper.getBoundingClientRect().top -
      node.getBoundingClientRect().top +
      node.scrollTop +
      within;
    node.scrollTo({ top: Math.max(0, top - PANE_PAD), behavior: 'smooth' });
  }, []);

  const scrollToPage = useCallback(
    (page: number) => {
      const clamped = Math.min(Math.max(1, page), Math.max(1, sizes.length));
      setVisible((v) => (v.has(clamped) ? v : new Set(v).add(clamped)));
      scrollToOffset(clamped, 0);
    },
    [sizes.length, scrollToOffset],
  );

  const highlight = useCallback(
    (quote: string, page: number) => {
      const clamped = Math.min(Math.max(1, page), Math.max(1, sizes.length));
      setVisible((v) => (v.has(clamped) ? v : new Set(v).add(clamped)));

      void (async () => {
        nonce.current += 1;
        const id = nonce.current;
        try {
          const rects = locate(quote, await runsFor(clamped));
          if (rects === null || rects.length === 0) {
            // Degrade: she still gets taken to the right page, and the page
            // itself flashes so the jump is not silent.
            setActive(null);
            setFlash({ page: clamped, nonce: id });
            scrollToOffset(clamped, 0);
            return;
          }
          setFlash(null);
          setActive({ page: clamped, rects, nonce: id });
          const first = rects[0];
          const node = scroller.current;
          const lead = node === null ? 0 : node.clientHeight / 3;
          scrollToOffset(clamped, (first?.y ?? 0) * scale - lead);
        } catch {
          setFlash({ page: clamped, nonce: id });
          scrollToOffset(clamped, 0);
        }
      })();
    },
    [sizes.length, runsFor, scale, scrollToOffset],
  );

  useImperativeHandle(ref, () => ({ scrollToPage, highlight }), [scrollToPage, highlight]);

  const zoom = useCallback((factor: number) => {
    setFitWidth(false);
    setScale((s) => clampScale(s * factor));
  }, []);

  const pageCount = sizes.length;
  const activeRects = useMemo(() => active?.rects ?? [], [active]);

  if (failure !== null) {
    return (
      <div className={clsx('grid h-full place-items-center bg-sunken', className)}>
        <EmptyState
          icon={FilePdf}
          title={failure}
          body="The record and everything already pulled out of it are still here."
          action={<Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>}
        />
      </div>
    );
  }

  return (
    // Sunken, not canvas: the page itself is white, so it needs a darker ground
    // to sit on or the sheet edge disappears.
    <div className={clsx('relative flex h-full min-h-0 flex-col bg-sunken', className)}>
      <div
        ref={scroller}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-auto"
        style={{ padding: PANE_PAD }}
      >
        {pageCount === 0 ? (
          <div className="grid h-full place-items-center">
            <Spinner size={18} label="Opening the document" className="text-label-tertiary" />
          </div>
        ) : (
          <div className="mx-auto flex flex-col items-center" style={{ gap: PAGE_GAP }}>
            {sizes.map((size, index) => {
              const page = index + 1;
              const width = Math.floor(size.w * scale);
              const height = Math.floor(size.h * scale);
              const pageMarks = marks.get(page) ?? [];
              return (
                <div
                  key={page}
                  data-page={page}
                  ref={(node) => {
                    if (node === null) wrappers.current.delete(page);
                    else wrappers.current.set(page, node);
                  }}
                  className="sq relative shrink-0 overflow-hidden rounded-row bg-surface shadow-e2"
                  style={{ width, height }}
                >
                  <canvas
                    ref={(node) => {
                      if (node === null) canvases.current.delete(page);
                      else canvases.current.set(page, node);
                    }}
                    className="block"
                  />

                  {pageMarks.map((mark) =>
                    mark.rects.map((rect, i) => (
                      <button
                        key={`${mark.key}-${i}`}
                        type="button"
                        title="Show the field this wording answers"
                        onClick={() => onCitationClick?.(mark.key)}
                        // Every citation, marked at a third of the highlight so the
                        // page reads as a document with notes on it, not a
                        // highlighter accident. The active one gets the full wash.
                        className="absolute bg-[color-mix(in_srgb,var(--highlight)_36%,transparent)] transition-colors duration-[var(--dur-fast)] ease-fast hover:bg-highlight"
                        style={{
                          left: rect.x * scale,
                          top: rect.y * scale,
                          width: rect.w * scale,
                          height: rect.h * scale,
                        }}
                      />
                    )),
                  )}

                  {active !== null &&
                    active.page === page &&
                    activeRects.map((rect, i) => (
                      <motion.span
                        key={`${active.nonce}-${i}`}
                        aria-hidden
                        // Two beats then a resting tint: the pulse says "here",
                        // the tint keeps saying it after the eye has moved.
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0, 1, 0.4, 1, 0.72] }}
                        transition={{
                          duration: 1.05,
                          times: [0, 0.18, 0.42, 0.66, 1],
                          ease: 'easeInOut',
                        }}
                        className="pointer-events-none absolute rounded-[2px] bg-highlight"
                        style={{
                          left: rect.x * scale - 1,
                          top: rect.y * scale - 1,
                          width: rect.w * scale + 2,
                          height: rect.h * scale + 2,
                        }}
                      />
                    ))}

                  {flash !== null && flash.page === page && (
                    <motion.span
                      key={flash.nonce}
                      aria-hidden
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0, 1, 0, 1, 0] }}
                      transition={{ duration: 1.1, ease: 'easeInOut' }}
                      className="sq pointer-events-none absolute inset-0 rounded-row shadow-[inset_0_0_0_2px_var(--accent)]"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pageCount > 0 && (
        <Glass
          radius="control"
          className="pointer-events-auto absolute bottom-[16px] left-1/2 flex -translate-x-1/2 items-center gap-[2px] p-[3px]"
        >
          <IconButton
            label="Previous page"
            size="sm"
            disabled={current <= 1}
            onClick={() => scrollToPage(current - 1)}
          >
            <CaretLeft size={13} weight="bold" />
          </IconButton>
          <span className="tabular px-[6px] text-callout text-label-secondary">
            page {current} of {pageCount}
          </span>
          <IconButton
            label="Next page"
            size="sm"
            disabled={current >= pageCount}
            onClick={() => scrollToPage(current + 1)}
          >
            <CaretRight size={13} weight="bold" />
          </IconButton>
          <span aria-hidden className="mx-[3px] h-[16px] w-[0.5px] bg-[var(--separator)]" />
          <IconButton label="Zoom out" size="sm" onClick={() => zoom(1 / ZOOM_STEP)}>
            <MagnifyingGlassMinus size={13} />
          </IconButton>
          <IconButton label="Zoom in" size="sm" onClick={() => zoom(ZOOM_STEP)}>
            <MagnifyingGlassPlus size={13} />
          </IconButton>
          <Tooltip content="Fit width">
            <IconButton
              label="Fit width"
              size="sm"
              active={fitWidth}
              onClick={() => setFitWidth(true)}
            >
              <ArrowsOutLineHorizontal size={13} />
            </IconButton>
          </Tooltip>
        </Glass>
      )}
    </div>
  );
});

function messageOf(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return 'This PDF could not be opened.';
}
