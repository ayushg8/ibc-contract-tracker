/**
 * Party-name normalisation and fuzzy matching.
 *
 * "Octillion Power Supply, Inc.", "OCTILLION POWER SUPPLY INC" and "Octillion
 * Power Supply" are the same counterparty. The repository has to know that, and
 * search has to survive a typo, so both live here as pure functions with no
 * dependencies -- this file is imported by the search path on every keystroke.
 */

/**
 * Legal suffixes stripped from the matching key. Ordered longest-first so
 * "L.L.C." is consumed before "Co." can nibble at something else, and applied
 * repeatedly because "Acme Cells Co., Ltd." carries two.
 */
const LEGAL_SUFFIXES = [
  'limited liability company',
  'limited partnership',
  'besloten vennootschap',
  'aktiengesellschaft',
  'kabushiki kaisha',
  'company limited',
  'private limited',
  'incorporated',
  'corporation',
  'company',
  'limited',
  'pte ltd',
  'pty ltd',
  'co ltd',
  'corp',
  'gmbh',
  'llc',
  'llp',
  'inc',
  'ltd',
  'plc',
  'pte',
  'pty',
  'lp',
  'ag',
  'sa',
  'nv',
  'bv',
  'kk',
  'co',
];

/**
 * Casefold, drop punctuation, drop legal suffixes, collapse whitespace.
 * The result is a matching key, never something to show a user.
 */
export function normalizeParty(name: string | null | undefined): string {
  if (!name) return '';

  let s = name
    .normalize('NFKD')
    // Drop combining marks so an accented spelling collapses onto the plain one.
    .replace(/[\u0300-\u036f]/g, '')
    // Collapse dotted acronyms first: "L.L.C." must become "llc", not "l l c",
    // or the suffix list never sees it. Two or more letter-dot pairs only, so
    // "St. Paul Cells" keeps its space.
    .replace(/(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .toLowerCase()
    // Ampersand is a word in company names, not punctuation.
    .replace(/&/g, ' and ')
    // Keep letters, digits and spaces. Dots inside "L.L.C." simply vanish.
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A company may carry several suffixes; keep peeling while any matches, but
  // never peel the whole name away (a party literally called "Group" stays).
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s === suffix) return s;
      if (s.endsWith(` ${suffix}`)) {
        const next = s.slice(0, -(suffix.length + 1)).trim();
        if (next) {
          s = next;
          changed = true;
          break;
        }
      }
    }
  }

  return s;
}

/** Tokens of the normalised name. Empty array for an empty name. */
export function partyTokens(name: string | null | undefined): string[] {
  const n = normalizeParty(name);
  return n ? n.split(' ') : [];
}

/* ───────────────────────────────── IBC ───────────────────────────────── */

/**
 * Every spelling of the home party we have seen or expect. Matched against the
 * normalised key, so suffixes and punctuation are already gone.
 */
const IBC_KEYS = new Set(['international battery', 'ibc', 'ibc battery']);

/**
 * Is this us? Drives which party is the counterparty, which is what the
 * repository sorts and searches by. Deliberately narrow: a false positive here
 * would hide a real counterparty from the table.
 */
export function isIbcParty(name: string | null | undefined): boolean {
  const n = normalizeParty(name);
  if (!n) return false;
  if (IBC_KEYS.has(n)) return true;
  // "international battery company inc" normalises to "international battery",
  // but drafters also write "International Battery Company (India) Pvt Ltd".
  if (/^international battery\b/.test(n)) return true;
  if (/^ibc\b/.test(n) && /batter/.test(n)) return true;
  return false;
}

/* ──────────────────────────── Fuzzy matching ─────────────────────────── */

/**
 * 0..1 similarity between two party-ish strings.
 *
 * A hybrid on purpose. Plain Levenshtein over the whole string fails the case we
 * actually care about -- someone typing "octilion" to find "Octillion Power
 * Supply, Inc." -- because the length gap swamps the edit distance. So we also
 * score the best per-token match and take the strongest signal.
 */
export function fuzzyScore(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeParty(a);
  const nb = normalizeParty(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const full = levRatio(na, nb);

  const ta = na.split(' ');
  const tb = nb.split(' ');
  const [query, doc] = ta.length <= tb.length ? [ta, tb] : [tb, ta];

  // How well does every token of the shorter name find a home in the longer one?
  let sum = 0;
  let exact = 0;
  for (const q of query) {
    let best = 0;
    for (const d of doc) {
      if (q === d) {
        best = 1;
        break;
      }
      const r = levRatio(q, d);
      if (r > best) best = r;
    }
    if (best === 1) exact += 1;
    sum += best;
  }
  const tokenAvg = query.length ? sum / query.length : 0;
  const overlap = query.length ? exact / query.length : 0;

  // A short query that is a clean prefix of the name is a match, not a coincidence.
  const prefix = nb.startsWith(na) || na.startsWith(nb) ? 0.9 : 0;
  const contained = na.length >= 4 && (nb.includes(na) || na.includes(nb)) ? 0.85 : 0;

  return clamp01(Math.max(full, 0.9 * tokenAvg, 0.85 * overlap + 0.15 * full, prefix, contained));
}

/** 1 - normalised edit distance. */
export function levRatio(a: string, b: string): number {
  if (a === b) return 1;
  const len = Math.max(a.length, b.length);
  if (len === 0) return 1;
  return clamp01(1 - levenshtein(a, b) / len);
}

/**
 * Two-row Levenshtein. No dependency, no matrix allocation per call -- this runs
 * over every contract on every keystroke of the search box.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Bound the work; party names are short and a 200-char paste is not a name.
  if (a.length > 256) a = a.slice(0, 256);
  if (b.length > 256) b = b.slice(0, 256);

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] ?? 0;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/* ──────────────────────────── Misc cleanup ───────────────────────────── */

/** Collapse the whitespace a PDF text layer sprays through an address block. */
export function collapseWhitespace(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Trim a value on its way into the database. Empty and whitespace-only become
 * null so "missing" is one state, not three.
 */
export function nullIfBlank(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}
