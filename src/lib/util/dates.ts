/**
 * The deterministic date engine.
 *
 * Nothing here touches `Date.parse` or `new Date(string)`. Both are
 * implementation-defined for anything that is not a strict ISO string, and both
 * silently reinterpret timezone, which is how a November 5 effective date becomes
 * November 4 for a reviewer in California. Every function is pure, every date is
 * a `YYYY-MM-DD` string, and every comparison happens at UTC midnight.
 *
 * Calendar arithmetic is calendar arithmetic: years and months move the field,
 * they do not add 365 or 30 days. Feb 29 + 1 year is Feb 28.
 */

/* ─────────────────────────────── Parsing ─────────────────────────────── */

export interface ParsedDate {
  /** ISO YYYY-MM-DD. */
  iso: string;
  /**
   * True when the source was a bare numeric date whose first two components were
   * both <= 12, so month-first vs day-first could not be decided from the text.
   * We resolve US month-first (IBC's counsel drafts US-style) and let the UI
   * flag it amber rather than pretend we knew.
   */
  ambiguous: boolean;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * Ordered most-specific-first; the first match that yields a *valid* date wins.
 * All are global so parseDate can walk every match in a clause -- the leftmost
 * regex hit is not always the date ("commencing September 5" vs "Section 5").
 */
const DATE_PATTERNS: {
  re: RegExp;
  build: (m: RegExpMatchArray) => { y: number; mo: number; d: number; ambiguous: boolean } | null;
}[] = [
  // "this 5th day of November, 2022"
  {
    re: /(\d{1,2})(?:st|nd|rd|th)?\s+day\s+of\s+([A-Za-z]+)\.?\s*,?\s*(\d{4})/gi,
    build: (m) => named(m[3], m[2], m[1]),
  },
  // 2022-11-05, optionally with a time suffix we ignore
  {
    re: /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g,
    build: (m) => numeric(m[1], m[2], m[3]),
  },
  // 2022/11/05
  {
    re: /(?<!\d)(\d{4})\/(\d{1,2})\/(\d{1,2})(?!\d)/g,
    build: (m) => numeric(m[1], m[2], m[3]),
  },
  // November 5, 2022 / Nov. 5th 2022
  {
    re: /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})(?!\d)/g,
    build: (m) => named(m[3], m[1], m[2]),
  },
  // 5 November 2022 / 5th of November, 2022
  {
    re: /(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})(?!\d)/g,
    build: (m) => named(m[3], m[2], m[1]),
  },
  // 11/5/2022 · 11-5-22 · 11.5.2022 — US month-first when genuinely ambiguous
  {
    re: /(?<!\d)(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})(?!\d)/g,
    build: (m) => {
      const a = int(m[1]);
      const b = int(m[2]);
      const y = expandYear(int(m[3]), (m[3] ?? '').length);
      if (a == null || b == null || y == null) return null;
      if (a > 12 && b <= 12) return { y, mo: b, d: a, ambiguous: false };
      if (b > 12) return { y, mo: a, d: b, ambiguous: false };
      return { y, mo: a, d: b, ambiguous: true };
    },
  },
];

function int(s: string | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

function expandYear(y: number | null, digits: number): number | null {
  if (y == null) return null;
  if (digits >= 3) return y;
  // Two-digit years in signed agreements are never 19xx in this corpus, but the
  // 50-year pivot is the conventional one and costs nothing.
  return y < 50 ? 2000 + y : 1900 + y;
}

function named(
  yRaw: string | undefined,
  monthRaw: string | undefined,
  dRaw: string | undefined,
): { y: number; mo: number; d: number; ambiguous: boolean } | null {
  const y = int(yRaw);
  const d = int(dRaw);
  const mo = monthRaw ? MONTHS[monthRaw.toLowerCase()] : undefined;
  if (y == null || d == null || mo == null) return null;
  return { y, mo, d, ambiguous: false };
}

function numeric(
  yRaw: string | undefined,
  moRaw: string | undefined,
  dRaw: string | undefined,
): { y: number; mo: number; d: number; ambiguous: boolean } | null {
  const y = int(yRaw);
  const mo = int(moRaw);
  const d = int(dRaw);
  if (y == null || mo == null || d == null) return null;
  return { y, mo, d, ambiguous: false };
}

/**
 * Read a date out of contract prose. Returns null rather than guessing.
 *
 * Accepts a bare date or a date embedded in a sentence, because the rules pass
 * feeds it whole clauses ("effective as of November 5, 2022, between...").
 */
export function parseDate(s: string | null | undefined): ParsedDate | null {
  if (!s) return null;
  const text = s.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  for (const { re, build } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const parts = build(m);
      if (!parts) continue;
      const iso = toIso(parts.y, parts.mo, parts.d);
      if (iso) return { iso, ambiguous: parts.ambiguous };
    }
  }
  return null;
}

/** parseDate when the caller only wants the value. */
export function parseDateIso(s: string | null | undefined): string | null {
  return parseDate(s)?.iso ?? null;
}

/** Build an ISO date, rejecting Feb 30 and friends instead of rolling over. */
function toIso(y: number, mo: number, d: number): string | null {
  if (y < 1000 || y > 9999) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  return `${pad4(y)}-${pad2(mo)}-${pad2(d)}`;
}

export function isIsoDate(s: string | null | undefined): boolean {
  if (!s) return false;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = int(m[1]);
  const mo = int(m[2]);
  const d = int(m[3]);
  if (y == null || mo == null || d == null) return false;
  return toIso(y, mo, d) === s;
}

/* ────────────────────────────── Durations ────────────────────────────── */

export type DurationUnit = 'day' | 'week' | 'month' | 'year';

export interface Duration {
  kind: 'fixed' | 'perpetual';
  /**
   * Nominal total length, for the `term_days` column and for sorting only.
   * Null when perpetual. Never use this for arithmetic — use addDuration, which
   * walks the real calendar.
   */
  days: number | null;
  /** The unit as drafted. Null when perpetual. */
  unit: DurationUnit | null;
  count: number | null;
}

const NOMINAL_DAYS: Record<DurationUnit, number> = { day: 1, week: 7, month: 30, year: 365 };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const PERPETUAL_RE =
  /\b(perpetual|perpetuity|perpetually|indefinite|indefinitely|forever|no\s+expiration|without\s+limit(?:ation)?\s+in\s+time|unlimited\s+(?:in\s+)?(?:time|duration))\b/;

function unitOf(raw: string | undefined): DurationUnit | null {
  switch (raw) {
    case 'year':
    case 'annum':
      return 'year';
    case 'month':
      return 'month';
    case 'week':
      return 'week';
    case 'day':
      return 'day';
    default:
      return null;
  }
}

/**
 * Read a term phrase. "five (5) years", "90 days", "twenty-four (24) months",
 * "in perpetuity". Returns null when nothing quantifiable is present, because a
 * wrong term silently produces a wrong termination date.
 */
export function parseDuration(s: string | null | undefined): Duration | null {
  if (!s) return null;
  const text = s.toLowerCase().replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (PERPETUAL_RE.test(text)) return { kind: 'perpetual', days: null, unit: null, count: null };

  const unitMatch = text.match(/\b(day|week|month|year|annum)s?\b/);
  if (!unitMatch) return null;
  const unit = unitOf(unitMatch[1]);
  if (unit == null) return null;

  const head = text.slice(0, unitMatch.index ?? 0);

  // A parenthesised numeral is the drafter being explicit; trust it over the words.
  const paren = head.match(/\(\s*(\d{1,4})\s*\)\s*$/) ?? head.match(/\(\s*(\d{1,4})\s*\)/);
  let count = int(paren?.[1]);

  if (count == null) {
    const digits = [...head.matchAll(/(\d{1,4})/g)].at(-1);
    count = int(digits?.[1]);
  }

  if (count == null) count = wordNumber(head);
  // "a period of one year" with the numeral missing entirely still reads as 1.
  if (count == null && /\b(a|an|each|per)\s*$/.test(head)) count = 1;
  if (count == null || count <= 0) return null;

  return { kind: 'fixed', days: count * NOMINAL_DAYS[unit], unit, count };
}

/** "twenty-four" -> 24, reading the trailing word group only. */
function wordNumber(head: string): number | null {
  const words = head.replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  let total: number | null = null;
  // Walk backwards so "a term of five years, renewable for ten" reads the five.
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w == null) continue;
    const v = NUMBER_WORDS[w];
    if (v == null) {
      if (total != null) break;
      continue;
    }
    if (total == null) {
      total = v;
      continue;
    }
    // "twenty" + already-seen "four" -> 24. Anything else ends the group.
    if (v >= 20 && total < 10) total = v + total;
    else break;
  }
  return total;
}

/* ───────────────────────────── Arithmetic ────────────────────────────── */

/**
 * Calendar-correct addition. Years and months move the field and clamp to the
 * last valid day: 2024-02-29 + 1 year = 2025-02-28, 2022-01-31 + 1 month =
 * 2022-02-28. Perpetual has no end date, so it returns null.
 */
export function addDuration(
  iso: string | null | undefined,
  duration: Duration | string | null | undefined,
): string | null {
  if (!iso || !isIsoDate(iso)) return null;
  // Callers usually hold the verbatim term phrase, not a parsed Duration.
  const d = typeof duration === 'string' ? parseDuration(duration) : duration;
  if (!d || d.kind === 'perpetual' || d.unit == null || d.count == null) return null;

  const { y, mo, day } = splitIso(iso);

  if (d.unit === 'day' || d.unit === 'week') {
    const add = d.unit === 'week' ? d.count * 7 : d.count;
    return fromUtcMs(utcMs(iso) + add * 86_400_000);
  }

  const monthsToAdd = d.unit === 'year' ? d.count * 12 : d.count;
  const zero = (y * 12 + (mo - 1)) + monthsToAdd;
  const ny = Math.floor(zero / 12);
  const nmo = (zero % 12) + 1;
  const nd = Math.min(day, daysInMonth(ny, nmo));
  return `${pad4(ny)}-${pad2(nmo)}-${pad2(nd)}`;
}

/** Whole days from a to b. Negative when b is before a. Never timezone-shifted. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcMs(b) - utcMs(a)) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  return fromUtcMs(utcMs(iso) + days * 86_400_000);
}

/** Today in the user's own timezone, as an ISO date. "Days remaining" is a local question. */
export function todayIso(now: Date = new Date()): string {
  return `${pad4(now.getFullYear())}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function daysInMonth(y: number, mo: number): number {
  if (mo === 2) return isLeapYear(y) ? 29 : 28;
  return mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/* ─────────────────────────── Presentation ────────────────────────────── */

/** "November 5, 2022". Empty string for nothing, never "Invalid Date". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso || !isIsoDate(iso)) return '';
  const { y, mo, day } = splitIso(iso);
  return `${MONTH_NAMES[mo - 1] ?? ''} ${day}, ${y}`;
}

/** "Nov 5 2022" — for table cells, where the comma is noise. */
export function formatShort(iso: string | null | undefined): string {
  if (!iso || !isIsoDate(iso)) return '';
  const { y, mo, day } = splitIso(iso);
  return `${(MONTH_NAMES[mo - 1] ?? '').slice(0, 3)} ${day} ${y}`;
}

/** "5 years" from a parsed duration, for when only the structured form survived. */
export function formatDuration(d: Duration | null): string {
  if (!d) return '';
  if (d.kind === 'perpetual') return 'Perpetual';
  if (d.count == null || d.unit == null) return '';
  return `${d.count} ${d.unit}${d.count === 1 ? '' : 's'}`;
}

/* ──────────────────────────── Internals ─────────────────────────────── */

function splitIso(iso: string): { y: number; mo: number; day: number } {
  return {
    y: Number(iso.slice(0, 4)),
    mo: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function utcMs(iso: string): number {
  const { y, mo, day } = splitIso(iso);
  return Date.UTC(y, mo - 1, day);
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/* ────────────────────── the two clocks, resolved ────────────────────── */

/**
 * Date shapes as they appear INSIDE prose, reusing the month alternation already
 * declared above. dates.ts sits at the bottom of the dependency graph and must not
 * reach up into the extraction layer for this.
 */
/** Full names plus the abbreviations contracts actually use. */
const MONTH_ALT = [
  ...MONTH_NAMES,
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sept', 'Sep', 'Oct', 'Nov', 'Dec',
].join('|');

const DATE_IN_TEXT_RE = new RegExp(
  [
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?(?:${MONTH_ALT})\\.?,?\\s+\\d{4}\\b`,
    `\\b(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,
    '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
    '\\b\\d{1,2}[\\/.]\\d{1,2}[\\/.]\\d{2,4}\\b',
  ].join('|'),
  'gi',
);

export interface EndDateInput {
  /**
   * The date the clock starts. Usually the effective date, but a confidentiality
   * obligation that runs "after termination" starts from the termination date --
   * see clockAnchor().
   */
  effective: string | null;
  /** The term phrase exactly as the document states it, or null. */
  term: string | null;
  /**
   * The quote the effective date came from. When it contains an ambiguous numeric
   * form (03/04/2024) we refuse to derive anything from it -- see below.
   */
  effectiveQuote?: string | null;
}

export interface EndDateResult {
  /** The resolved end date, or null when we decline to assert one. */
  iso: string | null;
  /** Why, for the audit trail and for the eval's failure messages. */
  reason:
    | 'duration'          // effective + parsed duration
    | 'stated-end-date'   // the term names an end date outright
    | 'perpetual'         // survives indefinitely; no end date exists
    | 'no-effective-date'
    | 'no-term'
    | 'unparseable-term'
    | 'ambiguous-effective-date';
}

/**
 * Resolve a term to an end date. THE one definition -- the pipeline and the eval both
 * call this, so the suite cannot pass while the app computes something else.
 *
 * Three rules learned from scoring a live engine against real drafting:
 *
 * 1. A term stated only as an END DATE ("shall continue until December 31, 2027") is
 *    not a duration. Arithmetic has nothing to add, but the document states the answer
 *    outright, so read it out rather than returning null.
 *
 * 2. An UNPARSEABLE term yields null, never the effective date. Treating an
 *    unrecognised phrase as a zero-length duration produced an agreement that expired
 *    the day it was signed -- asserted as a computed fact, with no quote to contradict.
 *
 * 3. An AMBIGUOUS effective date poisons everything downstream. 03/04/2024 is 4 March
 *    in London and 3 April in Fremont. The rules pass already abstains on it so a human
 *    looks; deriving a confident termination date from whichever reading the model
 *    picked would launder that coin flip into a hard fact in the Expiring view. If the
 *    input is uncertain, the derived value does not exist.
 */
export function resolveEndDate(input: EndDateInput): EndDateResult {
  const { effective, term, effectiveQuote } = input;
  if (!effective) return { iso: null, reason: 'no-effective-date' };

  if (effectiveQuote) {
    const parsedQuote = parseDate(effectiveQuote);
    if (parsedQuote?.ambiguous) return { iso: null, reason: 'ambiguous-effective-date' };
  }

  if (!term || !term.trim()) return { iso: null, reason: 'no-term' };

  const duration = parseDuration(term);
  if (duration?.kind === 'perpetual') return { iso: null, reason: 'perpetual' };
  if (duration) {
    const added = addDuration(effective, duration);
    // Equal to the input means nothing was actually added.
    if (added && added !== effective) return { iso: added, reason: 'duration' };
  }

  // No duration: the term may name the end date itself. Take the latest date in the
  // phrase that is after the effective date -- "commences on the Effective Date and
  // shall continue until December 31, 2027" contains both.
  const candidates = (term.match(DATE_IN_TEXT_RE) ?? [])
    .map((s) => parseDate(s))
    .filter((p): p is ParsedDate => p !== null && !p.ambiguous)
    .map((p) => p.iso)
    .filter((iso): iso is string => iso !== null && iso > effective)
    .sort();
  const last = candidates[candidates.length - 1];
  if (last) return { iso: last, reason: 'stated-end-date' };

  return { iso: null, reason: 'unparseable-term' };
}

/**
 * A term phrase should be a duration or an end date, not a clause. When a model hands
 * back the whole sentence, keep the operative fragment so the tracker column stays
 * readable and the Excel export does not carry a paragraph.
 */
export function tidyTerm(term: string | null): string | null {
  if (!term) return null;
  const flat = term.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  if (flat.length <= 40) return flat;

  const d = parseDuration(flat);
  if (d && d.kind !== 'perpetual' && d.count && d.unit) {
    return `${d.count} ${d.unit}${d.count === 1 ? '' : 's'}`;
  }
  if (/\b(?:perpetual|perpetuity|indefinite)/i.test(flat)) return 'perpetual';

  const dates = flat.match(DATE_IN_TEXT_RE);
  const untilDate = dates?.[dates.length - 1];
  if (untilDate) return `until ${untilDate}`;

  // Nothing operative found; a clause is not a term.
  return null;
}

/* ─────────────────────── which date the clock runs from ─────────────── */

export type ClockAnchor = 'effective' | 'termination';

/**
 * Confidentiality obligations very often run from TERMINATION, not from the effective
 * date: "survive for 7 years after termination of this Agreement". Computing that from
 * the effective date understates the obligation by the whole length of the agreement --
 * on a real Octillion evaluation agreement it produced 2031 where the correct answer is
 * 2033. Silent, and on the one field that answers "are we still bound?".
 *
 * Read from the clause the model quoted, not from the bare duration, because the
 * duration alone ("7 years") cannot tell you what it is seven years from.
 */
const AFTER_TERMINATION_RE =
  /\b(?:after|following|from|upon|post)\s+(?:the\s+)?(?:date\s+of\s+)?(?:such\s+)?(?:expiration\s+or\s+)?(?:earlier\s+)?termination\b|\bafter\s+(?:the\s+)?(?:expiry|expiration)\b|\bsurvive[sd]?\s+(?:the\s+)?(?:expiration\s+or\s+)?termination\s+(?:of\s+this\s+agreement\s+)?(?:for|by)\b/i;

export function clockAnchor(quote: string | null | undefined): ClockAnchor {
  if (!quote) return 'effective';
  return AFTER_TERMINATION_RE.test(quote.replace(/\s+/g, ' ')) ? 'termination' : 'effective';
}
