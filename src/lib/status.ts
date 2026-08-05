/**
 * Expiry, computed. Never read from a stored column.
 *
 * A status written to disk is correct exactly once. The day after, the row still
 * says "Active" and nobody notices until an NDA has already lapsed -- which is
 * the whole reason this app exists. So the only status in the product is the one
 * derived here, at read time, from the dates plus today.
 *
 * `today` is a parameter, not a call to Date.now() buried three frames deep, so
 * every one of these branches is testable.
 */

// Relative, matching providers/types.ts: intra-lib imports must resolve under
// vitest as well as under the Next bundler, and vitest does not read tsconfig paths.
import { daysBetween, isIsoDate, todayIso } from './util/dates';

export type AgreementStatus = 'active' | 'expiring' | 'expired' | 'unknown';

/** Inside this many days of the end date, the repository calls it expiring. */
export const EXPIRING_WINDOW_DAYS = 90;

export interface StatusResult {
  status: AgreementStatus;
  /** Whole days from today until the end date. Negative once past. Null when unknown. */
  daysRemaining: number | null;
}

const UNKNOWN: StatusResult = { status: 'unknown', daysRemaining: null };

/**
 * Status of the agreement itself.
 *
 * No end date means unknown, not active: a perpetual term and an unparseable
 * term are both "we cannot say", and pretending otherwise is how a lapsed
 * agreement hides in the Active filter. `effectiveDate` is accepted so a record
 * dated in the future reads honestly rather than as already running.
 */
export function agreementStatus(
  effectiveDate: string | null | undefined,
  terminationDate: string | null | undefined,
  today: string = todayIso(),
): StatusResult {
  return windowStatus(effectiveDate, terminationDate, today);
}

/**
 * Status of the confidentiality obligation -- its own clock. Her Eval Agmt row is
 * the case: a 90-day term with a 5-year duty of confidence, so the agreement is
 * expired while the obligation still runs.
 */
export function confidentialityStatus(
  effectiveDate: string | null | undefined,
  confidentialityEnd: string | null | undefined,
  today: string = todayIso(),
): StatusResult {
  return windowStatus(effectiveDate, confidentialityEnd, today);
}

function windowStatus(
  start: string | null | undefined,
  end: string | null | undefined,
  today: string,
): StatusResult {
  if (!end || !isIsoDate(end)) return UNKNOWN;
  if (!isIsoDate(today)) return UNKNOWN;

  const daysRemaining = daysBetween(today, end);

  // A date that has passed is expired regardless of what the start date says.
  if (daysRemaining < 0) return { status: 'expired', daysRemaining };

  // Not started yet. It is a real, countable window, so report the days, but do
  // not colour it amber -- there is nothing to renew.
  if (start && isIsoDate(start) && daysBetween(today, start) > 0) {
    return { status: 'active', daysRemaining };
  }

  if (daysRemaining <= EXPIRING_WINDOW_DAYS) return { status: 'expiring', daysRemaining };
  return { status: 'active', daysRemaining };
}

/** Sort/filter order that puts what needs attention first. */
export const STATUS_ORDER: Record<AgreementStatus, number> = {
  expiring: 0,
  expired: 1,
  active: 2,
  unknown: 3,
};

export const STATUS_LABELS: Record<AgreementStatus, string> = {
  active: 'Active',
  expiring: 'Expiring',
  expired: 'Expired',
  unknown: 'Unknown',
};

/** "63 days" / "Expired 12 days ago" / "Nov 5 2027". The table's STATUS cell. */
export function statusDetail(r: StatusResult): string {
  if (r.status === 'unknown' || r.daysRemaining == null) return 'Unknown';
  if (r.status === 'expired') {
    const n = Math.abs(r.daysRemaining);
    return n === 0 ? 'Expired today' : `Expired ${n} day${n === 1 ? '' : 's'} ago`;
  }
  if (r.status === 'expiring') {
    return r.daysRemaining === 0
      ? 'Expires today'
      : `${r.daysRemaining} day${r.daysRemaining === 1 ? '' : 's'}`;
  }
  return 'Active';
}
