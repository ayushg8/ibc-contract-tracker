/**
 * Regression tests for the macOS packaging.
 *
 * None of this ships inside the app, so nothing here can be caught by the rest
 * of the suite -- and every bug in it lands on a CFO's Mac with no Terminal and
 * no way to describe what she is seeing. So the properties that make the
 * install survivable are asserted mechanically:
 *
 *   - the shell parses (a typo in a .command is a silent no-op on a double click)
 *   - the launcher can never hang without a dialog
 *   - the .app opens the port that is actually serving, not a literal
 *   - the uninstaller cannot delete her contracts
 *   - the Node pin is above the node:sqlite floor and its checksums are real
 *   - the icon generator emits every size iconutil expects, at the right pixels
 *   - every script in the bundle is staged, shipped and removable
 *
 * The last one is not theoretical. update.sh and repair.sh were both written,
 * neither was ever staged by the installer, and the entire update-rollback-
 * repair mechanism was therefore unreachable on her Mac while every unit test
 * for it passed. Hand-maintained lists of filenames are the recurring shape of
 * that bug, so the assertions below compare against the directory instead.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = join(ROOT, 'packaging');
const TPL = join(PKG, 'app-template');
const BIN = join(TPL, 'bin');

const INSTALL = join(PKG, 'install.command');
const UNINSTALL = join(PKG, 'uninstall.command');
const MAKE_DIST = join(PKG, 'make-distributable.sh');
const LAUNCHER = join(TPL, 'launcher.sh');
const COMMON = join(BIN, 'common.sh');
const SERVER = join(BIN, 'server.sh');
const UPDATE = join(BIN, 'update.sh');
const INFO_PLIST = join(TPL, 'Info.plist.in');
const AGENT_PLIST = join(TPL, 'LaunchAgent.plist.in');
const UPDATECHECK_PLIST = join(TPL, 'UpdateCheck.plist.in');
const RELEASE_WORKFLOW = join(ROOT, '.github', 'workflows', 'release.yml');
const MAKE_ICON = join(ROOT, 'scripts', 'make-icon.mjs');

/**
 * Read off disk, never listed here. A script added to the bundle joins every
 * assertion in this file the moment it exists, which is the only arrangement
 * under which "the installer forgot one" cannot happen twice.
 */
const BIN_SCRIPTS: readonly string[] = readdirSync(BIN)
  .filter((n) => n.endsWith('.sh'))
  .sort();

const SHELL_SCRIPTS = [
  INSTALL,
  UNINSTALL,
  MAKE_DIST,
  LAUNCHER,
  ...BIN_SCRIPTS.map((n) => join(BIN, n)),
];
const ALL_SOURCES = [
  ...SHELL_SCRIPTS,
  INFO_PLIST,
  AGENT_PLIST,
  UPDATECHECK_PLIST,
  MAKE_ICON,
  join(PKG, 'README.md'),
];

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** The value of a `KEY="value"` assignment in common.sh. */
function shellVar(name: string): string {
  const m = new RegExp(`^${name}="([^"]*)"`, 'm').exec(read(COMMON));
  expect(m, `${name} is not assigned in common.sh`).not.toBeNull();
  return m?.[1] ?? '';
}

describe('shell scripts', () => {
  it.each(SHELL_SCRIPTS)('%s parses under POSIX sh', (file) => {
    // A syntax error in a .command shows the user a Terminal window that
    // closes instantly with no explanation, so this is the single most
    // valuable assertion in the file.
    expect(() => execFileSync('/bin/sh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(SHELL_SCRIPTS)('%s declares /bin/sh, not bash', (file) => {
    expect(read(file).split('\n')[0]).toBe('#!/bin/sh');
  });

  it.each(SHELL_SCRIPTS)('%s uses no bash-only constructs', (file) => {
    const body = read(file);
    // [[ ]], arrays and `local` are the three that silently work in an
    // interactive zsh and then fail under the /bin/sh the .app actually uses.
    //
    // The trailing space matters: bash's test keyword is always `[[ `, whereas
    // a POSIX character class is `[[:cntrl:]]`. Matching a bare `[[` condemned
    // the entirely correct `grep -q '[[:cntrl:]]'` in repair.sh.
    expect(body).not.toMatch(/\[\[\s/);
    expect(body).not.toMatch(/^\s*declare\s/m);
    expect(body).not.toMatch(/^\s*local\s/m);
  });

  it('the double-clickable scripts are executable', () => {
    for (const file of [INSTALL, UNINSTALL]) {
      expect(statSync(file).mode & 0o111, `${file} is not executable`).not.toBe(0);
    }
  });

  it.each(ALL_SOURCES)('%s is plain ASCII', (file) => {
    const offending = [...read(file)].filter((ch) => ch.codePointAt(0)! > 0x7e);
    expect(offending).toEqual([]);
  });

  it('never escalates to sudo', () => {
    // Comments are allowed to say the word; code is not. A password prompt is
    // a step she cannot complete.
    for (const file of SHELL_SCRIPTS) {
      const code = read(file)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      expect(code, `${file} reaches for sudo`).not.toMatch(/\bsudo\b/);
    }
  });
});

describe('the Node runtime pin', () => {
  it('is at or above the node:sqlite floor of 22.5', () => {
    const version = shellVar('IBC_NODE_VERSION');
    const m = /^v(\d+)\.(\d+)\.\d+$/.exec(version);
    expect(m, `IBC_NODE_VERSION "${version}" is not a vN.N.N version`).not.toBeNull();
    const major = Number(m?.[1]);
    const minor = Number(m?.[2]);
    expect(major).toBeGreaterThanOrEqual(22);
    if (major === 22) expect(minor).toBeGreaterThanOrEqual(5);
  });

  it('carries a real SHA256 for both processors', () => {
    for (const name of ['IBC_NODE_SHA256_ARM64', 'IBC_NODE_SHA256_X64']) {
      expect(shellVar(name), name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(shellVar('IBC_NODE_SHA256_ARM64')).not.toBe(shellVar('IBC_NODE_SHA256_X64'));
  });

  it('verifies the download before unpacking it', () => {
    const body = read(INSTALL);
    const verify = body.indexOf('checksum_ok "$NODE_CACHED"');
    const unpack = body.indexOf('tar -xzf "$NODE_CACHED"');
    expect(verify).toBeGreaterThan(-1);
    expect(unpack).toBeGreaterThan(verify);
  });

  it('detects the processor rather than assuming one', () => {
    const body = read(COMMON);
    expect(body).toMatch(/uname -m/);
    expect(body).toMatch(/arm64/);
    expect(body).toMatch(/x86_64/);
  });
});

describe('ports', () => {
  const ports = shellVar('IBC_PORTS').trim().split(/\s+/).map(Number);

  it('offers more than one candidate', () => {
    expect(ports.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('avoids the ports everything else already uses', () => {
    for (const p of ports) {
      expect([3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888]).not.toContain(p);
    }
  });

  it('stays below the macOS ephemeral range so the OS cannot hand one out', () => {
    for (const p of ports) {
      expect(p).toBeGreaterThan(1023);
      expect(p).toBeLessThan(49152);
    }
  });

  it('walks the range instead of failing when one is taken', () => {
    const body = read(SERVER);
    expect(body).toMatch(/for p in \$IBC_PORTS/);
    expect(body).toMatch(/ibc_port_free/);
  });

  it('records the chosen port before the server binds it', () => {
    const body = read(SERVER);
    const write = body.indexOf('>"$IBC_PORT_FILE"');
    const start = body.indexOf('"$NEXT_BIN" start');
    expect(write).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(write);
  });

  it('opens the port that is serving, never a literal', () => {
    // The bug this guards: a hardcoded port in the launcher means that the one
    // time the server has to move, the icon opens a window at nothing.
    const body = read(LAUNCHER);
    expect(body).not.toMatch(/127\.0\.0\.1:\d/);
    expect(body).not.toMatch(/localhost:\d/);
    expect(body).toMatch(/ibc_running_port/);
  });
});

describe('the liveness probe', () => {
  // The bug this whole block exists for, found by running the thing: the
  // launcher polled /api/health once a second while waiting for startup. That
  // endpoint spawns the Claude CLI on every call, so fifteen of them piled up
  // and the server stopped answering anything for ten minutes. Waiting for the
  // app to start was what stopped it starting.
  it('never polls an endpoint that runs application code', () => {
    for (const file of [COMMON, SERVER, LAUNCHER]) {
      const code = read(file)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      expect(code, `${file} probes an API route`).not.toMatch(/\/api\//);
    }
  });

  it('asks for a static file, and requires exactly 200', () => {
    const common = read(COMMON);
    expect(common).toMatch(/IBC_PING_PATH="\/[A-Za-z0-9._-]+"/);
    expect(common).toMatch(/ibc_http_code "http:\/\/127\.0\.0\.1:\$1\$IBC_PING_PATH"/);
    expect(common).toMatch(/\)" = "200" \]/);
  });

  it('is served by a marker the installer actually writes', () => {
    const pingPath = /IBC_PING_PATH="(\/[A-Za-z0-9._-]+)"/.exec(read(COMMON))?.[1] ?? '';
    expect(pingPath).not.toBe('');
    // public/<name> is what Next serves at /<name>.
    expect(read(INSTALL)).toContain(`"$APP_SRC/public${pingPath}"`);
  });

  it('writes the marker before the build, not after', () => {
    const body = read(INSTALL);
    const write = body.indexOf('public/ibc-ping.txt');
    const build = body.indexOf('next/dist/bin/next build');
    expect(write).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(write);
  });

  it('filters with a TCP connect so a closed port costs nothing', () => {
    expect(read(COMMON)).toMatch(/nc -z/);
  });
});

describe('the launcher', () => {
  const body = read(LAUNCHER);

  it('bounds every wait by wall clock', () => {
    // Hanging forever is worse than failing: there is nothing on screen to
    // report and nothing to click. Counting iterations is not a bound either --
    // with a 5s probe timeout, "90 iterations" is up to 9 minutes.
    expect(body).toMatch(/LIMIT=\d+/);
    expect(body).toMatch(/DEADLINE=\$\(\(\$\(date \+%s\) \+ LIMIT\)\)/);
    expect(body).toMatch(/while \[ "\$\(date \+%s\)" -lt "\$DEADLINE" \]/);
    expect(body).not.toMatch(/waited \+ 1/);
  });

  it('ends a failed wait in a dialog, not in silence', () => {
    expect(body).toMatch(/fail_and_exit/);
    expect(read(COMMON)).toMatch(/display dialog/);
  });

  it('passes dialog text as an argument so no path needs escaping', () => {
    // Building the AppleScript string by hand broke the first time a path
    // contained a quote.
    expect(read(COMMON)).toMatch(/on run argv/);
    expect(read(COMMON)).toMatch(/item 1 of argv/);
  });

  it('resolves its own bundle through symlinks', () => {
    expect(body).toMatch(/resolve_self/);
    expect(body).toMatch(/while \[ -L /);
  });

  it('prefers Chrome app mode and falls back to the default browser', () => {
    const common = read(COMMON);
    expect(common).toMatch(/open -na "Google Chrome" --args --app=/);
    expect(common).toMatch(/-d "\$HOME\/Applications\/Google Chrome\.app"/);
    // The fallback must be a plain `open`, i.e. whatever browser she uses.
    expect(common).toMatch(/open "\$_url"/);
  });

  it('never starts a second server when one is already answering', () => {
    const fastPath = body.indexOf('if PORT=$(ibc_running_port); then');
    const coldStart = body.indexOf('launchctl kickstart');
    expect(fastPath).toBeGreaterThan(-1);
    expect(coldStart).toBeGreaterThan(fastPath);
  });
});

describe('server.sh', () => {
  const body = read(SERVER);

  it('takes an atomic lock', () => {
    // mkdir is the atomic primitive; a test-then-write on a lock file is not.
    expect(body).toMatch(/mkdir "\$IBC_LOCK_DIR"/);
  });

  it('reclaims a lock whose owner is gone', () => {
    expect(body).toMatch(/kill -0 "\$STALE_PID"/);
  });

  it('idles instead of starting a second server', () => {
    // Idle, not exit: exiting 0 while KeepAlive is watching is a respawn loop,
    // and idling means this supervisor takes over if the other one stops.
    const check = body.indexOf('if RUNNING=$(ibc_running_port); then');
    const start = body.indexOf('"$NEXT_BIN" start');
    expect(check).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(check);
    expect(body).toMatch(/if RUNNING=\$\(ibc_running_port\); then[\s\S]{0,200}?continue/);
  });

  it('restarts its own child rather than trusting launchd KeepAlive', () => {
    // Measured on macOS 26: after the child was killed, server.sh exited 137
    // and launchd parked the respawn on its "successful exit" semaphore and
    // never fired it. A crashed server has to heal either way.
    expect(body).toMatch(/^while true; do$/m);
    expect(body).toMatch(/server exited with status \$STATUS; restarting/);
    // ...but not forever, if it can never come up.
    expect(body).toMatch(/MAX_FAILURES=\d+/);
    expect(body).toMatch(/FAILURES" -ge "\$MAX_FAILURES"/);
  });

  it('holds the lock for the supervisor lifetime, not just startup', () => {
    expect(body).not.toMatch(/^cleanup_lock$/m);
    expect(body).toMatch(/trap 'cleanup_lock' EXIT/);
  });

  it('bounds startup by wall clock', () => {
    expect(body).toMatch(/DEADLINE=\$\(\(\$\(date \+%s\) \+ HEALTH_TIMEOUT\)\)/);
    expect(body).toMatch(/while \[ "\$\(date \+%s\)" -lt "\$DEADLINE" \]/);
    expect(body).not.toMatch(/waited \+ 1/);
  });

  it('binds loopback only', () => {
    // Contracts on a laptop that joins hotel wifi. Never 0.0.0.0.
    expect(body).toMatch(/-H 127\.0\.0\.1/);
    expect(body).not.toMatch(/0\.0\.0\.0/);
  });
});

describe('Info.plist', () => {
  const body = read(INFO_PLIST);

  it.each([
    'CFBundleName',
    'CFBundleIdentifier',
    'CFBundleIconFile',
    'CFBundleExecutable',
    'CFBundleShortVersionString',
    'CFBundleVersion',
    'LSMinimumSystemVersion',
  ])('declares %s', (key) => {
    expect(body).toContain(`<key>${key}</key>`);
  });

  it('is valid once its tokens are filled in', () => {
    expectValidPlistTemplate(INFO_PLIST);
  });
});

describe('the LaunchAgent', () => {
  const body = read(AGENT_PLIST);

  it('runs at login', () => {
    expect(body).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('restarts on a crash but not on a clean exit', () => {
    // SuccessfulExit=false is load bearing: "another copy is already serving"
    // is a clean exit, and restarting that is an infinite loop.
    expect(body).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
  });

  it('is Interactive, so macOS does not throttle its disk I/O', () => {
    // The single worst bug found while testing this. Under ProcessType
    // Background the server booted in 18.9s instead of 0.6s and then answered
    // nothing at all for two minutes -- indistinguishable from a hang, and
    // impossible for her to describe over the phone.
    expect(body).toMatch(/<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
    expect(body).not.toContain('<string>Background</string>');
  });

  it('throttles restarts', () => {
    expect(body).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/);
  });

  it('logs into the app data directory', () => {
    expect(body).toContain('<key>StandardOutPath</key>');
    expect(body).toContain('<key>StandardErrorPath</key>');
    const install = read(INSTALL);
    expect(install).toMatch(/s\|@@STDOUT@@\|\$IBC_LOG_DIR\//);
    expect(install).toMatch(/s\|@@STDERR@@\|\$IBC_LOG_DIR\//);
  });

  it('gives launchd a PATH that can find the claude CLI', () => {
    // launchd hands a job almost no environment; without this the CLI engine
    // reports "claude not found" on a machine where it is plainly installed.
    expect(body).toContain('<key>PATH</key>');
    expect(read(INSTALL)).toMatch(/AGENT_PATH=.*\.local\/bin/);
  });

  it('runs the same server.sh the launcher does', () => {
    expect(body).toContain('@@SERVER_SH@@');
    expect(read(INSTALL)).toMatch(/@@SERVER_SH@@\|\$APP_PATH\/Contents\/Resources\/bin\/server\.sh/);
  });

  it('is valid once its tokens are filled in', () => {
    expectValidPlistTemplate(AGENT_PLIST);
  });

  it('is installed into ~/Library/LaunchAgents', () => {
    expect(shellVar('IBC_AGENT_PLIST')).toBe('$HOME/Library/LaunchAgents/$IBC_AGENT_LABEL.plist');
  });
});

function expectValidPlistTemplate(file: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'ibc-plist-'));
  try {
    const filled = read(file).replace(/@@[A-Z_]+@@/g, 'placeholder');
    const out = join(dir, 'test.plist');
    execFileSync('/bin/sh', ['-c', `cat > "$1"`, 'sh', out], { input: filled });
    expect(() => execFileSync('plutil', ['-lint', out], { stdio: 'pipe' })).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the update-check agent', () => {
  const body = read(UPDATECHECK_PLIST);

  it('is valid once its tokens are filled in', () => {
    expectValidPlistTemplate(UPDATECHECK_PLIST);
  });

  it('runs at load as well as on the calendar', () => {
    // A Mac that was switched off at the appointed minute does not get a
    // replayed calendar fire. RunAtLoad is what covers that.
    expect(body).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(body).toContain('<key>StartCalendarInterval</key>');
  });

  it('can only ever offer an update, never install one', () => {
    // GET is the whole guarantee. A POST of {"action":"check"} would force a
    // check on every fire, and a job with a state-changing verb in it is one
    // step from a silent auto-install on a system of record.
    expect(body).not.toMatch(/-X\s*POST|--request\s*POST|-d\s*'/);
    expect(body).toContain('/api/update');
  });

  it('checks the status rather than trusting curl exit code', () => {
    // curl exits 0 having reached a 404 from something else on the port. The
    // same lesson launchctl taught the launcher.
    expect(body).toMatch(/%\{http_code\}/);
    expect(body).toMatch(/\[ "\$CODE" != "200" \]/);
  });

  it('is Background, unlike the server agent, because nobody is waiting', () => {
    expect(body).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  });
});

describe('template tokens', () => {
  it('every @@TOKEN@@ is substituted by the installer', () => {
    const install = read(INSTALL);
    for (const file of [INFO_PLIST, AGENT_PLIST, UPDATECHECK_PLIST]) {
      const tokens = new Set(read(file).match(/@@[A-Z_]+@@/g) ?? []);
      expect(tokens.size, `${file} has no tokens`).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(install, `${token} from ${file} is never substituted`).toContain(`s|${token}|`);
      }
    }
  });

  it('leaves no token behind in what it writes', () => {
    // Guards the reverse mistake: a sed line for a token the template renamed.
    const install = read(INSTALL);
    const declared = new Set([
      ...(read(INFO_PLIST).match(/@@[A-Z_]+@@/g) ?? []),
      ...(read(AGENT_PLIST).match(/@@[A-Z_]+@@/g) ?? []),
      ...(read(UPDATECHECK_PLIST).match(/@@[A-Z_]+@@/g) ?? []),
    ]);
    for (const m of install.matchAll(/s\|(@@[A-Z_]+@@)\|/g)) {
      expect(declared, `${m[1]} is substituted but no template uses it`).toContain(m[1]);
    }
  });
});

describe('the uninstaller', () => {
  const body = read(UNINSTALL);

  it('cannot delete the contracts', () => {
    // Every destructive command in the file, checked against the one path that
    // must survive. This is the assertion that matters most in this suite.
    const destructive = body.match(/^\s*(?:rm|rmdir|ditto|mv|find)\b.*$/gm) ?? [];
    expect(destructive.length).toBeGreaterThan(0);
    for (const line of destructive) {
      expect(line, `destructive line targets the data directory: ${line}`).not.toMatch(
        /IBC_DATA_DIR|Application Support/,
      );
    }
  });

  it('only ever deletes inside the app, a LaunchAgent or the cache', () => {
    const rmLines = body.match(/^\s*rm\s+.*$/gm) ?? [];
    expect(rmLines.length).toBeGreaterThan(0);
    for (const line of rmLines) {
      expect(line).toMatch(/IBC_APP_NAME|AGENT_PLIST|IBC_CACHE_DIR|IBC_LOCK_DIR/);
    }
  });

  it('removes every agent this product installs, not just the server one', () => {
    // Three exist: the server agent, the fortnightly updatecheck agent written
    // by the installer, and the repair agent, which is created at RUNTIME
    // whenever a repair defers on a usage limit. Booting out one label left the
    // others behind, polling a port on a Mac with no tracker on it.
    //
    // A glob rather than three names, so the next sibling is caught without
    // anyone remembering to come back here -- and anchored on the label, so it
    // can only ever match this product's own plists.
    expect(body).toContain('"$HOME/Library/LaunchAgents/$IBC_AGENT_LABEL"*.plist');
    // Booted out by the label read back off each plist, because an unloaded
    // agent whose file is gone is still loaded until launchd is told.
    expect(body).toMatch(/AGENT_LABEL=\$\(basename "\$AGENT_PLIST" \.plist\)/);
    expect(body).toMatch(/launchctl bootout "gui\/\$\(id -u\)\/\$AGENT_LABEL"/);
  });

  it('says on screen that the contracts are kept', () => {
    expect(body).toMatch(/YOUR CONTRACTS ARE KEPT/);
    expect(body).toMatch(/\$IBC_DATA_DIR/);
  });

  it('makes you confirm', () => {
    expect(body).toMatch(/ANSWER" != "remove"/);
  });

  it('removes the LaunchAgents and the app', () => {
    expect(body).toMatch(/launchctl bootout/);
    expect(body).toMatch(/rm -f "\$AGENT_PLIST"/);
    expect(body).toMatch(/IBC_APP_NAME\.app/);
  });
});

describe('the installer', () => {
  const body = read(INSTALL);

  it('falls back to ~/Applications rather than needing an admin password', () => {
    expect(body).toMatch(/-w "\/Applications"/);
    expect(body).toMatch(/APPS_DIR="\$HOME\/Applications"/);
  });

  it('assembles the bundle locally instead of shipping one', () => {
    // A .app created on the machine has no com.apple.quarantine, which is the
    // entire reason this works without a paid signing certificate.
    expect(readdirSync(TPL)).not.toContain('IBC Contracts.app');
    expect(body).toMatch(/mkdir -p "\$STAGE\/Contents\/MacOS"/);
  });

  it('is idempotent: it moves an existing install aside and can roll back', () => {
    expect(body).toMatch(/mv "\$APP_PATH" "\$APP_PATH\.old"/);
    expect(body).toMatch(/mv "\$APP_PATH\.old" "\$APP_PATH"/);
  });

  it('stops the old server before replacing its files', () => {
    const bootout = body.indexOf('launchctl bootout');
    const move = body.indexOf('mv "$APP_PATH" "$APP_PATH.old"');
    expect(bootout).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(bootout);
  });

  it('never copies a developer .env into her app', () => {
    // Keys live in the Keychain. One must never ride along in a copy.
    //
    // A GLOB, not the two names. `.env` and `.env.local` was the list, and
    // .env.example sits in the repository root and sailed straight past it.
    // .env.production is the next one that would have.
    expect(body).toMatch(/--exclude '\.env\*'/);
  });

  it('installs from the lockfile so two installs match', () => {
    expect(body).toMatch(/npm ci|"\$NPM_BIN" ci/);
  });

  it('starts the agent explicitly instead of trusting RunAtLoad', () => {
    // Measured on macOS 26: `launchctl bootstrap` does not honour RunAtLoad,
    // not even for an agent that declares nothing else. Without the explicit
    // kickstart the tracker is not running until her next login.
    const bootstrap = body.indexOf('launchctl bootstrap "gui/$(id -u)" "$IBC_AGENT_PLIST"');
    const kickstart = body.indexOf('launchctl kickstart "gui/$(id -u)/$IBC_AGENT_LABEL"');
    expect(bootstrap).toBeGreaterThan(-1);
    expect(kickstart).toBeGreaterThan(bootstrap);
  });

  it('runs doctor and reports its result', () => {
    expect(body).toMatch(/run --silent doctor/);
    expect(body).toMatch(/DOCTOR_STATUS/);
  });

  it('uses the final paths after the bundle moves', () => {
    // A NODE_BIN still pointing into the staging directory is a bug that only
    // appears after the move, i.e. on the machine that matters.
    const move = body.indexOf('mv "$STAGE" "$APP_PATH"');
    const rebind = body.indexOf('NODE_BIN="$APP_PATH/Contents/Resources/node/bin/node"');
    const doctor = body.indexOf('run --silent doctor');
    expect(rebind).toBeGreaterThan(move);
    expect(doctor).toBeGreaterThan(rebind);
  });

  it('explains failures instead of printing a stack trace', () => {
    expect(body).toMatch(/What went wrong:/);
    expect(body).toMatch(/What to do:/);

    // Every call site passes a cause AND a remedy. `fail` with one argument
    // would print an empty "What to do:", which is the exact dead end this
    // whole error taxonomy exists to prevent.
    // Join shell line continuations first, so a call split over three lines
    // reads the same as one written inline.
    const joined = body.replace(/\\\n\s*/g, ' ');
    const calls = [...joined.matchAll(/(?:^|\s)fail((?: +"[^"]*")+)/g)];
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      const args = (call[1] ?? '').match(/"[^"]*"/g) ?? [];
      expect(args.length, `fail(...) with ${args.length} argument(s): ${call[0]}`).toBe(2);
      for (const arg of args) expect(arg.length).toBeGreaterThan(2);
    }
  });

  it('references every template it needs', () => {
    for (const rel of [
      'Info.plist.in',
      'LaunchAgent.plist.in',
      'UpdateCheck.plist.in',
      'launcher.sh',
    ]) {
      expect(body).toContain(rel);
      expect(() => statSync(join(TPL, rel))).not.toThrow();
    }
  });

  it('stages every script in the bundle, by iterating the folder', () => {
    // THE bug this whole block exists for. install.command named common.sh and
    // server.sh and stopped there, so a freshly installed Resources/bin held
    // exactly those two: no update.sh, no repair.sh, detectLayout() found no
    // updater, and update, rollback and self-repair were all unreachable on the
    // one machine that matters -- with a green test suite the whole time.
    //
    // The fix is not "add the two missing names". It is to stop keeping a list.
    expect(body).toMatch(/for SCRIPT in "\$TEMPLATE"\/bin\/\*\.sh; do/);
    expect(body).toMatch(/cp "\$SCRIPT" "\$STAGE\/Contents\/Resources\/bin\/\$SCRIPT_NAME"/);
    expect(body).toMatch(/chmod 755 "\$STAGE\/Contents\/Resources\/bin\/\$SCRIPT_NAME"/);

    // And no leftover copy-by-name, which would be the same bug in the same
    // shape. (Sourcing common.sh for its constants is a different thing and is
    // still allowed -- the installer has to read the pins from somewhere.)
    for (const name of BIN_SCRIPTS) {
      expect(body, `${name} is copied by name; iterate bin/ instead`).not.toContain(
        `cp "$TEMPLATE/bin/${name}"`,
      );
    }
  });

  it('installs the fortnightly update checker as its own agent', () => {
    // Without it the tracker only notices a new version if she happens to open
    // Settings. She is a CFO who will not open Terminal; "she must receive
    // fixes without doing anything" is the whole requirement.
    expect(body).toMatch(/UPDATECHECK_LABEL="\$IBC_AGENT_LABEL\.updatecheck"/);
    expect(body).toMatch(
      /UPDATECHECK_PLIST="\$HOME\/Library\/LaunchAgents\/\$UPDATECHECK_LABEL\.plist"/,
    );
    expect(body).toContain('"$TEMPLATE/UpdateCheck.plist.in" >"$UPDATECHECK_PLIST"');
    // Malformed plists load as nothing at all, silently.
    expect(body).toMatch(/plutil -lint "\$UPDATECHECK_PLIST"/);
  });

  it('kickstarts the update checker too, instead of trusting RunAtLoad', () => {
    // Same measured reason as the server agent: `bootstrap` accepts the job and
    // does not honour RunAtLoad, so without the explicit kickstart the first
    // check does not happen until her next login. An exit code is a claim.
    const bootout = body.indexOf('launchctl bootout "gui/$(id -u)/$UPDATECHECK_LABEL"');
    const bootstrap = body.indexOf('launchctl bootstrap "gui/$(id -u)" "$UPDATECHECK_PLIST"');
    const kickstart = body.indexOf('launchctl kickstart "gui/$(id -u)/$UPDATECHECK_LABEL"');
    expect(bootout).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(bootout);
    expect(kickstart).toBeGreaterThan(bootstrap);
  });

  it('installs from a download without npm, a registry or a build', () => {
    // The reason this whole artifact exists. Running `npm ci` and `next build`
    // on her Mac means dev dependencies, a toolchain she does not have, minutes
    // of waiting and a class of failure she cannot read, describe or fix.
    // Both are still here for Ayush, who installs from a checkout -- so what
    // matters is that they are unreachable in the mode she uses.
    const region = body.slice(
      body.indexOf('# --- 4 and 5.'),
      body.indexOf('# --- 6. bundle plumbing'),
    );
    expect(region.length).toBeGreaterThan(0);
    const guard = region.indexOf('if [ "$MODE" = "source" ]; then');
    expect(guard).toBeGreaterThan(-1);
    expect(region.indexOf('"$NPM_BIN" ci'), 'npm ci is not behind the source guard').toBeGreaterThan(
      guard,
    );
    expect(region.indexOf('next build'), 'next build is not behind the source guard').toBeGreaterThan(
      guard,
    );
    // And nowhere else in the file.
    expect(body.split('"$NPM_BIN" ci').length - 1).toBe(1);
    expect(body.split('next build').length - 1).toBe(1);
  });

  it('consumes the same payload format the updater does', () => {
    // One format, two paths. If the installer ever grew its own layout, a
    // payload that installs would not necessarily be a payload that updates,
    // and the difference would only show up on her Mac, months later.
    expect(body).toContain('--strip-components 1');
    const required = read(UPDATE).match(/for _need in ([^\n;]*); do/);
    for (const need of (required?.[1] ?? '').trim().split(/\s+/)) {
      expect(body, `the installer accepts a payload with no ${need}`).toContain(need);
    }
  });

  it('checks the payload fingerprint before it unpacks anything', () => {
    // The same rule the Node download follows: a corrupt archive that gets
    // unpacked anyway is a tracker that half works, and half working is the one
    // outcome a system of record cannot have.
    const check = body.indexOf('do not match their fingerprint');
    const unpack = body.indexOf('tar -xzf "$PAYLOAD_FILE"');
    expect(check).toBeGreaterThan(-1);
    expect(unpack).toBeGreaterThan(check);
  });

  it('takes the Node fingerprint from common.sh, not from the folder it arrived in', () => {
    // Otherwise a tampered download could supply the answer that clears it.
    expect(body).toContain('NODE_EXPECTED=$(ibc_node_sha256 "$ARCH")');
    expect(body).not.toMatch(/manifest_str\s+nodeSha/);
  });

  it('strips quarantine from the whole bundle, not from two places in it', () => {
    // Measured on a real install from a real download: AirDrop quarantines the
    // zip, Archive Utility stamps everything it unzips, and macOS tar stamps
    // everything it extracts from a quarantined tarball -- 263 files inside
    // Contents/Resources carried the flag, and the old two-line version looked
    // only at the bundle directory and Contents/MacOS.
    expect(body).toMatch(/xattr -rd com\.apple\.quarantine "\$STAGE"/);
    // The move is what publishes the bundle. Stripping after it would leave a
    // window where the app in /Applications is the quarantined one.
    const strip = body.indexOf('xattr -rd com.apple.quarantine "$STAGE"');
    const move = body.indexOf('mv "$STAGE" "$APP_PATH"');
    expect(strip).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(strip);
  });

  it('draws the icon from the tree it just installed, not from a checkout', () => {
    // There is no checkout in a download. Both modes put the same file in the
    // same place, so this is one path rather than two.
    expect(body).toContain('"$APP_SRC/scripts/make-icon.mjs"');
    expect(body).not.toContain('"$REPO_ROOT/scripts/make-icon.mjs"');
  });

  it('never lets a missing update checker fail the whole install', () => {
    // It is the unattended half of updates, not the app. Failing the install
    // over it would trade a working tracker for a scheduling detail.
    const kickstart = body.indexOf('launchctl kickstart "gui/$(id -u)/$UPDATECHECK_LABEL"');
    const tail = body.slice(kickstart);
    expect(tail).toMatch(/Updates can/);
    expect(tail.slice(0, tail.indexOf('# --- 8'))).not.toMatch(/^\s*fail /m);
  });
});

/*
 * The installer, run for real against a fabricated download.
 *
 * Everything above is a reading of the source. These four are not: they build a
 * folder shaped like the one she unzips and run install.command against it. All
 * four are refusals that happen in step one, before a single byte is downloaded
 * and before anything is written outside the sandbox -- which is what makes
 * them cheap enough to keep in the suite.
 *
 * HOME is redirected, so the data directory, the cache and the LaunchAgents all
 * land in the sandbox. macOS only: the first thing install.command checks is
 * `uname -s`, so on any other platform these would prove nothing.
 */
describe('the installer, against a fabricated download', () => {
  const mac = process.platform === 'darwin';

  interface Refusal {
    readonly status: number;
    readonly out: string;
  }

  function fabricate(opts: {
    arch: string;
    version: string;
    sha?: string;
    payload?: boolean;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), 'ibc-download-'));
    teardown.push(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(dir, 'kit', 'payload'), { recursive: true });
    const kit = join(dir, 'kit');
    cpSync(INSTALL, join(kit, 'install.command'));
    chmodSync(join(kit, 'install.command'), 0o755);
    cpSync(TPL, join(kit, 'app-template'), { recursive: true });

    const tarball = `ibc-contracts-${opts.version}-darwin-${opts.arch}.tar.gz`;
    if (opts.payload !== false) {
      writeFileSync(join(kit, 'payload', tarball), 'not a real payload\n');
    }
    writeFileSync(
      join(kit, 'manifest.json'),
      [
        '{',
        '  "schemaVersion": 1,',
        `  "version": "${opts.version}",`,
        `  "arch": "${opts.arch}",`,
        `  "url": "payload/${tarball}",`,
        `  "sha256": "${opts.sha ?? 'b'.repeat(64)}",`,
        '  "sizeBytes": 1234,',
        '  "nodeVersion": "v24.18.1",',
        '  "nodeTarball": "",',
        '  "publishedAt": "2026-07-31T09:00:00Z",',
        '  "builtOn": "darwin-arm64 node v24.18.1"',
        '}',
        '',
      ].join('\n'),
    );
    return kit;
  }

  function run(kit: string): Refusal {
    const r = spawnSync('/bin/sh', [join(kit, 'install.command')], {
      encoding: 'utf8',
      // A sandboxed HOME keeps the data directory, the Node cache and the
      // LaunchAgents inside the fixture. /dev/null on stdin makes the "press
      // return to close this window" prompt return immediately.
      env: { ...process.env, HOME: join(kit, '..', 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  const thisArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const otherArch = thisArch === 'arm64' ? 'x64' : 'arm64';
  const version = shellVar('IBC_VERSION');

  it.skipIf(!mac)('refuses a payload built for the other processor', () => {
    // node_modules carries platform-gated packages. An arm64 tree on an Intel
    // Mac is a tracker that will not start, and it would not fail until long
    // after this window closed.
    const r = run(fabricate({ arch: otherArch, version }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('different kind of Mac');
    expect(r.out).toContain(otherArch);
    expect(r.out).toContain('What to do:');
  });

  it.skipIf(!mac)('refuses when the installer and the payload disagree on version', () => {
    // The bundle's version is stamped from common.sh and the Updates screen
    // reads it back. A disagreement means the tracker reports a version it is
    // not running, and "is there a newer one" is wrong from then on.
    const r = run(fabricate({ arch: thisArch, version: '9.9.9' }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('9.9.9');
    expect(r.out).toContain(version);
  });

  it.skipIf(!mac)('refuses when the payload was left behind in the zip', () => {
    const r = run(fabricate({ arch: thisArch, version, payload: false }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('program files are missing');
  });

  it.skipIf(!mac)('refuses a manifest with no usable fingerprint', () => {
    // An unchecked payload is an unverified one, and an unverified payload is
    // the one thing this product cannot let look verified.
    const r = run(fabricate({ arch: thisArch, version, sha: 'not-a-checksum' }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('fingerprint');
  });

  it.skipIf(!mac)('never touches /Applications on the way to refusing', () => {
    const before = existsSync('/Applications/IBC Contracts.app.building');
    run(fabricate({ arch: otherArch, version }));
    expect(existsSync('/Applications/IBC Contracts.app.building')).toBe(before);
  });
});

describe('the icon', () => {
  // iconutil silently ignores any file it does not recognise, which is how an
  // .icns ends up missing exactly the size the Dock wanted.
  const EXPECTED: ReadonlyArray<readonly [string, number]> = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  it('emits every size iconutil expects, as real PNGs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ibc-icon-'));
    try {
      const iconset = join(dir, 'test.iconset');
      // Spawned rather than imported: tsconfig has allowJs off, so a direct
      // import of the .mjs would fail `tsc --noEmit`.
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { writeIconset } from ${JSON.stringify(MAKE_ICON)};
           writeIconset(${JSON.stringify(iconset)});`,
        ],
        { stdio: 'pipe' },
      );

      expect(readdirSync(iconset).sort()).toEqual(EXPECTED.map(([n]) => n).sort());

      for (const [name, size] of EXPECTED) {
        const buf = readFileSync(join(iconset, name));
        expect([...buf.subarray(0, 8)], `${name} is not a PNG`).toEqual([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        // IHDR width and height, big endian, at fixed offsets.
        expect(buf.readUInt32BE(16), `${name} width`).toBe(size);
        expect(buf.readUInt32BE(20), `${name} height`).toBe(size);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('needs no dependency beyond the standard library', () => {
    const body = read(MAKE_ICON);
    for (const m of body.matchAll(/from '([^']+)'/g)) {
      expect(m[1], `${m[1]} is not a node: builtin`).toMatch(/^node:/);
    }
  });
});

describe('the applier as a script', () => {
  const body = read(UPDATE);

  it('never blocks a signal with SIG_IGN', () => {
    // `trap '' SIG` is SIG_IGN, and an ignored disposition is inherited across
    // fork AND exec -- POSIX then requires the child shell to go on ignoring
    // it. update.sh starts server.sh from inside its critical section, so
    // SIG_IGN there made the supervisor's own `trap 'on_term' TERM` a dead
    // letter for the rest of that server's life. From the SECOND update onward
    // stop_server could not stop it, the old code kept the port with a stale
    // working directory, and every update rolled back forever after.
    //
    // A no-op HANDLER protects the critical section identically and is reset to
    // SIG_DFL on exec, so children stay killable.
    expect(body, "trap '' sets SIG_IGN; use trap ':' instead").not.toMatch(
      /^\s*trap\s+''/m,
    );
    expect(body, 'trap "" sets SIG_IGN; use trap \':\' instead').not.toMatch(
      /^\s*trap\s+""/m,
    );
    expect(body).toMatch(/^trap ':' TERM INT$/m);
  });

  it('refreshes whatever scripts the payload carries, not a list of names', () => {
    // repair.sh joined the bundle and the list was never widened, so an update
    // would have removed self-repair from her Mac -- the same shape of bug as
    // the installer's, and it survived a full build-and-verify cycle too.
    expect(body).toMatch(/for _src in "\$STAGING"\/bin\/\*\.sh; do/);
    for (const name of BIN_SCRIPTS) {
      expect(body, `${name} is refreshed by name; iterate bin/ instead`).not.toMatch(
        new RegExp(`for _f in .*${name.replace('.', '\\.')}`),
      );
    }
    // launcher.sh is the bundle executable, not a bin/ script, and still goes
    // to Contents/MacOS under its own name.
    expect(body).toMatch(/\[ "\$_f" = "launcher\.sh" \] && continue/);
  });

  it('prunes the version that failed, but only behind the readlink guard', () => {
    // Three full copies, node_modules and .next included, measured at about a
    // gigabyte. prune_versions only ever runs on the success path.
    expect(body).toContain('prune_failed_version');
    const fn = body.slice(body.indexOf('prune_failed_version() {'));
    const end = fn.indexOf('\n}\n');
    const guarded = fn.slice(0, end);
    // The same guard swap_to relies on: a linked directory can never be the one
    // removed, whatever else went wrong above.
    expect(guarded).toMatch(/readlink "\$APP_LINK"/);
    // It RECORDS the failed version rather than deleting it: self-repair is handed
    // this failure immediately and the failed tree is the evidence it reads. The
    // delete moved to discard_previous_failure, at the start of the next apply.
    expect(guarded).toMatch(/failed-version/);
    expect(guarded).not.toMatch(/rm -rf "\$_dead"/);
    expect(guarded.indexOf('readlink')).toBeLessThan(guarded.indexOf('failed-version'));
    // Never in rollback mode: there app-$NEW_VERSION is a version she asked to
    // go back to, and one that will not start is still not ours to delete.
    expect(guarded).toMatch(/\[ "\$MODE" = "apply" \] \|\| return 0/);
  });

  it('prunes only after the rollback has actually answered', () => {
    // Until something is serving, the failed directory is still the best thing
    // left to try.
    const answered = body.indexOf('ROLLBACK_OK="1"');
    const prune = body.indexOf('  prune_failed_version');
    expect(answered).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(answered);
  });
});

/* ------------------------- the payload builder --------------------------- */

/*
 * make-distributable.sh builds two things out of one set of steps: the tarball
 * the release workflow publishes, and the .zip Ayush hands Bonnie. That is the
 * point of it. The updater already consumed a tarball of prebuilt .next plus
 * production node_modules, so the installer consumes the same one -- one format
 * exercised by both paths instead of two that drift.
 */
describe('the payload builder', () => {
  const body = read(MAKE_DIST);

  it('builds the layout update.sh unpacks', () => {
    // One top directory, because update.sh strips one component, holding app/
    // and the bin/ scripts it is allowed to refresh.
    expect(body).toContain('TOP="$WORK/stage/ibc-contracts-$VERSION"');
    expect(body).toContain('APP="$TOP/app"');
    expect(body).toMatch(/tar -czf "\$TARBALL" -C "\$WORK\/stage" "ibc-contracts-\$VERSION"/);
  });

  it('asserts exactly what update.sh refuses a payload without', () => {
    // Failing here costs a rebuild. Failing there costs a rollback on her Mac.
    const required = read(UPDATE).match(
      /for _need in ([^\n;]*); do/,
    );
    expect(required, 'update.sh no longer lists its required files inline').not.toBeNull();
    for (const need of (required?.[1] ?? '').trim().split(/\s+/)) {
      expect(body, `the builder does not check for ${need}`).toContain(need);
    }
  });

  it('packs every script in the bundle, by iterating the folder', () => {
    // update.sh installs exactly what the payload carries. A script missing
    // from the payload is a script deleted from her install on the next update,
    // which is how repair.sh would have disappeared.
    expect(body).toMatch(/for f in "\$TEMPLATE"\/bin\/\*\.sh; do/);
    for (const name of BIN_SCRIPTS) {
      expect(body, `${name} is packed by name; iterate bin/ instead`).not.toMatch(
        new RegExp(`for f in .*${name.replace('.', '\\.')}`),
      );
    }
    // launcher.sh is the bundle executable, not a bin/ script, and still has to
    // reach the payload under its own name.
    expect(body).toContain('cp "$TEMPLATE/launcher.sh" "$TOP/bin/launcher.sh"');
  });

  it('checks the scripts arrived rather than trusting cp', () => {
    expect(body).toMatch(/did not reach the payload/);
  });

  it('never lets an env file into the payload', () => {
    // The glob, not the two names. `.env` and `.env.local` let .env.example
    // through, and .env.production would be next. The rsync exclusion and the
    // assertion have to agree or the assertion is the only thing that fires.
    expect(body).toMatch(/--exclude '\.env\*'/);
    expect(body).toMatch(/-name '\.env\*'/);
    expect(body).toMatch(/an env file reached the payload/);
  });

  it('drops the build cache, which is scratch space and not the build', () => {
    // .next/dev was 641 MB on this machine. Sending it is sending her a
    // dependency graph she will never read.
    expect(body).toMatch(/rm -rf "\$APP\/\.next\/cache"/);
    expect(body).toContain('"$APP/.next/dev"');
  });

  it('reduces node_modules by reinstalling, not by pruning', () => {
    // npm prune leaves whatever a dev dependency dropped in place, and this
    // tree is unpacked verbatim onto her Mac.
    expect(body).toContain('rm -rf "$APP/node_modules"');
    expect(body).toMatch(/npm ci --omit=dev/);
  });

  it('builds in a copy, never in the checkout', () => {
    // `npm ci --omit=dev` deletes and reinstalls node_modules. Doing that in
    // the repository would take Ayush's working tree apart while he is in it.
    const mktemp = body.indexOf('WORK=$(mktemp -d');
    const install = body.indexOf('npm ci --no-audit');
    expect(mktemp).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(mktemp);
    expect(body).not.toMatch(/cd "\$REPO_ROOT" && npm/);
  });

  it('watches the finished tarball serve a real request', () => {
    // An exit code is a claim. `next build` exiting 0 is a claim that a build
    // happened, not evidence that what came out can answer a request.
    expect(body).toContain('tar -xzf "$TARBALL" -C "$SMOKE_DIR" --strip-components 1');
    expect(body).toMatch(/ibc-ping\.txt/);
    expect(body).toMatch(/did not serve \/ibc-ping\.txt/);
    // Its own data directory: a smoke test must never touch a real tracker.db.
    expect(body).toContain('IBC_DATA_DIR="$WORK/smoke-data"');
  });

  it('refuses to build for a processor this Mac is not', () => {
    // node_modules is platform-gated. An arm64 tree on an Intel Mac is a
    // tracker that will not start, and there is no cross-compiling it.
    expect(body).toMatch(/uname -s.*Darwin|Darwin.*uname -s/);
    expect(body).toContain('ARCH=$(ibc_node_arch)');
  });

  it('never assembles a .app of its own', () => {
    // The bundle is built on HER Mac, by install.command. One created locally
    // carries no com.apple.quarantine, which is the whole reason this works
    // without a paid signing certificate. A .app that arrived in a download is
    // refused outright by Gatekeeper, and she has no way past that.
    expect(body).not.toMatch(/Contents\/MacOS/);
    expect(body).not.toMatch(/\.app\/Contents/);
    expect(body).not.toMatch(/Info\.plist/);
  });

  it('takes the Node fingerprint from common.sh, never from the artifact', () => {
    // A tampered .zip must not be able to supply the answer that clears it.
    const fetched = body.indexOf('ibc_node_sha256');
    const copied = body.indexOf('cp "$NODE_CACHED" "$DIST/payload/');
    expect(fetched).toBeGreaterThan(-1);
    expect(copied).toBeGreaterThan(fetched);
  });
});

describe('the manifest', () => {
  const dist = read(MAKE_DIST);
  const install = read(INSTALL);

  it('carries every key the installer reads out of it', () => {
    // Two files, one format. A key renamed on one side and not the other is an
    // empty string on her Mac, and an empty string here means a version check
    // or a checksum check that silently passes over nothing.
    const keys = [...install.matchAll(/manifest_(?:str|num) ([a-zA-Z0-9]+)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(3);
    for (const key of keys) {
      expect(dist, `make-distributable.sh never writes "${key}"`).toContain(`"${key}":`);
    }
  });

  it('is written one flat key per line, because the reader is sed', () => {
    // A stock Mac has no jq, and a dependency she would have to install is a
    // dependency she cannot install. So the format stays parseable by a sed
    // one-liner: no nesting, no arrays, one key per printf.
    const block = dist.slice(dist.indexOf("printf '{\\n'"), dist.indexOf("printf '}\\n'"));
    expect(block.length).toBeGreaterThan(0);
    let keyLines = 0;
    for (const line of block.split('\n')) {
      if (!/printf '.*"/.test(line)) continue;
      keyLines += 1;
      expect(line, `manifest line is not one flat key: ${line.trim()}`).toMatch(
        /printf '\s*"[a-zA-Z0-9]+": (?:"[^"]*"|%s|[0-9]+),?\\n'/,
      );
    }
    expect(keyLines).toBeGreaterThan(3);
  });

  it('is read with sed and never with jq', () => {
    // Comments are allowed to say the word; code is not. jq is not on a stock
    // Mac, and "first install jq" is not a step she can complete.
    const code = install
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\bjq\b/);
    expect(install).toMatch(/manifest_str\(\) \{\n\s*sed -n/);
  });

  it('parses a manifest of the shape the builder writes', () => {
    // The parser, executed. Reading the regex and believing it is exactly the
    // habit that puts an unverified value where a verified one should be.
    const dir = mkdtempSync(join(tmpdir(), 'ibc-manifest-'));
    try {
      const sha = 'a'.repeat(64);
      writeFileSync(
        join(dir, 'manifest.json'),
        [
          '{',
          '  "schemaVersion": 1,',
          '  "version": "1.2.3",',
          '  "arch": "arm64",',
          '  "url": "payload/ibc-contracts-1.2.3-darwin-arm64.tar.gz",',
          `  "sha256": "${sha}",`,
          '  "sizeBytes": 161234567,',
          '  "nodeVersion": "v24.18.1",',
          '  "nodeTarball": "",',
          '  "publishedAt": "2026-07-31T09:00:00Z",',
          '  "builtOn": "darwin-arm64 node v24.18.1"',
          '}',
          '',
        ].join('\n'),
      );

      // The two functions exactly as install.command defines them.
      const fns = ['manifest_str', 'manifest_num']
        .map((name) => {
          const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(install);
          expect(m, `${name} is not defined the way this test slices it`).not.toBeNull();
          return m?.[0] ?? '';
        })
        .join('\n');

      const script = join(dir, 'probe.sh');
      writeFileSync(
        script,
        `#!/bin/sh\nMANIFEST="${join(dir, 'manifest.json')}"\n${fns}\n` +
          'printf "%s|%s|%s|%s|%s|%s\\n" "$(manifest_str version)" "$(manifest_str arch)" ' +
          '"$(manifest_str url)" "$(manifest_str sha256)" "$(manifest_num sizeBytes)" ' +
          '"$(manifest_str nodeTarball)"\n',
      );

      const out = execFileSync('/bin/sh', [script], { encoding: 'utf8' }).trim();
      expect(out).toBe(
        `1.2.3|arm64|payload/ibc-contracts-1.2.3-darwin-arm64.tar.gz|${sha}|161234567|`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the release workflow', () => {
  const body = read(RELEASE_WORKFLOW);

  it('builds its payload with the one payload builder', () => {
    // It used to keep its own copy of the assembly steps, which is how the
    // installer and the updater ended up able to disagree about what a payload
    // is. There is one builder now and this is the only place it is called.
    expect(body).toMatch(/sh packaging\/make-distributable\.sh --payload-only --out "\$TARBALL"/);
  });

  it('keeps no second copy of the assembly steps', () => {
    // Only the packaging job. `verify` installs and builds too, but it does
    // that to typecheck and test the checkout, not to assemble a payload.
    //
    // Comments may name the steps the builder took over; the YAML may not
    // carry them out. Any of these reappearing here means the drift has
    // started again.
    const job = body.slice(body.indexOf('\n  package:'), body.indexOf('\n  publish:'));
    expect(job.length).toBeGreaterThan(0);
    const code = job
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/rsync -a/);
    expect(code).not.toMatch(/npm ci/);
    expect(code).not.toMatch(/tar -czf/);
    expect(code).not.toMatch(/next build/);
  });

  it('re-derives the checksum rather than trusting the one it was handed', () => {
    expect(body).toMatch(/does not match its own checksum/);
  });
});

/* -------------------- the applier, against a real bundle ----------------- */

/*
 * Everything above is a reading of the source. This is not: it builds a bundle
 * on disk, runs the real update.sh against it, and watches what serves.
 *
 * It exists for one defect in particular. `trap '' TERM INT` cannot be caught
 * by applying ONE update -- the first one works perfectly, because the server
 * it stops was started by something else. Only the second update meets a
 * supervisor that update.sh itself started, and therefore inherited SIG_IGN.
 * That is why a full build-and-verify cycle shipped it. So the test applies two.
 */

const SANDBOX = mkdtempSync(join(tmpdir(), 'ibc-packaging-'));
const teardown: Array<() => void> = [];

afterAll(() => {
  for (const fn of teardown.splice(0)) {
    try {
      fn();
    } catch {
      // Best effort: a fixture that is already gone is the outcome we wanted.
    }
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
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
      s.close(() => resolve(typeof addr === 'object' && addr !== null ? addr.port : 0));
    });
  });
}

/** Enough of an app folder to satisfy update.sh's payload check. */
function writeAppDir(dir: string, version: string, opts: { broken?: boolean } = {}): void {
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  mkdirSync(join(dir, '.next'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'), '#!/bin/sh\n');
  writeFileSync(join(dir, '.next', 'BUILD_ID'), `build-${version}\n`);
  writeFileSync(
    join(dir, 'public', 'ibc-ping.txt'),
    `com.internationalbattery.contract-tracker ${version}\n`,
  );
  if (opts.broken === true) writeFileSync(join(dir, 'BROKEN'), 'this build does not start\n');
}

/*
 * A stand-in for server.sh that copies the two properties this test turns on:
 *
 *   1. `trap 'on_term' TERM INT`, which is what SIG_IGN silently disarms;
 *   2. one `cd` before a restart loop, so the supervisor's working directory is
 *      an inode captured once. That is why an un-killable old supervisor goes on
 *      serving the OLD version after the symlink has moved -- it never looks at
 *      the link again -- and it is exactly what makes the health check fail.
 */
const FAKE_SERVER = `#!/bin/sh
set -u
SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
RES_DIR=$(cd -- "$SELF_DIR/.." && pwd)
. "$SELF_DIR/common.sh"
IBC_LOG_TARGET="$IBC_LOG_DIR/fake-server.log"
mkdir -p "$IBC_RUNTIME_DIR" "$IBC_LOG_DIR" 2>/dev/null || true

CHILD=""
LOCK_HELD=""

cleanup_lock() {
  [ -n "$LOCK_HELD" ] && rm -rf "$IBC_LOCK_DIR" 2>/dev/null
  LOCK_HELD=""
}

on_term() {
  ibc_log "stop requested"
  [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null
  cleanup_lock
  exit 0
}

if mkdir "$IBC_LOCK_DIR" 2>/dev/null; then
  LOCK_HELD=1
else
  STALE_PID=$(tr -dc '0-9' <"$IBC_LOCK_DIR/pid" 2>/dev/null)
  if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
    ibc_log "another supervisor is running (pid $STALE_PID); standing down"
    exit 0
  fi
  rm -rf "$IBC_LOCK_DIR" 2>/dev/null
  mkdir "$IBC_LOCK_DIR" 2>/dev/null || exit 0
  LOCK_HELD=1
fi
printf '%s\\n' "$$" >"$IBC_LOCK_DIR/pid"
trap 'on_term' TERM INT
trap 'cleanup_lock' EXIT

cd "$RES_DIR/app" || exit 1
ibc_log "supervising $(pwd)"

while true; do
  if [ -e "BROKEN" ]; then
    ibc_log "refusing to start: BROKEN marker present"
    cleanup_lock
    exit 1
  fi
  printf '%s\\n' "$IBC_TEST_PORT" >"$IBC_PORT_FILE"
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
        /* fall through */
      }
    }
    res.writeHead(404);
    res.end();
  })
  .listen(Number(process.argv[1]), "127.0.0.1");
' "$IBC_TEST_PORT" &
  CHILD=$!
  wait "$CHILD"
  CHILD=""
  ibc_log "server exited; restarting"
  sleep 1
done
`;

async function makeFixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(join(SANDBOX, `${name}-`));
  const contents = join(root, 'IBC Contracts.app', 'Contents'); // the space is load-bearing
  const resources = join(contents, 'Resources');
  mkdirSync(join(resources, 'bin'), { recursive: true });
  mkdirSync(join(contents, 'MacOS'), { recursive: true });

  const port = await freePort();

  // Our own common.sh with the port range narrowed to one free port, so the
  // probe cannot find -- and then stop -- the real installed tracker.
  const common = read(COMMON).replace(/^IBC_PORTS=".*"$/m, `IBC_PORTS="${port}"`);
  expect(common, 'the IBC_PORTS rewrite did not take').toContain(`IBC_PORTS="${port}"`);
  writeFileSync(join(resources, 'bin', 'common.sh'), common);
  cpSync(UPDATE, join(resources, 'bin', 'update.sh'));
  writeFileSync(join(resources, 'bin', 'server.sh'), FAKE_SERVER);
  writeFileSync(join(contents, 'MacOS', 'ibc-contracts'), '#!/bin/sh\nexit 0\n');
  for (const f of ['common.sh', 'server.sh', 'update.sh']) {
    chmodSync(join(resources, 'bin', f), 0o755);
  }

  writeAppDir(join(resources, 'app-1.0.0'), '1.0.0');
  symlinkSync('app-1.0.0', join(resources, 'app'));

  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'archive'), { recursive: true });
  writeFileSync(join(dataDir, 'tracker.db'), 'PRETEND SQLITE BYTES');
  writeFileSync(join(dataDir, 'archive', 'nda.pdf'), '%PDF-1.4 pretend');

  // HOME points here so IBC_AGENT_PLIST cannot resolve to the real LaunchAgent
  // and launchctl is never reached at all.
  mkdirSync(join(root, 'Library', 'LaunchAgents'), { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    IBC_DATA_DIR: dataDir,
    IBC_TEST_PORT: String(port),
    IBC_TEST_NODE: process.execPath,
    IBC_UPDATE_LAUNCHD_GRACE: '3',
    IBC_UPDATE_HEALTH_TIMEOUT: '15',
    IBC_UPDATE_ROLLBACK_TIMEOUT: '25',
    IBC_UPDATE_STOP_TIMEOUT: '10',
  };
  delete env['IBC_UPDATE_DIR'];
  // A Node process that inherits NODE_CHANNEL_FD attaches to whatever IPC
  // channel it names -- here the vitest worker's own -- and then talks over it.
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
    resources,
    appLink: join(resources, 'app'),
    updateSh: join(resources, 'bin', 'update.sh'),
    serverSh: join(resources, 'bin', 'server.sh'),
    dataDir,
    updateDir: join(dataDir, 'update'),
    port,
    env,
  };
  teardown.push(() => stopEverything(fixture));
  return fixture;
}

function startServer(f: Fixture): void {
  const child = spawn('/bin/sh', [f.serverSh], { detached: true, stdio: 'ignore', env: f.env });
  child.unref();
}

/**
 * Kill the supervisor AND whatever is listening. Not tidiness: the supervisor
 * restarts its child, so a fixture left running outlives the suite and keeps a
 * port for as long as the machine is up.
 */
function stopEverything(f: Fixture): void {
  try {
    const pid = Number.parseInt(
      readFileSync(join(f.dataDir, 'runtime', 'start.lock', 'pid'), 'utf8').trim(),
      10,
    );
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
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

async function waitForVersion(port: number, want: string, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await servingVersion(port)) === want) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** One top-level directory holding app/, and optionally bin/ scripts. */
function buildPayload(
  version: string,
  opts: { broken?: boolean; binScripts?: Record<string, string> } = {},
): { path: string; sha256: string; size: number } {
  const stage = mkdtempSync(join(SANDBOX, 'payload-'));
  const top = join(stage, `ibc-contracts-${version}`);
  writeAppDir(join(top, 'app'), version, { broken: opts.broken ?? false });
  if (opts.binScripts !== undefined) {
    mkdirSync(join(top, 'bin'), { recursive: true });
    for (const [name, contents] of Object.entries(opts.binScripts)) {
      writeFileSync(join(top, 'bin', name), contents);
    }
  }
  const tarball = join(stage, `payload-${version}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', stage, `ibc-contracts-${version}`]);
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
 * Run the applier the way the server does: detached, in its own session. It
 * leaves a supervisor behind it, and a supervisor in the test runner's own
 * process group takes the vitest worker down with it.
 */
async function runUpdate(f: Fixture): Promise<Map<string, string>> {
  await new Promise<number>((resolve) => {
    const child = spawn('/bin/sh', [f.updateSh], { env: f.env, detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // Already gone.
      }
      resolve(-2);
    }, 150_000);
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
    // No result file at all: the assertions will say so.
  }
  return result;
}

async function applyUpdate(
  f: Fixture,
  from: string,
  to: string,
  opts: { broken?: boolean; binScripts?: Record<string, string> } = {},
): Promise<Map<string, string>> {
  const payload = buildPayload(to, opts);
  writePlan(f, {
    mode: 'apply',
    version: to,
    fromVersion: from,
    resources: f.resources,
    sha256: payload.sha256,
    url: `file://${payload.path}`,
    sizeBytes: String(payload.size),
  });
  return runUpdate(f);
}

function versionDirs(f: Fixture): string[] {
  return readdirSync(f.resources)
    .filter((n) => /^app-\d/.test(n))
    .sort();
}

function dataSnapshot(f: Fixture): Record<string, string> {
  return {
    db: read(join(f.dataDir, 'tracker.db')),
    pdf: read(join(f.dataDir, 'archive', 'nda.pdf')),
  };
}

describe('two updates in a row', () => {
  it(
    'applies the second one, which is the one an ignored TERM breaks',
    async () => {
      const f = await makeFixture('twice');
      const before = dataSnapshot(f);
      startServer(f);
      expect(await waitForVersion(f.port, '1.0.0'), 'the fixture never came up').toBe(true);

      // ---- update one. This one passes either way: the server it has to stop
      // was started by the test, so its TERM disposition is the default.
      const first = await applyUpdate(f, '1.0.0', '1.1.0', {
        // A script that is in neither of the two lists this bug lived in.
        // Iterating bin/ is what puts it on her Mac; a list is what lost it.
        binScripts: { 'repair.sh': '#!/bin/sh\nexit 0\n' },
      });
      expect(first.get('failCode') ?? '', first.get('detail') ?? '').toBe('');
      expect(first.get('ok')).toBe('1');
      expect(readlinkSync(f.appLink)).toBe('app-1.1.0');
      expect(await waitForVersion(f.port, '1.1.0')).toBe(true);

      // The payload's extra script was installed, not silently dropped.
      expect(existsSync(join(f.resources, 'bin', 'repair.sh'))).toBe(true);
      expect(statSync(join(f.resources, 'bin', 'repair.sh')).mode & 0o111).not.toBe(0);

      // ---- update two. The server it must stop is one update.sh started
      // itself, so it inherited whatever disposition update.sh had at the time.
      // With `trap '' TERM INT` the supervisor is unkillable, keeps the port
      // with its working directory still inside app-1.1.0, and 1.2.0 never
      // answers: this assertion fails and every update after it would too.
      const second = await applyUpdate(f, '1.1.0', '1.2.0');
      expect(second.get('failCode') ?? '', second.get('detail') ?? '').toBe('');
      expect(second.get('ok')).toBe('1');
      expect(readlinkSync(f.appLink)).toBe('app-1.2.0');
      expect(await waitForVersion(f.port, '1.2.0')).toBe(true);

      // Two kept, the oldest pruned -- one rollback's worth of disk.
      expect(versionDirs(f)).toEqual(['app-1.1.0', 'app-1.2.0']);

      // And through both of them, her data is byte-identical.
      expect(dataSnapshot(f)).toEqual(before);
      stopEverything(f);
    },
    240_000,
  );
});

describe('a rolled-back update', () => {
  it(
    'leaves nothing of the version that would not start',
    async () => {
      const f = await makeFixture('rollback-prune');
      startServer(f);
      expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

      const result = await applyUpdate(f, '1.0.0', '1.1.0', { broken: true });
      expect(result.get('ok')).toBe('0');
      expect(result.get('rollbackOk'), 'the rollback itself did not come back').toBe('1');

      // Back on the version she was on...
      expect(readlinkSync(f.appLink)).toBe('app-1.0.0');
      expect(await waitForVersion(f.port, '1.0.0')).toBe(true);

      // ...and the version that would not start is still on disk, deliberately.
      // Repair is handed this failure the moment the rollback lands and the first
      // thing it needs is the tree that failed; deleting it here made the handover
      // fire correctly and then always refuse. It is reclaimed at the next apply.
      expect(versionDirs(f)).toEqual(['app-1.0.0', 'app-1.1.0']);
      expect(existsSync(join(f.resources, 'app-1.1.0'))).toBe(true);
      expect(readFileSync(join(f.dataDir, 'update', 'failed-version'), 'utf8').trim()).toBe(
        'app-1.1.0',
      );

      // The next apply reclaims it, and the link still decides what survives.
      await applyUpdate(f, '1.0.0', '1.2.0');
      expect(await waitForVersion(f.port, '1.2.0')).toBe(true);
      expect(existsSync(join(f.resources, 'app-1.1.0'))).toBe(false);
      stopEverything(f);
    },
    240_000,
  );
});
