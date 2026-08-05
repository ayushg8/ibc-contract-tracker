/**
 * The date engine is the one place where a silent off-by-one becomes a legal
 * problem, so every documented input form and every calendar edge is pinned here.
 *
 * Relative imports on purpose: these must run under `vitest run` with no config,
 * and vitest does not read tsconfig paths.
 */

import { describe, expect, it } from 'vitest';

import {
  addDays,
  addDuration,
  clockAnchor,
  daysBetween,
  daysInMonth,
  formatDate,
  formatDuration,
  formatShort,
  isIsoDate,
  isLeapYear,
  parseDate,
  parseDateIso,
  parseDuration,
  resolveEndDate,
  todayIso,
} from '../src/lib/util/dates';

describe('parseDate', () => {
  it('reads every form the corpus uses', () => {
    expect(parseDate('November 5, 2022')).toEqual({ iso: '2022-11-05', ambiguous: false });
    expect(parseDate('Nov 5, 2022')).toEqual({ iso: '2022-11-05', ambiguous: false });
    expect(parseDate('Nov. 5, 2022')).toEqual({ iso: '2022-11-05', ambiguous: false });
    expect(parseDate('November 5th, 2022')).toEqual({ iso: '2022-11-05', ambiguous: false });
    expect(parseDate('5 November 2022')).toEqual({ iso: '2022-11-05', ambiguous: false });
    expect(parseDate('5th of November, 2022')).toEqual({ iso: '2022-11-05', ambiguous: false });
    expect(parseDate('2022-11-05')).toEqual({ iso: '2022-11-05', ambiguous: false });
    expect(parseDate('2022/11/05')).toEqual({ iso: '2022-11-05', ambiguous: false });
  });

  it('reads the "5th day of November" recital form', () => {
    expect(parseDateIso('this 5th day of November, 2022')).toBe('2022-11-05');
    expect(parseDateIso('made this 1st day of March 2019')).toBe('2019-03-01');
    expect(parseDateIso('entered into this 23rd day of December, 2024')).toBe('2024-12-23');
  });

  it('accepts abbreviated and irregular month spellings', () => {
    expect(parseDateIso('Sept 5, 2022')).toBe('2022-09-05');
    expect(parseDateIso('Sep 5, 2022')).toBe('2022-09-05');
    expect(parseDateIso('JANUARY 14, 2024')).toBe('2024-01-14');
    expect(parseDateIso('jan 14 2024')).toBe('2024-01-14');
  });

  it('finds a date embedded in a clause', () => {
    expect(parseDateIso('This Agreement is effective as of November 5, 2022, between')).toBe(
      '2022-11-05',
    );
    expect(parseDateIso('dated as of 11 September 2022 by and among')).toBe('2022-09-11');
    // A non-month word followed by a number must not shadow the real date.
    expect(parseDateIso('Section 5 November 2022')).toBe('2022-11-05');
  });

  it('resolves a bare numeric date US month-first and flags it ambiguous', () => {
    expect(parseDate('11/5/2022')).toEqual({ iso: '2022-11-05', ambiguous: true });
    expect(parseDate('03/04/2024')).toEqual({ iso: '2024-03-04', ambiguous: true });
    expect(parseDate('3.4.2024')).toEqual({ iso: '2024-03-04', ambiguous: true });
    expect(parseDate('11-5-2022')).toEqual({ iso: '2022-11-05', ambiguous: true });
  });

  it('is not ambiguous when only one reading is possible', () => {
    expect(parseDate('25/03/2024')).toEqual({ iso: '2024-03-25', ambiguous: false });
    expect(parseDate('11/25/2022')).toEqual({ iso: '2022-11-25', ambiguous: false });
  });

  it('expands two-digit years on the conventional 50-year pivot', () => {
    expect(parseDateIso('11/5/22')).toBe('2022-11-05');
    expect(parseDateIso('11/5/99')).toBe('1999-11-05');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseDate('February 30, 2022')).toBeNull();
    expect(parseDate('2022-02-29')).toBeNull();
    expect(parseDate('13/45/2024')).toBeNull();
    expect(parseDateIso('2024-02-29')).toBe('2024-02-29');
  });

  it('returns null rather than guessing', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
    expect(parseDate('sometime next quarter')).toBeNull();
    expect(parseDate('the Effective Date')).toBeNull();
  });

  it('does not find a date inside a longer run of digits', () => {
    expect(parseDate('invoice 120221105999')).toBeNull();
  });
});

describe('isIsoDate', () => {
  it('accepts only a real, zero-padded ISO date', () => {
    expect(isIsoDate('2022-11-05')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(isIsoDate('2022-11-5')).toBe(false);
    expect(isIsoDate('11/5/2022')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe('parseDuration', () => {
  it('reads plain durations', () => {
    expect(parseDuration('5 years')).toEqual({ kind: 'fixed', days: 1825, unit: 'year', count: 5 });
    expect(parseDuration('90 days')).toEqual({ kind: 'fixed', days: 90, unit: 'day', count: 90 });
    expect(parseDuration('3 weeks')).toEqual({ kind: 'fixed', days: 21, unit: 'week', count: 3 });
    expect(parseDuration('18 months')).toEqual({
      kind: 'fixed',
      days: 540,
      unit: 'month',
      count: 18,
    });
    expect(parseDuration('1 year')).toEqual({ kind: 'fixed', days: 365, unit: 'year', count: 1 });
  });

  it('prefers the parenthesised numeral drafters write', () => {
    expect(parseDuration('five (5) years')?.count).toBe(5);
    expect(parseDuration('twenty-four (24) months')?.count).toBe(24);
    expect(parseDuration('one (1) year')?.count).toBe(1);
    expect(parseDuration('ninety (90) days')?.count).toBe(90);
    expect(parseDuration('a period of three (3) years from the Effective Date')?.count).toBe(3);
  });

  it('reads spelled-out numbers with no numeral at all', () => {
    expect(parseDuration('ninety days')?.count).toBe(90);
    expect(parseDuration('five years')?.count).toBe(5);
    expect(parseDuration('twenty-four months')?.count).toBe(24);
    expect(parseDuration('twenty four months')?.count).toBe(24);
    expect(parseDuration('a term of one year')?.count).toBe(1);
  });

  it('recognises a perpetual obligation', () => {
    for (const s of [
      'perpetual',
      'in perpetuity',
      'indefinite',
      'indefinitely',
      'survives in perpetuity',
      'forever',
    ]) {
      expect(parseDuration(s)).toEqual({ kind: 'perpetual', days: null, unit: null, count: null });
    }
  });

  it('returns null when nothing quantifiable is present', () => {
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('until terminated')).toBeNull();
    expect(parseDuration('5')).toBeNull();
    expect(parseDuration('years')).toBeNull();
    expect(parseDuration('zero years')).toBeNull();
  });

  it('reads the first term in a clause that mentions two', () => {
    expect(parseDuration('a term of five (5) years, renewable for ten (10) years')?.count).toBe(5);
  });
});

describe('addDuration', () => {
  it('moves the calendar, not a day count', () => {
    expect(addDuration('2022-11-05', parseDuration('5 years'))).toBe('2027-11-05');
    expect(addDuration('2024-01-14', parseDuration('3 years'))).toBe('2027-01-14');
    expect(addDuration('2022-11-05', parseDuration('24 months'))).toBe('2024-11-05');
    expect(addDuration('2022-12-15', parseDuration('1 month'))).toBe('2023-01-15');
  });

  it('clamps to the last day of the target month', () => {
    expect(addDuration('2024-02-29', parseDuration('1 year'))).toBe('2025-02-28');
    expect(addDuration('2024-02-29', parseDuration('4 years'))).toBe('2028-02-29');
    expect(addDuration('2022-01-31', parseDuration('1 month'))).toBe('2022-02-28');
    expect(addDuration('2024-01-31', parseDuration('1 month'))).toBe('2024-02-29');
    expect(addDuration('2023-11-30', parseDuration('3 months'))).toBe('2024-02-29');
    expect(addDuration('2022-08-31', parseDuration('1 month'))).toBe('2022-09-30');
  });

  it('adds days and weeks exactly', () => {
    expect(addDuration('2022-11-05', parseDuration('90 days'))).toBe('2023-02-03');
    expect(addDuration('2026-07-02', parseDuration('90 days'))).toBe('2026-09-30');
    expect(addDuration('2024-02-27', parseDuration('3 days'))).toBe('2024-03-01');
    expect(addDuration('2023-02-27', parseDuration('3 days'))).toBe('2023-03-02');
    expect(addDuration('2022-11-05', parseDuration('2 weeks'))).toBe('2022-11-19');
  });

  it('accepts the verbatim term phrase as well as a parsed duration', () => {
    expect(addDuration('2022-11-05', '5 years')).toBe('2027-11-05');
    expect(addDuration('2022-11-05', 'five (5) years')).toBe('2027-11-05');
  });

  it('has no answer for perpetual or for missing inputs', () => {
    expect(addDuration('2022-11-05', parseDuration('in perpetuity'))).toBeNull();
    expect(addDuration('2022-11-05', null)).toBeNull();
    expect(addDuration('2022-11-05', 'until terminated')).toBeNull();
    expect(addDuration(null, parseDuration('5 years'))).toBeNull();
    expect(addDuration('not a date', parseDuration('5 years'))).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts whole days with no timezone drift', () => {
    expect(daysBetween('2022-11-05', '2022-11-06')).toBe(1);
    expect(daysBetween('2022-11-05', '2022-11-05')).toBe(0);
    expect(daysBetween('2022-11-06', '2022-11-05')).toBe(-1);
    expect(daysBetween('2022-11-05', '2027-11-05')).toBe(1826);
  });

  it('survives the DST boundary in both hemispheres', () => {
    // US spring forward is 2024-03-10; a naive local-time subtraction loses an hour.
    expect(daysBetween('2024-03-01', '2024-04-01')).toBe(31);
    expect(daysBetween('2024-03-09', '2024-03-11')).toBe(2);
    // Southern hemisphere shift back.
    expect(daysBetween('2024-04-06', '2024-04-08')).toBe(2);
  });

  it('counts leap days', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2023-02-28', '2023-03-01')).toBe(1);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366);
    expect(daysBetween('2023-01-01', '2024-01-01')).toBe(365);
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2022-12-31', 1)).toBe('2023-01-01');
    expect(addDays('2023-01-01', -1)).toBe('2022-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
  });
});

describe('calendar facts', () => {
  it('knows the leap rule including the century exceptions', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
  });

  it('knows month lengths', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2024, 4)).toBe(30);
    expect(daysInMonth(2024, 12)).toBe(31);
  });
});

describe('formatting', () => {
  it('renders the two forms the UI uses', () => {
    expect(formatDate('2022-11-05')).toBe('November 5, 2022');
    expect(formatShort('2022-11-05')).toBe('Nov 5 2022');
    expect(formatDate('2024-01-14')).toBe('January 14, 2024');
    expect(formatShort('2026-09-30')).toBe('Sep 30 2026');
  });

  it('renders nothing rather than "Invalid Date"', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('not a date')).toBe('');
    expect(formatShort(null)).toBe('');
  });

  it('renders a duration', () => {
    expect(formatDuration(parseDuration('5 years'))).toBe('5 years');
    expect(formatDuration(parseDuration('1 year'))).toBe('1 year');
    expect(formatDuration(parseDuration('in perpetuity'))).toBe('Perpetual');
    expect(formatDuration(null)).toBe('');
  });
});

describe('todayIso', () => {
  it('renders the injected local date, zero-padded', () => {
    expect(todayIso(new Date(2022, 10, 5, 23, 59))).toBe('2022-11-05');
    expect(todayIso(new Date(2024, 0, 1, 0, 0))).toBe('2024-01-01');
    expect(isIsoDate(todayIso())).toBe(true);
  });
});

describe('clockAnchor - which date a survival period runs from', () => {
  // Found on a real Octillion evaluation agreement: "7 years after termination"
  // computed from the effective date gave 2031 where the answer is 2033. Two years
  // wrong, silently, on the field that answers "are we still bound?".
  const cases: { quote: string; anchor: 'effective' | 'termination'; why: string }[] = [
    {
      quote: 'The obligations of confidentiality survive for 7 years after termination of this Agreement',
      anchor: 'termination',
      why: 'runs from termination, not signing',
    },
    {
      quote: 'shall survive for five (5) years from the Effective Date',
      anchor: 'effective',
      why: 'explicitly anchored to the effective date',
    },
    {
      quote:
        'The obligations set out in Section 3 continue for 36 months from the Effective Date and survive expiration or termination of this Agreement.',
      anchor: 'effective',
      why: 'the duration is effective-anchored; "survive termination" is a survival clause, not the anchor',
    },
    {
      quote: 'survive for 5 years following the expiration or earlier termination hereof',
      anchor: 'termination',
      why: '"following ... termination" is the anchor',
    },
    {
      quote: 'shall remain confidential for a period of three (3) years after the date of termination',
      anchor: 'termination',
      why: '"after the date of termination"',
    },
  ];

  for (const c of cases) {
    it(`${c.anchor}: ${c.why}`, () => {
      expect(clockAnchor(c.quote)).toBe(c.anchor);
    });
  }

  it('defaults to effective when there is no quote to read', () => {
    expect(clockAnchor(null)).toBe('effective');
    expect(clockAnchor('')).toBe('effective');
  });

  it('resolves the Octillion case to 2033, not 2031', () => {
    const termination = resolveEndDate({ effective: '2024-03-14', term: '2 years' }).iso;
    expect(termination).toBe('2026-03-14');
    // 7 years after TERMINATION
    expect(resolveEndDate({ effective: termination, term: '7 years' }).iso).toBe('2033-03-14');
    // the wrong answer the bug produced, kept here so a regression is obvious
    expect(resolveEndDate({ effective: '2024-03-14', term: '7 years' }).iso).toBe('2031-03-14');
  });
});
