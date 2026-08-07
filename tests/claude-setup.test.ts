import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/*
 * claude-setup.sh, executed rather than read.
 *
 * This is the script that decides whether her Mac ends up with a working engine,
 * and the app trusts the path it writes AHEAD of its own four discovery probes.
 * So the two properties that matter are asserted by running it:
 *
 *   - it records a path only for a binary that actually executes
 *   - it never exits non-zero, whatever happens
 *
 * The second is the constraint, not a nicety. Its caller runs under `set -e`, so
 * a non-zero exit here is a failed install -- and the most likely reason for this
 * script to fail is that her Mac had no network the morning she ran it. Losing the
 * whole tracker over that would be the worst trade in the product.
 *
 * Nothing here reaches the network. A stub `claude` on PATH stands in for a real
 * install, and the no-network case is produced by pointing curl at a stub too.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'packaging', 'app-template', 'bin', 'claude-setup.sh');

const teardown: (() => void)[] = [];
afterAll(() => {
  for (const fn of teardown) fn();
});

interface Run {
  readonly status: number;
  readonly out: string;
  readonly recorded: string | null;
}

/** A sandbox with its own HOME, its own data dir, and a stub bin dir on PATH. */
function sandbox(): { dir: string; bin: string; data: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ibc-claude-setup-'));
  teardown.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'stubbin');
  const data = join(dir, 'data');
  mkdirSync(bin, { recursive: true });
  mkdirSync(data, { recursive: true });
  return { dir, bin, data };
}

function stub(bin: string, name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(s: { dir: string; bin: string; data: string }, args: string[] = []): Run {
  const r = spawnSync('/bin/sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: s.dir,
      IBC_DATA_DIR: s.data,
      // Only the stubs, plus what the script genuinely needs from the system.
      PATH: `${s.bin}:/usr/bin:/bin`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const recordedAt = join(s.data, 'runtime', 'claude-path');
  return {
    status: r.status ?? -1,
    out: `${r.stdout}${r.stderr}`,
    recorded: existsSync(recordedAt) ? readFileSync(recordedAt, 'utf8').trim() : null,
  };
}

describe('claude-setup.sh', () => {
  const mac = process.platform === 'darwin';

  it('parses under /bin/sh', () => {
    // A syntax error in a script launchd runs is a silent no-op, and this one is
    // reached only on someone else's Mac.
    const r = spawnSync('/bin/sh', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it.skipIf(!mac)('records the path of a claude that already works', () => {
    const s = sandbox();
    stub(s.bin, 'claude', 'exit 0');
    const r = run(s);
    expect(r.status).toBe(0);
    expect(r.recorded).toBe(join(s.bin, 'claude'));
    expect(r.out).toContain('Claude Code is ready');
  });

  it.skipIf(!mac)('finds an install that is not on PATH', () => {
    // The whole reason the app cannot rely on `which`: a LaunchAgent-launched
    // process does not see ~/.local/bin, so the known locations are searched too.
    const s = sandbox();
    mkdirSync(join(s.dir, '.local', 'bin'), { recursive: true });
    const bin = join(s.dir, '.local', 'bin', 'claude');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    const r = run(s, ['--check']);
    expect(r.status).toBe(0);
    expect(r.recorded).toBe(bin);
  });

  it.skipIf(!mac)('refuses to record a binary that does not run', () => {
    // The dangerous case. The app prefers this path over its own probes, so a
    // path written for something broken takes a working install offline.
    const s = sandbox();
    stub(s.bin, 'claude', 'exit 3');
    const r = run(s, ['--check']);
    expect(r.status).toBe(0);
    expect(r.recorded).toBeNull();
    expect(r.out).toContain('could not be set up');
  });

  it.skipIf(!mac)('exits 0 and records nothing when there is no network', () => {
    // curl fails, so nothing installs. This must cost her a sentence, not the
    // tracker: the caller runs under `set -e`.
    const s = sandbox();
    stub(s.bin, 'curl', 'exit 6'); // 6 = could not resolve host
    const r = run(s);
    expect(r.status).toBe(0);
    expect(r.recorded).toBeNull();
    expect(r.out).toContain('still opens');
  });

  it.skipIf(!mac)('exits 0 when the download is an error page rather than a script', () => {
    // A proxy or a captive portal answers 200 with HTML. Piping that to sh is
    // noise on stderr and no install, which must land in the same place.
    const s = sandbox();
    stub(s.bin, 'curl', 'printf "<html>404</html>\\n"; exit 0');
    const r = run(s);
    expect(r.status).toBe(0);
    expect(r.recorded).toBeNull();
  });

  it.skipIf(!mac)('clears a stale recorded path when setup fails', () => {
    // Left behind, the app keeps preferring a binary that no longer runs instead
    // of falling through to the probes that might still find a good one.
    const s = sandbox();
    mkdirSync(join(s.data, 'runtime'), { recursive: true });
    writeFileSync(join(s.data, 'runtime', 'claude-path'), '/gone/claude\n');
    stub(s.bin, 'curl', 'exit 6');
    const r = run(s);
    expect(r.status).toBe(0);
    expect(r.recorded).toBeNull();
  });

  it.skipIf(!mac)('installs nothing in --check mode', () => {
    // The mode the app uses to re-probe without touching the machine.
    const s = sandbox();
    stub(s.bin, 'curl', 'printf "curl-was-called\\n" >&2; exit 0');
    const r = run(s, ['--check']);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('curl-was-called');
  });
});
