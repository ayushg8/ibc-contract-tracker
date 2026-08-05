/**
 * Two clocks, four states, and the boundaries between them.
 *
 * The number Bonnie acts on is "days remaining", and the colour she scans for is the
 * 90-day amber. Both come from here, so every edge gets an explicit row: the day before
 * the window opens, the first day inside it, the termination date itself, and the day
 * after. `today` is always passed in, never read from the clock.
 */

import { ALL_FIXTURES, daysBetweenIso } from '../fixtures/index';
import { CaseRun, type CaseContext, type CaseResult } from '../report';
import { load } from './_modules';

const TODAY = '2026-07-29';

/** Independent oracle: what the status must be, computed from first principles. */
function oracle(end: string | null, today: string): { status: string; daysRemaining: number | null } {
  if (end === null) return { status: 'unknown', daysRemaining: null };
  const days = daysBetweenIso(today, end);
  if (days < 0) return { status: 'expired', daysRemaining: days };
  if (days <= 90) return { status: 'expiring', daysRemaining: days };
  return { status: 'active', daysRemaining: days };
}

export async function runCase(ctx: CaseContext): Promise<CaseResult> {
  const run = new CaseRun('status', 'Agreement and confidentiality status at the boundaries');
  const { mod: status, reason } = await load('status');
  if (!status) {
    run.skipCase(reason ?? 'status module unavailable');
    return run.finish();
  }
  const today = ctx.today === '' ? TODAY : ctx.today;
  const effective = '2020-01-01';

  run.eq('window.is-90-days', status.EXPIRING_WINDOW_DAYS, 90);

  const boundaries: { offset: number; expected: string; why: string }[] = [
    { offset: 400, expected: 'active', why: 'far from expiry' },
    { offset: 92, expected: 'active', why: 'two days outside the window' },
    { offset: 91, expected: 'active', why: 'one day outside the window' },
    { offset: 90, expected: 'expiring', why: 'the first day inside the window' },
    { offset: 89, expected: 'expiring', why: 'inside the window' },
    { offset: 1, expected: 'expiring', why: 'tomorrow' },
    { offset: 0, expected: 'expiring', why: 'the termination date itself is not yet expired' },
    { offset: -1, expected: 'expired', why: 'one day after termination' },
    { offset: -400, expected: 'expired', why: 'long gone' },
  ];

  for (const b of boundaries) {
    const end = shift(today, b.offset);
    const agreement = status.agreementStatus(effective, end, today);
    run.ok(
      `agreement.day${b.offset}`,
      agreement.status === b.expected && agreement.daysRemaining === b.offset,
      () =>
        `${b.offset} days out (${b.why}): expected ${b.expected}/${b.offset}, got ${agreement.status}/${agreement.daysRemaining}`,
    );
    const conf = status.confidentialityStatus(effective, end, today);
    run.ok(
      `confidentiality.day${b.offset}`,
      conf.status === b.expected && conf.daysRemaining === b.offset,
      () =>
        `${b.offset} days out (${b.why}): expected ${b.expected}/${b.offset}, got ${conf.status}/${conf.daysRemaining}`,
    );
  }

  run.eq('agreement.no-end-date', status.agreementStatus(effective, null, today).status, 'unknown');
  run.eq(
    'agreement.no-end-date-days',
    status.agreementStatus(effective, null, today).daysRemaining,
    null,
  );
  run.eq('agreement.unparseable-end', status.agreementStatus(effective, 'soon', today).status, 'unknown');
  // Perpetual confidentiality has no end date, so it reads as unknown rather than active.
  // The verbatim term ("in perpetuity") is what the UI shows; this is the deliberate
  // reading of a four-state enum that has no "perpetual" member.
  run.eq(
    'confidentiality.perpetual-is-unknown',
    status.confidentialityStatus(effective, null, today).status,
    'unknown',
  );

  // A record dated in the future is running, not expiring: there is nothing to renew.
  const futureStart = shift(today, 30);
  const futureEnd = shift(today, 60);
  run.eq(
    'agreement.not-started-yet',
    status.agreementStatus(futureStart, futureEnd, today).status,
    'active',
  );

  // The case the product exists for: expired agreement, live confidentiality obligation.
  const twoClocks = status;
  run.eq('two-clocks.agreement', twoClocks.agreementStatus('2026-07-02', '2026-09-30', '2026-12-01').status, 'expired');
  run.eq(
    'two-clocks.confidentiality',
    twoClocks.confidentialityStatus('2026-07-02', '2031-07-02', '2026-12-01').status,
    'active',
  );

  // Every fixture, both clocks, against the independent oracle.
  for (const f of ALL_FIXTURES) {
    const wantAgreement = oracle(f.computed.terminationDate, today);
    const gotAgreement = status.agreementStatus(f.expected.effective_date, f.computed.terminationDate, today);
    run.ok(
      `fixture.${f.id}.agreement`,
      gotAgreement.status === wantAgreement.status &&
        gotAgreement.daysRemaining === wantAgreement.daysRemaining,
      () =>
        `${f.id}: expected ${wantAgreement.status}/${wantAgreement.daysRemaining}, got ${gotAgreement.status}/${gotAgreement.daysRemaining}`,
    );
    const wantConf = oracle(f.computed.confidentialityEnd, today);
    const gotConf = status.confidentialityStatus(
      f.expected.effective_date,
      f.computed.confidentialityEnd,
      today,
    );
    run.ok(
      `fixture.${f.id}.confidentiality`,
      gotConf.status === wantConf.status && gotConf.daysRemaining === wantConf.daysRemaining,
      () =>
        `${f.id}: expected ${wantConf.status}/${wantConf.daysRemaining}, got ${gotConf.status}/${gotConf.daysRemaining}`,
    );
  }

  // The labels and the sort order are part of the contract the table reads.
  for (const key of ['active', 'expiring', 'expired', 'unknown'] as const) {
    run.ok(
      `labels.${key}`,
      typeof status.STATUS_LABELS[key] === 'string' && status.STATUS_LABELS[key].length > 0,
      () => `STATUS_LABELS.${key} is empty`,
    );
    run.ok(
      `order.${key}`,
      Number.isFinite(status.STATUS_ORDER[key]),
      () => `STATUS_ORDER.${key} is not a number`,
    );
  }
  run.ok(
    'order.expiring-before-active',
    status.STATUS_ORDER.expiring < status.STATUS_ORDER.active,
    () => 'the table must be able to sort what needs attention to the top',
  );

  const detail = status.statusDetail(status.agreementStatus(effective, shift(today, 63), today));
  run.ok(
    'detail.mentions-days',
    /63/.test(detail),
    () => `statusDetail for 63 days remaining should name the number, got ${JSON.stringify(detail)}`,
  );

  return run.finish();
}

/** Local day shift, so the boundary table does not depend on the module under test. */
function shift(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
