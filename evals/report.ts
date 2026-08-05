/**
 * The result model and the printer.
 *
 * The runner's job is to produce one number Bonnie can hold in her head. Everything here
 * exists to make that number honest: skipped assertions are never counted as passes, and a
 * case that could not run says so instead of quietly contributing zero.
 */

export interface Assertion {
  /** Dotted id, e.g. "octillion.term" or "addDuration.leap-day-clamp". */
  id: string;
  ok: boolean;
  /** Present when !ok. Must name both the expected and the actual value. */
  detail?: string;
  /** True when the assertion could not be evaluated at all. Never counted either way. */
  skipped?: boolean;
  skipReason?: string;
  /** Counts toward field-level accuracy (one of the 16 tracker fields). */
  field?: boolean;
}

export type CaseStatus = 'pass' | 'fail' | 'skip';

export interface CaseResult {
  name: string;
  title: string;
  status: CaseStatus;
  /** Why the whole case did not run. */
  skipReason?: string;
  assertions: Assertion[];
  /** Real spend, live cases only. */
  costUsd: number | null;
  durationMs: number;
  /** True for cases that only run under --live. */
  live: boolean;
}

export interface CaseContext {
  live: boolean;
  /** Frozen "today" so status assertions never depend on the wall clock. */
  today: string;
  verbose: boolean;
  /** Fixture ids to restrict a live run to. Null means every fixture. */
  fixtures: string[] | null;
}

export type CaseFn = (ctx: CaseContext) => Promise<CaseResult>;

export interface CaseDef {
  name: string;
  title: string;
  /** What this case proves. Printed by --list. */
  proves: string;
  live: boolean;
  run: CaseFn;
}

/* ─────────────────────────── building results ────────────────────────── */

export class CaseRun {
  readonly assertions: Assertion[] = [];
  readonly name: string;
  readonly title: string;
  readonly live: boolean;
  private readonly startedAt = Date.now();
  private wholeCaseSkip: string | null = null;
  costUsd: number | null = null;

  // Written out longhand rather than as parameter properties: `node
  // --experimental-strip-types` refuses those, and this file has to run under it.
  constructor(name: string, title: string, live = false) {
    this.name = name;
    this.title = title;
    this.live = live;
  }

  /** Record a pass/fail. `detail` is only read when the assertion fails. */
  ok(id: string, condition: boolean, detail: () => string, opts: { field?: boolean } = {}): void {
    this.assertions.push({
      id,
      ok: condition,
      ...(condition ? {} : { detail: detail() }),
      ...(opts.field ? { field: true } : {}),
    });
  }

  eq<T>(id: string, actual: T, expected: T, opts: { field?: boolean } = {}): void {
    this.ok(id, actual === expected, () => `expected ${show(expected)}, got ${show(actual)}`, opts);
  }

  /** An assertion that could not be evaluated. Counted as neither pass nor fail. */
  skipAssertion(id: string, reason: string): void {
    this.assertions.push({ id, ok: true, skipped: true, skipReason: reason });
  }

  /** The whole case could not run: a module is not built yet, or no engine is available. */
  skipCase(reason: string): void {
    this.wholeCaseSkip = reason;
  }

  finish(): CaseResult {
    const failed = this.assertions.some((a) => !a.skipped && !a.ok);
    const ran = this.assertions.filter((a) => !a.skipped);
    const status: CaseStatus = failed
      ? 'fail'
      : this.wholeCaseSkip !== null || ran.length === 0
        ? 'skip'
        : 'pass';
    return {
      name: this.name,
      title: this.title,
      status,
      ...(this.wholeCaseSkip !== null ? { skipReason: this.wholeCaseSkip } : {}),
      assertions: this.assertions,
      costUsd: this.costUsd,
      durationMs: Date.now() - this.startedAt,
      live: this.live,
    };
  }
}

export function show(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v.length > 120 ? `${v.slice(0, 117)}...` : v);
  return String(v);
}

/* ──────────────────────────── aggregation ────────────────────────────── */

export interface Totals {
  cases: number;
  casesPassed: number;
  casesFailed: number;
  casesSkipped: number;
  assertions: number;
  assertionsPassed: number;
  assertionsSkipped: number;
  fieldsCorrect: number;
  fieldsTotal: number;
  costUsd: number;
  durationMs: number;
  /** Offline failures are regressions and set the exit code. */
  offlineFailures: number;
}

export function totalsOf(results: CaseResult[]): Totals {
  const t: Totals = {
    cases: results.length,
    casesPassed: 0,
    casesFailed: 0,
    casesSkipped: 0,
    assertions: 0,
    assertionsPassed: 0,
    assertionsSkipped: 0,
    fieldsCorrect: 0,
    fieldsTotal: 0,
    costUsd: 0,
    durationMs: 0,
    offlineFailures: 0,
  };
  for (const r of results) {
    if (r.status === 'pass') t.casesPassed++;
    else if (r.status === 'fail') {
      t.casesFailed++;
      if (!r.live) t.offlineFailures++;
    } else t.casesSkipped++;
    t.durationMs += r.durationMs;
    t.costUsd += r.costUsd ?? 0;
    for (const a of r.assertions) {
      if (a.skipped) {
        t.assertionsSkipped++;
        continue;
      }
      t.assertions++;
      if (a.ok) t.assertionsPassed++;
      if (a.field) {
        t.fieldsTotal++;
        if (a.ok) t.fieldsCorrect++;
      }
    }
  }
  return t;
}

/* ───────────────────────────── rendering ─────────────────────────────── */

const COLOUR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: string, s: string): string {
  return COLOUR ? `\u001b[${code}m${s}\u001b[0m` : s;
}

const green = (s: string) => paint('32', s);
const red = (s: string) => paint('31', s);
const yellow = (s: string) => paint('33', s);
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);

function badge(status: CaseStatus): string {
  if (status === 'pass') return green('PASS');
  if (status === 'fail') return red('FAIL');
  return yellow('SKIP');
}

function pad(s: string, width: number): string {
  // Padding is computed on the unpainted length, so colour never breaks alignment.
  const visible = s.replace(/\u001b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, width - visible.length));
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
}

export function renderTable(results: CaseResult[]): string {
  const rows = results.map((r) => {
    const ran = r.assertions.filter((a) => !a.skipped);
    const passed = ran.filter((a) => a.ok).length;
    const fields = r.assertions.filter((a) => a.field && !a.skipped);
    const fieldsPassed = fields.filter((a) => a.ok).length;
    return {
      name: r.name,
      status: badge(r.status),
      checks: ran.length === 0 ? dim('-') : `${passed}/${ran.length}`,
      fields: fields.length === 0 ? dim('-') : `${fieldsPassed}/${fields.length}`,
      cost: r.costUsd === null ? dim('-') : `$${r.costUsd.toFixed(4)}`,
      time: ms(r.durationMs),
      note: r.skipReason ?? '',
    };
  });
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    checks: Math.max(6, ...rows.map((r) => r.checks.length)),
    fields: Math.max(6, ...rows.map((r) => r.fields.length)),
    cost: Math.max(5, ...rows.map((r) => r.cost.length)),
    time: Math.max(4, ...rows.map((r) => r.time.length)),
  };
  const head = [
    pad('CASE', w.name),
    pad('     ', 4),
    pad('CHECKS', w.checks),
    pad('FIELDS', w.fields),
    pad('COST', w.cost),
    pad('TIME', w.time),
  ].join('  ');
  const lines = [dim(head)];
  for (const r of rows) {
    lines.push(
      [
        pad(r.name, w.name),
        pad(r.status, 4),
        pad(r.checks, w.checks),
        pad(r.fields, w.fields),
        pad(r.cost, w.cost),
        pad(r.time, w.time),
        r.note === '' ? '' : dim(r.note),
      ]
        .join('  ')
        .trimEnd(),
    );
  }
  return lines.join('\n');
}

/**
 * Failures grouped by the family of their id, showing a couple of examples each.
 *
 * One root cause routinely fails thirty assertions. A flat list of thirty lines reads as
 * thirty problems and buries the other two, so the group counts stay visible and the
 * examples stay few.
 */
export function renderFailures(results: CaseResult[], examplesPerGroup = 2): string {
  const out: string[] = [];
  for (const r of results) {
    const bad = r.assertions.filter((a) => !a.skipped && !a.ok);
    if (bad.length === 0) continue;
    out.push('', red(`${r.name} - ${r.title}`));

    const groups = new Map<string, Assertion[]>();
    for (const a of bad) {
      const key = a.id.split('.').slice(0, 2).join('.');
      const bucket = groups.get(key);
      if (bucket) bucket.push(a);
      else groups.set(key, [a]);
    }

    for (const [key, members] of groups) {
      const head = members.length === 1 ? '' : dim(`  (${members.length} of these)`);
      out.push(`  ${red('x')} ${key}${head}`);
      for (const a of members.slice(0, examplesPerGroup)) {
        out.push(`      ${dim(a.id)}  ${a.detail ?? ''}`);
      }
      if (members.length > examplesPerGroup) {
        out.push(dim(`      ...and ${members.length - examplesPerGroup} more`));
      }
    }
  }
  return out.join('\n');
}

export function renderHeadline(t: Totals, opts: { live: boolean }): string {
  const pct = t.fieldsTotal === 0 ? 0 : (t.fieldsCorrect / t.fieldsTotal) * 100;
  const accuracy = `field-level accuracy: ${t.fieldsCorrect}/${t.fieldsTotal} (${pct.toFixed(1)}%)`;
  const checks = `checks: ${t.assertionsPassed}/${t.assertions} passed`;
  const cases = `cases: ${t.casesPassed} passed, ${t.casesFailed} failed, ${t.casesSkipped} skipped`;
  const lines = [
    '',
    bold(t.offlineFailures === 0 ? green(accuracy) : red(accuracy)),
    dim(`${checks}  |  ${cases}`),
  ];
  if (t.assertionsSkipped > 0) {
    lines.push(dim(`${t.assertionsSkipped} checks skipped (module not built, or no engine)`));
  }
  if (opts.live) lines.push(dim(`spend this run: $${t.costUsd.toFixed(4)}`));
  if (!opts.live) lines.push(dim('offline run - no engine was called, nothing was spent'));
  return lines.join('\n');
}

export interface JsonReport {
  generatedAt: string;
  live: boolean;
  today: string;
  totals: Totals;
  fieldAccuracy: number;
  cases: CaseResult[];
}

export function toJson(results: CaseResult[], ctx: CaseContext): JsonReport {
  const totals = totalsOf(results);
  return {
    generatedAt: new Date().toISOString(),
    live: ctx.live,
    today: ctx.today,
    totals,
    fieldAccuracy: totals.fieldsTotal === 0 ? 0 : totals.fieldsCorrect / totals.fieldsTotal,
    cases: results,
  };
}
