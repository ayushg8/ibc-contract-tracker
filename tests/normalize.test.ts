import { describe, expect, it } from 'vitest';

import {
  collapseWhitespace,
  fuzzyScore,
  isIbcParty,
  levRatio,
  levenshtein,
  normalizeParty,
  nullIfBlank,
  partyTokens,
} from '../src/lib/util/normalize';

describe('normalizeParty', () => {
  it('casefolds and collapses whitespace', () => {
    expect(normalizeParty('  Octillion   Power  Supply  ')).toBe('octillion power supply');
    expect(normalizeParty('OCTILLION POWER SUPPLY')).toBe('octillion power supply');
  });

  it('strips every legal suffix in the corpus', () => {
    expect(normalizeParty('Ntrium, Inc.')).toBe('ntrium');
    expect(normalizeParty('Ntrium Inc')).toBe('ntrium');
    expect(normalizeParty('Acme, L.L.C.')).toBe('acme');
    expect(normalizeParty('Acme LLC')).toBe('acme');
    expect(normalizeParty('Acme Cells GmbH')).toBe('acme cells');
    expect(normalizeParty('Acme Ltd')).toBe('acme');
    expect(normalizeParty('Acme Limited')).toBe('acme');
    expect(normalizeParty('Acme Corporation')).toBe('acme');
    expect(normalizeParty('Acme Corp.')).toBe('acme');
    expect(normalizeParty('Acme Company')).toBe('acme');
    expect(normalizeParty('Acme Incorporated')).toBe('acme');
    expect(normalizeParty('Acme S.A.')).toBe('acme');
    expect(normalizeParty('Acme B.V.')).toBe('acme');
    expect(normalizeParty('Acme Pte. Ltd.')).toBe('acme');
    expect(normalizeParty('Acme PLC')).toBe('acme');
    expect(normalizeParty('Acme AG')).toBe('acme');
    expect(normalizeParty('Acme K.K.')).toBe('acme');
    expect(normalizeParty('Acme KK')).toBe('acme');
  });

  it('peels more than one suffix', () => {
    expect(normalizeParty('Acme Cells Co., Ltd.')).toBe('acme cells');
    expect(normalizeParty('Acme Holdings Company Limited')).toBe('acme holdings');
  });

  it('never peels the name away entirely', () => {
    expect(normalizeParty('Inc.')).toBe('inc');
    expect(normalizeParty('Limited')).toBe('limited');
  });

  it('treats an ampersand as a word, not punctuation', () => {
    expect(normalizeParty('Smith & Sons, Inc.')).toBe('smith and sons');
  });

  it('folds accents onto their plain letters', () => {
    expect(normalizeParty('Sarl Grenoble Batteries')).toBe(
      normalizeParty('S\u00e0rl Grenoble Batteries'),
    );
  });

  it('is empty for nothing', () => {
    expect(normalizeParty(null)).toBe('');
    expect(normalizeParty(undefined)).toBe('');
    expect(normalizeParty('')).toBe('');
    expect(normalizeParty('   ')).toBe('');
    expect(normalizeParty(',.-')).toBe('');
  });

  it('tokenises the normalised key', () => {
    expect(partyTokens('Octillion Power Supply, Inc.')).toEqual(['octillion', 'power', 'supply']);
    expect(partyTokens(null)).toEqual([]);
  });
});

describe('isIbcParty', () => {
  it('recognises every spelling of the home party', () => {
    expect(isIbcParty('International Battery Company, Inc.')).toBe(true);
    expect(isIbcParty('INTERNATIONAL BATTERY COMPANY INC')).toBe(true);
    expect(isIbcParty('International Battery Co.')).toBe(true);
    expect(isIbcParty('International Battery Company (India) Private Limited')).toBe(true);
    expect(isIbcParty('IBC')).toBe(true);
    expect(isIbcParty('IBC Battery')).toBe(true);
  });

  it('does not claim a counterparty', () => {
    expect(isIbcParty('Ntrium, Inc.')).toBe(false);
    expect(isIbcParty('Octillion Power Supply, Inc.')).toBe(false);
    expect(isIbcParty('International Paper Company')).toBe(false);
    expect(isIbcParty('IBC Advanced Alloys')).toBe(false);
    expect(isIbcParty(null)).toBe(false);
    expect(isIbcParty('')).toBe(false);
  });
});

describe('fuzzyScore', () => {
  it('is 1 for the same company written differently', () => {
    expect(fuzzyScore('Ntrium, Inc.', 'Ntrium Inc')).toBe(1);
    expect(fuzzyScore('OCTILLION POWER SUPPLY, INC.', 'Octillion Power Supply')).toBe(1);
    expect(fuzzyScore('International Battery Company, Inc.', 'International Battery Co')).toBe(1);
  });

  it('finds Octillion from a typo', () => {
    expect(fuzzyScore('octilion', 'Octillion Power Supply, Inc.')).toBeGreaterThan(0.7);
    expect(fuzzyScore('Ntreum', 'Ntrium, Inc.')).toBeGreaterThan(0.7);
    expect(fuzzyScore('acme cels', 'Acme Cells GmbH')).toBeGreaterThan(0.7);
  });

  it('matches a partial name against a longer one', () => {
    expect(fuzzyScore('octillion', 'Octillion Power Supply, Inc.')).toBeGreaterThan(0.8);
    expect(fuzzyScore('power supply', 'Octillion Power Supply, Inc.')).toBeGreaterThan(0.8);
  });

  it('scores unrelated names low', () => {
    expect(fuzzyScore('Ntrium', 'Octillion Power Supply')).toBeLessThan(0.4);
    expect(fuzzyScore('zzzz', 'Acme Cells')).toBeLessThan(0.4);
  });

  it('is symmetric', () => {
    const a = 'octilion';
    const b = 'Octillion Power Supply, Inc.';
    expect(fuzzyScore(a, b)).toBe(fuzzyScore(b, a));
  });

  it('is 0 when either side is empty', () => {
    expect(fuzzyScore('', 'Acme')).toBe(0);
    expect(fuzzyScore('Acme', null)).toBe(0);
    expect(fuzzyScore(null, null)).toBe(0);
  });

  it('stays inside 0..1', () => {
    for (const [a, b] of [
      ['a', 'Octillion Power Supply'],
      ['Acme', 'Acme'],
      ['xyz', ''],
      ['Acme Cells GmbH', 'acme cells'],
    ] as const) {
      const s = fuzzyScore(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe('levenshtein', () => {
  it('matches the textbook values', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('octilion', 'octillion')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('gives a ratio in 0..1', () => {
    expect(levRatio('abc', 'abc')).toBe(1);
    expect(levRatio('', '')).toBe(1);
    expect(levRatio('abc', 'xyz')).toBe(0);
    expect(levRatio('octilion', 'octillion')).toBeCloseTo(1 - 1 / 9, 6);
  });
});

describe('cleanup helpers', () => {
  it('collapses the whitespace a PDF text layer sprays out', () => {
    expect(collapseWhitespace('  123  Main\n  St.\tSuite 4  ')).toBe('123 Main St. Suite 4');
    expect(collapseWhitespace('a\u00a0b')).toBe('a b');
    expect(collapseWhitespace(null)).toBe('');
  });

  it('turns blanks into one honest null', () => {
    expect(nullIfBlank('  Acme  ')).toBe('Acme');
    expect(nullIfBlank('   ')).toBeNull();
    expect(nullIfBlank('')).toBeNull();
    expect(nullIfBlank(null)).toBeNull();
    expect(nullIfBlank(undefined)).toBeNull();
  });
});
