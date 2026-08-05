/**
 * The fixture contract.
 *
 * A fixture is a synthetic agreement whose text we own and whose 16 expected field
 * values were written by hand before any extraction code existed. That ordering is the
 * whole point: the fixtures are the specification, not a snapshot of current behaviour.
 *
 * Every helper in this file is deliberately implemented WITHOUT importing anything from
 * src/lib. The suite needs an independent oracle for date arithmetic and string
 * comparison, otherwise a bug in src/lib/util/dates.ts would agree with itself and the
 * eval would pass.
 */

import type { DocType, FieldKey, FieldType } from '../../src/lib/fields';
import { FIELDS } from '../../src/lib/fields';

export interface FixtureComputed {
  /** effective_date + term, calendar-correct, month-end clamped. */
  terminationDate: string | null;
  /** effective_date + confidentiality_term. Null when perpetual or absent. */
  confidentialityEnd: string | null;
  /** True when the confidentiality obligation never lapses. */
  confidentialityPerpetual: boolean;
}

export interface Fixture {
  /** Stable slug. Used by --case=fixtures and printed in the report. */
  id: string;
  label: string;
  filename: string;
  docType: DocType;
  /** 1-indexed page bodies. Joined with page markers to form the extraction text. */
  pages: string[];
  /** All 16 fields. Written by hand. null means "correctly absent from the document". */
  expected: Record<FieldKey, string | null>;
  /**
   * Extra answers a careful human would also accept, per field. Used only when scoring a
   * model (live mode); the deterministic cases always compare against `expected`.
   */
  acceptable?: Partial<Record<FieldKey, (string | null)[]>>;
  /** The verbatim span that supports each expected value. Self-checked against `pages`. */
  quotes: Partial<Record<FieldKey, string>>;
  /** The page each quote lives on. Self-checked. */
  pageOf?: Partial<Record<FieldKey, number>>;
  computed: FixtureComputed;
  /** Fields a deterministic rule MUST find. Failing to find one is a failure. */
  rulesMustFind: FieldKey[];
  /** Fields no rule may answer: genuinely ambiguous. Firing here is a failure. */
  rulesMustNotFind: FieldKey[];
  /** One line: what this fixture exists to prove. Printed by the runner. */
  proves: string;
}

/* ───────────────────────── page-delimited text ───────────────────────── */

/**
 * ASSUMPTION (src/lib/extraction/pdf.ts): extracted text carries page boundaries as
 * `[[page N]]` on its own line. This is the only place the marker is spelled out; if the
 * reader emits a different delimiter, change these three functions and nothing else.
 */
export function pageMarker(page: number): string {
  return `[[page ${page}]]`;
}

export const PAGE_MARKER_RE = /\[\[page (\d+)\]\]/g;

export function fixtureText(f: Fixture): string {
  return f.pages.map((body, i) => `${pageMarker(i + 1)}\n${body.trim()}\n`).join('\n');
}

/** 1-indexed page containing a character offset, per the markers in the text. */
export function pageOfOffset(text: string, offset: number): number {
  let page = 1;
  for (const m of text.slice(0, offset).matchAll(PAGE_MARKER_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) page = n;
  }
  return page;
}

/** 1-indexed page a literal substring first appears on, or null if it is absent. */
export function pageOfQuote(text: string, quote: string): number | null {
  const at = text.indexOf(quote);
  return at === -1 ? null : pageOfOffset(text, at);
}

/* ─────────────────── independent date oracle (no src/lib) ─────────────── */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIso(s: string | null): boolean {
  if (!s) return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function isoToUtc(iso: string): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function utcToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return utcToIso(isoToUtc(iso) + days * DAY_MS);
}

export function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round((isoToUtc(toIso) - isoToUtc(fromIso)) / DAY_MS);
}

/**
 * Calendar month/year arithmetic with month-end clamping: 2024-02-29 + 1 year is
 * 2025-02-28, not 2025-03-01. Clamping is the convention the whole suite asserts.
 */
export function addMonths(iso: string, months: number): string {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const total = y * 12 + (mo - 1) + months;
  const ny = Math.floor(total / 12);
  const nmo = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nmo));
  return `${String(ny).padStart(4, '0')}-${String(nmo).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/* ───────────────────────── value comparison ──────────────────────────── */

const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032]/g;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/g;
const SOFT_HYPHEN = /\u00ad/g;
const SPACES = /[\u00a0\u2007\u202f\u2009\u200a]/g;
/** Zero-width characters a PDF text layer likes to sprinkle mid-word. */
const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff]/g;

/** Cosmetic normalisation only. Never changes which words are present. */
export function normalise(s: string): string {
  return s
    .replace(SOFT_HYPHEN, '')
    .replace(ZERO_WIDTH, '')
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(SPACES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loose(s: string): string {
  return normalise(s)
    .toLowerCase()
    .replace(/[.,;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "ninety (90) days" and "90 days" are the same answer. So are "3 years" and "three years". */
const WORD_NUMBERS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  twelve: '12',
  eighteen: '18',
  twenty: '20',
  'twenty-four': '24',
  'twenty four': '24',
  thirty: '30',
  'thirty-six': '36',
  'thirty six': '36',
  sixty: '60',
  ninety: '90',
};

function canonDuration(s: string): string {
  let t = loose(s);
  for (const [word, digit] of Object.entries(WORD_NUMBERS)) {
    t = t.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }
  // "5 (5) years" collapses to "5 years" once the spelled form is digitised.
  t = t.replace(/\b(\d+)\s+\1\b/g, '$1');
  t = t.replace(/\b(year|month|day|week)\b/g, '$1s');
  return t.replace(/\s+/g, ' ').trim();
}

function canonAddress(s: string): string {
  return loose(s)
    .replace(/\bsuite\b/g, 'ste')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonCompany(s: string): string {
  return loose(s)
    .replace(/\b(incorporated|inc)\b/g, 'inc')
    .replace(/\b(limited|ltd)\b/g, 'ltd')
    .replace(/\bcorporation\b/g, 'corp')
    .replace(/\bcompany\b/g, 'co')
    .trim();
}

/**
 * Addresses are free text, so exact string equality is the wrong assertion.
 *
 * Scoring a live engine made this obvious: it returned
 * "Northwind Energy Storage, Inc., 720 Olive Way, Suite 1400, Seattle, Washington
 * 98101, Attn: Legal Department" where the fixture had the Attn line second. It also
 * appended "marked for the attention of the Managing Director" on another, and included
 * the company name on a third where the fixture had omitted it. Every one of those is a
 * correct transcription of the same address -- two humans would not agree on the string
 * either. Failing them measured the fixture author's arbitrary choices, not the app.
 *
 * So the test is whether the address IDENTIFIES the same place: every distinctive token
 * of the expected value -- street numbers, postcodes, the street and city names -- must
 * appear in the answer. Extra detail is allowed; a missing or different number is not,
 * because that is a different address.
 */
function addressTokens(s: string): { numbers: string[]; words: Set<string> } {
  const flat = canonAddress(s);
  const numbers = flat.match(/\d+[a-z]?/g) ?? [];
  const words = new Set(
    (flat.match(/[a-z]{4,}/g) ?? []).filter(
      // Structural words carry no identifying information.
      (w) =>
        ![
          'suite', 'floor', 'level', 'attn', 'attention', 'marked', 'department',
          'street', 'road', 'avenue', 'parkway', 'boulevard', 'square', 'drive',
          'united', 'states', 'america', 'copy', 'email', 'with', 'their', 'the',
        ].includes(w),
    ),
  );
  return { numbers, words };
}

function addressesAgree(actual: string, expected: string): boolean {
  if (canonAddress(actual) === canonAddress(expected)) return true;
  const want = addressTokens(expected);
  const got = addressTokens(actual);
  // Every number in the expected address must be present -- a wrong building number
  // or postcode is a different address, however similar the prose.
  for (const n of want.numbers) if (!got.numbers.includes(n)) return false;
  for (const w of want.words) if (!got.words.has(w)) return false;
  return true;
}

export function valuesEqual(type: FieldType, actual: string | null, expected: string | null): boolean {
  if (actual == null || actual === '') return expected == null || expected === '';
  if (expected == null || expected === '') return false;
  switch (type) {
    case 'date':
      return actual.trim() === expected.trim();
    case 'duration':
      return canonDuration(actual) === canonDuration(expected);
    case 'email':
      return loose(actual).replace(/\s/g, '') === loose(expected).replace(/\s/g, '');
    case 'longtext':
      return addressesAgree(actual, expected);
    case 'boolean':
      return loose(actual).startsWith('y') === loose(expected).startsWith('y');
    case 'text':
      return canonCompany(actual) === canonCompany(expected);
  }
}

/** Scoring entry point. `acceptable` widens the answer set for model output only. */
export function fieldMatches(
  f: Fixture,
  key: FieldKey,
  actual: string | null,
  opts: { allowAcceptable: boolean },
): boolean {
  const type = FIELDS[key].type;
  if (valuesEqual(type, actual, f.expected[key])) return true;
  if (!opts.allowAcceptable) return false;
  const alts = f.acceptable?.[key];
  if (!alts) return false;
  return alts.some((alt) => valuesEqual(type, actual, alt));
}
