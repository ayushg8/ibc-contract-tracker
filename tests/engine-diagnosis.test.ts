/**
 * The five ways Claude Code can be wrong, and the promise that each one gets a
 * different sentence and a different next action.
 *
 * These are regression tests for a support call, not for a function. Each one
 * pins a distinction that, if it collapsed, would put a non-technical user in
 * front of a message she cannot act on.
 */

import { homedir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  candidatePaths,
  classifyCliOutput,
  parseShellLookup,
  type CliRunOutcome,
} from '../src/lib/providers/cli';
import { errorInfo, redact, type EngineErrorCode } from '../src/lib/providers/errors';
import {
  CLI_CASES,
  clearProgress,
  cliCaseForCode,
  describeCli,
  parseWatchStatus,
  readProgress,
  whereFoundLine,
  writeProgress,
  type CliCase,
} from '../src/lib/engine-diagnosis';

function outcome(over: Partial<CliRunOutcome> = {}): CliRunOutcome {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    toolsDisabled: true,
    ...over,
  };
}

function codeOf(res: ReturnType<typeof classifyCliOutput>): EngineErrorCode | 'ok' {
  return res.kind === 'ok' ? 'ok' : res.code;
}

/* ─────────────────── case 4 vs case 5: plan, not a limit ─────────────────── */

describe('a plan without the access we need is not a usage limit', () => {
  it('names a plan problem when Claude Code is not available on the plan', () => {
    const res = classifyCliOutput(
      outcome({
        stderr: 'Error: Claude Code is not available on your current plan.',
        exitCode: 1,
      }),
    );
    expect(codeOf(res)).toBe('CLI_PLAN_UNSUPPORTED');
  });

  it('names a plan problem when a Pro or Max subscription is required', () => {
    const res = classifyCliOutput(
      outcome({ stderr: 'This feature requires a Claude Pro or Max subscription.', exitCode: 1 }),
    );
    expect(codeOf(res)).toBe('CLI_PLAN_UNSUPPORTED');
  });

  it('does not read a plan problem as a sign-in problem', () => {
    // "no ... subscription" is close enough to the auth patterns to be a real risk.
    const res = classifyCliOutput(
      outcome({ stderr: 'No Claude Pro subscription on this account.', exitCode: 1 }),
    );
    expect(codeOf(res)).toBe('CLI_PLAN_UNSUPPORTED');
  });

  it('still calls a capped subscription a usage limit even when it invites an upgrade', () => {
    // The worse mistake by far: telling someone whose limit resets at 3pm that
    // their plan will never work.
    const res = classifyCliOutput(
      outcome({
        stdout: "You've reached your usage limit. Resets at 3pm, or upgrade to a higher plan.",
        exitCode: 1,
      }),
    );
    expect(codeOf(res)).toBe('CLI_USAGE_LIMIT');
  });

  it('keeps calling a plain cap a usage limit', () => {
    const res = classifyCliOutput(
      outcome({ stdout: 'Claude usage limit reached. Try again later.', exitCode: 1 }),
    );
    expect(codeOf(res)).toBe('CLI_USAGE_LIMIT');
  });

  it('does not mistake contract language about plans for a plan failure', () => {
    // An answer is read before any pattern is hunted for, so a confidentiality
    // clause quoting the words "your plan does not include" stays an answer.
    const answer = JSON.stringify({
      doc_type: 'nda',
      fields: {
        party_a: {
          value: 'IBC',
          quote:
            'Benefits are limited to what your plan does not include and requires a Claude Pro review.',
          page: 2,
        },
      },
    });
    expect(codeOf(classifyCliOutput(outcome({ stdout: answer })))).toBe('ok');
  });
});

/* ──────────────────── five failures, five different answers ─────────────── */

const FIVE: CliCase[] = [
  'not-installed',
  'not-on-path',
  'not-signed-in',
  'plan-unsupported',
  'usage-limit',
];

describe('every failure gets its own sentence and its own next action', () => {
  it('gives each of the five a distinct headline', () => {
    const titles = FIVE.map((c) => describeCli(c).title);
    expect(new Set(titles).size).toBe(FIVE.length);
  });

  it('never leaves a failure without something to do', () => {
    for (const kind of FIVE) {
      const d = describeCli(kind);
      // Either a command she can forward, or a button, or a sentence naming who
      // to tell. A dead end here is the whole failure mode this pass exists for.
      const actionable = d.command !== null || d.forward !== null || d.remedy !== null;
      expect(actionable, `${kind} has no next action`).toBe(true);
    }
  });

  it('gives the two Terminal fixes different commands', () => {
    expect(describeCli('not-installed').command).not.toBe(describeCli('not-signed-in').command);
    expect(describeCli('not-installed').command).not.toBe(describeCli('too-old').command);
  });

  it('says who to send the command to wherever there is one to type', () => {
    for (const kind of Object.keys(CLI_CASES) as CliCase[]) {
      const info = CLI_CASES[kind];
      if (info.command === null) continue;
      expect(info.forward, `${kind} hands over a command with nobody to send it to`).not.toBeNull();
      expect(info.forward).toMatch(/Ayush/);
    }
  });

  it('offers no Terminal command where typing one cannot help', () => {
    // A plan and a cap are account facts. A command would be theatre.
    expect(describeCli('plan-unsupported').command).toBeNull();
    expect(describeCli('usage-limit').command).toBeNull();
  });

  it('takes its headline from the error taxonomy so the wording cannot drift', () => {
    for (const kind of Object.keys(CLI_CASES) as CliCase[]) {
      const info = CLI_CASES[kind];
      if (info.code === null || info.ownTitle === true) continue;
      expect(describeCli(kind).title).toBe(errorInfo(info.code).message);
      expect(describeCli(kind).remedy).toEqual(errorInfo(info.code).remedy);
    }
  });

  it('does not tell her to install software she already has', () => {
    // Case 1 and case 2 both report CLI_NOT_FOUND, because that is what the engine
    // throws. They must not read the same: one is "install it", the other is
    // "it is installed, this app just cannot reach it".
    const missing = describeCli('not-installed');
    const unreachable = describeCli('not-on-path');
    expect(missing.code).toBe(unreachable.code);
    expect(unreachable.title).not.toBe(missing.title);
    expect(unreachable.title).not.toMatch(/isn't installed|not installed/i);
    expect(unreachable.command).not.toMatch(/npm install/);
  });

  it('maps every code the classifier can emit back to a case', () => {
    expect(cliCaseForCode('CLI_NOT_FOUND')).toBe('not-installed');
    expect(cliCaseForCode('CLI_NOT_AUTHENTICATED')).toBe('not-signed-in');
    expect(cliCaseForCode('CLI_PLAN_UNSUPPORTED')).toBe('plan-unsupported');
    expect(cliCaseForCode('CLI_USAGE_LIMIT')).toBe('usage-limit');
    expect(cliCaseForCode('CLI_VERSION_UNSUPPORTED')).toBe('too-old');
    expect(cliCaseForCode('CLI_PERMISSION_PROMPT')).toBe('blocked');
    // Not an engine-setup fault, so it must not be dressed up as one.
    expect(cliCaseForCode('PDF_ENCRYPTED')).toBeNull();
    expect(cliCaseForCode(undefined)).toBeNull();
  });

  it('a working engine is not a failure and asks for nothing', () => {
    const d = describeCli('working', { binPath: '/opt/homebrew/bin/claude', foundVia: 'which' });
    expect(d.state).toBe('ok');
    expect(d.command).toBeNull();
    expect(d.code).toBeNull();
  });
});

/* ─────────────────────── the GUI-launch PATH problem ────────────────────── */

describe('the PATH an app inherits from the Dock', () => {
  const home = homedir();

  it('probes every place Claude Code is actually installed', () => {
    const paths = candidatePaths();
    for (const expected of [
      `${home}/.claude/local/claude`,
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      `${home}/.local/bin/claude`,
      `${home}/.bun/bin/claude`,
      `${home}/.volta/bin/claude`,
      `${home}/.asdf/shims/claude`,
      `${home}/.npm-global/bin/claude`,
      `${home}/Library/pnpm/claude`,
    ]) {
      expect(paths, `${expected} is not probed`).toContain(expected);
    }
  });

  it('never lists the same location twice', () => {
    const paths = candidatePaths();
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('reads the login shell through its own greeting', () => {
    // A login shell prints whatever her dotfiles print. Reading that banner as an
    // answer would tell someone with nothing installed that it is installed but
    // unreachable -- the wrong instruction, and an unfindable bug.
    const noisy = [
      'Restored session: Thu Jul 30 14:19:02 PDT 2026',
      'nvm: using node v22.5.0',
      'IBC-CLAUDE-PATH:/Users/bonnie/.local/bin/claude',
    ].join('\n');
    expect(parseShellLookup(noisy)).toBe('/Users/bonnie/.local/bin/claude');
  });

  it('reports nothing when the shell does not know the name either', () => {
    // The marker is present and empty: the probe ran, the answer was "no".
    expect(parseShellLookup('Restored session: today\nIBC-CLAUDE-PATH:\n')).toBeNull();
    // No marker at all: the probe never ran. Also not an answer.
    expect(parseShellLookup('Welcome to your Mac\n')).toBeNull();
  });

  it('reports an alias or a shell function as a real answer', () => {
    // Her shell knows the name; this app cannot spawn it. That is case 2, and it
    // must not be reported as "not installed".
    expect(parseShellLookup('IBC-CLAUDE-PATH:claude')).toBe('claude');
  });

  it('flags a binary only a deeper probe could find', () => {
    // Found this way, it works today and disappears the moment a PATH is edited.
    // That is worth saying out loud rather than reporting a plain green tick.
    expect(describeCli('working', { foundVia: 'login-shell' }).neededDeepProbe).toBe(true);
    expect(describeCli('working', { foundVia: 'npm-prefix' }).neededDeepProbe).toBe(true);
    expect(describeCli('working', { foundVia: 'which' }).neededDeepProbe).toBe(false);
    expect(describeCli('working', { foundVia: 'known-location' }).neededDeepProbe).toBe(false);
  });

  it('says where it was found, with the version, or says nothing', () => {
    const found = describeCli('working', {
      binPath: '/opt/homebrew/bin/claude',
      foundVia: 'login-shell',
      version: '2.1.4',
    });
    expect(whereFoundLine(found)).toContain('/opt/homebrew/bin/claude');
    expect(whereFoundLine(found)).toContain('2.1.4');
    expect(whereFoundLine(describeCli('not-installed'))).toBeNull();
  });
});

/* ────────────────────────── nothing leaks into support ──────────────────── */

describe('a diagnosis is safe to paste into an email', () => {
  it('carries nothing that survives redaction', () => {
    for (const kind of Object.keys(CLI_CASES) as CliCase[]) {
      const payload = JSON.stringify(
        describeCli(kind, {
          binPath: '/opt/homebrew/bin/claude',
          foundVia: 'which',
          version: '2.1.4',
          limitResetsAt: '2026-07-30T15:00:00.000Z',
        }),
      );
      // If redact() changes anything, the diagnosis contained something that
      // looked like a credential or an address, and it must not have.
      expect(redact(payload), `${kind} carries redactable content`).toBe(payload);
    }
  });

  it('never puts a key-shaped string in a command', () => {
    for (const kind of Object.keys(CLI_CASES) as CliCase[]) {
      expect(CLI_CASES[kind].command ?? '').not.toMatch(/sk-ant/);
    }
  });
});

/* ──────────────────────── the watcher that is not built yet ─────────────── */

describe('the watch status endpoint, before it exists', () => {
  it('reads a flat answer', () => {
    const s = parseWatchStatus({
      running: true,
      folder: '/Users/bonnie/NDAs',
      lastScanAt: '2026-07-30T09:00:00.000Z',
      ingested: 4,
      lastError: null,
    });
    expect(s).toEqual({
      running: true,
      folder: '/Users/bonnie/NDAs',
      lastScanAt: '2026-07-30T09:00:00.000Z',
      ingested: 4,
      lastError: null,
    });
  });

  it('reads the same answer nested under `watch`', () => {
    const s = parseWatchStatus({ watch: { watching: true, watchFolder: '/x', count: 2 } });
    expect(s.running).toBe(true);
    expect(s.folder).toBe('/x');
    expect(s.ingested).toBe(2);
  });

  it('reads the shape the watcher actually returns', () => {
    // GET /api/watch answers { watch: WatchStatus } with the failure under `error`.
    // Pinned here so a change on that side shows up as a failing test rather than
    // as a folder step that silently reports nothing.
    const s = parseWatchStatus({
      watch: {
        running: true,
        started: true,
        folder: '/Users/bonnie/IBC/NDAs',
        scanning: false,
        lastScanAt: '2026-07-30T09:00:00.000Z',
        intervalMs: 5000,
        backedOff: false,
        settling: 0,
        ingested: 7,
        reopened: 1,
        duplicates: 2,
        error: null,
        skipped: [],
      },
    });
    expect(s.running).toBe(true);
    expect(s.folder).toBe('/Users/bonnie/IBC/NDAs');
    expect(s.ingested).toBe(7);
    expect(s.lastScanAt).toBe('2026-07-30T09:00:00.000Z');
    expect(s.lastError).toBeNull();
  });

  it('unwraps a folder failure into one readable line', () => {
    const s = parseWatchStatus({
      watch: {
        running: false,
        error: { code: 'FOLDER_MISSING', message: 'The watched folder no longer exists.' },
      },
    });
    expect(s.lastError).toBe('The watched folder no longer exists.');
  });

  it('unwraps a serialised engine error into one readable line', () => {
    const s = parseWatchStatus({
      lastError: { code: 'FOLDER_MISSING', message: 'The watched folder no longer exists.' },
    });
    expect(s.lastError).toBe('The watched folder no longer exists.');
  });

  it('survives a shape nobody planned for', () => {
    for (const body of [null, undefined, 'nope', 42, [], {}]) {
      const s = parseWatchStatus(body);
      expect(s.running).toBe(false);
      expect(s.ingested).toBe(0);
      expect(s.folder).toBeNull();
    }
  });
});

/* ─────────────────────────── closing the window ─────────────────────────── */

describe('setup resumes where she left it', () => {
  const store = new Map<string, string>();

  function stubStorage(impl?: Partial<Storage>): void {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        ...impl,
      },
    };
  }

  afterEach(() => {
    store.clear();
    delete (globalThis as { window?: unknown }).window;
  });

  it('comes back to the step she was on', () => {
    stubStorage();
    writeProgress({ step: 2, testPassed: true });
    const back = readProgress(4);
    expect(back?.step).toBe(2);
    expect(back?.testPassed).toBe(true);
  });

  it('starts at the beginning when there is nothing saved', () => {
    stubStorage();
    expect(readProgress(4)).toBeNull();
  });

  it('clamps a saved step that no longer exists', () => {
    stubStorage();
    store.set('ibc.onboarding.progress.v1', JSON.stringify({ step: 99, testPassed: false }));
    expect(readProgress(4)?.step).toBe(4);
  });

  it('ignores a hand-edited or corrupt value rather than throwing', () => {
    stubStorage();
    for (const junk of ['not json', '[]', '{"step":-3}', 'null']) {
      store.set('ibc.onboarding.progress.v1', junk);
      expect(() => readProgress(4)).not.toThrow();
    }
  });

  it('keeps working when storage itself refuses', () => {
    // Private browsing, a full disk, a locked profile. Losing the position is a
    // worse first run; throwing here would be a broken one.
    stubStorage({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(readProgress(4)).toBeNull();
    expect(() => writeProgress({ step: 1, testPassed: false })).not.toThrow();
    expect(() => clearProgress()).not.toThrow();
  });

  it('forgets the position once setup is finished', () => {
    stubStorage();
    writeProgress({ step: 3, testPassed: false });
    clearProgress();
    expect(readProgress(4)).toBeNull();
  });

  it('records position only, never completion', () => {
    stubStorage();
    writeProgress({ step: 4, testPassed: true });
    // Completion is a server-side setting. A stale browser must never be able to
    // claim she finished a setup that never happened.
    const raw = store.get('ibc.onboarding.progress.v1') ?? '';
    expect(raw).not.toMatch(/onboardingComplete|complete["']?\s*:/i);
  });
});
