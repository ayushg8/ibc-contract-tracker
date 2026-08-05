/**
 * Every date and duration path, as a table.
 *
 * These are the functions whose bugs are invisible: a date read one day off, or a term
 * added as 365 days instead of a calendar year, produces a plausible number that nobody
 * questions until an NDA has already lapsed. So the table includes the forms that appear
 * in the fixtures, the forms that must be refused, leap years, and month-end rollover.
 */

import { CaseRun, type CaseContext, type CaseResult } from '../report';
import { load } from './_modules';

interface DateCase {
  input: string;
  /** null means "must refuse to guess". */
  iso: string | null;
  ambiguous?: boolean;
  why: string;
}

const DATE_CASES: DateCase[] = [
  { input: 'November 5, 2022', iso: '2022-11-05', why: 'US long form, the common case' },
  { input: 'effective as of November 5, 2022, between', iso: '2022-11-05', why: 'embedded in a clause' },
  { input: 'the 5th day of November, 2022', iso: '2022-11-05', why: 'word ordinal, old-style drafting' },
  { input: 'this 1st day of March, 2019', iso: '2019-03-01', why: 'word ordinal with "this"' },
  { input: 'the 29th day of February, 2024', iso: '2024-02-29', why: 'a real leap day' },
  { input: '14 January 2024', iso: '2024-01-14', why: 'day-first, no comma' },
  { input: '1st April 2025', iso: '2025-04-01', why: 'British ordinal-numeric' },
  { input: 'Jan. 9, 2023', iso: '2023-01-09', why: 'abbreviated month with a period' },
  { input: 'Sept. 8, 2021', iso: '2021-09-08', why: 'four-letter month abbreviation' },
  { input: '2025-06-30', iso: '2025-06-30', why: 'ISO in the document itself' },
  { input: 'December 31, 2027', iso: '2027-12-31', why: 'year end' },
  { input: '03/04/2024', iso: '2024-03-04', ambiguous: true, why: 'ambiguous, and must say so' },
  { input: '13/04/2024', iso: '2024-04-13', ambiguous: false, why: 'day > 12 decides it, no ambiguity' },
  { input: 'February 30, 2024', iso: null, why: 'a date that does not exist' },
  { input: '2023-02-29', iso: null, why: '2023 is not a leap year' },
  { input: '2024-13-01', iso: null, why: 'month 13' },
  { input: 'sometime next spring', iso: null, why: 'no date at all' },
  { input: '', iso: null, why: 'empty input' },
];

interface DurationCase {
  input: string;
  /** null means "must refuse to guess". */
  unit: 'day' | 'week' | 'month' | 'year' | null;
  count: number | null;
  perpetual?: boolean;
  why: string;
}

const DURATION_CASES: DurationCase[] = [
  { input: 'five (5) years', unit: 'year', count: 5, why: 'the standard NDA drafting' },
  { input: '5 years', unit: 'year', count: 5, why: 'digits only' },
  { input: 'one (1) year', unit: 'year', count: 1, why: 'singular' },
  { input: 'ninety (90) days', unit: 'day', count: 90, why: 'the evaluation-agreement term' },
  { input: '90 days', unit: 'day', count: 90, why: 'digits only' },
  { input: 'twenty-four (24) months', unit: 'month', count: 24, why: 'hyphenated word number' },
  { input: '36 months', unit: 'month', count: 36, why: 'months, not years' },
  { input: 'seven (7) years', unit: 'year', count: 7, why: 'a long confidentiality tail' },
  { input: 'in perpetuity', unit: null, count: null, perpetual: true, why: 'never expires' },
  { input: 'shall survive in perpetuity with respect to any trade secret', unit: null, count: null, perpetual: true, why: 'perpetual inside a clause' },
  { input: 'indefinitely', unit: null, count: null, perpetual: true, why: 'another word for perpetual' },
  { input: 'until December 31, 2027', unit: null, count: null, why: 'an end date is not a duration' },
  { input: 'a reasonable period', unit: null, count: null, why: 'unquantifiable' },
  { input: '', unit: null, count: null, why: 'empty input' },
];

interface AddCase {
  from: string;
  term: string;
  to: string | null;
  why: string;
}

const ADD_CASES: AddCase[] = [
  { from: '2022-11-05', term: '5 years', to: '2027-11-05', why: 'the Ntrium row' },
  { from: '2026-07-02', term: 'ninety (90) days', to: '2026-09-30', why: 'the Octillion row, day arithmetic' },
  { from: '2024-02-29', term: 'one (1) year', to: '2025-02-28', why: 'leap day clamps to Feb 28' },
  { from: '2024-02-29', term: 'three (3) years', to: '2027-02-28', why: 'leap day, three years on' },
  { from: '2022-01-31', term: '1 month', to: '2022-02-28', why: 'month-end rollover clamps' },
  { from: '2024-01-31', term: '1 month', to: '2024-02-29', why: 'month-end into a leap February' },
  { from: '2024-01-31', term: '13 months', to: '2025-02-28', why: 'more than a year in months' },
  { from: '2019-03-01', term: 'five (5) years', to: '2024-03-01', why: 'spans two leap years' },
  { from: '2025-06-30', term: 'twenty-four (24) months', to: '2027-06-30', why: 'months across two years' },
  { from: '2026-12-15', term: '30 days', to: '2027-01-14', why: 'days across a year boundary' },
  { from: '2024-02-28', term: '1 day', to: '2024-02-29', why: 'the leap day itself' },
  { from: '2019-03-01', term: 'in perpetuity', to: null, why: 'perpetual has no end date' },
];

export async function runCase(_ctx: CaseContext): Promise<CaseResult> {
  const run = new CaseRun('dates', 'Date and duration arithmetic');
  const { mod: dates, reason } = await load('dates');
  if (!dates) {
    run.skipCase(reason ?? 'dates module unavailable');
    return run.finish();
  }

  for (const c of DATE_CASES) {
    const parsed = dates.parseDate(c.input);
    const iso = parsed === null ? null : parsed.iso;
    run.ok(
      `parseDate.${slug(c.input)}`,
      iso === c.iso,
      () => `${JSON.stringify(c.input)} (${c.why}): expected ${c.iso}, got ${iso}`,
    );
    if (c.ambiguous !== undefined && parsed !== null) {
      run.ok(
        `parseDate.ambiguity.${slug(c.input)}`,
        parsed.ambiguous === c.ambiguous,
        () =>
          `${JSON.stringify(c.input)}: expected ambiguous=${c.ambiguous}, got ${parsed.ambiguous}`,
      );
    }
  }

  // parseDateIso is what the rest of the app calls; it must agree with parseDate.
  for (const c of DATE_CASES) {
    run.ok(
      `parseDateIso.${slug(c.input)}`,
      dates.parseDateIso(c.input) === c.iso,
      () => `${JSON.stringify(c.input)}: expected ${c.iso}, got ${dates.parseDateIso(c.input)}`,
    );
  }

  for (const c of DURATION_CASES) {
    const d = dates.parseDuration(c.input);
    if (c.perpetual === true) {
      run.ok(
        `parseDuration.${slug(c.input)}`,
        d !== null && d.kind === 'perpetual',
        () => `${JSON.stringify(c.input)} (${c.why}): expected perpetual, got ${JSON.stringify(d)}`,
      );
      continue;
    }
    if (c.unit === null) {
      run.ok(
        `parseDuration.${slug(c.input)}`,
        d === null,
        () => `${JSON.stringify(c.input)} (${c.why}): expected null, got ${JSON.stringify(d)}`,
      );
      continue;
    }
    run.ok(
      `parseDuration.${slug(c.input)}`,
      d !== null && d.unit === c.unit && d.count === c.count,
      () =>
        `${JSON.stringify(c.input)} (${c.why}): expected ${c.count} ${c.unit}, got ${JSON.stringify(d)}`,
    );
  }

  for (const c of ADD_CASES) {
    const got = dates.addDuration(c.from, dates.parseDuration(c.term));
    run.ok(
      `addDuration.${c.from}.${slug(c.term)}`,
      got === c.to,
      () => `${c.from} + ${c.term} (${c.why}): expected ${c.to}, got ${got}`,
    );
  }

  run.eq('addDuration.null-date', dates.addDuration(null, dates.parseDuration('5 years')), null);
  run.eq('addDuration.null-duration', dates.addDuration('2022-11-05', null), null);
  run.eq('addDuration.bad-date', dates.addDuration('05/11/2022', dates.parseDuration('1 year')), null);

  run.eq('daysBetween.forward', dates.daysBetween('2026-07-02', '2026-09-30'), 90);
  run.eq('daysBetween.backward', dates.daysBetween('2026-09-30', '2026-07-02'), -90);
  run.eq('daysBetween.same-day', dates.daysBetween('2026-07-02', '2026-07-02'), 0);
  run.eq('daysBetween.across-leap', dates.daysBetween('2024-02-28', '2024-03-01'), 2);
  run.eq('daysBetween.across-non-leap', dates.daysBetween('2023-02-28', '2023-03-01'), 1);
  run.eq('daysBetween.five-years', dates.daysBetween('2022-11-05', '2027-11-05'), 1826);

  run.eq('addDays.forward', dates.addDays('2026-12-15', 30), '2027-01-14');
  run.eq('addDays.backward', dates.addDays('2027-01-14', -30), '2026-12-15');

  run.eq('isLeapYear.2024', dates.isLeapYear(2024), true);
  run.eq('isLeapYear.2023', dates.isLeapYear(2023), false);
  run.eq('isLeapYear.1900', dates.isLeapYear(1900), false);
  run.eq('isLeapYear.2000', dates.isLeapYear(2000), true);
  run.eq('daysInMonth.feb-leap', dates.daysInMonth(2024, 2), 29);
  run.eq('daysInMonth.feb-common', dates.daysInMonth(2023, 2), 28);
  run.eq('daysInMonth.april', dates.daysInMonth(2024, 4), 30);

  run.eq('isIsoDate.valid', dates.isIsoDate('2022-11-05'), true);
  run.eq('isIsoDate.impossible-day', dates.isIsoDate('2023-02-29'), false);
  run.eq('isIsoDate.us-form', dates.isIsoDate('11/05/2022'), false);
  run.eq('isIsoDate.null', dates.isIsoDate(null), false);

  // Timezone independence: the formatter must never shift the day.
  run.eq('formatDate.no-tz-shift', dates.formatDate('2022-11-05'), 'November 5, 2022');
  run.eq('formatDate.null', dates.formatDate(null), '');
  run.eq('formatShort.no-comma', dates.formatShort('2022-11-05'), 'Nov 5 2022');

  return run.finish();
}

function slug(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base === '' ? 'empty' : base.slice(0, 44);
}
