/**
 * `npm run doctor` - the command a person runs when the app will not start.
 *
 * Every check prints PASS, WARN or FAIL, one line of what it found, and one line of what
 * to do about it. No stack traces, no jargon, no check that leaves someone stuck without a
 * next action. The last block is plain text meant to be copied into an email.
 *
 * Hard checks decide the exit code: 1 means the app cannot work on this machine yet.
 * Warnings mean it will work but something is not as expected.
 */

import { register } from 'node:module';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir, arch, platform, release } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Doctor has to be the one command that always runs, so it does not care whether src/lib
 * uses TypeScript that `--experimental-strip-types` refuses (a parameter property, an
 * enum). If we are not already under the fuller transform, hand off to a child that is.
 */
const TRANSFORM = '--experimental-transform-types';
if (!process.execArgv.includes(TRANSFORM)) {
  const child = spawnSync(
    process.execPath,
    [
      TRANSFORM,
      '--disable-warning=ExperimentalWarning',
      ...process.execArgv.filter((a) => a !== '--experimental-strip-types'),
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  process.exit(child.status ?? 1);
}

/**
 * The same resolve hook evals/run.ts installs, for the same reason: `node
 * --experimental-strip-types` does not read tsconfig `paths` and does not infer
 * extensions, and both entry points have to bootstrap themselves before they can import
 * anything from src/lib.
 */
const SRC_DIR = join(resolvePath(import.meta.dirname, '..'), 'src');

register(
  `data:text/javascript,${encodeURIComponent(`
import { pathToFileURL } from 'node:url';
const SRC = ${JSON.stringify(`${SRC_DIR}/`)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = SRC + specifier.slice(2);
    for (const candidate of [base, base + '.ts', base + '/index.ts']) {
      try { return await nextResolve(pathToFileURL(candidate).href, context); } catch {}
    }
  }
  try { return await nextResolve(specifier, context); }
  catch (err) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const suffix of ['.ts', '/index.ts']) {
        try { return await nextResolve(specifier + suffix, context); } catch {}
      }
    }
    throw err;
  }
}`)}`,
);

const exec = promisify(execFile);

/* ────────────────────────────── the model ───────────────────────────── */

type State = 'pass' | 'warn' | 'fail';

interface Result {
  state: State;
  /** What was found. One line. */
  detail: string;
  /** What to do about it. One line. Required whenever state is not pass. */
  fix?: string;
}

interface Check {
  id: string;
  label: string;
  /** A failure here means the app cannot work. Warnings never set the exit code. */
  hard: boolean;
  run: () => Promise<Result>;
}

const MIN_NODE = [22, 5, 0] as const;
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const DEV_PORT = 3000;

function short(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (raw.split('\n')[0] ?? raw).slice(0, 140);
}

/** Loads a src/lib module, or explains why it could not. */
async function tryImport<T>(label: string, thunk: () => Promise<T>): Promise<T | string> {
  try {
    return await thunk();
  } catch (e) {
    return `${label}: ${short(e)}`;
  }
}

function isModule<T>(v: T | string): v is T {
  return typeof v !== 'string';
}

/* ─────────────────────────────── checks ─────────────────────────────── */

function nodeVersion(): Check {
  return {
    id: 'node-version',
    label: 'Node version',
    hard: true,
    async run() {
      const parts = process.versions.node.split('.').map(Number);
      const [major = 0, minor = 0] = parts;
      const ok =
        major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
      return ok
        ? { state: 'pass', detail: `v${process.versions.node}` }
        : {
            state: 'fail',
            detail: `v${process.versions.node}`,
            fix: `Install Node ${MIN_NODE[0]}.${MIN_NODE[1]} or newer: brew install node`,
          };
    },
  };
}

function nodeSqlite(): Check {
  return {
    id: 'node-sqlite',
    label: 'node:sqlite',
    hard: true,
    async run() {
      try {
        const sqlite = await import('node:sqlite');
        const db = new sqlite.DatabaseSync(':memory:');
        db.exec('CREATE TABLE t (a INTEGER)');
        db.close();
        return { state: 'pass', detail: 'built in, no native module needed' };
      } catch (e) {
        return {
          state: 'fail',
          detail: short(e),
          fix: 'This Node build has no node:sqlite. Install Node 22.5 or newer.',
        };
      }
    },
  };
}

function fts5(): Check {
  return {
    id: 'sqlite-fts5',
    label: 'SQLite FTS5 (search)',
    hard: true,
    async run() {
      try {
        const sqlite = await import('node:sqlite');
        const db = new sqlite.DatabaseSync(':memory:');
        db.exec("CREATE VIRTUAL TABLE s USING fts5(body, tokenize='unicode61 remove_diacritics 2')");
        db.exec("INSERT INTO s (body) VALUES ('Octillion Power Supply')");
        const row = db.prepare("SELECT count(*) AS n FROM s WHERE s MATCH 'octillion'").get();
        db.close();
        const n = typeof row?.['n'] === 'number' ? row['n'] : Number(row?.['n'] ?? 0);
        return n === 1
          ? { state: 'pass', detail: 'available, unicode61 tokenizer works' }
          : {
              state: 'fail',
              detail: `FTS5 matched ${n} rows, expected 1`,
              fix: 'Repository search will not work. Report this with the summary below.',
            };
      } catch (e) {
        return {
          state: 'fail',
          detail: short(e),
          fix: 'This Node build has no FTS5. Install the official Node 22.5+ build from nodejs.org.',
        };
      }
    },
  };
}

interface Paths {
  dataDir: string;
  dbPath: string;
}

/** The data dir, from paths.ts when it loads, from the documented default otherwise. */
async function resolvePaths(): Promise<Paths> {
  const mod = await tryImport('paths', () => import('../src/lib/paths'));
  if (isModule(mod)) return { dataDir: mod.dataDir(), dbPath: mod.dbPath() };
  const override = process.env.IBC_DATA_DIR;
  const dir =
    override !== undefined && override !== ''
      ? override
      : join(homedir(), 'Library', 'Application Support', 'IBC Contract Tracker');
  return { dataDir: dir, dbPath: join(dir, 'tracker.db') };
}

function dataDirCheck(paths: Paths): Check {
  return {
    id: 'data-dir',
    label: 'Data folder',
    hard: true,
    async run() {
      try {
        mkdirSync(paths.dataDir, { recursive: true });
        const probe = join(paths.dataDir, '.doctor-write-test');
        writeFileSync(probe, 'ok');
        rmSync(probe);
        return { state: 'pass', detail: paths.dataDir };
      } catch (e) {
        return {
          state: 'fail',
          detail: `${paths.dataDir}: ${short(e)}`,
          fix: 'Grant write access to that folder, or set IBC_DATA_DIR to one you own.',
        };
      }
    },
  };
}

function databaseCheck(paths: Paths): Check {
  return {
    id: 'database',
    label: 'Database',
    hard: true,
    async run() {
      const migrate = await tryImport('db/migrate', () => import('../src/lib/db/migrate'));
      if (!isModule(migrate)) {
        return { state: 'fail', detail: migrate, fix: 'The database module did not load. Report this.' };
      }
      try {
        const sqlite = await import('node:sqlite');
        const fresh = !existsSync(paths.dbPath);
        const db = new sqlite.DatabaseSync(paths.dbPath);
        migrate.migrate(db);
        const row = db.prepare('SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1').get();
        const version = Number(row?.['version'] ?? 0);
        const counts = db.prepare('SELECT (SELECT count(*) FROM documents) AS d, (SELECT count(*) FROM contracts) AS c').get();
        db.close();
        const size = existsSync(paths.dbPath) ? statSync(paths.dbPath).size : 0;
        const summary = `schema v${version}, ${counts?.['d'] ?? 0} documents, ${counts?.['c'] ?? 0} contracts, ${Math.round(size / 1024)}kB${fresh ? ' (created just now)' : ''}`;
        return version === migrate.SCHEMA_VERSION
          ? { state: 'pass', detail: summary }
          : {
              state: 'fail',
              detail: `${summary}, expected v${migrate.SCHEMA_VERSION}`,
              fix: 'The database is from a different version of the app. Report this before opening it.',
            };
      } catch (e) {
        return {
          state: 'fail',
          detail: `${paths.dbPath}: ${short(e)}`,
          fix: 'Quit the app and run this again. If it persists, move the file aside and reopen the app.',
        };
      }
    },
  };
}

interface EngineFacts {
  cliPath: string | null;
  cliVersion: string | null;
  cliAuthenticated: boolean;
  cliSummary: string;
  keySource: string;
  keyFingerprint: string | null;
}

async function engineFacts(): Promise<EngineFacts> {
  const facts: EngineFacts = {
    cliPath: null,
    cliVersion: null,
    cliAuthenticated: false,
    cliSummary: 'not checked',
    keySource: 'none',
    keyFingerprint: null,
  };

  const cli = await tryImport('providers/cli', () => import('../src/lib/providers/cli'));
  if (isModule(cli)) {
    facts.cliPath = await cli.resolveClaudeBinary();
    const provider = new cli.CliProvider();
    const health = await provider.health();
    facts.cliSummary = health.summary;
    facts.cliVersion = health.version ?? null;
    facts.cliAuthenticated = health.state === 'ok';
  } else {
    facts.cliSummary = cli;
    try {
      const { stdout } = await exec('claude', ['--version'], { timeout: 10_000 });
      facts.cliVersion = stdout.trim();
      facts.cliPath = 'claude (on PATH)';
    } catch {
      facts.cliPath = null;
    }
  }

  const keychain = await tryImport('providers/keychain', () => import('../src/lib/providers/keychain'));
  if (isModule(keychain)) {
    const lookup = await keychain.getKey();
    facts.keySource = lookup.source;
    facts.keyFingerprint = lookup.key === null ? null : keychain.keyFingerprint(lookup.key);
  } else if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY !== '') {
    facts.keySource = 'env';
  }

  return facts;
}

function claudeCliCheck(facts: EngineFacts): Check {
  return {
    id: 'claude-cli',
    label: 'Claude Code CLI',
    hard: false,
    async run() {
      if (facts.cliPath === null) {
        return {
          state: 'warn',
          detail: 'not found on PATH',
          fix: 'Install it (npm i -g @anthropic-ai/claude-code) or use an API key instead.',
        };
      }
      const where = `${facts.cliPath}${facts.cliVersion === null ? '' : ` (v${facts.cliVersion})`}`;
      return facts.cliAuthenticated
        ? { state: 'pass', detail: `${where} - ${facts.cliSummary}` }
        : {
            state: 'warn',
            detail: `${where} - ${facts.cliSummary}`,
            fix: 'Run `claude` once in Terminal and complete the login, then run doctor again.',
          };
    },
  };
}

function apiKeyCheck(facts: EngineFacts): Check {
  return {
    id: 'api-key',
    label: 'Anthropic API key',
    hard: false,
    async run() {
      if (facts.keySource === 'none') {
        return {
          state: 'warn',
          detail: 'not set in the keychain or the environment',
          fix: 'Optional. Add one in Settings -> Engine, or set ANTHROPIC_API_KEY.',
        };
      }
      return {
        state: 'pass',
        detail: `found in ${facts.keySource}${facts.keyFingerprint === null ? '' : ` (${facts.keyFingerprint})`}`,
      };
    },
  };
}

function engineAvailableCheck(facts: EngineFacts): Check {
  return {
    id: 'engine',
    label: 'At least one engine',
    hard: true,
    async run() {
      if (facts.cliAuthenticated) return { state: 'pass', detail: 'Claude subscription is signed in' };
      if (facts.keySource !== 'none') return { state: 'pass', detail: `API key from ${facts.keySource}` };
      return {
        state: 'fail',
        detail: 'no signed-in CLI and no API key',
        fix: 'Sign in with `claude` in Terminal, or add an API key in Settings -> Engine.',
      };
    },
  };
}

function portCheck(): Check {
  return {
    id: 'port-3000',
    label: `Port ${DEV_PORT}`,
    hard: false,
    async run() {
      const state = await new Promise<'free' | 'busy' | 'error'>((done) => {
        const server = createServer();
        server.once('error', (e: NodeJS.ErrnoException) => {
          done(e.code === 'EADDRINUSE' ? 'busy' : 'error');
        });
        server.once('listening', () => {
          server.close(() => done('free'));
        });
        server.listen(DEV_PORT, '127.0.0.1');
      });
      if (state === 'free') return { state: 'pass', detail: 'free' };
      return {
        state: 'warn',
        detail: state === 'busy' ? 'already in use' : 'could not be tested',
        fix: 'Something else is on port 3000. Quit it, or start the app with PORT=3001 npm run dev.',
      };
    },
  };
}

function diskCheck(paths: Paths): Check {
  return {
    id: 'disk-space',
    label: 'Disk space',
    hard: true,
    async run() {
      try {
        const fs = await statfs(paths.dataDir);
        const free = Number(fs.bavail) * Number(fs.bsize);
        const gb = (free / 1024 ** 3).toFixed(1);
        return free >= MIN_FREE_BYTES
          ? { state: 'pass', detail: `${gb}GB free` }
          : {
              state: 'fail',
              detail: `${gb}GB free`,
              fix: 'Free up at least 500MB. The app archives every PDF it reads.',
            };
      } catch (e) {
        return { state: 'warn', detail: short(e), fix: 'Could not read free space. Check the disk manually.' };
      }
    },
  };
}

/** A one-page PDF with a text layer, built here so the check needs no fixture on disk. */
function tinyPdf(): Uint8Array {
  // Comfortably above the reader's chars-per-page floor for "this is not a scan".
  const content =
    'BT /F1 12 Tf 40 700 Td 14 TL (Doctor check: this page carries a real text layer,) Tj T* ' +
    '(and it is long enough that the reader will not mistake it for a scan.) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

function pdfCheck(): Check {
  return {
    id: 'pdfjs',
    label: 'PDF reader',
    hard: true,
    async run() {
      const pdf = await tryImport('extraction/pdf', () => import('../src/lib/extraction/pdf'));
      if (!isModule(pdf)) {
        return { state: 'fail', detail: pdf, fix: 'Reinstall dependencies: npm install' };
      }
      try {
        const read = await pdf.readPdf(tinyPdf());
        return read.pageCount === 1 && read.hasTextLayer
          ? { state: 'pass', detail: 'pdfjs read a test page and found its text' }
          : {
              state: 'fail',
              detail: `read ${read.pageCount} pages, text layer ${read.hasTextLayer ? 'yes' : 'no'}`,
              fix: 'pdfjs loaded but could not read text. Reinstall dependencies: npm install',
            };
      } catch (e) {
        return { state: 'fail', detail: short(e), fix: 'Reinstall dependencies: npm install' };
      }
    },
  };
}

/**
 * The narrowest shape of exceljs this check needs. Declared locally because exceljs is
 * CommonJS: under plain node its named exports live on `default`, and structural narrowing
 * is how we find the constructor without a cast.
 */
interface WorkbookLike {
  addWorksheet(name: string): { getCell(row: number, col: number): { value: unknown } };
  xlsx: { writeBuffer(): Promise<{ byteLength: number }> };
}

function hasWorkbook(v: unknown): v is { Workbook: new () => WorkbookLike } {
  return typeof v === 'object' && v !== null && typeof Reflect.get(v, 'Workbook') === 'function';
}

function excelCheck(): Check {
  return {
    id: 'exceljs',
    label: 'Excel writer',
    hard: true,
    async run() {
      try {
        const loaded: unknown = await import('exceljs');
        const root =
          typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'default') : null;
        const source = hasWorkbook(loaded) ? loaded : hasWorkbook(root) ? root : null;
        if (source === null) {
          return {
            state: 'fail',
            detail: 'exceljs loaded but exposes no Workbook constructor',
            fix: 'Reinstall dependencies: npm install',
          };
        }
        const wb = new source.Workbook();
        const ws = wb.addWorksheet('NDA');
        ws.getCell(4, 1).value = 'Party A';
        const buffer = await wb.xlsx.writeBuffer();
        return buffer.byteLength > 0
          ? { state: 'pass', detail: `wrote a ${Math.round(buffer.byteLength / 1024)}kB test workbook` }
          : { state: 'fail', detail: 'wrote an empty workbook', fix: 'Reinstall dependencies: npm install' };
      } catch (e) {
        return { state: 'fail', detail: short(e), fix: 'Reinstall dependencies: npm install' };
      }
    },
  };
}

/* ─────────────────────────────── output ─────────────────────────────── */

const COLOUR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const ESC = '';

function paint(code: string, s: string): string {
  return COLOUR ? `${ESC}[${code}m${s}${ESC}[0m` : s;
}

function badge(state: State): string {
  if (state === 'pass') return paint('32', 'PASS');
  if (state === 'warn') return paint('33', 'WARN');
  return paint('31', 'FAIL');
}

async function main(): Promise<void> {
  const paths = await resolvePaths();
  const facts = await engineFacts();

  const checks: Check[] = [
    nodeVersion(),
    nodeSqlite(),
    fts5(),
    dataDirCheck(paths),
    databaseCheck(paths),
    claudeCliCheck(facts),
    apiKeyCheck(facts),
    engineAvailableCheck(facts),
    portCheck(),
    diskCheck(paths),
    pdfCheck(),
    excelCheck(),
  ];

  const redactor = await tryImport('providers/errors', () => import('../src/lib/providers/errors'));
  const clean = (s: string): string =>
    isModule(redactor) ? (redactor.redact(s) ?? s) : s;

  const labelWidth = Math.max(...checks.map((c) => c.label.length));
  const rows: { check: Check; result: Result }[] = [];

  process.stdout.write('\nIBC Contract Tracker - doctor\n\n');

  for (const check of checks) {
    let result: Result;
    try {
      result = await check.run();
    } catch (e) {
      result = { state: 'fail', detail: short(e), fix: 'Unexpected. Report this with the summary below.' };
    }
    result = { ...result, detail: clean(result.detail) };
    rows.push({ check, result });
    process.stdout.write(
      `  ${badge(result.state)}  ${check.label.padEnd(labelWidth)}  ${result.detail}\n`,
    );
    if (result.state !== 'pass' && result.fix !== undefined) {
      process.stdout.write(`        ${' '.repeat(labelWidth)}  ${paint('2', `fix: ${result.fix}`)}\n`);
    }
  }

  const failed = rows.filter((r) => r.result.state === 'fail');
  const warned = rows.filter((r) => r.result.state === 'warn');
  const hardFailures = failed.filter((r) => r.check.hard);

  process.stdout.write('\n');
  if (hardFailures.length === 0 && warned.length === 0) {
    process.stdout.write(`  ${paint('32', 'Everything checks out. The app will start.')}\n`);
  } else if (hardFailures.length === 0) {
    process.stdout.write(
      `  ${paint('33', `The app will start. ${warned.length} thing${warned.length === 1 ? '' : 's'} to know about above.`)}\n`,
    );
  } else {
    process.stdout.write(
      `  ${paint('31', `${hardFailures.length} problem${hardFailures.length === 1 ? '' : 's'} stop the app from working. Fix those first.`)}\n`,
    );
  }

  // Plain text, no colour: this block is meant to be copied into an email.
  const lines = [
    '',
    '--- copy everything below into your email ---',
    `IBC Contract Tracker doctor - ${new Date().toISOString()}`,
    `platform: ${platform()} ${release()} ${arch()} | node ${process.version}`,
    `data dir: ${paths.dataDir}`,
    '',
    ...rows.map(
      (r) =>
        `${r.result.state.toUpperCase().padEnd(4)} ${r.check.id.padEnd(14)} ${r.result.detail}`,
    ),
    '',
    `${failed.length} failed, ${warned.length} warnings, ${rows.length - failed.length - warned.length} passed`,
    '--- end ---',
    '',
  ];
  process.stdout.write(lines.join('\n'));

  process.exitCode = hardFailures.length > 0 ? 1 : 0;
}

await main();
