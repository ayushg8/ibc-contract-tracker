/**
 * The gates a candidate fix must pass before it goes anywhere near the live install.
 *
 * The whole file is written against one rule: an exit code is a claim, not
 * evidence. Every gate here has a way of exiting 0 while having proved nothing --
 *
 *   * `vitest run` exits 0 when it matches no test files at all, and the app's
 *     tests are excluded from the .app bundle, so this is not hypothetical.
 *   * `tsc --noEmit` prints nothing on success, and also prints nothing when it
 *     silently resolved a different tsconfig.
 *   * `next build` can exit 0 off a warm cache without compiling the change.
 *   * `npm run eval` exits 0 when every case was skipped.
 *
 * So each gate is required to produce a COUNT -- files checked, tests passed,
 * cases scored -- and `ok` is derived from the count. A gate that cannot say what
 * it did has failed, whatever it exited with.
 *
 * Second rule: tests and evals are judged against a baseline taken from the
 * pristine tree before Claude ever runs. A test that was already failing on this
 * Mac (a timing-sensitive one, say) is not evidence about the repair, and letting
 * it veto every future repair would be a self-repair system that can never repair
 * anything. A test that PASSED before and fails after is fatal, always.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { redact } from '@/lib/providers/errors';

import { GATE_TIMEOUT_MS, type GateId, type GateResult } from './types';

/* ─────────────────────────── running a child ────────────────────────── */

export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

const OUTPUT_CAP = 512 * 1024;
const SIGKILL_GRACE_MS = 5_000;

/**
 * Spawn, capture, and never leave the child behind.
 *
 * stdin is closed immediately: a build tool that decides to ask a question must
 * die at the deadline rather than hold a repair open for twenty minutes.
 */
export function runCommand(
  bin: string,
  argv: readonly string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunOutcome> {
  const started = Date.now();
  return new Promise<RunOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(bin, [...argv], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });

    let killTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      killTimer ??= setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, SIGKILL_GRACE_MS);
    }, opts.timeoutMs);

    const settle = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode, signal, timedOut, durationMs: Date.now() - started });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk;
    });
    child.on('error', (err: Error) => {
      stderr += `\nspawn failed: ${err.message}`;
      settle(null, null);
    });
    child.on('close', (code, signal) => settle(code, signal));
    child.stdin.on('error', () => {
      // EPIPE if the child died early; close() already reported the real reason.
    });
    child.stdin.end();
  });
}

/* ──────────────────────────── what to run ───────────────────────────── */

export interface GateEnvironment {
  /** The tree under test. Never the live install. */
  cwd: string;
  /** The node that runs the gates. The bundled runtime, by default. */
  node: string;
  /** Where a gate may write its machine-readable report. */
  reportDir: string;
}

export function defaultGateEnvironment(cwd: string, reportDir: string): GateEnvironment {
  // process.execPath is the runtime this server is already running under, which
  // inside the .app is the pinned node in the bundle. Reaching for `npx` instead
  // would resolve against a PATH a LaunchAgent does not have.
  return { cwd, node: process.execPath, reportDir };
}

/** Paths every gate needs. Checked before a Claude session is spent, not after. */
export interface GateReadiness {
  ready: boolean;
  missing: string[];
}

export function checkGateReadiness(cwd: string): GateReadiness {
  const required = [
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    'tests',
    'evals/run.ts',
    'node_modules/typescript/bin/tsc',
    'node_modules/vitest/vitest.mjs',
    'node_modules/next/dist/bin/next',
  ];
  const missing = required.filter((rel) => !existsSync(join(cwd, rel)));
  return { ready: missing.length === 0, missing };
}

function childEnv(reportDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    // A gate must never read or write the real database, the real archive or the
    // real settings. IBC_DATA_DIR is the one switch that guarantees it, and it is
    // pointed somewhere disposable rather than merely unset -- unset means the
    // default, and the default is her contracts.
    IBC_DATA_DIR: join(reportDir, 'scratch-data'),
  };
}

/* ───────────────────────────── typecheck ────────────────────────────── */

export interface TscVerdict {
  errors: number;
  filesChecked: number;
  firstErrors: string[];
}

/**
 * Read tsc's own numbers. `--extendedDiagnostics` prints a Files: count, which
 * is the positive evidence that it compiled a program rather than resolving an
 * empty one.
 */
export function parseTscOutput(text: string): TscVerdict {
  const errors: string[] = [];
  for (const line of text.split('\n')) {
    if (/error TS\d+:/.test(line)) errors.push(line.trim());
  }
  const files = /^Files:\s+(\d+)/m.exec(text);
  return {
    errors: errors.length,
    filesChecked: files?.[1] === undefined ? 0 : Number.parseInt(files[1], 10),
    firstErrors: errors.slice(0, 20),
  };
}

/* ─────────────────────────────── tests ──────────────────────────────── */

export interface TestVerdict {
  total: number;
  passed: number;
  failed: number;
  files: number;
  /** Full test name -> passed. The baseline comparison needs names, not counts. */
  byName: Record<string, boolean>;
  failures: string[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Vitest's json reporter, which follows Jest's shape. Read tolerantly: the
 * counts are the verdict, the names are what makes a baseline comparison
 * possible, and a report we cannot parse counts as zero tests -- which fails.
 */
export function parseVitestReport(json: unknown): TestVerdict {
  const root = asRecord(json);
  const verdict: TestVerdict = {
    total: 0,
    passed: 0,
    failed: 0,
    files: 0,
    byName: {},
    failures: [],
  };
  if (root === null) return verdict;

  verdict.total = asNumber(root['numTotalTests']);
  verdict.passed = asNumber(root['numPassedTests']);
  verdict.failed = asNumber(root['numFailedTests']);

  const results = Array.isArray(root['testResults']) ? root['testResults'] : [];
  verdict.files = results.length;
  for (const entry of results) {
    const file = asRecord(entry);
    if (file === null) continue;
    const fileName = typeof file['name'] === 'string' ? file['name'] : '';
    const assertions = Array.isArray(file['assertionResults']) ? file['assertionResults'] : [];
    for (const raw of assertions) {
      const assertion = asRecord(raw);
      if (assertion === null) continue;
      const name =
        typeof assertion['fullName'] === 'string' && assertion['fullName'] !== ''
          ? assertion['fullName']
          : `${fileName} ${String(assertion['title'] ?? '')}`;
      const status = String(assertion['status'] ?? '');
      // 'skipped', 'todo' and 'pending' are neither a pass nor a failure, and
      // must not be recorded as a pass: a test skipped after the repair that ran
      // before it would otherwise slip through the baseline comparison.
      if (status === 'passed') verdict.byName[name] = true;
      else if (status === 'failed') {
        verdict.byName[name] = false;
        verdict.failures.push(name);
      }
    }
  }
  return verdict;
}

/**
 * Tests that passed in the baseline and do not pass now. The only test result
 * that can veto a repair -- and it always does.
 */
export function newlyFailing(baseline: TestVerdict | null, after: TestVerdict): string[] {
  if (baseline === null) return after.failures;
  const broken: string[] = [];
  for (const [name, passed] of Object.entries(baseline.byName)) {
    if (!passed) continue;
    if (after.byName[name] !== true) broken.push(name);
  }
  return broken.sort();
}

/* ─────────────────────────────── evals ──────────────────────────────── */

export interface EvalVerdict {
  cases: number;
  passed: number;
  offlineFailures: number;
  byName: Record<string, boolean>;
  failures: string[];
}

/** `npm run eval -- --json` emits { totals, cases: [{ name, status, live }] }. */
export function parseEvalReport(json: unknown): EvalVerdict {
  const root = asRecord(json);
  const verdict: EvalVerdict = {
    cases: 0,
    passed: 0,
    offlineFailures: 0,
    byName: {},
    failures: [],
  };
  if (root === null) return verdict;

  const totals = asRecord(root['totals']);
  if (totals !== null) {
    verdict.cases = asNumber(totals['cases']);
    verdict.passed = asNumber(totals['casesPassed']);
    verdict.offlineFailures = asNumber(totals['offlineFailures']);
  }

  const cases = Array.isArray(root['cases']) ? root['cases'] : [];
  for (const raw of cases) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const name = String(entry['name'] ?? '');
    if (name === '') continue;
    const status = String(entry['status'] ?? '');
    if (status === 'pass') verdict.byName[name] = true;
    else if (status === 'fail') {
      verdict.byName[name] = false;
      // A live case failing is a model having a bad day, not a regression; the
      // runner already refuses to gate on those, and so do we.
      if (entry['live'] !== true) verdict.failures.push(name);
    }
  }
  return verdict;
}

export function newlyFailingEvals(baseline: EvalVerdict | null, after: EvalVerdict): string[] {
  if (baseline === null) return after.failures;
  const broken: string[] = [];
  for (const [name, passed] of Object.entries(baseline.byName)) {
    if (!passed) continue;
    if (after.byName[name] !== true) broken.push(name);
  }
  return broken.sort();
}

/* ────────────────────────────── the build ───────────────────────────── */

/**
 * next build's evidence is the manifest it writes, not what it printed. A build
 * that exits 0 without leaving a routes manifest behind did not build anything
 * this app can serve.
 */
export function buildProduced(cwd: string): { ok: boolean; detail: string } {
  const required = [
    join(cwd, '.next', 'BUILD_ID'),
    join(cwd, '.next', 'routes-manifest.json'),
  ];
  const missing = required.filter((file) => !existsSync(file));
  return missing.length === 0
    ? { ok: true, detail: '' }
    : { ok: false, detail: `build left no ${missing.map((m) => m.split('/').pop()).join(', ')}` };
}

/* ─────────────────────────── the gate runner ────────────────────────── */

export interface Baseline {
  tests: TestVerdict | null;
  evals: EvalVerdict | null;
}

export interface GateRunResult extends GateResult {
  /** The parsed verdict, for the baseline of a later run. */
  tests?: TestVerdict;
  evals?: EvalVerdict;
}

function tail(text: string, max = 4_000): string {
  const clean = redact(text.trim()) ?? '';
  return clean.length <= max ? clean : `...${clean.slice(clean.length - max)}`;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function runGate(
  id: GateId,
  env: GateEnvironment,
  baseline: Baseline = { tests: null, evals: null },
): Promise<GateRunResult> {
  mkdirSync(env.reportDir, { recursive: true });
  const timeoutMs = GATE_TIMEOUT_MS[id];
  const childEnvironment = childEnv(env.reportDir);

  switch (id) {
    case 'typecheck': {
      const out = await runCommand(
        env.node,
        ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false', '--extendedDiagnostics'],
        { cwd: env.cwd, timeoutMs, env: childEnvironment },
      );
      const verdict = parseTscOutput(`${out.stdout}\n${out.stderr}`);
      // Files: 0 means tsc resolved an empty program -- a pass that proves nothing.
      const ok = !out.timedOut && verdict.errors === 0 && verdict.filesChecked > 0;
      return {
        id,
        ok,
        evidence: `${verdict.filesChecked} files checked, ${verdict.errors} errors`,
        detail: ok
          ? ''
          : out.timedOut
            ? `tsc did not finish within ${timeoutMs}ms`
            : verdict.filesChecked === 0
              ? `tsc checked no files, so its exit code proves nothing. ${tail(out.stderr, 600)}`
              : verdict.firstErrors.join('\n'),
        exitCode: out.exitCode,
        durationMs: out.durationMs,
      };
    }

    case 'tests': {
      const report = join(env.reportDir, 'vitest.json');
      rmSync(report, { force: true });
      const out = await runCommand(
        env.node,
        ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${report}`],
        { cwd: env.cwd, timeoutMs, env: childEnvironment },
      );
      const verdict = parseVitestReport(readJsonFile(report));
      const broken = newlyFailing(baseline.tests, verdict);
      // A run with no tests in it is the false pass this gate exists to catch.
      const ran = verdict.total > 0 && verdict.files > 0;
      const ok = !out.timedOut && ran && broken.length === 0;
      return {
        id,
        ok,
        evidence: `${verdict.passed} passed, ${verdict.failed} failed, ${verdict.total} tests in ${verdict.files} files`,
        detail: ok
          ? ''
          : out.timedOut
            ? `the test run did not finish within ${timeoutMs}ms`
            : !ran
              ? `no tests ran, so exit ${out.exitCode} proves nothing. ${tail(out.stderr, 600)}`
              : `tests that passed before the repair and fail after it:\n${broken.slice(0, 20).join('\n')}`,
        exitCode: out.exitCode,
        durationMs: out.durationMs,
        tests: verdict,
      };
    }

    case 'evals': {
      const report = join(env.reportDir, 'eval.json');
      rmSync(report, { force: true });
      const out = await runCommand(
        env.node,
        ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'evals/run.ts', '--json'],
        { cwd: env.cwd, timeoutMs, env: childEnvironment },
      );
      // The runner prints its JSON to stdout; keep a copy for the record.
      const parsed = parseJsonFromText(out.stdout);
      const verdict = parseEvalReport(parsed);
      const broken = newlyFailingEvals(baseline.evals, verdict);
      const ran = verdict.cases > 0;
      const ok = !out.timedOut && ran && broken.length === 0 && verdict.offlineFailures === 0;
      return {
        id,
        ok,
        evidence: `${verdict.passed}/${verdict.cases} cases passed, ${verdict.offlineFailures} offline failures`,
        detail: ok
          ? ''
          : out.timedOut
            ? `the eval run did not finish within ${timeoutMs}ms`
            : !ran
              ? `no eval cases ran, so exit ${out.exitCode} proves nothing. ${tail(out.stderr, 600)}`
              : `eval cases that passed before the repair and fail after it: ${broken.join(', ') || 'none'}; offline failures: ${verdict.offlineFailures}`,
        exitCode: out.exitCode,
        durationMs: out.durationMs,
        evals: verdict,
      };
    }

    case 'build': {
      // A stale .next would let a broken change "build" instantly off cache.
      rmSync(join(env.cwd, '.next'), { recursive: true, force: true });
      const out = await runCommand(env.node, ['node_modules/next/dist/bin/next', 'build'], {
        cwd: env.cwd,
        timeoutMs,
        env: childEnvironment,
      });
      const produced = buildProduced(env.cwd);
      const ok = !out.timedOut && out.exitCode === 0 && produced.ok;
      return {
        id,
        ok,
        evidence: produced.ok ? 'build output written' : 'no build output',
        detail: ok
          ? ''
          : out.timedOut
            ? `the build did not finish within ${timeoutMs}ms`
            : produced.ok
              ? tail(`${out.stdout}\n${out.stderr}`)
              : `${produced.detail}. ${tail(out.stderr, 1_500)}`,
        exitCode: out.exitCode,
        durationMs: out.durationMs,
      };
    }

    default:
      return {
        id,
        ok: false,
        evidence: 'unknown gate',
        detail: `no such gate: ${String(id)}`,
        exitCode: null,
        durationMs: 0,
      };
  }
}

/** The eval runner prints a banner before its JSON on some paths. Find the object. */
export function parseJsonFromText(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface GateReport {
  ok: boolean;
  results: GateRunResult[];
  /** Everything a failing gate said, for the next prompt and for the audit trail. */
  detail: string;
}

/**
 * Run gates in the given order and stop at the first failure.
 *
 * Stopping early is deliberate: after a type error the test run tells you
 * nothing you did not already know, and every extra minute here is a minute of
 * her Mac's fans.
 */
export async function runGates(
  env: GateEnvironment,
  ids: readonly GateId[],
  baseline: Baseline = { tests: null, evals: null },
): Promise<GateReport> {
  const results: GateRunResult[] = [];
  for (const id of ids) {
    const result = await runGate(id, env, baseline);
    results.push(result);
    if (!result.ok) break;
  }
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0 && results.length === ids.length,
    results,
    detail: failed.map((r) => `[${r.id}] ${r.evidence}\n${r.detail}`).join('\n\n'),
  };
}

/**
 * What the pristine tree already fails, measured before Claude is invoked.
 *
 * It doubles as the proof that the gates can run here at all: spending a
 * subscription session on a workspace whose tests cannot execute is the
 * expensive way to discover a missing directory.
 */
export async function measureBaseline(env: GateEnvironment): Promise<Baseline> {
  const tests = await runGate('tests', env);
  const evals = await runGate('evals', env);
  return { tests: tests.tests ?? null, evals: evals.evals ?? null };
}
