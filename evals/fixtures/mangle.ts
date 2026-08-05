/**
 * The two halves of the hallucination guard's job, as data.
 *
 * MANGLERS turn a real quote into the shape a PDF text layer would have given it. Every
 * mangled quote MUST still verify: rejecting one of these means a reviewer sees "not found
 * in document" next to a clause that is plainly in the document, and stops trusting the app.
 *
 * FABRICATORS turn a real quote into something the document does not say. Every fabricated
 * quote MUST be rejected. One accepted fabrication is a silent wrong answer, which is the
 * only failure mode this product cannot recover from.
 */

export interface Mangler {
  name: string;
  /** Why a real PDF does this. */
  why: string;
  apply: (quote: string) => string;
}

const LIGATURES: [RegExp, string][] = [
  [/fi/g, '\ufb01'],
  [/fl/g, '\ufb02'],
];

export const MANGLERS: Mangler[] = [
  {
    name: 'curly-quotes',
    why: 'Word smart-quotes the apostrophes before the PDF is printed.',
    apply: (q) =>
      q
        .replace(/(\w)'(\w)/g, '$1\u2019$2')
        .replace(/'/g, '\u2019')
        .replace(/"([^"]*)"/g, '\u201c$1\u201d'),
  },
  {
    name: 'nbsp',
    why: 'Justified text leaves non-breaking spaces between a number and its unit.',
    apply: (q) => q.replace(/ /g, (_m, i: number) => (i % 3 === 0 ? '\u00a0' : ' ')),
  },
  {
    name: 'soft-hyphen',
    why: 'Hyphenation dictionaries insert U+00AD at every legal break point.',
    apply: (q) => q.replace(/([a-z]{3})([a-z]{3})/g, '$1\u00ad$2'),
  },
  {
    name: 'mid-word-line-wrap',
    why: 'A word broken across two lines arrives as "confiden-\\ntial".',
    apply: (q) => q.replace(/([a-z]{4})([a-z]{3,})/, '$1-\n$2'),
  },
  {
    name: 'collapsed-whitespace',
    why: 'Column extraction turns every run of spaces into one, or into a newline.',
    apply: (q) => q.replace(/ /g, (_m, i: number) => (i % 5 === 0 ? '\n' : '  ')),
  },
  {
    name: 'ligatures',
    why: 'Embedded fonts map "fi" and "fl" to single ligature glyphs.',
    apply: (q) => LIGATURES.reduce((acc, [re, ch]) => acc.replace(re, ch), q),
  },
  {
    name: 'zero-width',
    why: 'Some producers sprinkle zero-width joiners between glyph runs.',
    apply: (q) => q.replace(/(\w)(\w)/g, '$1\u200b$2'),
  },
  {
    name: 'en-dash-for-hyphen',
    why: 'Typographic substitution turns "non-use" into "non\u2013use".',
    apply: (q) => q.replace(/-/g, '\u2013'),
  },
  {
    name: 'trailing-page-furniture',
    why: 'A quote that runs to the end of a page picks up the footer.',
    apply: (q) => `${q}   \n\n`,
  },
  {
    name: 'everything-at-once',
    why: 'Real scanned-then-OCRd contracts do all of the above in one paragraph.',
    apply: (q) =>
      LIGATURES.reduce((acc, [re, ch]) => acc.replace(re, ch), q)
        .replace(/'/g, '\u2019')
        .replace(/ /g, (_m, i: number) => (i % 4 === 0 ? '\u00a0' : ' '))
        .replace(/([a-z]{4})([a-z]{4,})/, '$1\u00ad$2'),
  },
];

export interface Fabricator {
  name: string;
  /** Why a model would produce this. */
  why: string;
  /** Return null when this fabrication does not apply to the given quote. */
  apply: (quote: string) => string | null;
}

export const FABRICATORS: Fabricator[] = [
  {
    name: 'number-swapped',
    why: 'The model read the right clause and wrote down the wrong figure.',
    apply: (q) => {
      const m = /\d+/.exec(q);
      if (!m) return null;
      const n = Number(m[0]);
      return q.replace(m[0], String(n === 7 ? 8 : 7));
    },
  },
  {
    name: 'word-substituted',
    why: 'A paraphrase that keeps the shape of the sentence but changes its meaning.',
    apply: (q) => {
      const swaps: [RegExp, string][] = [
        [/\bshall\b/, 'may'],
        [/\byears\b/, 'months'],
        [/\bdays\b/, 'weeks'],
        [/\bDelaware\b/, 'California'],
        [/\bconfidential\b/, 'public'],
      ];
      for (const [re, to] of swaps) if (re.test(q)) return q.replace(re, to);
      return null;
    },
  },
  {
    name: 'invented-clause',
    why: 'The model produced a clause that a document like this usually contains.',
    apply: () =>
      'This Agreement shall automatically renew for successive one (1) year periods unless either party gives notice of non-renewal.',
  },
  {
    name: 'wrong-party-inserted',
    why: 'Cross-contamination from another document in the same batch.',
    apply: (q) =>
      /Inc\.|LLC|Ltd|GmbH|Limited/.test(q)
        ? q.replace(/(Inc\.|LLC|Ltd\.?|GmbH|Limited)/, 'Holdings PLC')
        : null,
  },
  {
    name: 'sentence-extended',
    why: 'The quote starts out real and then keeps going into something invented.',
    apply: (q) => `${q}, and in no event longer than ten (10) years from the date of disclosure`,
  },
  {
    name: 'words-reordered',
    why: 'A reconstructed-from-memory quote with the right words in the wrong order.',
    apply: (q) => {
      const words = q.trim().split(/\s+/);
      if (words.length < 6) return null;
      const mid = Math.floor(words.length / 2);
      return [...words.slice(mid), ...words.slice(0, mid)].join(' ');
    },
  },
  {
    name: 'plausible-boilerplate',
    why: 'Generic legal filler that appears in most agreements but not in this one.',
    apply: () =>
      'Each party represents and warrants that it has full corporate power and authority to enter into this Agreement.',
  },
];
