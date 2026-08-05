/**
 * Shared machinery for the cases and tests that run the real pipeline.
 *
 * Two rules this file exists to enforce:
 *   1. An eval NEVER touches the user's database. `useEvalDataDir()` points IBC_DATA_DIR
 *      at a throwaway directory before anything can open a connection.
 *   2. The stub provider is built from a fixture, not from hand-written JSON, so a canned
 *      answer cannot drift away from the document it claims to quote.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DocType, FieldKey } from '../../src/lib/fields';
import type {
  ExtractionRequest,
  ExtractionResponse,
  ExtractOptions,
  Provider,
  ProviderHealth,
  RawFieldAnswer,
} from '../../src/lib/providers/types';
import type { Fixture } from '../fixtures/index';
import { makePdf } from '../fixtures/pdf';

/* ─────────────────────────── throwaway data dir ──────────────────────── */

let evalDataDir: string | null = null;

/**
 * Call before importing anything that can open the database. Idempotent, and a no-op if
 * the caller already pointed IBC_DATA_DIR somewhere of their own.
 */
export function useEvalDataDir(): string {
  if (evalDataDir) return evalDataDir;
  const existing = process.env.IBC_DATA_DIR;
  if (existing !== undefined && existing !== '') {
    evalDataDir = existing;
    return evalDataDir;
  }
  evalDataDir = mkdtempSync(join(tmpdir(), 'ibc-eval-'));
  process.env.IBC_DATA_DIR = evalDataDir;
  return evalDataDir;
}

export function evalScratchDir(): string {
  const dir = join(useEvalDataDir(), 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeEvalDataDir(): void {
  if (!evalDataDir) return;
  // Only ever removes a directory this process created under the OS temp dir.
  if (evalDataDir.startsWith(tmpdir())) rmSync(evalDataDir, { recursive: true, force: true });
  evalDataDir = null;
}

/* ─────────────────────────── fixture as a file ───────────────────────── */

export interface FixtureFile {
  path: string;
  bytes: Uint8Array;
  fileHash: string;
}

/**
 * Writes the fixture as a real PDF so the pipeline can read it the way it reads a drop.
 *
 * The suffix is stamped into the last page as well as the filename. Identity in this app is
 * the SHA-256 of the bytes, so two tests that want two separate documents have to differ in
 * their content, not just their name - which is exactly the behaviour the duplicate check
 * relies on.
 */
export function writeFixturePdf(f: Fixture, suffix = ''): FixtureFile {
  const pages = [...f.pages];
  if (suffix !== '') {
    const last = pages.length - 1;
    pages[last] = `${pages[last] ?? ''}\n\nDocument reference: ${suffix}`;
  }
  const bytes = makePdf(pages);
  const path = join(evalScratchDir(), `${f.id}${suffix}.pdf`);
  writeFileSync(path, bytes);
  return { path, bytes, fileHash: createHash('sha256').update(bytes).digest('hex') };
}

/* ──────────────────────────── canned answers ─────────────────────────── */

/**
 * A citation for a field the fixture does not spell one out for: the sentence around the
 * expected value, taken verbatim from the page. Returns null when the value genuinely is
 * not in the text, which is what makes "value with no quote gets dropped" testable.
 */
export function quoteFor(f: Fixture, key: FieldKey): { quote: string; page: number } | null {
  const explicit = f.quotes[key];
  if (explicit !== undefined) {
    const page = f.pages.findIndex((p) => p.includes(explicit));
    if (page >= 0) return { quote: explicit, page: page + 1 };
  }
  const value = f.expected[key];
  if (value === null || value.length < 4) return null;
  for (let i = 0; i < f.pages.length; i++) {
    const page = f.pages[i] ?? '';
    const at = page.indexOf(value);
    if (at === -1) continue;
    const from = Math.max(0, at - 40);
    const to = Math.min(page.length, at + value.length + 40);
    return { quote: page.slice(from, to), page: i + 1 };
  }
  return null;
}

export interface StubOptions {
  /** Fields to answer. Defaults to whatever the pipeline asks for. */
  only?: FieldKey[];
  /** Fields to deliberately leave empty even when asked. */
  omit?: FieldKey[];
  /** Fields to answer with a real value and a quote the document does not contain. */
  fabricate?: FieldKey[];
  /** Fields to answer with a wrong value, to prove a rule hit is not overwritten. */
  wrongValue?: Partial<Record<FieldKey, string>>;
  docType?: DocType | null;
  /** Throw this instead of answering. */
  throws?: () => Error;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface StubProvider extends Provider {
  /** Every request the pipeline made, in order. Empty means the cache served it. */
  readonly requests: ExtractionRequest[];
  readonly calls: number;
}

const FABRICATED_QUOTE =
  'The parties acknowledge that this clause was never printed in this document.';

/** A Provider that answers from the fixture. No network, no cost, fully deterministic. */
export function stubProvider(f: Fixture, opts: StubOptions = {}): StubProvider {
  const requests: ExtractionRequest[] = [];

  const answer = (key: FieldKey): RawFieldAnswer => {
    if (opts.omit?.includes(key)) return { value: null, quote: null, page: null };
    const wrong = opts.wrongValue?.[key];
    const cite = quoteFor(f, key);
    if (opts.fabricate?.includes(key)) {
      return { value: wrong ?? f.expected[key] ?? 'fabricated', quote: FABRICATED_QUOTE, page: 1 };
    }
    const value = wrong ?? f.expected[key];
    if (value === null || value === undefined) return { value: null, quote: null, page: null };
    if (!cite) return { value: null, quote: null, page: null };
    return { value, quote: cite.quote, page: cite.page };
  };

  const provider: StubProvider = {
    id: 'api',
    maxConcurrency: 1,
    supportsVision: true,
    requests,
    get calls() {
      return requests.length;
    },
    async extract(req: ExtractionRequest, _opts?: ExtractOptions): Promise<ExtractionResponse> {
      requests.push(req);
      if (opts.throws) throw opts.throws();
      const keys = (opts.only ?? req.fieldsToFill).filter((k) => req.fieldsToFill.includes(k));
      const fields: Partial<Record<FieldKey, RawFieldAnswer>> = {};
      for (const key of keys) fields[key] = answer(key);
      return {
        fields,
        docType: opts.docType === undefined ? f.docType : opts.docType,
        usage: {
          inputTokens: opts.inputTokens ?? 1000,
          outputTokens: opts.outputTokens ?? 200,
          costUsd: opts.costUsd ?? 0.004,
        },
        raw: {
          provider: 'api',
          model: 'stub-model',
          promptVersion: req.promptVersion,
          prompt: `stub prompt for ${f.id}`,
          response: JSON.stringify({ fields }),
          repairAttempts: 0,
        },
        durationMs: 1,
      };
    },
    async health(): Promise<ProviderHealth> {
      return { provider: 'api', state: 'ok', summary: 'stub provider', checks: [] };
    },
    async selfTest() {
      return { ok: true, durationMs: 1, fieldsFound: 4, fieldsTotal: 4, costUsd: 0 };
    },
  };
  return provider;
}
