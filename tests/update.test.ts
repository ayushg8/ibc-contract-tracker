/**
 * The update mechanism, end to end against a real fake bundle on disk.
 *
 * WHY so much of this file is shell and not unit tests: the interesting failures
 * of an updater are all in the seams. A version comparison can be tested in a
 * millisecond and is not where anyone gets hurt. What gets someone hurt is a
 * payload that unpacks before its fingerprint is checked, a symlink that is
 * flipped and never flipped back, a "restart" that returned zero without
 * restarting anything, and an update that touches the database. So a whole
 * disposable bundle is built in a temp directory -- versioned app folders, a
 * symlink, a supervisor script, a real HTTP server answering the real liveness
 * endpoint -- and the real update.sh is run against it.
 *
 * Every assertion here is one of the properties the design rests on:
 *
 *   - a payload whose SHA256 does not match is never unpacked, and the running
 *     server is never even stopped
 *   - a payload missing part of the app is caught BEFORE the swap
 *   - the old version stays on disk and the symlink can be flipped back
 *   - a new version that does not come up is rolled back automatically, and the
 *     rollback is verified by asking the server what version it is
 *   - launchd claiming success while nothing serves does NOT end the wait --
 *     this is the exact bug the launcher had, written down so it cannot return
 *   - two appliers cannot run at once
 *   - the database, the PDF archive and the thumbnails are byte-identical after
 *     an update
 *
 * The fixture rewrites IBC_PORTS in its own copy of common.sh and runs with HOME
 * pointed at the temp directory. Both are deliberate: without them these tests
 * would find, health-check, and then STOP the real IBC Contracts server on the
 * machine running them.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = join(ROOT, 'packaging', 'app-template');
const REAL_UPDATE_SH = join(TEMPLATE, 'bin', 'update.sh');
const REAL_COMMON_SH = join(TEMPLATE, 'bin', 'common.sh');

/* Every module under test reads paths at call time, so the env has to be set
 * before the first import -- same reason as tests/db.test.ts. */
const SANDBOX = mkdtempSync(join(tmpdir(), 'ibc-update-'));
process.env['IBC_DATA_DIR'] = join(SANDBOX, 'data');
mkdirSync(join(SANDBOX, 'data'), { recursive: true });

const version = await import('@/lib/update/version');
const source = await import('@/lib/update/source');
const manifestMod = await import('@/lib/update/manifest');
const runtimeMod = await import('@/lib/update/runtime');
const installMod = await import('@/lib/update/install');
const stateMod = await import('@/lib/update/state');
const failuresMod = await import('@/lib/update/failures');
const serviceMod = await import('@/lib/update/service');
const types = await import('@/lib/update/types');

const cleanups: (() => void)[] = [];

afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // Best effort: a fixture that half tore down must not fail the run.
    }
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

/* ══════════════════════════════ version ═══════════════════════════════ */

describe('version comparison', () => {
  it('parses the shapes we publish and rejects the ones we do not', () => {
    expect(version.parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(version.parseVersion('v1.2.3')?.major).toBe(1);
    expect(version.parseVersion('1.2.3-rc.1')?.prerelease).toEqual(['rc', '1']);
    expect(version.parseVersion('1.2.3+build.5')?.prerelease).toEqual([]);

    for (const bad of ['1.2', '1.2.3.4', 'latest', '', '1.2.3-', 'v', '../1.2.3', '1.2.3/x']) {
      expect(version.parseVersion(bad), bad).toBeNull();
    }
  });

  it('orders releases above their own prereleases', () => {
    expect(version.isNewer('1.2.0', '1.2.0-rc.1')).toBe(true);
    expect(version.isNewer('1.2.0-rc.2', '1.2.0-rc.1')).toBe(true);
    expect(version.isNewer('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(version.isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(version.isNewer('2.0.0', '1.99.99')).toBe(true);
  });

  it('treats an unreadable version as NOT older', () => {
    // The dangerous direction. If an installation whose version we could not
    // read counted as 0.0.0, every payload on earth would look like an upgrade.
    expect(version.isNewer('1.0.0', 'unknown')).toBe(false);
    expect(version.isNewer('unknown', '1.0.0')).toBe(false);
    expect(version.compareStrings('1.0.0', 'nope')).toBeNull();
    expect(version.isAtLeast('1.0.0', 'nope')).toBe(false);
  });

  it('sorts newest first and sinks the unparseable', () => {
    expect(version.sortVersionsDescending(['1.0.0', '1.10.0', '1.2.0', 'junk'])).toEqual([
      '1.10.0',
      '1.2.0',
      '1.0.0',
      'junk',
    ]);
  });
});

/* ══════════════════════════════ manifest ══════════════════════════════ */

const GOOD_MANIFEST = {
  schemaVersion: 1,
  version: '1.1.0',
  url: 'https://example.com/ibc-1.1.0.tar.gz',
  sha256: 'A'.repeat(64),
  sizeBytes: 1234,
  publishedAt: '2026-07-30T00:00:00.000Z',
  minimumSupportedVersion: '1.0.0',
  notes: 'Fixes the expiry date on renewals.',
  critical: false,
};

describe('manifest', () => {
  const parse = manifestMod.__testing.parseManifest;

  it('accepts a complete manifest and lowercases the fingerprint', () => {
    const m = parse(JSON.stringify(GOOD_MANIFEST));
    expect(m.version).toBe('1.1.0');
    expect(m.sha256).toBe('a'.repeat(64));
    expect(m.critical).toBe(false);
    expect(m.minimumSupportedVersion).toBe('1.0.0');
  });

  it('fills the optional fields with null rather than leaving them absent', () => {
    const m = parse(
      JSON.stringify({
        schemaVersion: 1,
        version: '2.0.0',
        url: 'https://example.com/x.tar.gz',
        sha256: 'b'.repeat(64),
      }),
    );
    expect(m.sizeBytes).toBeNull();
    expect(m.publishedAt).toBeNull();
    expect(m.minimumSupportedVersion).toBeNull();
    expect(m.notes).toBeNull();
    expect(m.critical).toBe(false);
  });

  it.each([
    ['a fingerprint that is not a sha256', { ...GOOD_MANIFEST, sha256: 'abc' }],
    ['no fingerprint at all', { ...GOOD_MANIFEST, sha256: undefined }],
    ['a version that is not a version', { ...GOOD_MANIFEST, version: 'latest' }],
    ['a future schema', { ...GOOD_MANIFEST, schemaVersion: 2 }],
    ['no url', { ...GOOD_MANIFEST, url: undefined }],
    ['a negative size', { ...GOOD_MANIFEST, sizeBytes: -1 }],
  ])('refuses %s', (_label, body) => {
    expect(() => parse(JSON.stringify(body))).toThrow();
  });

  it('refuses something that is not JSON at all', () => {
    // A captive wifi portal answering with an HTML login page is the realistic
    // shape of this, and it must not look like "no update available".
    expect(() => parse('<html>Sign in to continue</html>')).toThrow();
  });
});

/* ═══════════════════════════════ source ═══════════════════════════════ */

describe('update source', () => {
  it('allows https and file, and http only to this machine', () => {
    expect(source.isAllowedUrl('https://example.com/m.json')).toBe(true);
    expect(source.isAllowedUrl('file:///Volumes/USB/m.json')).toBe(true);
    expect(source.isAllowedUrl('http://127.0.0.1:8080/m.json')).toBe(true);
    expect(source.isAllowedUrl('http://localhost:8080/m.json')).toBe(true);
    // The one that matters: a payload fetched over plain http from elsewhere can
    // be swapped in flight, and so can the manifest that vouches for it.
    expect(source.isAllowedUrl('http://updates.example.com/m.json')).toBe(false);
    expect(source.isAllowedUrl('ftp://example.com/m.json')).toBe(false);
    expect(source.isAllowedUrl('not a url')).toBe(false);
  });

  it('never puts a query string in the display label', () => {
    const label = source.safeLabel('https://example.com/m.json?token=SECRET-VALUE');
    expect(label).not.toContain('SECRET');
    expect(label).toContain('example.com');
  });

  it('defaults to the fortnight the plist delegates to it', () => {
    /*
     * UpdateCheck.plist.in cannot say "every 14 days", so it fires weekly and
     * delegates the real interval to checkIntervalHours -- and NOTHING writes
     * source.json, so on every installation that has never been configured by
     * hand the delegate is this default. A 24 here would have meant the
     * documented fortnight did not exist and the agent checked weekly.
     *
     * Asserted against 336 and against the documents that promise it, not
     * against whatever the constant happens to be.
     */
    const FORTNIGHT_HOURS = 14 * 24;
    expect(FORTNIGHT_HOURS).toBe(336);

    const dir = mkdtempSync(join(SANDBOX, 'source-default-'));
    process.env['IBC_UPDATE_DIR'] = dir;
    delete process.env['IBC_UPDATE_CHECK_HOURS'];
    expect(source.readSource().checkIntervalHours).toBe(FORTNIGHT_HOURS);

    // A configured source that says nothing about the interval gets it too:
    // the floor is the shipped default, not a property of being unconfigured.
    writeFileSync(
      join(dir, 'source.json'),
      JSON.stringify({ githubRepo: 'ibc/contract-tracker' }),
    );
    const configured = source.readSource();
    expect(configured.kind).toBe('github');
    expect(configured.checkIntervalHours).toBe(FORTNIGHT_HOURS);
    delete process.env['IBC_UPDATE_DIR'];

    for (const doc of [
      join(ROOT, 'packaging', 'README.md'),
      join(ROOT, 'packaging', 'app-template', 'UpdateCheck.plist.in'),
    ]) {
      expect(readFileSync(doc, 'utf8'), `${doc} no longer documents ${FORTNIGHT_HOURS}`).toContain(
        String(FORTNIGHT_HOURS),
      );
    }
  });
});

/* ══════════════════════ progress and result parsing ═══════════════════ */

describe('the seam with update.sh', () => {
  it('reads a value containing spaces, because the bundle path has one', () => {
    const dir = mkdtempSync(join(SANDBOX, 'seam-'));
    process.env['IBC_UPDATE_DIR'] = dir;
    writeFileSync(
      join(dir, 'progress'),
      [
        'phase downloading',
        'version 1.1.0',
        'fromVersion 1.0.0',
        'startedAt 2026-07-30T00:00:00Z',
        `pid ${process.pid}`,
        'note Downloading version 1.1.0 into /Applications/IBC Contracts.app',
      ].join('\n'),
    );
    const p = runtimeMod.readProgress();
    expect(p?.phase).toBe('downloading');
    expect(p?.note).toContain('/Applications/IBC Contracts.app');
    expect(p?.alive).toBe(true);
    delete process.env['IBC_UPDATE_DIR'];
  });

  it('calls a progress file whose process is gone what it is: not progress', () => {
    const dir = mkdtempSync(join(SANDBOX, 'seam-dead-'));
    process.env['IBC_UPDATE_DIR'] = dir;
    // pid 2147483647 cannot exist. An apply that the Mac slept through leaves a
    // perfectly well formed file describing something that stopped happening.
    writeFileSync(
      join(dir, 'progress'),
      ['phase unpacking', 'version 1.1.0', 'fromVersion 1.0.0', 'pid 2147483647'].join('\n'),
    );
    const p = runtimeMod.readProgress();
    expect(p?.alive).toBe(false);
    expect(runtimeMod.interruptedResult(p!).failure?.code).toBe('INTERRUPTED');
    delete process.env['IBC_UPDATE_DIR'];
  });

  it('reads only plan keys that apply.ts writes', () => {
    // The plan file is the whole instruction set handed across the process
    // boundary. A rename on either side is silent -- the shell just reads an
    // empty value -- so the two vocabularies are compared mechanically.
    const script = readFileSync(REAL_UPDATE_SH, 'utf8');
    const writer = readFileSync(join(ROOT, 'src', 'lib', 'update', 'apply.ts'), 'utf8');
    const read = new Set([...script.matchAll(/plan_get (\w+)/g)].map((m) => m[1] ?? ''));
    expect(read.size).toBeGreaterThan(5);
    for (const key of read) {
      expect(writer, `update.sh reads plan key "${key}" that apply.ts never writes`).toMatch(
        new RegExp(`\`${key} \\$\\{`),
      );
    }
  });

  it('every phase update.sh writes is a phase the type union knows', () => {
    const script = readFileSync(REAL_UPDATE_SH, 'utf8');
    const written = [...script.matchAll(/set_phase ([a-z-]+)/g)].map((m) => m[1]);
    expect(written.length).toBeGreaterThan(6);
    for (const phase of written) {
      expect(types.UPDATE_PHASES, `update.sh writes phase "${phase}"`).toContain(phase);
    }
  });

  it('every failure code update.sh writes is in the catalog', () => {
    const script = readFileSync(REAL_UPDATE_SH, 'utf8');
    const codes = [...script.matchAll(/\bfail ([A-Z_]+) /g)].map((m) => m[1] ?? '');
    expect(codes.length).toBeGreaterThan(6);
    for (const code of codes) {
      expect(failuresMod.isUpdateFailureCode(code), code).toBe(true);
    }
  });
});

/* ════════════════════════════ layout on disk ══════════════════════════ */

interface Fixture {
  readonly root: string;
  readonly bundle: string;
  readonly resources: string;
  readonly appLink: string;
  readonly updateSh: string;
  readonly serverSh: string;
  readonly dataDir: string;
  readonly updateDir: string;
  readonly port: number;
  readonly env: NodeJS.ProcessEnv;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** A minimal but real app folder: enough files for update.sh's payload check. */
function writeAppDir(dir: string, appVersion: string, opts: { broken?: boolean } = {}): void {
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  mkdirSync(join(dir, '.next'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: appVersion }));
  writeFileSync(join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'), '#!/bin/sh\n');
  writeFileSync(join(dir, '.next', 'BUILD_ID'), `build-${appVersion}\n`);
  writeFileSync(
    join(dir, 'public', 'ibc-ping.txt'),
    `com.internationalbattery.contract-tracker ${appVersion}\n`,
  );
  if (opts.broken === true) writeFileSync(join(dir, 'BROKEN'), 'this build does not start\n');
}

/**
 * A stand-in for server.sh: same lock, same port file, same liveness endpoint,
 * and -- the part that matters -- it serves public/ relative to its own working
 * directory, exactly as `next start` does. That is what makes "restart picks up
 * the new symlink target" a real observation here rather than a stub.
 */
const FAKE_SERVER = `#!/bin/sh
set -u
SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
RES_DIR=$(cd -- "$SELF_DIR/.." && pwd)
. "$SELF_DIR/common.sh"
IBC_LOG_TARGET="$IBC_LOG_DIR/fake-server.log"
mkdir -p "$IBC_RUNTIME_DIR" "$IBC_LOG_DIR" 2>/dev/null || true

APP_DIR="$RES_DIR/app"
if [ -e "$APP_DIR/BROKEN" ]; then
  ibc_log "fake server refusing to start: BROKEN marker present"
  exit 1
fi

if ! mkdir "$IBC_LOCK_DIR" 2>/dev/null; then
  STALE=$(tr -dc '0-9' <"$IBC_LOCK_DIR/pid" 2>/dev/null)
  if [ -n "\${STALE:-}" ] && kill -0 "$STALE" 2>/dev/null; then
    ibc_log "another fake server is running; standing down"
    exit 0
  fi
  rm -rf "$IBC_LOCK_DIR" 2>/dev/null
  mkdir "$IBC_LOCK_DIR" 2>/dev/null || exit 0
fi
printf '%s\\n' "$$" >"$IBC_LOCK_DIR/pid"

CHILD=""
cleanup() {
  [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null
  rm -rf "$IBC_LOCK_DIR" 2>/dev/null
}
trap 'cleanup; exit 0' TERM INT
trap 'cleanup' EXIT

printf '%s\\n' "$IBC_TEST_PORT" >"$IBC_PORT_FILE"
cd "$APP_DIR" || exit 1
ibc_log "fake server up on $IBC_TEST_PORT serving $(pwd)"
"$IBC_TEST_NODE" -e '
const http = require("node:http");
const fs = require("node:fs");
http
  .createServer((req, res) => {
    if (req.url === "/ibc-ping.txt") {
      try {
        const body = fs.readFileSync("public/ibc-ping.txt");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(body);
        return;
      } catch (e) {
        /* fall through to 404 */
      }
    }
    res.writeHead(404);
    res.end();
  })
  .listen(Number(process.argv[1]), "127.0.0.1");
' "$IBC_TEST_PORT" &
CHILD=$!
wait "$CHILD"
`;

async function makeFixture(
  name: string,
  opts: { appIsRealDirectory?: boolean; extraVersions?: string[] } = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(SANDBOX, `${name}-`));
  const bundle = join(root, 'IBC Contracts.app'); // the space is load-bearing
  const contents = join(bundle, 'Contents');
  const resources = join(contents, 'Resources');
  mkdirSync(join(resources, 'bin'), { recursive: true });
  mkdirSync(join(contents, 'MacOS'), { recursive: true });

  const port = await freePort();

  // Our own copy of common.sh with the port range narrowed to one free port.
  // Without this the probe would find, and then stop, the real installed app.
  const common = readFileSync(REAL_COMMON_SH, 'utf8').replace(
    /^IBC_PORTS=".*"$/m,
    `IBC_PORTS="${port}"`,
  );
  expect(common, 'the IBC_PORTS rewrite did not take').toContain(`IBC_PORTS="${port}"`);
  writeFileSync(join(resources, 'bin', 'common.sh'), common);
  cpSync(REAL_UPDATE_SH, join(resources, 'bin', 'update.sh'));
  writeFileSync(join(resources, 'bin', 'server.sh'), FAKE_SERVER);
  writeFileSync(join(contents, 'MacOS', 'ibc-contracts'), '#!/bin/sh\nexit 0\n');
  for (const f of ['update.sh', 'server.sh', 'common.sh']) {
    chmodSync(join(resources, 'bin', f), 0o755);
  }
  chmodSync(join(contents, 'MacOS', 'ibc-contracts'), 0o755);

  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
</dict></plist>
`,
  );

  for (const v of opts.extraVersions ?? []) writeAppDir(join(resources, `app-${v}`), v);

  if (opts.appIsRealDirectory === true) {
    // What install.command produces today, before the first update has run.
    writeAppDir(join(resources, 'app'), '1.0.0');
  } else {
    writeAppDir(join(resources, 'app-1.0.0'), '1.0.0');
    symlinkSync('app-1.0.0', join(resources, 'app'));
  }

  // Her data, which nothing in an update is allowed to touch.
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'archive'), { recursive: true });
  mkdirSync(join(dataDir, 'thumbnails'), { recursive: true });
  writeFileSync(join(dataDir, 'tracker.db'), 'PRETEND SQLITE BYTES');
  writeFileSync(join(dataDir, 'archive', 'nda.pdf'), '%PDF-1.4 pretend');

  // HOME points here so IBC_AGENT_PLIST cannot resolve to the real LaunchAgent.
  mkdirSync(join(root, 'Library', 'LaunchAgents'), { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    IBC_DATA_DIR: dataDir,
    IBC_TEST_PORT: String(port),
    IBC_TEST_NODE: process.execPath,
    IBC_UPDATE_LAUNCHD_GRACE: '3',
    IBC_UPDATE_HEALTH_TIMEOUT: '12',
    IBC_UPDATE_ROLLBACK_TIMEOUT: '20',
    IBC_UPDATE_STOP_TIMEOUT: '10',
  };
  delete env['IBC_UPDATE_DIR'];

  // The fake server runs a Node process, and a Node process that inherits
  // NODE_CHANNEL_FD attaches itself to whatever IPC channel it names -- here,
  // the vitest worker's own -- and then talks over it. Stripping these is the
  // difference between a test suite and a test suite that kills its runner.
  for (const leaky of [
    'NODE_CHANNEL_FD',
    'NODE_OPTIONS',
    'NODE_V8_COVERAGE',
    'VITEST_WORKER_ID',
    'VITEST_POOL_ID',
  ]) {
    delete env[leaky];
  }

  const fixture: Fixture = {
    root,
    bundle,
    resources,
    appLink: join(resources, 'app'),
    updateSh: join(resources, 'bin', 'update.sh'),
    serverSh: join(resources, 'bin', 'server.sh'),
    dataDir,
    updateDir: join(dataDir, 'update'),
    port,
    env,
  };
  cleanups.push(() => stopFixtureServer(fixture));
  return fixture;
}

const running = new Map<string, ChildProcess>();

function startFixtureServer(f: Fixture): void {
  const child = spawn('/bin/sh', [f.serverSh], {
    detached: true,
    stdio: 'ignore',
    env: f.env,
  });
  child.unref();
  running.set(f.root, child);
}

function stopFixtureServer(f: Fixture): void {
  const pidFile = join(f.dataDir, 'runtime', 'start.lock', 'pid');
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  const child = running.get(f.root);
  if (child !== undefined) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    running.delete(f.root);
  }
  // Anything still holding the port, whoever started it.
  spawnSync(
    '/bin/sh',
    ['-c', `lsof -n -P -t -iTCP:${f.port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`],
    { stdio: 'ignore' },
  );
}

async function servingVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ibc-ping.txt`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.text()).trim().split(/\s+/)[1] ?? null;
  } catch {
    return null;
  }
}

async function waitForVersion(port: number, want: string, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await servingVersion(port)) === want) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Build a payload tarball whose single top-level directory holds app/ (+ bin/). */
function buildPayload(
  payloadVersion: string,
  opts: { broken?: boolean; omit?: string } = {},
): { path: string; sha256: string; size: number } {
  const stage = mkdtempSync(join(SANDBOX, 'payload-'));
  const top = join(stage, `ibc-contracts-${payloadVersion}`);
  const app = join(top, 'app');
  writeAppDir(app, payloadVersion, { broken: opts.broken ?? false });
  // The payload ships a stale marker on purpose: update.sh must overwrite it, or
  // the health check could be satisfied by a version number nobody installed.
  writeFileSync(
    join(app, 'public', 'ibc-ping.txt'),
    'com.internationalbattery.contract-tracker 0.0.1\n',
  );
  if (opts.omit !== undefined) rmSync(join(app, opts.omit), { recursive: true, force: true });

  const tarball = join(stage, `payload-${payloadVersion}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', stage, `ibc-contracts-${payloadVersion}`]);
  const bytes = readFileSync(tarball);
  return {
    path: tarball,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

function writePlan(f: Fixture, lines: Record<string, string>): void {
  mkdirSync(f.updateDir, { recursive: true });
  writeFileSync(
    join(f.updateDir, 'plan'),
    `${Object.entries(lines)
      .map(([k, v]) => `${k} ${v}`)
      .join('\n')}\n`,
  );
}

/**
 * Run the applier the way the server does: detached, in its own session.
 *
 * Not a stylistic choice. update.sh leaves a supervisor running behind it, and a
 * supervisor started inside the test runner's own process group outlives the
 * test and takes the vitest worker down with it. Production spawns it detached
 * for the related reason that the applier has to survive the server it stops.
 */
async function runUpdate(f: Fixture): Promise<{ status: number; result: Map<string, string> }> {
  const status = await new Promise<number>((resolve) => {
    const child = spawn('/bin/sh', [f.updateSh], {
      env: f.env,
      detached: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // Already gone.
      }
      resolve(-2);
    }, 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });

  const result = new Map<string, string>();
  try {
    for (const line of readFileSync(join(f.updateDir, 'result'), 'utf8').split('\n')) {
      if (line === '') continue;
      const i = line.indexOf(' ');
      result.set(i === -1 ? line : line.slice(0, i), i === -1 ? '' : line.slice(i + 1));
    }
  } catch {
    // No result file: the assertions will say so.
  }
  return { status, result };
}

function dataSnapshot(f: Fixture): Record<string, string> {
  return {
    db: readFileSync(join(f.dataDir, 'tracker.db'), 'utf8'),
    pdf: readFileSync(join(f.dataDir, 'archive', 'nda.pdf'), 'utf8'),
  };
}

function versionDirs(f: Fixture): string[] {
  return readdirSync(f.resources)
    .filter((n) => /^app-\d/.test(n))
    .sort();
}

/* ════════════════════════════ shell hygiene ═══════════════════════════ */

describe('update.sh as a shell script', () => {
  const body = readFileSync(REAL_UPDATE_SH, 'utf8');

  it('parses under POSIX sh', () => {
    expect(() =>
      execFileSync('/bin/sh', ['-n', REAL_UPDATE_SH], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('declares /bin/sh and uses no bash-only constructs', () => {
    expect(body.split('\n')[0]).toBe('#!/bin/sh');
    expect(body).not.toMatch(/\[\[/);
    expect(body).not.toMatch(/^\s*local\s/m);
    expect(body).not.toMatch(/^\s*declare\s/m);
  });

  it('is plain ASCII', () => {
    const offending = [...body].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7e);
    expect(offending.join('')).toBe('');
  });

  it('cannot reach the database, the PDF archive or the thumbnails', () => {
    // The strongest form of "an update cannot lose a contract" that can be
    // asserted statically: the applier never names any of those paths, and the
    // only thing it derives from the data directory is its own update folder.
    const code = body
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    for (const forbidden of ['tracker.db', 'archive/', 'thumbnails', 'exports/']) {
      expect(code, `update.sh reaches ${forbidden}`).not.toContain(forbidden);
    }
    const usesOfDataDir = [...code.matchAll(/\$\{?IBC_DATA_DIR\b/g)];
    expect(usesOfDataDir).toHaveLength(1);
    expect(code).toContain('UPDATE_DIR="${IBC_UPDATE_DIR:-$IBC_DATA_DIR/update}"');
  });

  it('ships the production timeouts as its defaults', () => {
    // The regression suite shortens these through the environment. If the
    // shipped default ever became the short one, every rollback in the field
    // would trigger on a slow boot rather than on a broken build.
    expect(body).toContain('HEALTH_TIMEOUT="${IBC_UPDATE_HEALTH_TIMEOUT:-180}"');
    expect(body).toContain('LAUNCHD_GRACE="${IBC_UPDATE_LAUNCHD_GRACE:-20}"');
    expect(body).toContain('ROLLBACK_HEALTH_TIMEOUT="${IBC_UPDATE_ROLLBACK_TIMEOUT:-240}"');
  });

  it('never treats a launchctl exit code as evidence', () => {
    // The launcher bug, in the one other file that talks to launchd. `launchctl
    // ... && started=1` is the exact shape that caused it.
    expect(body).not.toMatch(/launchctl[^\n]*&&\s*\w+=1/);
    expect(body).toMatch(/Exit code deliberately discarded/);
  });

  it('verifies the fingerprint before it unpacks anything', () => {
    const verify = body.indexOf('shasum -a 256');
    const untar = body.indexOf('tar -xzf');
    expect(verify).toBeGreaterThan(0);
    expect(untar).toBeGreaterThan(0);
    expect(verify, 'the checksum is checked after the untar').toBeLessThan(untar);
  });

  it('only ever kills a LISTENER on the port', () => {
    // `lsof -ti tcp:PORT` lists everything holding a connection to that port as
    // well as the process listening on it -- so the browser window Bonnie is
    // looking at, and any keep-alive client. An applier that kills "whatever is
    // on the port" closes her window. Found by this suite killing its own runner.
    expect(body).not.toMatch(/lsof\s+-ti\s/);
    expect(body).toContain('-sTCP:LISTEN');
  });

  it('keeps the token off the command line', () => {
    // curl arguments are visible to every process on the machine through `ps`.
    expect(body).not.toMatch(/-H\s+["']Authorization/);
    expect(body).toContain('-K "$CURL_CONFIG"');
  });
});

/* ═════════════════════════ layout detection ═══════════════════════════ */

describe('layout detection', () => {
  it('reads the running version from the symlink, and lists what can be rolled back to', async () => {
    const f = await makeFixture('layout', { extraVersions: ['0.9.0', '1.1.0'] });
    // Point the link at 1.1.0 so the newest directory is not the answer by luck.
    rmSync(f.appLink);
    symlinkSync('app-1.1.0', f.appLink);

    process.env['IBC_APP_BUNDLE'] = f.bundle;
    const layout = installMod.detectLayout();
    delete process.env['IBC_APP_BUNDLE'];

    expect(layout.kind).toBe('bundle');
    expect(layout.currentVersion).toBe('1.1.0');
    expect(layout.appLinkIsSymlink).toBe(true);
    expect(layout.installedVersions).toEqual(['1.1.0', '1.0.0', '0.9.0']);
    expect(layout.previousVersion).toBe('1.0.0');
    expect(layout.updateScript).toBe(join(f.resources, 'bin', 'update.sh'));
    expect(layout.unsupportedReason).toBeNull();
  });

  it('falls back to Info.plist before the first update, when app is a real folder', async () => {
    const f = await makeFixture('layout-fresh', { appIsRealDirectory: true });
    process.env['IBC_APP_BUNDLE'] = f.bundle;
    const layout = installMod.detectLayout();
    delete process.env['IBC_APP_BUNDLE'];

    expect(layout.appLinkIsSymlink).toBe(false);
    expect(layout.currentVersion).toBe('1.0.0');
    expect(layout.previousVersion).toBeNull();
  });

  it('never offers the build that just failed as the way back from it', async () => {
    /*
     * The on-disk state a failed update actually leaves, reproduced exactly: the
     * broken 1.2.0 was unpacked, the applier pointed the link back at 1.1.0, and
     * for whatever reason -- an interrupted rollback, an older applier -- the
     * directory is still there. "The first installed version that is not the
     * current one", over a newest-first list, answers 1.2.0. That makes the
     * recovery from a bad update be reinstalling the bad update.
     */
    const f = await makeFixture('rollback-target', { extraVersions: ['1.1.0', '1.2.0'] });
    rmSync(f.appLink);
    symlinkSync('app-1.1.0', f.appLink);

    const dir = mkdtempSync(join(SANDBOX, 'rollback-target-state-'));
    process.env['IBC_UPDATE_DIR'] = dir;
    process.env['IBC_APP_BUNDLE'] = f.bundle;
    const layout = installMod.detectLayout();
    delete process.env['IBC_APP_BUNDLE'];
    delete process.env['IBC_UPDATE_DIR'];

    expect(layout.currentVersion).toBe('1.1.0');
    expect(layout.installedVersions).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(layout.previousVersion).toBe('1.0.0');
    expect(layout.previousVersion).not.toBe('1.2.0');
  });

  it('excludes a version the applier recorded as failing, even an older one', async () => {
    // The second belt. A directory we have watched fail to start is never the
    // right place to go, whichever side of the running version it sits on.
    const f = await makeFixture('rollback-known-bad', { extraVersions: ['0.9.0'] });
    rmSync(f.appLink);
    symlinkSync('app-1.0.0', f.appLink);

    const dir = mkdtempSync(join(SANDBOX, 'rollback-known-bad-state-'));
    writeFileSync(
      join(dir, 'result'),
      [
        'ok 0',
        'version 0.9.0',
        'fromVersion 1.0.0',
        'failPhase health-check',
        'failCode HEALTH_FAILED',
        'rolledBackTo 1.0.0',
        'rollbackOk 1',
      ].join('\n'),
    );
    process.env['IBC_UPDATE_DIR'] = dir;
    process.env['IBC_APP_BUNDLE'] = f.bundle;
    const layout = installMod.detectLayout();
    delete process.env['IBC_APP_BUNDLE'];
    delete process.env['IBC_UPDATE_DIR'];

    expect(layout.installedVersions).toEqual(['1.0.0', '0.9.0']);
    expect(layout.previousVersion).toBeNull();
  });

  it('reports a source checkout as unable to update itself', () => {
    // No IBC_APP_BUNDLE, and vitest's node is not inside a bundle.
    const layout = installMod.detectLayout();
    expect(layout.kind).toBe('development');
    expect(layout.unsupportedReason).not.toBeNull();
  });
});

/* ═════════════════════════════ the applier ════════════════════════════ */

describe('update.sh applying an update', () => {
  it('downloads, verifies, swaps, restarts, health-checks, and prunes', async () => {
    const f = await makeFixture('happy', { extraVersions: ['0.9.0'] });
    const before = dataSnapshot(f);
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

    const payload = buildPayload('1.1.0');
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status, result } = await runUpdate(f);
    expect(status, 'update.sh did not exit cleanly').toBe(0);
    expect(result.get('ok')).toBe('1');
    expect(result.get('version')).toBe('1.1.0');

    // The link moved, and the server actually restarted onto the new code.
    expect(readlinkSync(f.appLink)).toBe('app-1.1.0');
    expect(await waitForVersion(f.port, '1.1.0')).toBe(true);

    // The stale marker that shipped inside the tarball was overwritten, so the
    // health check could not have been satisfied by the payload's own claim.
    expect(
      readFileSync(join(f.resources, 'app-1.1.0', 'public', 'ibc-ping.txt'), 'utf8'),
    ).toContain('1.1.0');

    // The previous version stays: that is the rollback. The one before it goes.
    expect(versionDirs(f)).toEqual(['app-1.0.0', 'app-1.1.0']);

    // And her data is byte-identical.
    expect(dataSnapshot(f)).toEqual(before);
    stopFixtureServer(f);
  }, 120_000);

  it('refuses a payload whose fingerprint is wrong, without stopping the server', async () => {
    const f = await makeFixture('bad-sha');
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

    const payload = buildPayload('1.1.0');
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: 'f'.repeat(64),
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status, result } = await runUpdate(f);
    expect(status).toBe(1);
    expect(result.get('ok')).toBe('0');
    expect(result.get('failCode')).toBe('CHECKSUM_MISMATCH');
    expect(result.get('failPhase')).toBe('verifying');

    // Nothing was unpacked and nothing was switched. The server never noticed.
    expect(existsSync(join(f.resources, 'app-1.1.0'))).toBe(false);
    expect(readlinkSync(f.appLink)).toBe('app-1.0.0');
    expect(await servingVersion(f.port)).toBe('1.0.0');
    stopFixtureServer(f);
  }, 120_000);

  it('catches a payload that is missing part of the app before the swap', async () => {
    const f = await makeFixture('incomplete');
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

    const payload = buildPayload('1.1.0', { omit: '.next' });
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status, result } = await runUpdate(f);
    expect(status).toBe(1);
    expect(result.get('failCode')).toBe('PAYLOAD_INCOMPLETE');
    expect(result.get('failPhase')).toBe('unpacking');
    expect(readlinkSync(f.appLink)).toBe('app-1.0.0');
    expect(await servingVersion(f.port)).toBe('1.0.0');
    stopFixtureServer(f);
  }, 120_000);

  it('rolls back automatically when the new version does not come up', async () => {
    const f = await makeFixture('rollback');
    const before = dataSnapshot(f);
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

    // A build that starts and immediately dies -- the realistic shape of a bad
    // release, and the one a "did the restart command return 0" check misses.
    const payload = buildPayload('1.1.0', { broken: true });
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status, result } = await runUpdate(f);
    expect(status).toBe(1);
    expect(result.get('ok')).toBe('0');
    expect(result.get('failCode')).toBe('HEALTH_FAILED');
    expect(result.get('rolledBackTo')).toBe('1.0.0');
    expect(result.get('rollbackOk')).toBe('1');

    // Back on the old code, and it is genuinely serving again.
    expect(readlinkSync(f.appLink)).toBe('app-1.0.0');
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);
    // The build that did not start is KEPT, and only once something else was
    // confirmed serving -- self-repair reads that tree to work out why it failed,
    // and an earlier version of this deleted it, so the handover fired correctly
    // and then had nothing to diagnose. It is reclaimed at the next apply.
    //
    // It being the newest directory on disk is exactly why previousVersion filters
    // on "older than the one running" rather than "not the one running": the way
    // back from a bad build must never be the bad build.
    expect(existsSync(join(f.resources, 'app-1.1.0'))).toBe(true);
    expect(dataSnapshot(f)).toEqual(before);
    stopFixtureServer(f);
  }, 120_000);

  it('keeps waiting when launchd claims success and starts nothing', async () => {
    /*
     * The launcher bug, transplanted. `launchctl kickstart` returns 0 having
     * merely ACCEPTED the request. Here launchctl is replaced by a script that
     * always succeeds and never starts anything; the update must still end with
     * the new version serving, because the applier starts server.sh itself once
     * the grace period expires.
     */
    const f = await makeFixture('launchd-lies');
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

    const fakeBin = join(f.root, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeBin, 'launchctl'), 0o755);
    writeFileSync(
      join(f.root, 'Library', 'LaunchAgents', 'com.internationalbattery.contract-tracker.plist'),
      '<plist />\n',
    );

    const payload = buildPayload('1.1.0');
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status, result } = await runUpdate({
      ...f,
      env: { ...f.env, PATH: `${fakeBin}:${f.env['PATH'] ?? ''}` },
    });

    expect(status, 'the applier gave up on a lying launchd').toBe(0);
    expect(result.get('ok')).toBe('1');
    expect(await waitForVersion(f.port, '1.1.0')).toBe(true);

    const log = readFileSync(join(f.dataDir, 'logs', 'update.log'), 'utf8');
    expect(log).toContain('launchd accepted the request but nothing is serving');
    stopFixtureServer(f);
  }, 120_000);

  it('converts an installation that predates versioned folders', async () => {
    const f = await makeFixture('migrate', { appIsRealDirectory: true });
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);
    expect(lstatSync(f.appLink).isSymbolicLink()).toBe(false);

    const payload = buildPayload('1.1.0');
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status, result } = await runUpdate(f);
    expect(status).toBe(0);
    expect(result.get('ok')).toBe('1');
    expect(lstatSync(f.appLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(f.appLink)).toBe('app-1.1.0');
    // The folder that was there became the rollback rather than being deleted.
    expect(existsSync(join(f.resources, 'app-1.0.0', '.next', 'BUILD_ID'))).toBe(true);
    expect(await waitForVersion(f.port, '1.1.0')).toBe(true);
    stopFixtureServer(f);
  }, 120_000);

  it('goes back on request, without downloading anything', async () => {
    const f = await makeFixture('manual-rollback', { extraVersions: ['1.1.0'] });
    rmSync(f.appLink);
    symlinkSync('app-1.1.0', f.appLink);
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.1.0')).toBe(true);

    writePlan(f, {
      mode: 'rollback',
      version: '1.0.0',
      fromVersion: '1.1.0',
      resources: f.resources,
      sha256: '',
      url: '',
      sizeBytes: '0',
    });

    const { status, result } = await runUpdate(f);
    expect(status).toBe(0);
    expect(result.get('ok')).toBe('1');
    expect(readlinkSync(f.appLink)).toBe('app-1.0.0');
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);
    // Rollback never prunes: the version we came from has to stay reachable.
    expect(existsSync(join(f.resources, 'app-1.1.0'))).toBe(true);
    stopFixtureServer(f);
  }, 120_000);

  it('will not run twice at once', async () => {
    const f = await makeFixture('locked');
    mkdirSync(join(f.updateDir, 'apply.lock'), { recursive: true });
    writeFileSync(join(f.updateDir, 'apply.lock', 'pid'), `${process.pid}\n`);

    const payload = buildPayload('1.1.0');
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status } = await runUpdate(f);
    // Standing down is a normal outcome, not a failure.
    expect(status).toBe(0);
    expect(existsSync(join(f.resources, 'app-1.1.0'))).toBe(false);
    expect(readlinkSync(f.appLink)).toBe('app-1.0.0');
    // The plan is left alone for the applier that actually holds the lock.
    expect(existsSync(join(f.updateDir, 'plan'))).toBe(true);
    rmSync(join(f.updateDir, 'apply.lock'), { recursive: true, force: true });
  }, 60_000);

  it('reclaims a lock whose owner is gone', async () => {
    const f = await makeFixture('stale-lock');
    startFixtureServer(f);
    expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

    mkdirSync(join(f.updateDir, 'apply.lock'), { recursive: true });
    writeFileSync(join(f.updateDir, 'apply.lock', 'pid'), '2147483647\n');

    const payload = buildPayload('1.1.0');
    writePlan(f, {
      mode: 'apply',
      version: '1.1.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });

    const { status, result } = await runUpdate(f);
    expect(status).toBe(0);
    expect(result.get('ok')).toBe('1');
    expect(existsSync(join(f.updateDir, 'apply.lock'))).toBe(false);
    stopFixtureServer(f);
  }, 120_000);

  it('refuses to install the version that is already running', async () => {
    const f = await makeFixture('same-version');
    const payload = buildPayload('1.0.0');
    writePlan(f, {
      mode: 'apply',
      version: '1.0.0',
      fromVersion: '1.0.0',
      resources: f.resources,
      sha256: payload.sha256,
      url: `file://${payload.path}`,
      sizeBytes: String(payload.size),
    });
    const { status } = await runUpdate(f);
    expect(status).toBe(1);
    expect(readlinkSync(f.appLink)).toBe('app-1.0.0');
  }, 60_000);
});

/* ═════════════════════════════ the state file ═════════════════════════ */

describe('state', () => {
  it('survives a corrupt file rather than refusing to start', async () => {
    const dir = mkdtempSync(join(SANDBOX, 'state-'));
    process.env['IBC_UPDATE_DIR'] = dir;
    writeFileSync(join(dir, 'state.json'), '{ this is not json');
    expect(stateMod.readState()).toEqual(stateMod.EMPTY_STATE);

    stateMod.patchState({ lastCheckedAt: '2026-07-30T00:00:00.000Z' });
    expect(stateMod.readState().lastCheckedAt).toBe('2026-07-30T00:00:00.000Z');
    delete process.env['IBC_UPDATE_DIR'];
  });
});

/* ═════════════════════ handing a failure to repair ════════════════════ */

/**
 * A stand-in for the app's own HTTP surface: the liveness marker the handover
 * uses to prove which install it is talking to, and the repair endpoint, which
 * here only counts.
 */
interface RepairSpy {
  readonly server: Server;
  readonly port: number;
  readonly posts: unknown[];
}

async function startRepairSpy(servedVersion: string): Promise<RepairSpy> {
  const posts: unknown[] = [];
  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ibc-ping.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`com.internationalbattery.contract-tracker ${servedVersion}\n`);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/repair') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          posts.push(parsed);
        } catch {
          posts.push(null);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  return { server, port, posts };
}

async function waitUntil(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !condition()) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('handing a failed update to repair', () => {
  const dataRoot = join(SANDBOX, 'data');
  const portFile = join(dataRoot, 'runtime', 'port');
  const spies: RepairSpy[] = [];

  afterAll(() => {
    for (const spy of spies) spy.server.close();
    rmSync(portFile, { force: true });
    delete process.env['IBC_UPDATE_DIR'];
  });

  /** A finished update, its log, and an app answering on a known port. */
  async function arrange(
    name: string,
    resultLines: string[],
  ): Promise<{ spy: RepairSpy; dir: string }> {
    const dir = mkdtempSync(join(SANDBOX, `${name}-`));
    process.env['IBC_UPDATE_DIR'] = dir;
    writeFileSync(join(dir, 'result'), `${resultLines.join('\n')}\n`);

    mkdirSync(join(dataRoot, 'logs'), { recursive: true });
    writeFileSync(join(dataRoot, 'logs', 'update.log'), 'the applier said what it did\n');

    const spy = await startRepairSpy(installMod.detectLayout().currentVersion);
    spies.push(spy);
    mkdirSync(join(dataRoot, 'runtime'), { recursive: true });
    writeFileSync(portFile, `${spy.port}\n`);
    return { spy, dir };
  }

  const ROLLED_BACK = [
    'ok 0',
    'version 1.2.0',
    'fromVersion 1.1.0',
    'startedAt 2026-07-30T09:00:00.000Z',
    'finishedAt 2026-07-30T09:04:00.000Z',
    'failPhase health-check',
    'failCode HEALTH_FAILED',
    'message Version 1.2.0 did not start.',
    'detail version 1.2.0 did not answer within 180s',
    'rolledBackTo 1.1.0',
    'rollbackOk 1',
  ];

  it('asks for a repair exactly once, however many times it is polled', async () => {
    /*
     * The defect this pins: runRepair() had one door, POST /api/repair, and
     * nothing in the tree ever knocked on it -- an update failed, rolled back
     * correctly, and nothing happened next. The other half is the shape of the
     * fix: reconciledResult() runs on every GET /api/update, which the UI polls,
     * so a handover that were not exactly-once would be a Claude session per
     * second.
     */
    const { spy, dir } = await arrange('handoff', ROLLED_BACK);

    await serviceMod.updateStatus();
    await waitUntil(() => spy.posts.length > 0);
    expect(spy.posts, 'the rolled-back failure was never handed to repair').toHaveLength(1);

    expect(spy.posts[0]).toMatchObject({
      action: 'repair',
      failure: {
        stage: 'health-check',
        code: 'HEALTH_FAILED',
        message: 'Version 1.2.0 did not start.',
      },
      // The precondition the whole repair design rests on, sent in full.
      rollback: { performed: true, healthy: true, version: '1.1.0' },
      update: { fromVersion: '1.1.0', toVersion: '1.2.0' },
    });

    const body = spy.posts[0] as { failure: { detail?: string; logExcerpt?: string } };
    expect(body.failure.detail).toContain('did not answer within 180s');
    expect(body.failure.detail, 'the log is named so a person can go and read it').toContain(
      'update.log',
    );
    expect(body.failure.logExcerpt).toContain('the applier said what it did');

    // Recorded where the result lives, not in memory: the failures that matter
    // most are the ones that took the server down with them, and a restarted
    // process must not hand the same one over again on its first poll.
    expect(existsSync(join(dir, 'repair-handoff'))).toBe(true);

    for (let i = 0; i < 10; i += 1) await serviceMod.updateStatus();
    await new Promise((r) => setTimeout(r, 500));
    expect(spy.posts, 'a poll started a second repair').toHaveLength(1);
  }, 30_000);

  it('says nothing when the rollback did not leave a healthy install', async () => {
    // The emergency. She may be looking at a broken app right now, and that
    // needs a person reading a loud log line -- not an AI quietly thinking for
    // twenty minutes while she waits.
    const { spy } = await arrange('handoff-emergency', [
      'ok 0',
      'version 1.2.0',
      'fromVersion 1.1.0',
      'startedAt 2026-07-30T09:00:00.000Z',
      'failPhase rolling-back',
      'failCode ROLLBACK_FAILED',
      'message The update failed and going back did not work either.',
      'rolledBackTo 1.1.0',
      'rollbackOk 0',
    ]);

    for (let i = 0; i < 5; i += 1) await serviceMod.updateStatus();
    await new Promise((r) => setTimeout(r, 500));
    expect(spy.posts, 'an unrecovered install started a repair').toHaveLength(0);
  }, 30_000);

  it('says nothing about an update that worked', async () => {
    // The version in the result has to be the one actually running, or this is
    // not a success at all: a result file claiming 1.2.0 while something else
    // serves is reconciled INTO a rolled-back failure, and would rightly be
    // handed over.
    const live = installMod.detectLayout().currentVersion;
    const { spy } = await arrange('handoff-ok', [
      'ok 1',
      `version ${live}`,
      'fromVersion 1.1.0',
      'startedAt 2026-07-30T09:00:00.000Z',
      'finishedAt 2026-07-30T09:04:00.000Z',
    ]);

    for (let i = 0; i < 5; i += 1) await serviceMod.updateStatus();
    await new Promise((r) => setTimeout(r, 500));
    expect(spy.posts).toHaveLength(0);
  }, 30_000);

  it('hands over the next failure, having handed over the last one', async () => {
    // Exactly once per FAILURE, not once ever. A marker that never moved on
    // would be the same silence in a different shape.
    const { spy, dir } = await arrange('handoff-second', ROLLED_BACK);
    await serviceMod.updateStatus();
    await waitUntil(() => spy.posts.length > 0);
    expect(spy.posts).toHaveLength(1);

    writeFileSync(
      join(dir, 'result'),
      `${[
        'ok 0',
        'version 1.3.0',
        'fromVersion 1.1.0',
        'startedAt 2026-07-31T09:00:00.000Z',
        'finishedAt 2026-07-31T09:04:00.000Z',
        'failPhase unpacking',
        'failCode PAYLOAD_INCOMPLETE',
        'message That download was not a whole app.',
        'rolledBackTo 1.1.0',
        'rollbackOk 1',
      ].join('\n')}\n`,
    );

    await serviceMod.updateStatus();
    await waitUntil(() => spy.posts.length > 1);
    expect(spy.posts).toHaveLength(2);
    expect(spy.posts[1]).toMatchObject({
      failure: { stage: 'unpacking', code: 'PAYLOAD_INCOMPLETE' },
      update: { toVersion: '1.3.0' },
    });
  }, 30_000);
});

/* ═══════════════════════════════ the API ══════════════════════════════ */

describe('GET and POST /api/update', () => {
  const apiDir = join(SANDBOX, 'api-update');

  beforeAll(() => {
    mkdirSync(apiDir, { recursive: true });
    process.env['IBC_UPDATE_DIR'] = apiDir;
  });

  afterAll(() => {
    delete process.env['IBC_UPDATE_DIR'];
    delete process.env['IBC_UPDATE_MANIFEST_URL'];
  });

  it('answers with the whole shape the UI codes against', async () => {
    process.env['IBC_UPDATE_MANIFEST_URL'] = 'https://example.com/manifest.json';
    const route = await import('@/app/api/update/route');
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body: unknown = await res.json();

    expect(body).toMatchObject({
      currentVersion: expect.any(String),
      supported: expect.any(Boolean),
      source: { kind: 'url', label: 'example.com/manifest.json', automatic: false },
      available: null,
      phase: 'idle',
      installedVersions: [],
      canRollback: false,
    });
    // The shape has to be complete even when nothing has ever happened, or the
    // UI has to guess which absent field means what.
    for (const key of [
      'unsupportedReason',
      'lastCheckedAt',
      'lastCheckError',
      'progress',
      'lastResult',
      'busy',
    ]) {
      expect(body, key).toHaveProperty(key);
    }
  });

  it('reports a development checkout as unsupported rather than pretending', async () => {
    const route = await import('@/app/api/update/route');
    const body: unknown = await (await route.GET()).json();
    expect(body).toMatchObject({ supported: false });
    expect((body as { unsupportedReason: string }).unsupportedReason).toContain('checkout');
  });

  it('refuses a POST from another origin', async () => {
    const route = await import('@/app/api/update/route');
    const res = await route.POST(
      new Request('http://127.0.0.1:47821/api/update', {
        method: 'POST',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string; detail?: string } };
    expect(body.error.message).toContain('did not come from the tracker');
    // Never a stack trace, never a path.
    expect(JSON.stringify(body)).not.toContain('at Object');
  });

  it('accepts a POST from the app itself', async () => {
    const route = await import('@/app/api/update/route');
    const res = await route.POST(
      new Request('http://127.0.0.1:47821/api/update', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:47821', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; deferred: { reason: string } | null };
    // Nothing has been checked for, so there is nothing to apply -- and that is
    // a sentence, not an error.
    expect(body.accepted).toBe(false);
    expect(body.deferred?.reason).toBe('nothing-available');
  });

  it('rejects an action it does not have', async () => {
    const route = await import('@/app/api/update/route');
    const res = await route.POST(
      new Request('http://127.0.0.1:47821/api/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete-everything' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
