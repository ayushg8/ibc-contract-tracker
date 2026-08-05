/**
 * The hallucination guard, plus the text primitives the deterministic pass shares.
 *
 * A model answer is worth nothing without a span of the document that proves it.
 * Everything here exists to answer one question honestly: does this quote actually
 * appear in the PDF we read, and does the claimed value follow from it?
 *
 * The matcher is deliberately tiered and deliberately tight. PDF text extraction
 * mangles quotes, dashes, ligatures and line wraps, so an exact-only comparison
 * would reject good citations and train the reviewer to ignore the warning. A
 * looser matcher than the one below would start accepting invented sentences,
 * which is the failure this product cannot have.
 */

import { FIELD_KEYS, FIELDS, type FieldKey } from '@/lib/fields';
import { EngineError } from '@/lib/providers/errors';
import type { RawFieldAnswer } from '@/lib/providers/types';
import { parseDateIso } from '@/lib/util/dates';

/* ─────────────────────────── text primitives ─────────────────────────── */

/**
 * Character folds applied before the punctuation-tolerant comparison. Every entry
 * is here because a real PDF produced it where the printed page showed something
 * else: smart quotes, en/em dashes, the fi/fl ligatures, soft hyphens inserted by
 * the typesetter, and the non-breaking spaces used to keep "Section 4" together.
 */
const CHAR_FOLDS: readonly (readonly [RegExp, string])[] = [
  [/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"'],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2043]/g, '-'],
  [/\u00AD/g, ''], // soft hyphen, inserted by the typesetter and invisible on the page
  [/[\u200B\u200C\u200D\uFEFF]/g, ''],
  [/\uFB00/g, 'ff'],
  [/\uFB01/g, 'fi'],
  [/\uFB02/g, 'fl'],
  [/\uFB03/g, 'ffi'],
  [/\uFB04/g, 'ffl'],
  [/[\uFB05\uFB06]/g, 'st'],
  [/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' '],
  [/\u2026/g, '...'],
];

/** Collapse every whitespace run to a single space. */
export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Whitespace + punctuation + ligature + hyphenation tolerant form. The
 * de-hyphenation runs first: a word broken across a line break arrives as
 * "confiden-\ntiality" and must become one token before spaces collapse.
 */
export function fold(s: string): string {
  let out = s.replace(/([A-Za-z])[-\u00AD\u2010\u2011]\s*\n\s*([A-Za-z])/g, '$1$2');
  for (const [re, to] of CHAR_FOLDS) out = out.replace(re, to);
  return collapse(out);
}

export function foldLower(s: string): string {
  return fold(s).toLowerCase();
}

/** Date shapes that appear in contracts. Parsing is delegated to parseDateIso. */
const MONTH =
  'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';

export const DATE_RE = new RegExp(
  [
    // 14th day of March, 2024 / 1 June 2023
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?(?:${MONTH})\\.?,?\\s+\\d{4}\\b`,
    // March 14, 2024
    `\\b(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,
    // 2024-03-14
    '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
    // 03/14/2024 · 14.03.2024
    '\\b\\d{1,2}[\\/.]\\d{1,2}[\\/.]\\d{2,4}\\b',
  ].join('|'),
  'gi',
);

/** Every date-looking substring, in document order. */
export function findDateStrings(s: string): string[] {
  return collapse(s).match(DATE_RE) ?? [];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  eighteen: 18,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};

/**
 * Compounds first: regex alternation is leftmost-match, so a bare "twenty" would
 * otherwise win against "twenty-four" and the "(24)" that follows would never line up.
 * Real drafting writes "twenty-four (24) months" far more often than "24 months".
 */
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const UNITS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const COMPOUND_WORDS = TENS.flatMap((t) => UNITS.map((u) => `${t}[-\\s]${u}`));

const NUMBER_WORD_ALT = [...COMPOUND_WORDS, ...Object.keys(NUMBER_WORDS)].join('|');

/** Resolves both "twelve" and "twenty-four". */
function numberWordValue(word: string): number | undefined {
  const w = word.toLowerCase().replace(/\s+/g, '-');
  const direct = NUMBER_WORDS[w];
  if (direct !== undefined) return direct;
  const parts = w.split('-');
  if (parts.length === 2) {
    const tens = NUMBER_WORDS[parts[0] ?? ''];
    const units = NUMBER_WORDS[parts[1] ?? ''];
    if (tens !== undefined && units !== undefined) return tens + units;
  }
  return undefined;
}

export type DurationUnit = 'day' | 'week' | 'month' | 'year';

export interface DurationParts {
  n: number;
  unit: DurationUnit;
  /** The number as printed, when it was printed as a word ("three"). */
  word: string | null;
}

/**
 * Matches "5 years", "three (3) years", "twelve (12) months", "ninety (90) days".
 * The parenthesised figure wins when both forms are present, because that is the
 * operative number in legal drafting.
 */
export const DURATION_RE = new RegExp(
  `\\b(?:(${NUMBER_WORD_ALT})|(\\d{1,3}))\\s*(?:\\(\\s*(\\d{1,3})\\s*\\)\\s*)?[\\s-]*(day|week|month|year)s?\\b`,
  'gi',
);

export function parseDurationParts(s: string): DurationParts | null {
  const re = new RegExp(DURATION_RE.source, 'i');
  const m = re.exec(collapse(s));
  if (!m) return null;
  const [, word, digits, paren, unitRaw] = m;
  if (!unitRaw) return null;
  const fromWord = word ? numberWordValue(word) : undefined;
  const n = paren ? Number(paren) : digits ? Number(digits) : fromWord;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const unit = unitRaw.toLowerCase();
  if (unit !== 'day' && unit !== 'week' && unit !== 'month' && unit !== 'year') return null;
  return { n, unit, word: word ? word.toLowerCase() : null };
}

/* ───────────────────────────── citations ─────────────────────────────── */

export type CitationMatchMethod = 'exact' | 'whitespace' | 'punctuation' | 'fuzzy' | 'none';

export interface CitationResult {
  found: boolean;
  /** 1-indexed, taken from where the quote actually is — never from the model. */
  page: number | null;
  method: CitationMatchMethod;
  /** 1 for the three exact tiers; the measured ratio for a fuzzy hit. */
  similarity: number;
}

/** Below this a "quote" is not evidence of anything. */
const MIN_QUOTE_CHARS = 4;
/** Fuzzy matching needs enough signal that a coincidence is implausible. */
const MIN_FUZZY_CHARS = 24;
const FUZZY_THRESHOLD = 0.92;
/**
 * The OCR haystack is itself a machine's best guess, so it carries its own errors:
 * a stray comma, an l read as a 1, a word split by a speck on the page. Holding a
 * good citation to the digital threshold would reject it for the SCAN's mistakes
 * rather than the model's.
 *
 * Loosened by four points and no more. The gate that actually keeps the fuzzy tier
 * honest is meaningPreserved(), and that one does NOT move -- see verifyOptions().
 */
const OCR_FUZZY_THRESHOLD = 0.88;
/** Fuzzy is O(n*m); long quotes are compared on their first slice only. */
const MAX_FUZZY_CHARS = 600;
const MAX_FUZZY_WINDOWS = 240;

const NOT_FOUND: CitationResult = { found: false, page: null, method: 'none', similarity: 0 };

export interface VerifyOptions {
  /**
   * The pages are machine-read text from a scan, not the PDF's own text layer.
   * Loosens the fuzzy similarity threshold only. Every meaning-bearing token --
   * every digit, month, modal and negation -- and every word of the quote still has
   * to be grounded in the matched span on exactly the same terms as on a digital
   * PDF, because OCR noise is not a reason to let a wrong number or a wrong name
   * through.
   */
  ocr?: boolean | undefined;
}

function fuzzyThreshold(opts: VerifyOptions | undefined): number {
  return opts?.ocr === true ? OCR_FUZZY_THRESHOLD : FUZZY_THRESHOLD;
}

/** Page indices to try, the model's claim first — it is usually right and it is cheap. */
function pageOrder(pageCount: number, claimedPage: number | null | undefined): number[] {
  const order: number[] = [];
  const claimed = typeof claimedPage === 'number' ? claimedPage - 1 : -1;
  if (claimed >= 0 && claimed < pageCount) order.push(claimed);
  for (let i = 0; i < pageCount; i++) if (i !== claimed) order.push(i);
  return order;
}

export function verifyCitation(
  quote: string,
  pagesText: string[],
  claimedPage?: number | null,
  opts?: VerifyOptions,
): CitationResult {
  const raw = quote.trim();
  if (raw.length < MIN_QUOTE_CHARS || pagesText.length === 0) return NOT_FOUND;
  const order = pageOrder(pagesText.length, claimedPage);

  for (const i of order) {
    if ((pagesText[i] ?? '').includes(raw)) {
      return { found: true, page: i + 1, method: 'exact', similarity: 1 };
    }
  }

  const ws = collapse(raw);
  for (const i of order) {
    if (collapse(pagesText[i] ?? '').includes(ws)) {
      return { found: true, page: i + 1, method: 'whitespace', similarity: 1 };
    }
  }

  const punct = foldLower(raw);
  for (const i of order) {
    if (foldLower(pagesText[i] ?? '').includes(punct)) {
      return { found: true, page: i + 1, method: 'punctuation', similarity: 1 };
    }
  }

  if (punct.length >= MIN_FUZZY_CHARS) {
    const threshold = fuzzyThreshold(opts);
    /*
     * Only the SIMILARITY threshold moves on a scan. The word gate below reads this
     * to decide whether per-word edit tolerance is warranted at all -- it is not, on
     * a text layer, where the characters are exact.
     */
    const ocr = opts?.ocr === true;
    // The quote with its capitals intact, and the same text folded down for scoring.
    // Cut once and lower-cased after, so the two cannot drift apart: the gate reads its
    // proper nouns off `cased`, and it has to be looking at the same span `needle` is.
    /*
     * The tail was being thrown away, and with it the whole guarantee.
     *
     * The slice bounds an O(n*m) alignment on a 120-page document, which is a real
     * cost, but nothing downstream ever looked at what it discarded -- not the
     * similarity score, not the token gate, not the word gate. So 600 verbatim
     * characters followed by any invented sentence verified at similarity 1.0000.
     * No near-miss required: the fabrication simply sat past the cut.
     *
     * The scoring window stays capped, because that is what the cost is. The word
     * gate now runs over the WHOLE quote -- it is linear, so the length that made
     * truncation necessary is not a problem for it. A quote is grounded in full or
     * it is not grounded.
     */
    const casedFull = fold(raw);
    const cased = casedFull.slice(0, MAX_FUZZY_CHARS);
    const needle = cased.toLowerCase();
    const truncated = casedFull.length > cased.length;
    let bestSim = 0;
    let bestPage: number | null = null;
    let bestWindow = '';
    let bestContext = '';
    for (const i of order) {
      const hit = bestWindowMatch(needle, cased, foldLower(pagesText[i] ?? ''), threshold, ocr);
      if (hit.similarity > bestSim) {
        bestSim = hit.similarity;
        bestPage = i + 1;
        bestWindow = hit.window;
        bestContext = hit.context;
      }
      if (bestSim >= 0.999) break;
    }
    // The similarity score alone is not sufficient evidence. See meaningPreserved().
    if (
      bestPage !== null &&
      bestSim >= threshold &&
      meaningPreserved(cased, bestWindow, bestContext, ocr) &&
      // Anything beyond the scoring cap has still never been compared to the page.
      // Ground the full quote against the page it matched, or refuse it.
      (!truncated || meaningPreserved(casedFull, bestWindow, foldLower(pagesText[bestPage - 1] ?? ''), ocr))
    ) {
      return { found: true, page: bestPage, method: 'fuzzy', similarity: bestSim };
    }
  }

  return NOT_FOUND;
}

/**
 * The gate that makes the fuzzy tier safe.
 *
 * Edit distance alone cannot tell an extraction artefact from a transcription error.
 * "effective as of November 7, 2022" scores 0.969 against "November 5, 2022" and
 * "five (7) years" scores 0.975 against "five (5) years" -- both well past any
 * threshold loose enough to absorb a soft hyphen. That is precisely the failure this
 * guard exists to catch: the model reads the right clause and writes down the wrong
 * figure, producing a contract record that is wrong in the one way nobody notices.
 *
 * So the fuzzy tier is allowed to forgive only COSMETIC difference. Every token that
 * carries meaning -- every number, every month, every modal, every negation -- must
 * survive the comparison intact and in order.
 */
/**
 * Spelled-out numerals. Deliberately broader than NUMBER_WORDS above (which only
 * carries the values the duration parser needs) -- for this gate we care that the
 * word is present and identical, not what it evaluates to, so every spelling counts.
 */
const NUMERAL_WORDS = [
  ...Object.keys(NUMBER_WORDS),
  'sixteen', 'seventeen', 'nineteen', 'seventy', 'eighty', 'hundred', 'thousand',
  'first', 'second', 'third', 'fourth', 'fifth',
];

const MONTH_WORDS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

/**
 * Words whose substitution changes legal meaning while leaving the sentence shape
 * intact -- "shall remain" vs "may remain", "survive" vs "terminate". A paraphrase
 * that swaps one of these is not a citation, it is a rewrite.
 */
const SEMANTIC_WORDS = [
  'shall', 'may', 'must', 'will', 'shall not', 'cannot',
  'not', 'no', 'never', 'nor', 'except', 'unless', 'subject',
  'survive', 'survives', 'survival', 'terminate', 'terminates', 'termination',
  'expire', 'expires', 'expiration', 'remain', 'remains', 'continue', 'continues',
  'perpetual', 'perpetuity', 'indefinite', 'indefinitely',
  'year', 'years', 'month', 'months', 'day', 'days', 'week', 'weeks',
  'mutual', 'exclusive', 'nonexclusive',
];

const SEMANTIC_SET = new Set([...NUMERAL_WORDS, ...MONTH_WORDS, ...SEMANTIC_WORDS]);

/**
 * The ordered sequence of meaning-bearing tokens in a folded string: every digit run
 * verbatim, plus every word from SEMANTIC_SET. Ordinary prose words are ignored --
 * they are what the similarity score is for.
 */
export function meaningTokens(folded: string): string[] {
  const out: string[] = [];
  for (const m of folded.toLowerCase().matchAll(/\d+|[a-z]+/g)) {
    const t = m[0];
    if (/^\d/.test(t)) out.push(t);
    else if (SEMANTIC_SET.has(t)) out.push(t);
  }
  return out;
}

/**
 * True when the quote's meaning tokens appear in the window as a contiguous
 * subsequence, in order. Contiguity matters: a window is wider than the quote, so an
 * unanchored subset test would let "five (7) years" borrow the 5 from a neighbouring
 * clause.
 */
function semanticTokensPreserved(needle: string, window: string): boolean {
  const want = meaningTokens(needle);
  if (want.length === 0) return true; // nothing load-bearing to check
  const have = meaningTokens(window);
  if (have.length < want.length) return false;
  outer: for (let i = 0; i + want.length <= have.length; i++) {
    for (let j = 0; j < want.length; j++) {
      if (have[i + j] !== want[j]) continue outer;
    }
    return true;
  }
  return false;
}

/* ── the closed half of the gate: every word has to be somewhere on the page ── */

/**
 * SEMANTIC_SET above is an ALLOW-LIST, and an allow-list is open: a word it has never
 * heard of is waved through as ordinary prose. That is how a fabricated jurisdiction
 * got recorded as verified -- "Delaware" and "New York" contain no digit and no
 * semantic word, so the check passed VACUOUSLY and the whole gate collapsed to the
 * similarity score, which one swapped noun in a long sentence barely dents. Proper
 * nouns are the facts a contract tracker exists to hold: counterparties, signers,
 * cities, jurisdictions, entity types.
 *
 * So the rest of the quote is checked the other way round -- closed. EVERY word of the
 * quote has to be findable in the span we matched, in order. A word we cannot place is
 * a rejection, whether or not any list has heard of it.
 */
interface QuoteWord {
  /** Lowercased, letters and digits only. */
  text: string;
  /** Printed with at least one capital letter. Read before the fold, or it is gone. */
  capitalised: boolean;
}

/**
 * The shortest word worth demanding, by whether the quote printed it with a capital.
 *
 * Three letters of lower-case prose is "and", "the", "for". Those are in every span of
 * English ever written, so requiring them proves nothing -- and they are exactly what a
 * scanner mangles most often, so requiring them would cost real citations and buy no
 * safety. Three letters with a capital in them is "Inc", "LLC", "New", "IBC": a name, an
 * entity type or a jurisdiction, and every one of those is a fact this record exists to
 * hold. The capital is the only signal available before the case is folded away, and it
 * is what decides which short words are load-bearing.
 */
function minGroundedChars(capitalised: boolean): number {
  return capitalised ? 3 : 4;
}

/** Letters and digits, in order, with every word break dropped. */
const WORD_RE = /[A-Za-z0-9]+/g;

/**
 * The words of the quote, read off the text BEFORE it was case-folded -- once folded,
 * "Delaware" and "delaware" are the same string and the fact that the document named a
 * place is gone.
 *
 * Capitalisation decides only WHICH short words are demanded, never how hard they are
 * demanded. That matters because titles, party blocks and signature blocks are printed
 * in full capitals ("MUTUAL NONDISCLOSURE AGREEMENT", "NTRIUM, INC."), where the capital
 * carries no signal at all: holding every word of a heading to a stricter standard than
 * the prose around it would make the title of half the corpus impossible to cite off a
 * scan. Every word here is checked on the same tolerance.
 */
function quoteWords(cased: string): QuoteWord[] {
  const out: QuoteWord[] = [];
  for (const m of cased.matchAll(WORD_RE)) {
    const w = m[0];
    const capitalised = /[A-Z]/.test(w);
    if (w.length < minGroundedChars(capitalised)) continue;
    out.push({ text: w.toLowerCase(), capitalised });
  }
  return out;
}

/**
 * How badly a word may be damaged and still count as present: one character in four,
 * and never less than one, so that no word is required to be perfect except the three
 * letter ones, where there is no room for a mistake to hide in.
 *
 * A scanner reads "m" as "rn" and "l" as "1", so a word has to survive a wrong character
 * or two or a scan would have every citation refused for the scanner's mistakes rather
 * than the model's. But scanner damage is LOCAL: it garbles a word, it does not replace
 * it. "New York" is not "Delaware" garbled and "LLC" is not "Inc." garbled -- those are
 * different facts, and a tolerance expressed as a fraction of the word will never reach
 * from one to the other.
 *
 * This is the same figure on a scan as on a digital PDF. The OCR option loosens the
 * SIMILARITY threshold and nothing else.
 */
function wordTolerance(w: QuoteWord, ocr: boolean): number {
  /*
   * Zero on a digital PDF, and this is the whole point.
   *
   * The per-word budget exists to absorb what a SCANNER does to a word -- the
   * "De1aware" class of damage. It was being spent on the text-layer path too,
   * where the characters are exact and there is nothing to absorb, and it bought a
   * complete bypass: a one-character edit inside any word of four letters or more.
   * "and Atrium, Inc., a Delaware" verified at 0.9643 against a document that says
   * Ntrium and was stored as party_b with citationVerified true. A sweep of
   * single-character edits over one fixture's proper nouns produced 21,984 accepted
   * fabrications; "International", at thirteen letters, was allowed three.
   *
   * Nothing legitimate needs it here. The mangling a real PDF reader produces --
   * ligatures, curly quotes, soft hyphens, a word split across a line, two words run
   * together -- is handled by fold() and by alnumStream() dropping word breaks, not
   * by edit distance. Those tests all still pass at zero.
   *
   * On a scan the budget stays, because there the damage is real and unavoidable.
   * That path already tells the reviewer, on the record and next to the evidence,
   * that quotes were checked against the machine read and not against the page.
   */
  if (!ocr) return 0;
  return w.text.length < 4 ? 0 : Math.max(1, Math.floor(w.text.length / 4));
}

/**
 * Letters and digits only, word breaks dropped. Two reasons for each half:
 *
 * Dropping the breaks is what lets the fuzzy tier keep doing its job -- a reader that
 * ran two words together ("accordancewith") or split one across a line still lines up
 * against the page, because on this stream there were never any spaces to disagree about.
 *
 * Keeping the digits is what makes the scanner's "De1aware" one character away from
 * "Delaware" instead of three.
 */
function alnumStream(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Index of the earliest place at or after `from` where `word` appears within `cap`
 * edits, or -1. The exact hit is found first and cheaply; the banded scan only runs
 * over the stretch before it, so a quote whose words are all really there costs one
 * indexOf per word.
 */
function findWord(stream: string, word: string, cap: number, from: number): number {
  const exact = stream.indexOf(word, from);
  if (cap <= 0 || exact === from) return exact;
  const limit = exact === -1 ? stream.length : exact;
  const shortest = Math.max(1, word.length - cap);
  const longest = word.length + cap;
  for (let start = Math.max(0, from); start + shortest <= limit; start++) {
    for (let len = shortest; len <= longest && start + len <= stream.length; len++) {
      if (editDistanceWithin(word, stream.slice(start, start + len), cap) !== null) return start;
    }
  }
  return exact;
}

/**
 * True when every word of the quote can be placed in the matched span, in order.
 *
 * `context` is the matched window plus a little of the page either side, because the
 * window is aligned by edit distance and can sit a few characters off -- without the
 * margin, a quote that ends on a proper noun would have that noun clipped in half and
 * be refused for the aligner's rounding rather than for anything the model did.
 */
function wordsGrounded(words: QuoteWord[], context: string, ocr: boolean): boolean {
  const stream = alnumStream(context);
  let cursor = 0;
  for (const w of words) {
    const at = findWord(stream, w.text, wordTolerance(w, ocr), cursor);
    if (at === -1) return false;
    // +1, not +length: the aim is that the words run left to right, not that they are
    // laid end to end. A fuzzy hit does not have a trustworthy end.
    cursor = at + 1;
  }
  return true;
}

/**
 * The whole gate. `needle` carries its original capitalisation; pass the folded quote,
 * not the lower-cased one, or the proper nouns in it stop being visible.
 */
export function meaningPreserved(
  needle: string,
  window: string,
  context?: string,
  ocr = false,
): boolean {
  if (!semanticTokensPreserved(needle, window)) return false;
  return wordsGrounded(quoteWords(needle), context ?? window, ocr);
}

/**
 * Anchored window search. Sliding every offset would be quadratic on a 120-page
 * document, so we align candidate windows on the rarest long word of the quote and
 * only fall back to a coarse slide when the quote has no such word.
 */
interface WindowMatch {
  similarity: number;
  /** The winning slice of the page. meaningPreserved() needs it, not just the score. */
  window: string;
  /** The same slice with a margin either side, for the word-grounding half of the gate. */
  context: string;
}

const NO_WINDOW: WindowMatch = { similarity: 0, window: '', context: '' };

/**
 * Keeps the best window AND its text, because the caller has to inspect the matched
 * span to decide whether the difference was cosmetic or substantive.
 *
 * A window that clears the similarity threshold but fails meaningPreserved() is not
 * simply discarded -- the search keeps going, because a later window on another page
 * may be the genuine source. Returning the first high-scoring near-miss would let one
 * decoy clause mask the real citation.
 */
function bestWindowMatch(
  needle: string,
  cased: string,
  hay: string,
  threshold: number,
  ocr: boolean,
): WindowMatch {
  if (hay.length === 0) return NO_WINDOW;
  const cap = Math.floor((1 - threshold) * needle.length) + 1;
  /** Alignment slack: the window can sit up to `cap` characters off either end. */
  const pad = cap + 2;
  let best = NO_WINDOW;
  /** Best window that also preserved meaning. Always preferred if one exists. */
  let bestClean = NO_WINDOW;
  let budget = MAX_FUZZY_WINDOWS;

  const tryWindow = (start: number): void => {
    if (budget <= 0) return;
    const from = Math.max(0, Math.min(start, hay.length - 1));
    const window = hay.slice(from, from + needle.length);
    if (Math.abs(window.length - needle.length) > cap) return;
    budget -= 1;
    const d = editDistanceWithin(needle, window, cap);
    if (d === null) return;
    const similarity = 1 - d / Math.max(needle.length, window.length);
    const context = hay.slice(Math.max(0, from - pad), from + needle.length + pad);
    if (similarity > best.similarity) best = { similarity, window, context };
    if (similarity >= threshold && similarity > bestClean.similarity) {
      if (meaningPreserved(cased, window, context, ocr))
        bestClean = { similarity, window, context };
    }
  };

  const done = (): boolean => bestClean.similarity >= 0.999;

  const anchors = pickAnchors(needle);
  if (anchors.length > 0) {
    for (const anchor of anchors) {
      let at = hay.indexOf(anchor.word);
      while (at !== -1 && budget > 0) {
        tryWindow(at - anchor.offset);
        if (done()) return bestClean;
        at = hay.indexOf(anchor.word, at + 1);
      }
    }
    if (bestClean.similarity > 0) return bestClean;
    if (best.similarity > 0) return best;
  }

  const step = Math.max(8, Math.floor(needle.length / 3));
  for (let start = 0; start < hay.length && budget > 0; start += step) {
    tryWindow(start);
    if (done()) return bestClean;
  }
  return bestClean.similarity > 0 ? bestClean : best;
}

interface Anchor {
  word: string;
  offset: number;
}

/** The three longest words of the quote, longest first — the rarest handles first. */
function pickAnchors(needle: string): Anchor[] {
  const found: Anchor[] = [];
  const re = /[a-z0-9]{5,}/g;
  let m: RegExpExecArray | null = re.exec(needle);
  while (m !== null) {
    const word = m[0];
    found.push({ word, offset: m.index });
    m = re.exec(needle);
  }
  return found.sort((a, b) => b.word.length - a.word.length).slice(0, 3);
}

/** Banded Levenshtein. Returns null as soon as the distance cannot beat `cap`. */
function editDistanceWithin(a: string, b: string, cap: number): number | null {
  if (Math.abs(a.length - b.length) > cap) return null;
  const n = b.length;
  const big = cap + 1;
  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j <= cap ? j : big;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i <= cap ? i : big;
    let rowMin = cur[0] ?? big;
    const lo = Math.max(1, i - cap);
    const hi = Math.min(n, i + cap);
    for (let j = 1; j <= n; j++) {
      if (j < lo || j > hi) {
        cur[j] = big;
        continue;
      }
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? big) + 1;
      const ins = (cur[j - 1] ?? big) + 1;
      const sub = (prev[j - 1] ?? big) + cost;
      const v = Math.min(del, ins, sub);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return null;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const d = prev[n] ?? big;
  return d > cap ? null : d;
}

/* ──────────────────────── value follows from quote ───────────────────── */

/**
 * Does the value the model reported actually follow from the span it cited?
 * A false here is not a rejection — the citation was real, so the reviewer gets an
 * amber field to look at rather than an empty one.
 */
export function verifyValueAgainstQuote(field: FieldKey, value: string, quote: string): boolean {
  const def = FIELDS[field];
  const v = value.trim();
  if (v.length === 0) return false;
  const nq = foldLower(quote);

  switch (def.type) {
    case 'date': {
      const iso = parseDateIso(v);
      if (!iso) return false;
      return findDateStrings(quote).some((d) => parseDateIso(d) === iso);
    }
    case 'duration': {
      const parts = parseDurationParts(v);
      if (!parts) return nq.includes(foldLower(v));
      const unitPresent = nq.includes(parts.unit);
      const digitRe = new RegExp(`(?<![0-9])${parts.n}(?![0-9])`);
      const numberPresent =
        digitRe.test(nq) ||
        (parts.word !== null && nq.includes(parts.word)) ||
        Object.entries(NUMBER_WORDS).some(([w, n]) => n === parts.n && nq.includes(w));
      return unitPresent && numberPresent;
    }
    case 'boolean':
      // "Is this on IBC's template?" is a judgement about the whole document, not a
      // span inside it. The citation check above is the only guard that applies.
      return true;
    case 'email':
      return nq.includes(v.toLowerCase());
    default:
      return nq.includes(foldLower(v));
  }
}

/* ───────────────────────── applied verification ──────────────────────── */

/**
 * Why a field was dropped or flagged.
 *
 * `unverifiable-on-scan` is deliberately its own value rather than a variant of
 * `quote-not-found`. On a digital PDF a missing quote means one thing: the model
 * wrote a sentence the document does not contain. On a scan it means one of two
 * things, and we cannot tell which -- the model invented it, or OCR mangled the line
 * it came from. The field is dropped either way, because a value we cannot evidence
 * is not a value; but the honest sentence to put in front of the reviewer is "could
 * not be checked against the scan", not "not found in the document".
 */
export type VerifyFailure =
  | 'no-quote'
  | 'quote-not-found'
  | 'unverifiable-on-scan'
  | 'value-not-supported';

/** One line of plain English per failure. What the UI shows next to the field. */
export const VERIFY_FAILURE_MESSAGES: Record<VerifyFailure, string> = {
  'no-quote': 'Claude gave a value with nothing to back it up.',
  'quote-not-found': 'The quoted wording is not in the document.',
  'unverifiable-on-scan': 'The quoted wording could not be checked against the scan.',
  'value-not-supported': 'The value does not follow from the quoted wording.',
};

export interface VerifiedField {
  value: string | null;
  quote: string | null;
  page: number | null;
  method: 'model' | 'missing';
  /** null only when verification does not apply (never set by this module). */
  citationVerified: boolean | null;
  /** Why the field was dropped or flagged. */
  reason?: VerifyFailure;
}

export type VerifiedFields = Partial<Record<FieldKey, VerifiedField>>;

export interface VerificationReport {
  fields: VerifiedFields;
  /** Answers where the model claimed a value. */
  claimed: number;
  /** Claims dropped because the citation could not be found. */
  rejected: number;
  /** Claims kept but flagged because the value does not follow from the quote. */
  flagged: number;
  notes: string[];
}

export function applyVerification(
  answers: Partial<Record<FieldKey, RawFieldAnswer>>,
  pagesText: string[],
  opts: VerifyOptions = {},
): VerificationReport {
  const fields: VerifiedFields = {};
  const notes: string[] = [];
  let claimed = 0;
  let rejected = 0;
  let flagged = 0;

  const notFound: VerifyFailure = opts.ocr === true ? 'unverifiable-on-scan' : 'quote-not-found';

  for (const key of FIELD_KEYS) {
    const answer = answers[key];
    if (!answer) continue;

    const value = typeof answer.value === 'string' ? answer.value.trim() : '';
    const quote = typeof answer.quote === 'string' ? answer.quote.trim() : '';

    if (value.length === 0) {
      fields[key] = { value: null, quote: null, page: null, method: 'missing', citationVerified: null };
      continue;
    }

    claimed += 1;

    if (quote.length === 0) {
      rejected += 1;
      notes.push(`${key}: ${VERIFY_FAILURE_MESSAGES['no-quote']}`);
      fields[key] = {
        value: null,
        quote: null,
        page: null,
        method: 'missing',
        citationVerified: false,
        reason: 'no-quote',
      };
      continue;
    }

    const cite = verifyCitation(quote, pagesText, answer.page, opts);
    if (!cite.found) {
      rejected += 1;
      notes.push(`${key}: ${VERIFY_FAILURE_MESSAGES[notFound]}`);
      fields[key] = {
        value: null,
        quote: null,
        page: null,
        method: 'missing',
        citationVerified: false,
        reason: notFound,
      };
      continue;
    }

    const supported = verifyValueAgainstQuote(key, value, quote);
    if (!supported) {
      flagged += 1;
      notes.push(`${key}: ${VERIFY_FAILURE_MESSAGES['value-not-supported']}`);
    }
    fields[key] = {
      value,
      quote,
      page: cite.page,
      method: 'model',
      citationVerified: supported,
      ...(supported ? {} : { reason: 'value-not-supported' as VerifyFailure }),
    };
  }

  if (claimed > 0 && rejected === claimed) {
    // On a scan this is as likely to be a bad machine read as a bad model run, so the
    // detail says which haystack was searched. The pipeline records the same fact.
    const where = opts.ocr === true ? 'the text read off the scan' : 'the document';
    throw new EngineError('ALL_CITATIONS_FAILED', {
      detail: `${rejected} of ${claimed} citations could not be found in ${where}`,
    });
  }

  return { fields, claimed, rejected, flagged, notes };
}
