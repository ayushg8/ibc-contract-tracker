/**
 * Regression tests for the update surface: the tab she reads, the LaunchAgent
 * that wakes the check up, and the workflow that produces what it finds.
 *
 * None of this can fail loudly on her Mac. A broken update check is silent by
 * construction -- it looks exactly like "no new version" -- so the properties
 * that make it trustworthy are asserted here instead:
 *
 *   - a malformed /api/update answer degrades into "not known", never a throw
 *   - the fortnightly agent parses, holds no verb that can install anything,
 *     and reads the HTTP status rather than believing curl's exit code
 *   - the release workflow cannot publish something that failed a test, and
 *     produces the payload layout update.sh actually unpacks
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fillPlistTemplate, readPlist } from './plist-support';

import {
  describeCadence,
  describeInstalled,
  describeNextCheck,
  describeOutcome,
  describePhase,
  describeRepair,
  describeStamp,
  describeWhen,
  toRepairView,
  toUpdateView,
  type UpdateView,
} from '../src/components/settings/UpdatesTab';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLIST = join(ROOT, 'packaging', 'app-template', 'UpdateCheck.plist.in');
const COMMON = join(ROOT, 'packaging', 'app-template', 'bin', 'common.sh');
const UPDATE_SH = join(ROOT, 'packaging', 'app-template', 'bin', 'update.sh');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'release.yml');
// The payload builder. release.yml used to keep its own copy of the assembly
// steps; it calls this instead, so that the tarball she installs from and the
// tarball she updates through are produced by one piece of code and cannot
// drift apart. The assertions below that used to read the workflow read this.
const MAKE_DIST = join(ROOT, 'packaging', 'make-distributable.sh');
const TABS = join(ROOT, 'src', 'components', 'settings', 'SettingsTabs.tsx');
const RUNBOOK = join(ROOT, 'packaging', 'README.md');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/* ─────────────────────── reading GET /api/update ─────────────────────── */

/** The shape src/lib/update/types.ts says the route answers with. */
const FULL: unknown = {
  currentVersion: '1.0.0',
  supported: true,
  unsupportedReason: null,
  source: {
    kind: 'github',
    label: 'github.com/ibc/tracker',
    automatic: false,
    checkIntervalHours: 336,
  },
  available: {
    version: '1.1.0',
    publishedAt: '2026-07-28T10:00:00.000Z',
    sizeBytes: 42 * 1024 * 1024,
    notes: 'Expiry dates now read the notice period.',
    critical: false,
    applicable: true,
    blockedReason: null,
  },
  lastCheckedAt: '2026-07-20T09:00:00.000Z',
  lastCheckError: null,
  phase: 'idle',
  progress: null,
  lastResult: {
    ok: false,
    version: '1.0.9',
    fromVersion: '1.0.0',
    startedAt: '2026-07-25T10:58:00.000Z',
    finishedAt: '2026-07-25T11:00:00.000Z',
    failure: {
      code: 'CHECKSUM_MISMATCH',
      phase: 'verifying',
      message: 'The download did not match its published fingerprint.',
      detail: 'expected aa, got bb',
      rolledBackTo: '1.0.0',
      rollbackOk: true,
      logPath: '/somewhere/update.log',
    },
  },
  installedVersions: ['1.0.0', '0.9.0'],
  canRollback: true,
  busy: null,
};

function view(): UpdateView {
  const parsed = toUpdateView(FULL);
  if (parsed === null) throw new Error('the fixture is not readable');
  return parsed;
}

function viewWith(patch: Partial<UpdateView>): UpdateView {
  return { ...view(), ...patch };
}

describe('toUpdateView', () => {
  it('reads a complete answer', () => {
    const v = view();
    expect(v.currentVersion).toBe('1.0.0');
    expect(v.available?.version).toBe('1.1.0');
    expect(v.available?.applicable).toBe(true);
    expect(v.source.configured).toBe(true);
    expect(v.source.checkIntervalHours).toBe(336);
    expect(v.lastResult?.failure?.rolledBackTo).toBe('1.0.0');
    expect(v.previousVersion).toBe('0.9.0');
    expect(v.canRollback).toBe(true);
  });

  it('refuses an answer with no version, because every headline needs one', () => {
    expect(toUpdateView({ supported: true })).toBeNull();
    expect(toUpdateView(null)).toBeNull();
    expect(toUpdateView('1.0.0')).toBeNull();
    expect(toUpdateView([{ currentVersion: '1.0.0' }])).toBeNull();
  });

  it('degrades a half-written answer instead of throwing', () => {
    // Two agents own the two ends of this contract. A field that arrives as the
    // wrong type has to read as "not known" -- a screen that throws while an
    // update is installing is the worst possible moment for it.
    const v = toUpdateView({
      currentVersion: '1.0.0',
      supported: 'yes',
      source: { kind: 'none', checkIntervalHours: -4 },
      available: { publishedAt: '2026-07-28T10:00:00.000Z' },
      phase: 'teleporting',
      lastResult: { ok: true },
      installedVersions: 'lots',
      canRollback: true,
    });
    expect(v).not.toBeNull();
    expect(v?.supported).toBe(true);
    expect(v?.source.configured).toBe(false);
    expect(v?.source.checkIntervalHours).toBe(24);
    // available with no version is not an update she can be offered.
    expect(v?.available).toBeNull();
    expect(v?.phase).toBe('idle');
    // A result with no version cannot be matched to an attempt, so it is dropped.
    expect(v?.lastResult).toBeNull();
    // No previous version on disk means rollback is not a thing to offer.
    expect(v?.previousVersion).toBeNull();
    expect(v?.canRollback).toBe(false);
  });

  it('assumes an update cannot be applied unless the server says it can', () => {
    // The safe direction. Offering a button that cannot work is the worse
    // mistake: she presses it, nothing happens, and she has no idea why.
    const v = toUpdateView({ currentVersion: '1.0.0', available: { version: '2.0.0' } });
    expect(v?.available?.applicable).toBe(false);
  });

  it('reads a phase that is actually in flight', () => {
    const v = toUpdateView({
      currentVersion: '1.0.0',
      phase: 'downloading',
      progress: { phase: 'downloading', version: '1.1.0', note: null, alive: true },
    });
    expect(v?.phase).toBe('downloading');
    expect(v?.progress?.version).toBe('1.1.0');
  });

  it('names every phase the updater can report', () => {
    // The map in the tab is keyed by the upstream union, so a phase added there
    // fails the build here rather than reaching her as the word "swapping".
    const phases = read(join(ROOT, 'src', 'lib', 'update', 'types.ts'))
      .split('export const UPDATE_PHASES')[1]
      ?.split(']')[0];
    expect(phases).toBeDefined();
    for (const m of (phases ?? '').matchAll(/'([a-z-]+)'/g)) {
      const phase = m[1] ?? '';
      const parsed = toUpdateView({ currentVersion: '1.0.0', phase });
      expect(parsed?.phase, `${phase} is not in the tab's phase map`).toBe(phase);
    }
  });
});

describe('toRepairView', () => {
  it('says nothing when self-repair is idle', () => {
    expect(toRepairView({ phase: 'idle' })).toBeNull();
    expect(toRepairView(null)).toBeNull();
  });

  it('reads a run paused on a usage limit', () => {
    const repair = toRepairView({
      phase: 'waiting-limit',
      resumeAt: '2026-07-30T15:00:00.000Z',
      scheduled: true,
      attemptsUsed: 1,
      attemptCap: 3,
      emergency: null,
    });
    expect(repair?.phase).toBe('waiting-limit');
    expect(repair?.resumeAt).toBe('2026-07-30T15:00:00.000Z');
    expect(repair?.emergency).toBe(false);
  });
});

/* ───────────────────────────── plain words ───────────────────────────── */

const NOW = new Date('2026-07-30T12:00:00');

describe('describeWhen', () => {
  it('says today, yesterday and tomorrow rather than a date', () => {
    expect(describeWhen('2026-07-30T09:15:00', NOW)).toMatch(/^today at /);
    expect(describeWhen('2026-07-29T09:15:00', NOW)).toMatch(/^yesterday at /);
    expect(describeWhen('2026-07-31T09:15:00', NOW)).toMatch(/^tomorrow at /);
  });

  it('names the weekday inside the week and the date beyond it', () => {
    expect(describeWhen('2026-08-03T12:20:00', NOW)).toBe('on Monday');
    expect(describeWhen('2026-08-13T12:20:00', NOW)).toMatch(/^on /);
    expect(describeWhen('2026-08-13T12:20:00', NOW)).not.toBe('on Monday');
  });

  it('has no opinion about a missing or unparseable time', () => {
    expect(describeWhen(null, NOW)).toBeNull();
    expect(describeWhen('soon', NOW)).toBeNull();
  });
});

describe('describeStamp', () => {
  it('never prints an ISO string at her', () => {
    const stamp = describeStamp('2026-07-01T09:00:00.000Z');
    expect(stamp).not.toContain('T');
    expect(stamp).not.toContain('Z');
  });

  it('says so when there is nothing to print', () => {
    expect(describeStamp(null)).toBe('Not known');
    expect(describeStamp('whenever')).toBe('Not known');
  });
});

describe('describeCadence', () => {
  it('says a fortnight in words, not in hours', () => {
    expect(describeCadence(336)).toBe('every two weeks');
    expect(describeCadence(168)).toBe('every week');
    expect(describeCadence(24)).toBe('every day');
    expect(describeCadence(48)).toBe('every 2 days');
    expect(describeCadence(6)).toBe('every 6 hours');
  });
});

describe('describeNextCheck', () => {
  it('works out when the next one falls due and says it in words', () => {
    // Last checked 20 July, every 336 hours: due 3 August, a Monday.
    const line = describeNextCheck(view(), NOW);
    expect(line).toContain('Every two weeks');
    expect(line).toContain('on Monday');
    // The sleep case is the one that otherwise reads as a missed fortnight.
    expect(line).toMatch(/asleep or off/);
  });

  it('says "next time you open it" rather than a date in the past', () => {
    const line = describeNextCheck(viewWith({ lastCheckedAt: '2026-01-01T09:00:00.000Z' }), NOW);
    expect(line).toContain('next time you open it');
  });

  it('says plainly when nothing is set up to check', () => {
    const line = describeNextCheck(
      viewWith({ source: { ...view().source, configured: false } }),
      NOW,
    );
    expect(line).toContain('Ayush');
  });

  it('reads the interval rather than assuming a fortnight', () => {
    const line = describeNextCheck(
      viewWith({ source: { ...view().source, checkIntervalHours: 24 }, lastCheckedAt: null }),
      NOW,
    );
    expect(line).toContain('every day');
  });
});

describe('describePhase', () => {
  it('names the version for the phases that are working on one', () => {
    expect(
      describePhase(
        { phase: 'downloading', version: '1.1.0', note: null, alive: true },
        'downloading',
      ),
    ).toBe('Downloading version 1.1.0...');
  });

  it('has a sentence for every phase, including the restart', () => {
    expect(
      describePhase({ phase: 'restarting', version: null, note: null, alive: true }, 'restarting'),
    ).toBe('Restarting the tracker...');
    expect(
      describePhase(
        { phase: 'health-check', version: null, note: null, alive: true },
        'health-check',
      ),
    ).toBe('Making sure it came back up...');
    expect(
      describePhase(
        { phase: 'rolling-back', version: null, note: null, alive: true },
        'rolling-back',
      ),
    ).toBe('Putting the previous version back...');
  });

  it('lets the server say it better if it has something to say', () => {
    expect(
      describePhase(
        { phase: 'verifying', version: '1.1.0', note: 'Checking the fingerprint', alive: true },
        'verifying',
      ),
    ).toBe('Checking the fingerprint');
  });

  it('falls back to the top-level phase when there is no progress record', () => {
    expect(describePhase(null, 'starting')).toBe('Getting ready...');
  });
});

describe('describeOutcome', () => {
  it('leads with what is still true, not with what broke', () => {
    const result = view().lastResult;
    expect(result).not.toBeNull();
    if (result === null) return;
    const words = describeOutcome(result, '1.0.0');
    expect(words).toContain('back on version 1.0.0');
    expect(words).toContain('None of your contracts were touched.');
    // No alarm, and nothing she is expected to do about it.
    expect(words).not.toMatch(/error|crash|corrupt|fatal/i);
  });

  it('says nothing was installed when nothing was', () => {
    const words = describeOutcome(
      {
        ok: false,
        version: '1.1.0',
        fromVersion: '1.0.0',
        finishedAt: null,
        failure: {
          message: 'The download did not finish.',
          detail: null,
          rolledBackTo: null,
          rollbackOk: false,
        },
      },
      '1.0.0',
    );
    expect(words).toContain('Nothing was installed');
    expect(words).toContain('still on version 1.0.0');
  });

  it('names the one case that genuinely needs Ayush, still without alarm', () => {
    const words = describeOutcome(
      {
        ok: false,
        version: '1.1.0',
        fromVersion: '1.0.0',
        finishedAt: null,
        failure: {
          message: 'The rollback did not finish.',
          detail: null,
          rolledBackTo: '1.0.0',
          rollbackOk: false,
        },
      },
      '1.1.0',
    );
    expect(words).toContain('Ayush');
    expect(words).toContain('None of your contracts were touched');
  });
});

describe('describeRepair', () => {
  it('gives the time a paused fix resumes', () => {
    const words = describeRepair(
      {
        phase: 'waiting-limit',
        resumeAt: '2026-07-30T15:00:00',
        scheduled: true,
        attemptsUsed: 1,
        attemptCap: 3,
        emergency: false,
      },
      NOW,
    );
    expect(words).toMatch(/today at /);
    expect(words).toContain('carries on by itself');
  });

  it('says something calm for every phase repair can be in', () => {
    const phases = read(join(ROOT, 'src', 'lib', 'repair', 'types.ts'))
      .split('export type RepairPhase =')[1]
      ?.split(';')[0];
    expect(phases).toBeDefined();
    for (const m of (phases ?? '').matchAll(/'([a-z-]+)'/g)) {
      const phase = m[1] ?? '';
      if (phase === 'idle') continue;
      const parsed = toRepairView({ phase, attemptsUsed: 0, attemptCap: 3 });
      expect(parsed, `${phase} is not in the tab's repair map`).not.toBeNull();
      if (parsed === null) continue;
      const words = describeRepair(parsed, NOW);
      expect(words.length, `${phase} has no sentence`).toBeGreaterThan(20);
      expect(words).not.toMatch(/error|exception|stack|traceback/i);
    }
  });
});

describe('describeInstalled', () => {
  it('uses the result that put this version here', () => {
    const v = viewWith({
      lastResult: {
        ok: true,
        version: '1.0.0',
        fromVersion: '0.9.0',
        finishedAt: '2026-07-01T09:00:00.000Z',
        failure: null,
      },
    });
    expect(describeInstalled(v)).not.toBe('With the app');
    expect(describeInstalled(v)).not.toContain('T');
  });

  it('says so plainly when this copy came from the installer', () => {
    expect(describeInstalled(viewWith({ lastResult: null }))).toBe('With the app');
    // A failed attempt at a different version says nothing about this one.
    expect(describeInstalled(view())).toBe('With the app');
  });
});

/* ─────────────────────────── the settings tab ────────────────────────── */

describe('the Updates tab is reachable', () => {
  const body = read(TABS);

  it('is registered, rendered, and mounted only while it is showing', () => {
    expect(body).toContain("{ id: 'updates'");
    expect(body).toContain('<UpdatesTab />');
    expect(body).toMatch(/<TabsContent value="updates">/);
    expect(body).toMatch(/\|\s*'updates'/);
  });

  it('sits before Diagnostics, which is where support starts', () => {
    expect(body.indexOf("id: 'updates'")).toBeLessThan(body.indexOf("id: 'diagnostics'"));
  });
});

/* ──────────────────────── the fortnightly agent ──────────────────────── */

/** The plist with its tokens filled in, as JSON. Parser per ./plist-support. */
function filledPlist(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'ibc-update-plist-'));
  try {
    const file = join(dir, 'agent.plist');
    writeFileSync(file, fillPlistTemplate(read(PLIST)));
    return readPlist(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function agentScript(): string {
  const args = filledPlist()['ProgramArguments'];
  expect(Array.isArray(args)).toBe(true);
  const list = args as unknown[];
  expect(list[0]).toBe('/bin/sh');
  expect(list[1]).toBe('-c');
  const script = list[2];
  expect(typeof script).toBe('string');
  return String(script);
}

describe('UpdateCheck.plist', () => {
  const body = read(PLIST);

  it('is plain ASCII', () => {
    expect([...body].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7e)).toEqual([]);
  });

  it('is a valid plist once its tokens are filled in', () => {
    expect(() => filledPlist()).not.toThrow();
  });

  it('every token it declares is documented for the installer', () => {
    // install.command is not this pass's file, so the runbook carries the sed
    // stanza. A token that appears here and nowhere in the runbook is a token
    // that ships as the literal string "@@LABEL@@".
    const runbook = read(RUNBOOK);
    const tokens = new Set(body.match(/@@[A-Z_]+@@/g) ?? []);
    expect(tokens.size).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(runbook, `${token} is never substituted in the runbook`).toContain(`s|${token}|`);
    }
  });

  it('fires weekly and also at load, because a calendar cannot say fortnightly', () => {
    const plist = filledPlist();
    expect(plist['StartCalendarInterval']).toEqual({ Weekday: 1, Hour: 12, Minute: 20 });
    // RunAtLoad is the powered-off case: launchd replays a calendar interval
    // missed while asleep, but not reliably one missed while shut down.
    expect(plist['RunAtLoad']).toBe(true);
  });

  it('is Background, unlike the server agent, because nobody is waiting on it', () => {
    const plist = filledPlist();
    expect(plist['ProcessType']).toBe('Background');
    // No KeepAlive: a failed check is a failed check, not something to relaunch
    // in a loop against GitHub.
    expect(plist['KeepAlive']).toBeUndefined();
  });

  it('parses under POSIX sh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ibc-update-sh-'));
    try {
      const file = join(dir, 'check.sh');
      writeFileSync(file, `#!/bin/sh\n${agentScript()}`);
      expect(() => execFileSync('/bin/sh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses no bash-only constructs', () => {
    const script = agentScript();
    expect(script).not.toMatch(/\[\[/);
    expect(script).not.toMatch(/^\s*local\s/m);
    expect(script).not.toMatch(/^\s*declare\s/m);
  });

  it('holds no verb that can change anything', () => {
    // Silent auto-install on a system of record is how she finds out by the
    // thing being different. GET is also the interval-floored path: a POST
    // check would force one on every weekly fire.
    const script = agentScript();
    expect(script).not.toMatch(/-X\s+POST/);
    expect(script).not.toContain('--data');
    expect(script).not.toContain('apply');
    expect(script).toContain('/api/update');
  });

  it('reads the HTTP status rather than believing curl exited 0', () => {
    // The launcher's lesson: launchctl returned 0 having merely accepted a
    // request. curl exits 0 for a 404 from a foreign server on the port.
    const script = agentScript();
    expect(script).toContain("-w '%{http_code}'");
    expect(script).toMatch(/if \[ "\$CODE" != "200" \]/);
  });

  it('reuses the shared port sweep instead of hardcoding a port', () => {
    const script = agentScript();
    expect(script).toContain('ibc_running_port');
    expect(script).not.toMatch(/127\.0\.0\.1:4\d{4}/);
    expect(read(COMMON)).toContain('ibc_running_port()');
  });

  it('bounds the request by wall clock', () => {
    expect(agentScript()).toMatch(/--max-time \d+/);
  });
});

/* ─────────────── the agent, run against a stub of the app ─────────────── */

/**
 * The shell above is asserted; this runs it. A plist that parses and a plist
 * that finds the server are different claims, and only one of them is the one
 * that matters at 12:20 on a Monday.
 */
describe('the fortnightly agent, actually run', () => {
  let server: Server;
  let port = 0;
  let status = 200;
  let pingStatus = 200;
  let hits = 0;
  let lastMethod: string | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/ibc-ping.txt') {
        res.writeHead(pingStatus, { 'Content-Type': 'text/plain' });
        res.end('ok\n');
        return;
      }
      if (req.url === '/api/update') {
        hits += 1;
        lastMethod = req.method ?? null;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ currentVersion: '1.0.0' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // An ephemeral port, and common.sh narrowed to it below. Binding a real
    // one would make this suite collide with a dev server, or with the other
    // update suite, for no gain: what is under test is the shell, not the port.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Runs the agent's script the way launchd does: sh -c SCRIPT sh COMMON_SH.
   *
   * Spawned, not execFileSync: the stub above is served by this same process,
   * and a synchronous child blocks the event loop that would have answered it.
   */
  function run(dataDir: string, common: string = COMMON): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', agentScript(), 'sh', common], {
        stdio: 'ignore',
        env: { ...process.env, IBC_DATA_DIR: dataDir },
      });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });
  }

  /**
   * A copy of common.sh whose port sweep is narrowed to the stub. IBC_PORTS is
   * assigned, not defaulted, so it cannot be overridden from the environment,
   * and leaving the real range in place would make this suite depend on nothing
   * else holding 47821-47830 -- which a dev server routinely does.
   */
  function commonWithOnly(only: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'ibc-update-common-'));
    const file = join(dir, 'common.sh');
    const body = read(COMMON).replace(/^IBC_PORTS=".*"$/m, `IBC_PORTS="${only}"`);
    expect(body).toContain(`IBC_PORTS="${only}"`);
    writeFileSync(file, body);
    return file;
  }

  function scratch(recorded: number | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'ibc-update-run-'));
    if (recorded !== null) {
      mkdirSync(join(dir, 'runtime'), { recursive: true });
      writeFileSync(join(dir, 'runtime', 'port'), `${recorded}\n`);
    }
    return dir;
  }

  it('reads /api/update on the port that is actually serving, and only reads', async () => {
    hits = 0;
    status = 200;
    const dir = scratch(port);
    const common = commonWithOnly(port);
    try {
      expect(await run(dir, common)).toBe(0);
      expect(hits).toBe(1);
      expect(lastMethod).toBe('GET');
      expect(read(join(dir, 'logs', 'update.log'))).toContain('answered 200');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores something else on the port, and exits clean', async () => {
    // Her Mac at 12:20 with the tracker closed and any other server holding the
    // port. Not an error: there is nothing to check and nothing to tell her.
    // Asking a stranger for an update would be the bug.
    hits = 0;
    pingStatus = 404;
    const dir = scratch(port);
    const common = commonWithOnly(port);
    try {
      expect(await run(dir, common)).toBe(0);
      expect(hits).toBe(0);
      expect(read(join(dir, 'logs', 'update.log'))).toContain('no server is answering');
    } finally {
      pingStatus = 200;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when the server answers with something other than 200', async () => {
    // launchd records a non-zero exit. A check that silently "succeeded"
    // against a 500 is a fortnight of nothing, with no line to find.
    status = 500;
    const dir = scratch(port);
    const common = commonWithOnly(port);
    try {
      expect(await run(dir, common)).not.toBe(0);
      expect(read(join(dir, 'logs', 'update.log'))).toContain('answered 500');
    } finally {
      status = 200;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ───────────────────────── the release workflow ──────────────────────── */

describe('release.yml', () => {
  const body = read(WORKFLOW);

  it('is plain ASCII', () => {
    expect([...body].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7e)).toEqual([]);
  });

  it('runs on a tag', () => {
    expect(body).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*- 'v\*'/);
  });

  it('cannot publish without typecheck, tests and build passing first', () => {
    // The gate. Everything else in this file is downstream of it.
    expect(body).toContain('npx tsc --noEmit');
    expect(body).toContain('npx vitest run');
    expect(body).toContain('npx next build');
    expect(body).toMatch(/package:\n(?:.*\n)*?\s*needs: verify/);
    expect(body).toMatch(/publish:\n(?:.*\n)*?\s*needs: \[verify, package\]/);
  });

  it('watches the finished tarball serve a request before publishing it', () => {
    // An exit code is a claim. `next build` exiting 0 does not mean the thing
    // starts, and the update client would inherit that.
    //
    // The smoke lives inside the payload builder now, which means Ayush gets it
    // too when he builds the download by hand -- it is not a step that only the
    // release path happens to run.
    const build = body.indexOf('make-distributable.sh --payload-only');
    const publish = body.indexOf('name: Publish\n');
    expect(build).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(build);
    const builder = read(MAKE_DIST);
    expect(builder).toContain('/ibc-ping.txt');
    expect(builder).toContain('tar -xzf "$TARBALL" -C "$SMOKE_DIR" --strip-components 1');
  });

  it('bounds the smoke wait by wall clock, not by iterations', () => {
    const builder = read(MAKE_DIST);
    expect(builder).toMatch(/DEADLINE=\$\(\(\$\(date \+%s\) \+ \d+\)\)/);
    expect(builder).toMatch(/while \[ "\$\(date \+%s\)" -lt "\$DEADLINE" \]/);
  });

  it('builds on macOS, once per processor, and checks the runner really is one', () => {
    expect(body).toContain('runner: macos-14');
    expect(body).toContain('runner: macos-13');
    expect(body).toContain('arch: arm64');
    expect(body).toContain('arch: x64');
    expect(body).toContain('uname -m');
  });

  it('builds its payload with the one payload builder', () => {
    // Two copies of the assembly steps is two payload formats waiting to
    // disagree, and the disagreement would only show up on her Mac.
    expect(body).toMatch(/sh packaging\/make-distributable\.sh --payload-only --out "\$TARBALL"/);
  });

  it('produces the layout update.sh unpacks', () => {
    // update.sh strips one component and then insists on app/ plus three files
    // inside it. Getting this wrong is PAYLOAD_INCOMPLETE on her Mac.
    expect(read(UPDATE_SH)).toContain('--strip-components 1');
    const builder = read(MAKE_DIST);
    expect(builder).toContain('TOP="$WORK/stage/ibc-contracts-$VERSION"');
    expect(builder).toContain('mkdir -p "$APP" "$TOP/bin"');
    for (const need of ['package.json', 'node_modules/next/dist/bin/next', '.next/BUILD_ID']) {
      expect(builder, `the builder does not assert ${need}`).toContain(need);
    }
    // The scripts update.sh is allowed to refresh, so a bug in the supervisor
    // or in the updater itself does not need a reinstall.
    // Iterated off disk, not a hand-maintained list: repair.sh was added later and
    // was silently absent from every payload precisely because a list had to be
    // remembered. A glob cannot forget.
    expect(builder).toContain('for f in "$TEMPLATE"/bin/*.sh; do');
    expect(builder).toContain('launcher.sh');
  });

  it('ships production node_modules from the lockfile, and a prebuilt .next', () => {
    const builder = read(MAKE_DIST);
    expect(builder).toContain('npm ci --omit=dev');
    // A dev-dependency leftover would ride onto her Mac verbatim.
    expect(builder).toContain('rm -rf "$APP/node_modules"');
    // And the build cache is not the build: it is scratch space Next recreates,
    // and it was 641 MB of the .next on the machine this was measured on.
    expect(builder).toContain('rm -rf "$APP/.next/cache"');
  });

  it('never lets a key ride along in the payload', () => {
    const builder = read(MAKE_DIST);
    // A glob, not the two names. `.env` and `.env.local` was the list, and
    // .env.example sits in the repository root and went straight past it.
    expect(builder).toContain("--exclude '.env*'");
    expect(builder).toContain('an env file reached the payload');
  });

  it('writes a manifest in the shape the client parses', () => {
    expect(body).toContain('schemaVersion: 1');
    expect(body).toContain('sha256: $sha');
    expect(body).toContain('sizeBytes: $size');
    expect(body).toMatch(/\[ "\$\{#sha\}" -eq 64 \]/);
    expect(body).toContain('shasum -a 256');
    // One per processor: node_modules is platform-gated, and the schema
    // describes exactly one payload.
    expect(body).toContain('write_manifest arm64 manifest.json');
    expect(body).toContain('write_manifest x64 manifest-darwin-x64.json');
    // asset: resolves through the Releases API, so a private repo works too.
    expect(body).toContain('"asset:ibc-contracts-${VERSION}-darwin-arm64.tar.gz"');
  });

  it('refuses a tag that disagrees with the version the app reports', () => {
    expect(body).toContain('IBC_VERSION');
    expect(body).toMatch(/if \[ "\$version" != "\$declared" \]/);
  });

  it('fetches the published manifest itself rather than trusting the upload', () => {
    // Through the API, along the same two hops as resolveFromGithub(): the
    // browser-facing /releases/latest/download/ form it used to curl is a 404 on
    // a private repository whatever token is presented, and this repository is
    // private -- so that check would have failed every good release, while
    // proving the one manifest shape her Mac does not use.
    expect(body).toContain('/releases/latest');
    expect(body).toContain('select(.name == "manifest.json")');
    expect(body).toContain('Accept: application/octet-stream');
    expect(body).toContain('Authorization: Bearer ${GH_TOKEN}');
    expect(body).toContain('--verify-tag');
  });
});

/* ─────────────────────────────── the runbook ──────────────────────────── */

describe('the runbook', () => {
  const body = read(RUNBOOK);

  it('is plain ASCII', () => {
    expect([...body].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7e)).toEqual([]);
  });

  it('says how to cut a release, check she got it, and roll one back', () => {
    expect(body).toContain('### Cutting a release');
    expect(body).toContain('### Checking she got it');
    expect(body).toContain('### Rolling one back');
  });

  it('spells out the fortnight, since nothing in launchd can express it', () => {
    expect(body).toContain('checkIntervalHours');
    expect(body).toContain('336');
  });

  it('says never to re-cut a version number', () => {
    expect(body).toMatch(/never a re-cut/);
  });
});
