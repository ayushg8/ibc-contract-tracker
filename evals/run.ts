/**
 * The eval runner.
 *
 *   npm run eval                       every offline case, no engine, no cost
 *   npm run eval -- --live             adds the live extraction case (spends money)
 *   npm run eval -- --case=verify      one case
 *   npm run eval -- --live --fixture=octillion   one document against the engine
 *   npm run eval -- --json             machine-readable, for CI
 *   npm run eval -- --list             what each case proves
 *
 * Exit code is 1 if any OFFLINE case regressed. Live results are reported but never gate,
 * because a model having a bad day is a judgement call for a human.
 *
 * Two things happen before any application module is imported, and both matter:
 *
 * 1. A module resolve hook. `node --experimental-strip-types` runs TypeScript directly but
 *    resolves specifiers exactly like ESM: no extension inference, no tsconfig `paths`. The
 *    hook supplies both, so src/lib can be written the way the bundler expects and the
 *    evals still run with plain node and zero build step.
 *
 * 2. IBC_DATA_DIR is pointed at a throwaway directory. An eval must never be able to touch
 *    the real database, and this is the one place that can guarantee it.
 */

import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `--experimental-strip-types` erases types but refuses TypeScript that needs real
 * codegen: a parameter property, an enum, a namespace. Those are legal in src/lib and none
 * of them are the eval suite's business, so if we are not already running under the fuller
 * transform, hand off to a child process that is. One extra spawn, and the runner stops
 * caring which TypeScript features the app happens to use.
 */
const TRANSFORM = '--experimental-transform-types';
if (!process.execArgv.includes(TRANSFORM)) {
  const argv = [
    TRANSFORM,
    '--disable-warning=ExperimentalWarning',
    ...process.execArgv.filter((a) => a !== '--experimental-strip-types'),
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ];
  const child = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const SRC_DIR = join(resolvePath(import.meta.dirname, '..'), 'src');

const RESOLVE_HOOK = `
import { pathToFileURL } from 'node:url';
const SRC = ${JSON.stringify(`${SRC_DIR}/`)};

/** Adds what ESM does not do for TypeScript: the @/ alias, and extension inference. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = SRC + specifier.slice(2);
    for (const candidate of [base, base + '.ts', base + '/index.ts']) {
      try {
        return await nextResolve(pathToFileURL(candidate).href, context);
      } catch {
        /* try the next shape */
      }
    }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          /* fall through to the original error */
        }
      }
    }
    throw err;
  }
}`;

register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK)}`);

if (process.env.IBC_DATA_DIR === undefined || process.env.IBC_DATA_DIR === '') {
  process.env.IBC_DATA_DIR = mkdtempSync(join(tmpdir(), 'ibc-eval-'));
}

/* ────────────────────────────── arguments ───────────────────────────── */

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

const live = flag('live');
const json = flag('json');
const verbose = flag('verbose');
const list = flag('list');
const keepData = flag('keep-data');
const only = option('case');
/** Restricts the live extraction case, so a spot check does not read all thirteen. */
const fixtures = option('fixture')?.split(',') ?? null;
/** Frozen so a status assertion cannot pass in July and fail in October. */
const today = option('today') ?? '2026-07-29';

/* ─────────────────────────── the case registry ──────────────────────── */

type CaseContextT = import('./report').CaseContext;
type CaseResultT = import('./report').CaseResult;

interface Registered {
  name: string;
  proves: string;
  live: boolean;
  load: () => Promise<{ runCase: (ctx: CaseContextT) => Promise<CaseResultT> }>;
}

const CASES: Registered[] = [
  {
    name: 'fixtures',
    proves:
      'Every fixture is internally consistent: its quotes are in its own text and its dates add up.',
    live: false,
    load: () => import('./cases/fixtures'),
  },
  {
    name: 'dates',
    proves:
      'Every date form in the corpus parses, ambiguous ones are flagged, impossible ones are refused, and calendar arithmetic clamps at month end.',
    live: false,
    load: () => import('./cases/dates'),
  },
  {
    name: 'rules',
    proves:
      'The deterministic pass never answers with a wrong value, and never stays silent where the document is unambiguous.',
    live: false,
    load: () => import('./cases/rules'),
  },
  {
    name: 'verify',
    proves:
      'Mangled real quotes are accepted; invented quotes are refused, including ones that differ by a single digit.',
    live: false,
    load: () => import('./cases/verify'),
  },
  {
    name: 'status',
    proves:
      'Both clocks are right at day 91, 90, 89, 0 and -1, and a perpetual obligation is not reported as expired.',
    live: false,
    load: () => import('./cases/status'),
  },
  {
    name: 'determinism',
    proves:
      'The same document extracted twice gives byte-identical output, calls the engine once, and costs nothing the second time.',
    live: false,
    load: () => import('./cases/determinism'),
  },
  {
    name: 'extraction',
    proves: 'A real engine reading every fixture, scored field by field, with the cost printed.',
    live: true,
    load: () => import('./cases/extraction'),
  },
];

function skipped(c: Registered, reason: string): CaseResultT {
  return {
    name: c.name,
    title: c.proves,
    status: 'skip',
    skipReason: reason,
    assertions: [],
    costUsd: null,
    durationMs: 0,
    live: c.live,
  };
}

/* ──────────────────────────────── main ──────────────────────────────── */

async function main(): Promise<void> {
  const report = await import('./report');

  if (list) {
    for (const c of CASES) {
      process.stdout.write(`${c.name}${c.live ? '  (--live)' : ''}\n  ${c.proves}\n\n`);
    }
    return;
  }

  const selected = only === null ? CASES : CASES.filter((c) => c.name === only);
  if (selected.length === 0) {
    process.stderr.write(
      `no case called ${JSON.stringify(only)}. Known cases: ${CASES.map((c) => c.name).join(', ')}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const ctx: CaseContextT = { live, today, verbose, fixtures };
  const results: CaseResultT[] = [];

  for (const c of selected) {
    if (c.live && !live) {
      results.push(skipped(c, 'needs --live'));
      continue;
    }
    try {
      const mod = await c.load();
      results.push(await mod.runCase(ctx));
    } catch (e) {
      // A case that cannot even be imported is a legible skip, not a silent absence.
      const first = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
      results.push(skipped(c, `case failed to load: ${first}`));
    }
  }

  const totals = report.totalsOf(results);

  if (json) {
    process.stdout.write(`${JSON.stringify(report.toJson(results, ctx), null, 2)}\n`);
  } else {
    process.stdout.write(`\n${report.renderTable(results)}\n`);
    const failures = report.renderFailures(results);
    if (failures.trim() !== '') process.stdout.write(`${failures}\n`);
    for (const r of results) {
      if (r.status !== 'pass' && r.skipReason !== undefined) {
        process.stdout.write(`\nskipped ${r.name}: ${r.skipReason}\n`);
      }
    }
    process.stdout.write(`${report.renderHeadline(totals, { live })}\n`);
    if (!live) {
      process.stdout.write('run with --live to score a real engine on every fixture\n');
    }
    process.stdout.write('\n');
  }

  process.exitCode = totals.offlineFailures > 0 ? 1 : 0;
}

try {
  await main();
} finally {
  if (!keepData) {
    const { useEvalDataDir, removeEvalDataDir } = await import('./cases/_harness');
    useEvalDataDir();
    removeEvalDataDir();
  }
}
