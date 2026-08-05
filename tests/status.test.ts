import { describe, expect, it } from 'vitest';

import {
  EXPIRING_WINDOW_DAYS,
  STATUS_LABELS,
  STATUS_ORDER,
  agreementStatus,
  confidentialityStatus,
  statusDetail,
} from '../src/lib/status';
import { addDays, addDuration, parseDuration } from '../src/lib/util/dates';

const TODAY = '2026-07-29';

describe('EXPIRING_WINDOW_DAYS', () => {
  it('is the 90 days the repository filter promises', () => {
    expect(EXPIRING_WINDOW_DAYS).toBe(90);
  });
});

describe('agreementStatus', () => {
  it('is unknown with no termination date', () => {
    expect(agreementStatus('2022-11-05', null, TODAY)).toEqual({
      status: 'unknown',
      daysRemaining: null,
    });
    expect(agreementStatus(null, null, TODAY)).toEqual({ status: 'unknown', daysRemaining: null });
    expect(agreementStatus('2022-11-05', '', TODAY)).toEqual({
      status: 'unknown',
      daysRemaining: null,
    });
  });

  it('is unknown rather than active for an unparseable end date', () => {
    expect(agreementStatus('2022-11-05', 'sometime in 2027', TODAY).status).toBe('unknown');
    expect(agreementStatus('2022-11-05', '2027-13-45', TODAY).status).toBe('unknown');
  });

  it('is expired once the date has passed', () => {
    expect(agreementStatus('2019-03-01', '2024-03-01', TODAY)).toEqual({
      status: 'expired',
      daysRemaining: -880,
    });
    expect(agreementStatus('2021-07-28', addDays(TODAY, -1), TODAY)).toEqual({
      status: 'expired',
      daysRemaining: -1,
    });
  });

  it('is expiring on the last day, not expired', () => {
    expect(agreementStatus('2021-07-29', TODAY, TODAY)).toEqual({
      status: 'expiring',
      daysRemaining: 0,
    });
  });

  it('treats the 90-day window as inclusive', () => {
    expect(agreementStatus('2020-01-01', addDays(TODAY, 89), TODAY).status).toBe('expiring');
    expect(agreementStatus('2020-01-01', addDays(TODAY, 90), TODAY).status).toBe('expiring');
    expect(agreementStatus('2020-01-01', addDays(TODAY, 91), TODAY).status).toBe('active');
  });

  it('is active well before the window', () => {
    expect(agreementStatus('2022-11-05', '2027-11-05', TODAY)).toEqual({
      status: 'active',
      daysRemaining: 464,
    });
  });

  it('does not colour a not-yet-started agreement amber', () => {
    // Signed ahead of time: starts in a month, runs 60 days. Inside 90 days of
    // its end, but there is nothing to renew yet.
    const start = addDays(TODAY, 30);
    const end = addDays(TODAY, 90);
    expect(agreementStatus(start, end, TODAY)).toEqual({ status: 'active', daysRemaining: 90 });
  });

  it('is unknown when today itself is not a date', () => {
    expect(agreementStatus('2022-11-05', '2027-11-05', 'today').status).toBe('unknown');
  });

  it('defaults today to now', () => {
    const far = agreementStatus('2020-01-01', '2099-01-01');
    expect(far.status).toBe('active');
    expect(agreementStatus('2000-01-01', '2001-01-01').status).toBe('expired');
  });
});

describe('confidentialityStatus', () => {
  it('runs on its own clock', () => {
    // Her Eval Agmt row: 90-day term, 5-year duty of confidence.
    const effective = '2026-07-02';
    const termEnd = addDuration(effective, parseDuration('90 days'));
    const confEnd = addDuration(effective, parseDuration('5 years'));
    expect(termEnd).toBe('2026-09-30');
    expect(confEnd).toBe('2031-07-02');

    const later = '2026-10-01';
    expect(agreementStatus(effective, termEnd, later).status).toBe('expired');
    expect(confidentialityStatus(effective, confEnd, later).status).toBe('active');
  });

  it('applies the same window rules', () => {
    expect(confidentialityStatus('2020-01-01', addDays(TODAY, 45), TODAY).status).toBe('expiring');
    expect(confidentialityStatus('2020-01-01', addDays(TODAY, -45), TODAY).status).toBe('expired');
    expect(confidentialityStatus('2020-01-01', null, TODAY).status).toBe('unknown');
  });

  it('is unknown for a perpetual obligation, since there is no end date', () => {
    const confEnd = addDuration('2022-11-05', parseDuration('in perpetuity'));
    expect(confEnd).toBeNull();
    expect(confidentialityStatus('2022-11-05', confEnd, TODAY).status).toBe('unknown');
  });
});

describe('statusDetail', () => {
  it('says what the table cell needs to say', () => {
    expect(statusDetail(agreementStatus('2020-01-01', addDays(TODAY, 63), TODAY))).toBe('63 days');
    expect(statusDetail(agreementStatus('2020-01-01', addDays(TODAY, 1), TODAY))).toBe('1 day');
    expect(statusDetail(agreementStatus('2020-01-01', TODAY, TODAY))).toBe('Expires today');
    expect(statusDetail(agreementStatus('2020-01-01', addDays(TODAY, -1), TODAY))).toBe(
      'Expired 1 day ago',
    );
    expect(statusDetail(agreementStatus('2020-01-01', addDays(TODAY, -12), TODAY))).toBe(
      'Expired 12 days ago',
    );
    expect(statusDetail(agreementStatus('2020-01-01', '2099-01-01', TODAY))).toBe('Active');
    expect(statusDetail(agreementStatus('2020-01-01', null, TODAY))).toBe('Unknown');
  });
});

describe('presentation tables', () => {
  it('sorts what needs attention first', () => {
    expect(STATUS_ORDER.expiring).toBeLessThan(STATUS_ORDER.expired);
    expect(STATUS_ORDER.expired).toBeLessThan(STATUS_ORDER.active);
    expect(STATUS_ORDER.active).toBeLessThan(STATUS_ORDER.unknown);
  });

  it('has a label for every status', () => {
    expect(STATUS_LABELS).toEqual({
      active: 'Active',
      expiring: 'Expiring',
      expired: 'Expired',
      unknown: 'Unknown',
    });
  });
});
