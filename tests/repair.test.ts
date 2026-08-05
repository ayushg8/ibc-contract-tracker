/**
 * Regression tests for unattended self-repair.
 *
 * This is the only part of the app that lets a model change the app, so the
 * tests are written against the guarantees rather than the implementation. In
 * rough order of how bad it would be to lose them:
 *
 *   1. A protected path is rejected however it is spelled.
 *   2. A gate that proves nothing is a failure, not a pass.
 *   3. The permission grant never widens, and never includes
 *      --dangerously-skip-permissions.
 *   4. The attempt cap survives a crash, and a usage limit does not spend one.
 *   5. Rollback that did not leave a healthy install stops repair dead.
 *   6. The scheduled agent and the promoter script parse, and say what they mean.
 *
 * IBC_DATA_DIR and IBC_LAUNCH_AGENTS_DIR are set before any import: the audit
 * writer opens a real database and the scheduler writes a real plist, and
 * neither may touch the machine running the tests.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { lintPlist } from './plist-support';

const root = mkdtempSync(join(tmpdir(), 'ibc-repair-'));
process.env['IBC_DATA_DIR'] = join(root, 'data');
process.env['IBC_LAUNCH_AGENTS_DIR'] = join(root, 'agents');
mkdirSync(join(root, 'agents'), { recursive: true });

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REPAIR_SH = join(REPO, 'packaging', 'app-template', 'bin', 'repair.sh');
const PLIST_IN = join(REPO, 'packaging', 'app-template', 'RepairAgent.plist.in');

const protectedPaths = await import('@/lib/repair/protected');
const signature = await import('@/lib/repair/signature');
const diff = await import('@/lib/repair/diff');
const state = await import('@/lib/repair/state');
const gates = await import('@/lib/repair/gates');
const claude = await import('@/lib/repair/claude');
const schedule = await import('@/lib/repair/schedule');
const workspace = await import('@/lib/repair/workspace');
const run = await import('@/lib/repair/run');
const audit = await import('@/lib/repair/audit');
const types = await import('@/lib/repair/types');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(state.statePath(), { force: true });
});

function tempDir(name: string): string {
  const dir = join(root, name, Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ═════════════════════════ protected paths ══════════════════════════ */

describe('protected paths', () => {
  const mustBeProtected = [
    'src/lib/extraction/pipeline.ts',
    'src/lib/extraction/verify.ts',
    'src/lib/extraction/ocr.ts',
    'src/lib/util/dates.ts',
    'src/lib/fields.ts',
    'src/lib/db/schema.sql',
    'src/lib/db/migrate.ts',
    'src/lib/providers/errors.ts',
    'evals/run.ts',
    'evals/cases/verify.ts',
    'tests/verify.test.ts',
    'tests/repair.test.ts',
  ];

  it.each(mustBeProtected)('refuses %s', (path) => {
    expect(protectedPaths.protectedRuleFor(path)).not.toBeNull();
  });

  it('also protects the repair machinery, the dependency list and the packaging', () => {
    // A repair agent that can edit its own guard rails is not a guard rail.
    for (const path of [
      'src/lib/repair/protected.ts',
      'src/lib/repair/run.ts',
      'package.json',
      'package-lock.json',
      'packaging/install.command',
      'packaging/app-template/bin/repair.sh',
      'node_modules/vitest/vitest.mjs',
      '.next/BUILD_ID',
    ]) {
      expect(protectedPaths.protectedRuleFor(path), path).not.toBeNull();
    }
  });

  it('protects the ruler as well as the thing being measured', () => {
    // The auditor did this for real: rewriting tsconfig.json with strict:false and
    // noUncheckedIndexedAccess:false turned a failing typecheck gate into a
    // passing one. The gate is only a guarantee while its own definition is not
    // something a repair may edit.
    for (const path of [
      'tsconfig.json',
      'tsconfig.build.json',
      'tsconfig.test.json',
      'next.config.ts',
      'vitest.config.ts',
    ]) {
      const rule = protectedPaths.protectedRuleFor(path);
      expect(rule, path).not.toBeNull();
      expect(rule?.reason).toContain('strictness');
    }
  });

  it('refuses a path carrying a control character', () => {
    // A newline in a filename is two paths to the shell script that reads the
    // promotion plan, and only the first of them was ever checked.
    const crafted = 'src/app/page.tsx\nsrc/lib/fields.ts';
    expect(protectedPaths.hasControlCharacters(crafted)).toBe(true);
    expect(protectedPaths.normaliseRelPath(crafted)).toBeNull();

    const violations = protectedPaths.protectedViolations([crafted, 'src/lib/watch.ts']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('control character');
    // Escaped, so the audit row cannot be split in two the same way.
    expect(violations[0]?.path).not.toContain('\n');
    expect(violations[0]?.path).toContain('\\x0a');
  });

  it('refuses every other control character too, not just the newline', () => {
    for (const ch of ['\t', '\r', '\u0000', '\u001b', '\u007f']) {
      expect(protectedPaths.hasControlCharacters(`src/a${ch}b.ts`), ch).toBe(true);
    }
    // And leaves an ordinary path alone: a guard that fires on everything is one
    // that gets turned off.
    expect(protectedPaths.hasControlCharacters('src/lib/watch.ts')).toBe(false);
    expect(protectedPaths.describePath('src/lib/watch.ts')).toBe('src/lib/watch.ts');
  });

  it('lets an ordinary source file through', () => {
    for (const path of [
      'src/lib/watch.ts',
      'src/app/api/health/route.ts',
      'src/components/ui/Button.tsx',
      'src/lib/db/queries.ts',
    ]) {
      expect(protectedPaths.protectedRuleFor(path), path).toBeNull();
    }
  });

  it('is not fooled by spelling', () => {
    // Every one of these resolves to a protected file. A guard that only matches
    // the tidy spelling is not a guard.
    for (const path of [
      './src/lib/extraction/pipeline.ts',
      'src//lib//extraction//pipeline.ts',
      'src\\lib\\extraction\\pipeline.ts',
    ]) {
      expect(protectedPaths.protectedRuleFor(path), path).not.toBeNull();
    }
  });

  it('treats a path outside the workspace as a violation of its own', () => {
    const violations = protectedPaths.protectedViolations([
      '/etc/hosts',
      '../../../Users/bonnie/Documents/secret.pdf',
      'src/lib/watch.ts',
    ]);
    expect(violations.map((v) => v.path)).toEqual([
      '/etc/hosts',
      '../../../Users/bonnie/Documents/secret.pdf',
    ]);
    expect(violations[0]?.reason).toContain('outside the repair workspace');
  });

  it('reports every offending path, not just the first', () => {
    const violations = protectedPaths.protectedViolations([
      'src/lib/fields.ts',
      'tests/db.test.ts',
      'src/lib/watch.ts',
    ]);
    expect(violations).toHaveLength(2);
  });

  it('matches globs the way the rules assume', () => {
    expect(protectedPaths.matchGlob('evals/**', 'evals/run.ts')).toBe(true);
    expect(protectedPaths.matchGlob('evals/**', 'evals/cases/a/b.ts')).toBe(true);
    expect(protectedPaths.matchGlob('evals/**', 'evalsomething/run.ts')).toBe(false);
    expect(protectedPaths.matchGlob('src/lib/util/dates.ts', 'src/lib/util/dates.ts')).toBe(true);
    expect(protectedPaths.matchGlob('src/lib/util/dates.ts', 'src/lib/util/dates.test.ts')).toBe(false);
  });

  it('puts every rule in the prompt', () => {
    const text = protectedPaths.protectedPathsForPrompt();
    for (const rule of protectedPaths.PROTECTED_RULES) {
      expect(text).toContain(rule.pattern);
    }
  });
});

/* ═══════════════════════ failure signatures ═════════════════════════ */

describe('failure signatures', () => {
  const base = {
    stage: 'build',
    code: 'BUILD_FAILED',
    message: 'next build exited 1',
    detail: 'src/lib/watch.ts(84,12): error TS2322: Type mismatch',
  };

  it('is stable across the noise two runs of one fault differ by', () => {
    const a = signature.failureSignature({
      ...base,
      detail: '2026-07-30T11:02:03Z /Users/bonnie/tmp/ibc-9f3a2 src/lib/watch.ts(84,12): error TS2322: Type mismatch in 12.4s',
    });
    const b = signature.failureSignature({
      ...base,
      detail: '2026-07-31T18:44:51Z /Users/someone/tmp/ibc-1c8ee src/lib/watch.ts(91,12): error TS2322: Type mismatch in 9.1s',
    });
    expect(a).toBe(b);
  });

  it('separates two genuinely different faults', () => {
    expect(signature.failureSignature(base)).not.toBe(
      signature.failureSignature({ ...base, message: 'next build ran out of memory' }),
    );
    expect(signature.failureSignature(base)).not.toBe(
      signature.failureSignature({ ...base, stage: 'health-check' }),
    );
  });

  it('ignores the log excerpt', () => {
    // The excerpt is the least stable thing on the machine. Hashing it would mint
    // a fresh signature for a fault that has already failed three times, and hand
    // the agent three more attempts at it.
    expect(signature.failureSignature({ ...base, logExcerpt: 'one' })).toBe(
      signature.failureSignature({ ...base, logExcerpt: 'completely different' }),
    );
  });

  it('is short enough to read down a phone', () => {
    expect(signature.failureSignature(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('normalises two positions the same however many digits they have', () => {
    // The hole: the clock rule matched the tail of a path as well as a time, so
    // `x.ts:84:12` became `x.ts:<time>` while `x.ts:91:7` became `x.ts:<pos>`.
    // One fault, two hashes, and a fresh allowance of three attempts every time
    // an edit above the error moved the column into a different digit count --
    // which is the cap the whole design leans on to stop an unfixable problem
    // looping forever on her subscription.
    const lines = [1, 7, 9, 12, 84, 91, 99, 112, 1_004];
    const columns = [1, 5, 7, 12, 40, 99, 100, 512];

    const colonForms = new Set<string>();
    const parenForms = new Set<string>();
    for (const line of lines) {
      for (const column of columns) {
        colonForms.add(signature.normaliseFailureText(`src/x.ts:${line}:${column}: error TS2322`));
        parenForms.add(signature.normaliseFailureText(`src/x.ts(${line},${column}): error TS2322`));
      }
    }
    expect([...colonForms]).toEqual(['src/x.ts:<pos>: error ts2322']);
    expect([...parenForms]).toEqual(['src/x.ts(<pos>): error ts2322']);
  });

  it('gives the same signature to the same fault at a different column', () => {
    const a = signature.failureSignature({ ...base, detail: 'src/lib/watch.ts:84:12: error TS2322' });
    const b = signature.failureSignature({ ...base, detail: 'src/lib/watch.ts:91:7: error TS2322' });
    expect(a).toBe(b);
  });

  it('still flattens a real clock, which is what that rule is for', () => {
    // Anchoring the clock rule must not stop it doing its job: a time of day in a
    // log line is noise, and two runs of one fault differ by it.
    expect(signature.normaliseFailureText('started at 10:30 am')).toBe('started at <time>');
    expect(signature.normaliseFailureText('started at 11:45 pm')).toBe('started at <time>');
    expect(signature.normaliseFailureText('[09:05:33] failed')).toBe('[<time>] failed');
    expect(signature.normaliseFailureText('[23:59:01] failed')).toBe('[<time>] failed');
  });

  it('never lets a clock match swallow the line after it', () => {
    // `\s*` before the optional am/pm used to eat a newline, gluing two lines of
    // a failure into one and hiding whatever was on the second.
    expect(signature.normaliseFailureText('at 10:30\nTS2322: type mismatch')).toBe(
      'at <time>\nts2322: type mismatch',
    );
  });
});

/* ══════════════════════════ tree diffing ════════════════════════════ */

describe('diffing the working tree', () => {
  it('finds what changed without being told', () => {
    const dir = tempDir('tree');
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(dir, 'b.ts'), 'const b = 2;\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'c.ts'), 'const c = 3;\n');

    const before = diff.scanTree(dir);
    writeFileSync(join(dir, 'a.ts'), 'const a = 99;\n');
    rmSync(join(dir, 'b.ts'));
    writeFileSync(join(dir, 'src', 'd.ts'), 'const d = 4;\n');
    const after = diff.scanTree(dir);

    const delta = diff.compareManifests(before, after);
    expect(delta.modified).toEqual(['a.ts']);
    expect(delta.removed).toEqual(['b.ts']);
    expect(delta.added).toEqual(['src/d.ts']);
    expect(diff.changedPaths(delta)).toEqual(['a.ts', 'b.ts', 'src/d.ts']);
  });

  it('does not walk node_modules or .next when fingerprinting source', () => {
    const dir = tempDir('tree');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(dir, '.next'), { recursive: true });
    writeFileSync(join(dir, '.next', 'BUILD_ID'), 'abc\n');
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');

    expect(Object.keys(diff.scanTree(dir))).toEqual(['a.ts']);
  });

  it('catches a write into node_modules by its timestamp', () => {
    // Hashing half a gigabyte of dependencies to prove nobody touched them is not
    // a trade worth making; a write there is forbidden, so detecting it is enough.
    const dir = tempDir('heavy');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'old.js'), 'old\n');
    const cutoff = Date.now() + 5;
    while (Date.now() <= cutoff) {
      /* the filesystem's mtime resolution is coarser than this loop */
    }
    writeFileSync(join(dir, 'pkg', 'new.js'), 'new\n');

    expect(diff.findWritesSince(dir, cutoff)).toEqual(['pkg/new.js']);
  });

  it('ignores a build cache inside node_modules', () => {
    // Running the tests is something the session is allowed to do, and vitest
    // writes its cache under node_modules. Reading that as tampering would
    // reject every well-behaved fix.
    const dir = tempDir('cache');
    mkdirSync(join(dir, '.vite'), { recursive: true });
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    const cutoff = Date.now() - 1_000;
    writeFileSync(join(dir, '.vite', 'deps.json'), '{}');
    writeFileSync(join(dir, 'pkg', 'patched.js'), 'tampered');
    expect(diff.findWritesSince(dir, cutoff)).toEqual(['pkg/patched.js']);
  });

  it('sees a symlink pointing out of the workspace, and says so', () => {
    // The auditor's escape: `escape -> /tmp/outside`, then a write to
    // `escape/src/lib/extraction/verify.ts`. The file outside the workspace was
    // modified and nothing at all was reported, because a link that points OUT is
    // the one thing hashing the tree cannot see.
    const dir = tempDir('escape-src');
    const outside = tempDir('escape-dst');
    mkdirSync(join(outside, 'src', 'lib', 'extraction'), { recursive: true });
    writeFileSync(join(outside, 'src', 'lib', 'extraction', 'verify.ts'), 'the citation guard\n');
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');

    const before = diff.scanTree(dir);
    symlinkSync(outside, join(dir, 'escape'));
    writeFileSync(join(dir, 'escape', 'src', 'lib', 'extraction', 'verify.ts'), 'tampered\n');
    const after = diff.scanTree(dir);

    // The link itself is an entry now, so the change is visible at all...
    expect(diff.compareManifests(before, after).added).toEqual(['escape']);
    // ...and it is rejected in its own right rather than followed.
    const violations = diff.symlinkViolations(dir, before, after);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('escape');
    expect(violations[0]?.target).toBe(outside);
    expect(violations[0]?.reason).toContain('created');
    expect(violations[0]?.reason).toContain('out of the repair workspace');
    // Nothing under the link was walked: following it is the escape, not the fix.
    expect(Object.keys(after).sort()).toEqual(['a.ts', 'escape']);
  });

  it('rejects a link the repair created even when it stays inside the tree', () => {
    const dir = tempDir('link-in');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'real.ts'), 'const a = 1;\n');
    const before = diff.scanTree(dir);
    symlinkSync(join(dir, 'src', 'real.ts'), join(dir, 'src', 'alias.ts'));
    const after = diff.scanTree(dir);

    const violations = diff.symlinkViolations(dir, before, after);
    expect(violations.map((v) => v.path)).toEqual(['src/alias.ts']);
    expect(violations[0]?.reason).toContain('created');
    expect(violations[0]?.reason).not.toContain('out of the repair workspace');
  });

  it('rejects a link that was repointed, and leaves an untouched one alone', () => {
    const dir = tempDir('link-move');
    writeFileSync(join(dir, 'one.ts'), 'const a = 1;\n');
    writeFileSync(join(dir, 'two.ts'), 'const b = 2;\n');
    symlinkSync('one.ts', join(dir, 'settled.ts'));
    symlinkSync('one.ts', join(dir, 'moved.ts'));

    const before = diff.scanTree(dir);
    rmSync(join(dir, 'moved.ts'));
    symlinkSync('two.ts', join(dir, 'moved.ts'));
    const after = diff.scanTree(dir);

    // A link is fingerprinted by its target, so repointing one is a modification.
    expect(diff.compareManifests(before, after).modified).toEqual(['moved.ts']);
    const violations = diff.symlinkViolations(dir, before, after);
    expect(violations.map((v) => v.path)).toEqual(['moved.ts']);
    expect(violations[0]?.reason).toContain('repointed');
  });

  it('reports a link that already led out, even though the repair did not make it', () => {
    // Not "was it changed" but "where does it go": a door out of the workspace is
    // a door out of the workspace whoever opened it, and the diff cannot see
    // through it either way.
    const dir = tempDir('link-old');
    symlinkSync('/etc', join(dir, 'etc'));
    const manifest = diff.scanTree(dir);
    const violations = diff.symlinkViolations(dir, manifest, manifest);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('a symbolic link that leads out of the repair workspace');
  });

  it('produces a unified diff a human can read', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after = 'one\ntwo\nTHREE\nfour\nfive\n';
    const text = diff.unifiedDiff('src/x.ts', before, after);
    expect(text).toContain('--- a/src/x.ts');
    expect(text).toContain('+++ b/src/x.ts');
    expect(text).toContain('-three');
    expect(text).toContain('+THREE');
    expect(text).toContain(' two');
    expect(text.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(1);
  });

  it('reports an added and a removed file as whole-file changes', () => {
    expect(diff.unifiedDiff('new.ts', '', 'hello\n')).toContain('+hello');
    expect(diff.unifiedDiff('gone.ts', 'hello\n', '')).toContain('-hello');
    expect(diff.unifiedDiff('same.ts', 'x\n', 'x\n')).toBe('');
  });

  it('refuses to diff a binary file rather than emitting rubbish', () => {
    const binary = `a${String.fromCharCode(0)}b`;
    expect(diff.unifiedDiff('x.png', binary, `${binary}c`)).toContain('binary file changed');
  });

  it('summarises a file too large to diff', () => {
    const huge = `${new Array(5_000).fill('x').join('\n')}\n`;
    expect(diff.unifiedDiff('big.ts', huge, `${huge}more\n`)).toContain('too large to diff');
  });

  it('builds one diff over an entire change set', () => {
    const beforeDir = tempDir('before');
    const afterDir = tempDir('after');
    writeFileSync(join(beforeDir, 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(afterDir, 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(afterDir, 'b.ts'), 'const b = 1;\n');

    const text = diff.buildUnifiedDiff(beforeDir, afterDir, {
      added: ['b.ts'],
      modified: ['a.ts'],
      removed: [],
    });
    expect(text).toContain('a/a.ts');
    expect(text).toContain('a/b.ts');
    expect(text).toContain('-const a = 1;');
    expect(text).toContain('+const a = 2;');
  });
});

/* ════════════════════════════ the state ═════════════════════════════ */

describe('durable state', () => {
  it('survives a corrupt file without losing the cap', () => {
    state.saveState({ ...state.emptyState(), attempts: { abc: 2 } });
    expect(state.loadState().attempts['abc']).toBe(2);

    writeFileSync(state.statePath(), '{not json at all');
    const recovered = state.loadState();
    expect(recovered.phase).toBe('idle');
    expect(recovered.attempts).toEqual({});
  });

  it('drops attempt counts that are not numbers', () => {
    const parsed = state.parseState('{"attempts":{"a":3,"b":"lots","c":-1}}');
    expect(parsed.attempts).toEqual({ a: 3 });
  });

  it('spends an attempt before the work, so a crash cannot buy another', () => {
    expect(state.spendAttempt('sig')).toBe(1);
    expect(state.spendAttempt('sig')).toBe(2);
    // Simulating the crash: nothing else ran, and the count is still on disk.
    expect(state.loadState().attempts['sig']).toBe(2);
    expect(state.capReached(state.loadState(), 'sig')).toBe(false);
    expect(state.spendAttempt('sig')).toBe(3);
    expect(state.capReached(state.loadState(), 'sig')).toBe(true);
  });

  it('refunds the attempt a usage limit consumed', () => {
    state.spendAttempt('sig');
    state.spendAttempt('sig');
    state.refundAttempt('sig');
    expect(state.loadState().attempts['sig']).toBe(1);
  });

  it('knows a resume is owed from the file alone', () => {
    const suspended = {
      attemptId: 'a',
      signature: 's',
      attempt: 1,
      workspace: '/tmp/w',
      request: {
        failure: { stage: 'build', code: 'X', message: 'y' },
        rollback: { performed: true, healthy: true, version: '1.0.0', at: '' },
        update: { fromVersion: '1.0.0', toVersion: '1.1.0', diff: '' },
      },
      sessionId: null,
      resumeAt: new Date(Date.now() - 60_000).toISOString(),
      resumeSource: 'cli' as const,
      lastGateDetail: '',
    };
    state.saveState({ ...state.emptyState(), suspended });
    expect(state.dueForResume(state.loadState())).toBe(true);

    state.saveState({
      ...state.emptyState(),
      suspended: { ...suspended, resumeAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(state.dueForResume(state.loadState())).toBe(false);
  });

  it('never resumes while an emergency is recorded', () => {
    state.saveState({
      ...state.emptyState(),
      emergency: { at: new Date().toISOString(), reason: 'rollback unhealthy' },
      suspended: {
        attemptId: 'a',
        signature: 's',
        attempt: 1,
        workspace: '/tmp/w',
        request: {
          failure: { stage: 'build', code: 'X', message: 'y' },
          rollback: { performed: false, healthy: false, version: null, at: '' },
          update: { fromVersion: null, toVersion: null, diff: '' },
        },
        sessionId: null,
        resumeAt: new Date(Date.now() - 1).toISOString(),
        resumeSource: 'default',
        lastGateDetail: '',
      },
    });
    expect(state.dueForResume(state.loadState())).toBe(false);
  });

  it('journals without the database', () => {
    state.journal('test.event', { a: 1 });
    expect(readFileSync(state.journalPath(), 'utf8')).toContain('test.event');
  });
});

/* ════════════════════════════ the gates ═════════════════════════════ */

describe('gates judge evidence, not exit codes', () => {
  it('fails a typecheck that checked no files', () => {
    // tsc prints nothing on success and also prints nothing when it resolved an
    // empty program. The Files: count is what tells them apart.
    const empty = gates.parseTscOutput('Files: 0\nLines: 0\n');
    expect(empty.errors).toBe(0);
    expect(empty.filesChecked).toBe(0);

    const real = gates.parseTscOutput('Files:                4137\nLines: 342282\n');
    expect(real.filesChecked).toBe(4137);
  });

  it('counts typescript errors', () => {
    const verdict = gates.parseTscOutput(
      ['src/a.ts(1,1): error TS2322: nope', 'src/b.ts(9,4): error TS2345: also nope', 'Files: 10'].join('\n'),
    );
    expect(verdict.errors).toBe(2);
    expect(verdict.firstErrors).toHaveLength(2);
  });

  it('fails a test run that ran no tests', () => {
    const verdict = gates.parseVitestReport({ numTotalTests: 0, testResults: [] });
    expect(verdict.total).toBe(0);
    expect(verdict.files).toBe(0);
  });

  it('reads test names so a baseline can be compared', () => {
    const verdict = gates.parseVitestReport({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      testResults: [
        {
          name: '/x/tests/a.test.ts',
          assertionResults: [
            { fullName: 'a passes', status: 'passed' },
            { fullName: 'b fails', status: 'failed' },
            { fullName: 'c skipped', status: 'skipped' },
          ],
        },
      ],
    });
    expect(verdict.byName['a passes']).toBe(true);
    expect(verdict.byName['b fails']).toBe(false);
    // A skip is neither a pass nor a failure, and must not be recorded as a pass.
    expect(verdict.byName['c skipped']).toBeUndefined();
    expect(verdict.failures).toEqual(['b fails']);
  });

  it('forgives a test that was already failing and never forgives a new one', () => {
    const baseline = gates.parseVitestReport({
      numTotalTests: 2,
      testResults: [
        {
          name: 'f',
          assertionResults: [
            { fullName: 'stores PDFs and thumbnails', status: 'failed' },
            { fullName: 'computes an expiry', status: 'passed' },
          ],
        },
      ],
    });

    const stillFlaky = gates.parseVitestReport({
      numTotalTests: 2,
      testResults: [
        {
          name: 'f',
          assertionResults: [
            { fullName: 'stores PDFs and thumbnails', status: 'failed' },
            { fullName: 'computes an expiry', status: 'passed' },
          ],
        },
      ],
    });
    expect(gates.newlyFailing(baseline, stillFlaky)).toEqual([]);

    const broken = gates.parseVitestReport({
      numTotalTests: 2,
      testResults: [
        {
          name: 'f',
          assertionResults: [
            { fullName: 'stores PDFs and thumbnails', status: 'failed' },
            { fullName: 'computes an expiry', status: 'failed' },
          ],
        },
      ],
    });
    expect(gates.newlyFailing(baseline, broken)).toEqual(['computes an expiry']);

    // A test that has vanished counts as broken: deleting the test that catches
    // you is not a way to pass.
    const deleted = gates.parseVitestReport({
      numTotalTests: 1,
      testResults: [
        { name: 'f', assertionResults: [{ fullName: 'stores PDFs and thumbnails', status: 'failed' }] },
      ],
    });
    expect(gates.newlyFailing(baseline, deleted)).toEqual(['computes an expiry']);
  });

  it('with no baseline, any failing test is fatal', () => {
    const after = gates.parseVitestReport({
      numTotalTests: 1,
      testResults: [{ name: 'f', assertionResults: [{ fullName: 'x', status: 'failed' }] }],
    });
    expect(gates.newlyFailing(null, after)).toEqual(['x']);
  });

  it('reads the eval runner and ignores live cases', () => {
    const verdict = gates.parseEvalReport({
      totals: { cases: 3, casesPassed: 2, offlineFailures: 1 },
      cases: [
        { name: 'verify', status: 'pass', live: false },
        { name: 'dates', status: 'fail', live: false },
        { name: 'engine', status: 'fail', live: true },
      ],
    });
    expect(verdict.cases).toBe(3);
    expect(verdict.offlineFailures).toBe(1);
    // A live case failing is a model having a bad day, not a regression.
    expect(verdict.failures).toEqual(['dates']);
  });

  it('treats an unparseable report as no evidence at all', () => {
    expect(gates.parseVitestReport(null).total).toBe(0);
    expect(gates.parseEvalReport('nonsense').cases).toBe(0);
    expect(gates.parseJsonFromText('no json here')).toBeNull();
    expect(gates.parseJsonFromText('noise {"a":1} trailing')).toEqual({ a: 1 });
  });

  it('requires the build to have left something behind', () => {
    const dir = tempDir('build');
    expect(gates.buildProduced(dir).ok).toBe(false);
    mkdirSync(join(dir, '.next'));
    writeFileSync(join(dir, '.next', 'BUILD_ID'), 'x');
    expect(gates.buildProduced(dir).ok).toBe(false);
    writeFileSync(join(dir, '.next', 'routes-manifest.json'), '{}');
    expect(gates.buildProduced(dir).ok).toBe(true);
  });

  it('refuses to gate a tree it cannot gate', () => {
    const bare = tempDir('bare');
    const readiness = gates.checkGateReadiness(bare);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain('tests');
    expect(readiness.missing).toContain('evals/run.ts');
    // The repo itself is gateable, which is what makes the check meaningful.
    expect(gates.checkGateReadiness(REPO).ready).toBe(true);
  });

  it('kills a command that overruns its deadline', async () => {
    const outcome = await gates.runCommand('/bin/sh', ['-c', 'sleep 30'], {
      cwd: root,
      timeoutMs: 300,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.durationMs).toBeLessThan(15_000);
  });

  it('captures what a command said', async () => {
    const outcome = await gates.runCommand('/bin/sh', ['-c', 'echo hello; echo bad >&2; exit 3'], {
      cwd: root,
      timeoutMs: 10_000,
    });
    expect(outcome.stdout).toContain('hello');
    expect(outcome.stderr).toContain('bad');
    expect(outcome.exitCode).toBe(3);
  });
});

/* ═══════════════════════ the permission grant ═══════════════════════ */

describe('the permission grant', () => {
  const everything = claude.parseRepairFlagSupport(
    [
      '--allowed-tools',
      '--disallowed-tools',
      '--permission-mode',
      '--dangerously-skip-permissions',
      '--output-format',
      '--model',
      '--max-turns',
      '--resume',
      '--add-dir',
    ].join('\n'),
  );

  it('never asks for --dangerously-skip-permissions', () => {
    // It is the one flag that would turn this from a narrow grant into a machine
    // that does whatever it likes on a CFO's Mac.
    const argv = claude.buildRepairArgv({ flags: everything, modelId: 'claude-opus-5' });
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(JSON.stringify(argv)).not.toContain('bypassPermissions');
  });

  it('asks for the narrowest mode that can edit at all', () => {
    const argv = claude.buildRepairArgv({ flags: everything, modelId: 'claude-opus-5' });
    expect(argv).toContain('--permission-mode');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('grants reading, editing and three named test commands, and nothing else', () => {
    const argv = claude.buildRepairArgv({ flags: everything, modelId: 'claude-opus-5' });
    const allowed = argv[argv.indexOf('--allowed-tools') + 1] ?? '';
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Edit');
    expect(allowed).toContain('Bash(node node_modules/vitest/vitest.mjs:*)');
    // Bare Bash is the whole difference between "may run the tests" and "may run
    // anything", and it is denied explicitly as well as omitted.
    expect(allowed.split(',')).not.toContain('Bash');
    const denied = argv[argv.indexOf('--disallowed-tools') + 1] ?? '';
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Task']) {
      expect(denied.split(',')).toContain(tool);
    }
  });

  it('caps the session in both dimensions', () => {
    const argv = claude.buildRepairArgv({ flags: everything, modelId: 'claude-opus-5' });
    expect(argv).toContain('--max-turns');
    expect(types.CLAUDE_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it('passes no flag the installed build does not have', () => {
    const ancient = claude.parseRepairFlagSupport('--allowed-tools\n');
    const argv = claude.buildRepairArgv({
      flags: ancient,
      modelId: 'claude-opus-5',
      resumeSessionId: 'abc',
    });
    expect(argv).not.toContain('--max-turns');
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--model');
  });

  it('resumes a capped session when the build can', () => {
    const argv = claude.buildRepairArgv({
      flags: everything,
      modelId: 'claude-opus-5',
      resumeSessionId: 'session-9',
    });
    expect(argv[argv.indexOf('--resume') + 1]).toBe('session-9');
  });

  it('refuses a build that cannot enforce the grant', () => {
    const noFlags = claude.parseRepairFlagSupport('--version\n--help\n');
    expect(claude.grantIsEnforceable(noFlags)).toBe(false);
    expect(claude.grantIsEnforceable(everything)).toBe(true);
  });

  it('describes the grant for the audit trail', () => {
    const described = claude.describeGrant(everything);
    expect(described).toContain('skipPermissions=never');
    expect(described).toContain('cwd=workspace-clone');
  });
});

/* ═══════════════════════════ the prompt ═════════════════════════════ */

describe('the repair prompt', () => {
  const request = {
    failure: {
      stage: 'build',
      code: 'BUILD_FAILED',
      message: 'next build exited 1',
      detail: 'src/lib/watch.ts(84,12): error TS2322',
      logExcerpt: 'a log line\nanother line',
    },
    rollback: { performed: true, healthy: true, version: '1.0.0', at: '2026-07-30T10:00:00Z' },
    update: { fromVersion: '1.0.0', toVersion: '1.1.0', diff: '--- a/x\n+++ b/x\n+broken\n' },
  };

  it('tells the model what it may not touch', () => {
    const prompt = claude.buildRepairPrompt({ request, attempt: 1, cap: 3 });
    expect(prompt).toContain('src/lib/extraction/**');
    expect(prompt).toContain('tests/**');
    expect(prompt).toContain('checked mechanically');
  });

  it('says the app is already rolled back and working', () => {
    const prompt = claude.buildRepairPrompt({ request, attempt: 2, cap: 3 });
    expect(prompt).toContain('ALREADY been rolled back');
    expect(prompt).toContain('attempt 2 of 3');
  });

  it('asks for the smallest change, not a refactor', () => {
    const prompt = claude.buildRepairPrompt({ request, attempt: 1, cap: 3 });
    expect(prompt).toContain('SMALLEST change');
    expect(prompt).toContain('Not a refactor');
  });

  it('feeds the previous rejection back in', () => {
    const prompt = claude.buildRepairPrompt({
      request,
      attempt: 2,
      cap: 3,
      previousGateDetail: '[tests] 3 failed',
      previousDiff: '--- a/y\n+++ b/y\n',
    });
    expect(prompt).toContain('[tests] 3 failed');
    expect(prompt).toContain('previous attempt');
  });

  it('redacts a credential that reached it through a log', () => {
    const leaky = {
      ...request,
      failure: {
        ...request.failure,
        logExcerpt: 'x-api-key: sk-ant-abcdefghijklmnop failed',
      },
    };
    const prompt = claude.buildRepairPrompt({ request: leaky, attempt: 1, cap: 3 });
    expect(prompt).not.toContain('sk-ant-abcdefghijklmnop');
  });

  it('is ASCII, like everything else that reaches a shell or a log', () => {
    const prompt = claude.buildRepairPrompt({ request, attempt: 1, cap: 3 });
    expect([...prompt].every((ch) => (ch.codePointAt(0) ?? 0) < 128)).toBe(true);
  });
});

/* ══════════════════════ reading a finished session ══════════════════ */

describe('reading a finished session', () => {
  it('treats prose with a clean exit as a finished session', () => {
    // classifyCliOutput is built for extraction, where the answer is JSON. A
    // repair's answer is prose, so CLI_BAD_OUTPUT plus exit 0 is the normal end.
    expect(
      claude.isRepairSessionOk({ kind: 'error', code: 'CLI_BAD_OUTPUT', detail: '' }, 0),
    ).toBe(true);
  });

  it('never treats a named failure as a finished session', () => {
    for (const code of [
      'CLI_USAGE_LIMIT',
      'CLI_PERMISSION_PROMPT',
      'CLI_NOT_AUTHENTICATED',
      'CLI_TIMEOUT',
      'CLI_CRASHED',
    ] as const) {
      expect(claude.isRepairSessionOk({ kind: 'error', code, detail: '' }, 0)).toBe(false);
    }
    expect(
      claude.isRepairSessionOk({ kind: 'error', code: 'CLI_BAD_OUTPUT', detail: '' }, 1),
    ).toBe(false);
  });

  it('finds the session id to resume with', () => {
    expect(
      claude.sessionIdFrom(JSON.stringify({ type: 'result', session_id: 'abc-123', result: 'done' })),
    ).toBe('abc-123');
    expect(claude.sessionIdFrom('just text')).toBeNull();
  });
});

/* ═════════════════════════ the scheduled agent ══════════════════════ */

describe('the usage limit is read in the dialect the app already speaks', () => {
  it('gets CLI_USAGE_LIMIT and a reset time from the same classifier the queue uses', async () => {
    // Reusing providers/cli.ts here is the whole point: a second way of noticing
    // a subscription cap would be a second thing to keep true, and the queue's
    // halt-once behaviour was already built on this one.
    const cli = await import('@/lib/providers/cli');
    const now = Date.parse('2026-07-30T12:00:00Z');
    const classified = cli.classifyCliOutput(
      {
        stdout: '',
        stderr: "You have reached your usage limit. It resets at 2026-07-30T15:00:00Z.",
        exitCode: 1,
        signal: null,
        timedOut: false,
        aborted: false,
        toolsDisabled: true,
      },
      now,
    );
    expect(classified.kind).toBe('error');
    if (classified.kind !== 'error') return;
    expect(classified.code).toBe('CLI_USAGE_LIMIT');
    expect(classified.limitResetsAt).toBe('2026-07-30T15:00:00.000Z');
    expect(classified.retryAfterMs).toBe(3 * 60 * 60 * 1000);
  });

  it('has a conservative default for a cap that will not say when it lifts', () => {
    // Guessing early would burn a session against a limit that has not moved.
    expect(types.DEFAULT_LIMIT_WAIT_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('does not spend an attempt on being told to come back later', () => {
    // Three caps in a row would otherwise exhaust the allowance without Claude
    // ever having read a line of the code.
    const sig = 'sig-limit';
    state.saveState(state.emptyState());
    state.spendAttempt(sig);
    state.refundAttempt(sig);
    expect(state.loadState().attempts[sig]).toBe(0);
    expect(state.capReached(state.loadState(), sig)).toBe(false);
  });
});

describe('the retry LaunchAgent', () => {
  const vars = {
    label: schedule.REPAIR_AGENT_LABEL,
    repairSh: '/Users/bonnie/Library/Application Support/IBC Contract Tracker/repair/bin/repair.sh',
    month: 8,
    day: 3,
    hour: 21,
    minute: 30,
    stdout: '/tmp/out.log',
    stderr: '/tmp/err.log',
    home: '/Users/bonnie',
    path: '/usr/bin:/bin',
  };

  it('renders with nothing left unsubstituted', () => {
    const plist = schedule.renderRepairPlist(vars);
    for (const placeholder of schedule.REPAIR_PLIST_PLACEHOLDERS) {
      expect(plist, placeholder).not.toContain(placeholder);
    }
    expect(plist).not.toMatch(/@@[A-Z_]+@@/);
  });

  it('is a plist macOS will actually load', () => {
    const file = join(tempDir('plist'), 'agent.plist');
    writeFileSync(file, schedule.renderRepairPlist(vars));
    expect(() => lintPlist(file)).not.toThrow();
  });

  it('fires at the reset time and never at load', () => {
    const plist = schedule.renderRepairPlist(vars);
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toContain('<integer>21</integer>');
    expect(plist).toContain('<integer>30</integer>');
    // RunAtLoad true would start a repair on every login, which is not what a
    // reset time means.
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });

  it('is background, unlike the server agent, and says why', () => {
    const plist = schedule.renderRepairPlist(vars);
    expect(plist).toContain('<string>Background</string>');
    expect(plist).toContain('<key>LowPriorityIO</key>');
    // The server's agent is Interactive because she waits on it. This is not that.
    const server = readFileSync(join(REPO, 'packaging', 'app-template', 'LaunchAgent.plist.in'), 'utf8');
    expect(server).toContain('<string>Interactive</string>');
  });

  it('does not collide with the server agent label', () => {
    expect(schedule.REPAIR_AGENT_LABEL).not.toBe('com.internationalbattery.contract-tracker');
    expect(schedule.REPAIR_AGENT_LABEL.startsWith('com.internationalbattery.contract-tracker')).toBe(true);
  });

  it('escapes a path that would otherwise break the XML', () => {
    const plist = schedule.renderRepairPlist({ ...vars, home: '/Users/a&b<c>' });
    expect(plist).toContain('/Users/a&amp;b&lt;c&gt;');
    const file = join(tempDir('plist'), 'agent.plist');
    writeFileSync(file, plist);
    expect(() => lintPlist(file)).not.toThrow();
  });

  it('clamps a reset time that has already passed', () => {
    // Otherwise launchd waits a year for the date to come round again.
    const now = new Date('2026-07-30T12:00:00');
    const past = schedule.calendarFor(new Date('2026-07-30T09:00:00'), now);
    expect(past.hour).toBe(12);
    expect(past.minute).toBe(1);

    const future = schedule.calendarFor(new Date('2026-07-30T21:30:00'), now);
    expect(future).toEqual({ month: 7, day: 30, hour: 21, minute: 30 });
  });

  it('keeps the packaging template byte-identical to the one that runs', () => {
    // Two copies of a launchd job is two behaviours. The installer's template and
    // the string the app writes at runtime must never drift apart.
    expect(readFileSync(PLIST_IN, 'utf8')).toBe(schedule.REPAIR_PLIST_TEMPLATE);
  });

  it('puts the agent somewhere an update cannot take away', () => {
    // A plist pointing inside the .app is one install away from being a broken
    // calendar entry, because the bundle is exactly what an update replaces.
    expect(schedule.promoterScriptPath()).toContain('repair/bin/repair.sh');
    expect(schedule.promoterScriptPath()).not.toContain('.app/');
  });
});

/* ══════════════════════════ the workspace ═══════════════════════════ */

describe('the workspace and the handover', () => {
  it('recognises the app source and rejects anything else', () => {
    expect(workspace.looksLikeAppSource(REPO)).toBe(true);
    expect(workspace.looksLikeAppSource(tempDir('nope'))).toBe(false);

    const impostor = tempDir('impostor');
    writeFileSync(join(impostor, 'package.json'), '{"name":"something-else"}');
    expect(workspace.looksLikeAppSource(impostor)).toBe(false);
  });

  it('verifies a clone arrived rather than trusting cp', () => {
    const source = tempDir('src');
    mkdirSync(join(source, 'src', 'lib'), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"name":"ibc-contract-tracker"}');
    writeFileSync(join(source, 'src', 'lib', 'fields.ts'), 'export const x = 1;\n');

    const target = join(tempDir('clone'), 'ws');
    const result = workspace.cloneTree(source, target);
    expect(existsSync(join(target, 'src', 'lib', 'fields.ts'))).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const incomplete = tempDir('incomplete');
    expect(() => workspace.cloneTree(incomplete, join(tempDir('clone2'), 'ws'))).toThrow();
  });

  it('writes a plan the shell can read without a JSON parser', () => {
    const plan = {
      attemptId: 'attempt-1',
      signature: 'sig',
      workspace: '/tmp/ws',
      live: "/Applications/IBC Contracts.app/Contents/Resources/app",
      files: ['src/lib/watch.ts', 'src/app/api/health/route.ts'],
      backup: '/tmp/backup',
      resultFile: '/tmp/result.txt',
      serverSh: '/tmp/server.sh',
      createdAt: new Date().toISOString(),
    };
    const staged = workspace.stagePromotion(plan);

    // The consumer is POSIX sh running after this process is dead, so the format
    // has to be sourceable.
    const probe = join(tempDir('probe'), 'probe.sh');
    writeFileSync(
      probe,
      ['#!/bin/sh', 'set -u', `. '${staged.envFile}'`, 'printf "%s|%s" "$PLAN_LIVE" "$PLAN_WORKSPACE"'].join('\n'),
    );
    const out = execFileSync('/bin/sh', [probe], { encoding: 'utf8' });
    expect(out).toBe(`${plan.live}|${plan.workspace}`);
    expect(readFileSync(staged.listFile, 'utf8').trim().split('\n')).toEqual(plan.files);
  });

  it('survives a path with a quote in it', () => {
    expect(workspace.shellQuote("Bonnie's Mac")).toBe(`Bonnie'\\''s Mac`);
  });

  it('takes the promoter script out of the update payload when the bundle has none', () => {
    // install.command excludes packaging/ from the .app, so on a machine
    // installed before self-repair existed the only copy of repair.sh is the one
    // the update brought with it. Without this, the first repair could never be
    // promoted on the machine that needs it most.
    const payload = tempDir('payload');
    const binDir = join(payload, 'packaging', 'app-template', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'repair.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(binDir, 'common.sh'), '# shared\n');

    const bundleless = tempDir('bundleless');
    const script = workspace.materialisePromoter(bundleless, [payload]);
    expect(script).not.toBeNull();
    expect(existsSync(script ?? '')).toBe(true);
    // Copied out of the payload, not referenced inside it: the payload is
    // temporary and the calendar entry is not.
    expect(script).toContain('repair/bin/repair.sh');
    expect(statSync(script ?? '').mode & 0o111).not.toBe(0);
  });

  it('calls an unfinished promotion pending, never applied', () => {
    // Absence of a verdict is not a verdict. Reading it as success would be the
    // worst possible default.
    expect(workspace.readPromotionResult('never-ran').status).toBe('pending');
  });

  it('reads the promoter verdict', () => {
    const id = 'attempt-result';
    mkdirSync(state.attemptDir(id), { recursive: true });
    writeFileSync(
      join(state.attemptDir(id), 'result.txt'),
      'status=reverted\ndetail=the fix did not answer\nat=2026-07-30T10:00:00Z\n',
    );
    const result = workspace.readPromotionResult(id);
    expect(result.status).toBe('reverted');
    expect(result.detail).toBe('the fix did not answer');
  });

  it('refuses to delete anything outside its own workspaces folder', () => {
    const outside = tempDir('precious');
    writeFileSync(join(outside, 'contracts.db'), 'do not delete me');
    workspace.removeWorkspace(outside);
    expect(existsSync(join(outside, 'contracts.db'))).toBe(true);
  });

  it('keeps only the most recent workspaces', () => {
    const dirs = ['w1', 'w2', 'w3', 'w4', 'w5'].map((name) => {
      const dir = join(state.workspacesDir(), name);
      mkdirSync(dir, { recursive: true });
      return dir;
    });
    state.pruneWorkspaces(2);
    const survivors = dirs.filter((d) => existsSync(d));
    expect(survivors.length).toBeLessThanOrEqual(3);
  });
});

/* ═══════════════════════ the orchestrator ═══════════════════════════ */

/** The state file is the only place an answer can arrive from a deferred run. */
async function settle(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the repair never reached a terminal state');
}

const healthyRollback = {
  performed: true,
  healthy: true,
  version: '1.0.0',
  at: new Date().toISOString(),
};

function requestFor(message: string, extra: Record<string, unknown> = {}) {
  return {
    failure: { stage: 'build', code: 'BUILD_FAILED', message },
    rollback: healthyRollback,
    update: { fromVersion: '1.0.0', toVersion: '1.1.0', diff: '' },
    ...extra,
  };
}

describe('the typecheck gate is measured against the pristine tree', () => {
  function typecheckResult(filesChecked: number, evidence?: string) {
    return [
      {
        id: 'typecheck' as const,
        ok: true,
        evidence: evidence ?? `${filesChecked} files checked, 0 errors`,
        detail: '',
        exitCode: 0,
        durationMs: 1,
      },
    ];
  }

  it('accepts a candidate that checks as much as the tree it started from', () => {
    expect(run.typecheckNarrowing(900, typecheckResult(900))).toBeNull();
    expect(run.typecheckNarrowing(900, typecheckResult(1_400))).toBeNull();
    // A fix is allowed to delete a file or two. A gate that fires on an honest
    // deletion is a gate that gets switched off.
    expect(run.typecheckNarrowing(900, typecheckResult(897))).toBeNull();
  });

  it('refuses a candidate that made the program smaller instead of correct', () => {
    // `errors === 0 && filesChecked > 0` is satisfiable by checking almost
    // nothing, which is the same defeat as rewriting tsconfig.json: move the
    // ruler, not the thing measured.
    const narrowed = run.typecheckNarrowing(900, typecheckResult(12));
    expect(narrowed).toContain('12 files');
    expect(narrowed).toContain('900');
    expect(narrowed).toContain('moved the ruler');
  });

  it('refuses a candidate whose typecheck stopped saying what it did', () => {
    // Having had a number and lost it is not the same as never having had one:
    // the first is a gate that can no longer be accounted for.
    expect(run.typecheckNarrowing(900, typecheckResult(0, 'unknown gate'))).toContain(
      'no longer reports',
    );
    expect(run.typecheckNarrowing(900, [])).toContain('no longer reports');
  });

  it('does nothing at all without a baseline', () => {
    // No floor is not a floor of zero. An unreadable baseline must disable the
    // comparison, never fail every candidate against a number we never had.
    expect(run.typecheckNarrowing(null, typecheckResult(3))).toBeNull();
    expect(run.typecheckNarrowing(0, typecheckResult(0, 'unknown gate'))).toBeNull();
  });
});

describe('the order the guardrails run in', () => {
  it('refuses to run at all when rollback did not leave a healthy install', async () => {
    // The whole design rests on this: repair is background work on a machine that
    // is already working. If it is not, an AI must not be the next thing to touch it.
    await run.runRepair({
      ...requestFor('the swap failed half way'),
      rollback: { performed: true, healthy: false, version: '1.0.0', at: '' },
    });
    await settle(() => run.repairStatus().phase === 'emergency');

    const status = run.repairStatus();
    expect(status.emergency).not.toBeNull();
    expect(status.emergency?.reason).toContain('health check');
    // No attempt was spent: this is not a problem attempts can solve.
    expect(status.attemptsUsed).toBe(0);

    const history = audit.recentRepairAudit(5);
    expect(history[0]?.action).toBe('repair_refused');
    expect(history[0]?.detail).toContain('EMERGENCY');
  });

  it('refuses again while the emergency stands', async () => {
    await run.runRepair({
      ...requestFor('another failure'),
      rollback: { performed: false, healthy: false, version: null, at: '' },
    });
    await settle(() => run.repairStatus().phase === 'emergency');
    const before = audit.recentRepairAudit(50).length;

    await run.runRepair(requestFor('a third failure'));
    await new Promise((r) => setTimeout(r, 200));
    expect(run.repairStatus().phase).toBe('emergency');
    expect(audit.recentRepairAudit(50).length).toBe(before);
  });

  it('stops permanently once a failure has had its attempts', async () => {
    const request = requestFor('a failure that cannot be fixed');
    const sig = signature.failureSignature(request.failure);
    state.saveState({
      ...state.emptyState(),
      attempts: { [sig]: types.MAX_ATTEMPTS_PER_SIGNATURE },
    });

    await run.runRepair(request);
    await settle(() => run.repairStatus().phase === 'exhausted');

    expect(run.repairStatus().attemptsUsed).toBe(types.MAX_ATTEMPTS_PER_SIGNATURE);
    const history = audit.recentRepairAudit(5);
    expect(history[0]?.action).toBe('repair_exhausted');
    expect(history[0]?.signature).toBe(sig);
  });

  it('refuses when the updater handed over nothing to gate against', async () => {
    // The installed .app has no tests/ and no evals/, by design. A repair that
    // cannot be gated must not be attempted at all.
    await run.runRepair(requestFor('a failure with no source tree'));
    await settle(() => run.repairStatus().phase === 'refused');

    const status = run.repairStatus();
    expect(status.last?.outcome).toBe('refused');
    expect(status.last?.summary).toContain('source tree');
    // Nothing was spent on a repair that was never possible.
    expect(status.attemptsUsed).toBe(0);
  });

  it('refuses a source tree the gates cannot run in', async () => {
    const bare = tempDir('bare-source');
    mkdirSync(join(bare, 'src', 'lib'), { recursive: true });
    writeFileSync(join(bare, 'package.json'), '{"name":"ibc-contract-tracker"}');
    writeFileSync(join(bare, 'src', 'lib', 'fields.ts'), 'export const x = 1;\n');

    await run.runRepair(requestFor('a failure with an incomplete tree', { sourceDir: bare }));
    await settle(() => run.repairStatus().phase === 'refused');

    expect(run.repairStatus().last?.summary).toContain('cannot be gated');
    expect(run.repairStatus().attemptsUsed).toBe(0);
  });

  it('creates the attempt directory itself rather than inheriting one', async () => {
    // It used to exist only because runGate() happened to mkdir its report
    // directory first. Everything in an attempt writes into it -- the prompt, the
    // baselines, the diff -- with unwrapped calls, so the day that order changed
    // a missing directory would have become a crash in a background job nobody
    // is awaiting.
    const attemptsRoot = join(state.repairDir(), 'attempts');
    mkdirSync(attemptsRoot, { recursive: true });
    const before = new Set(readdirSync(attemptsRoot));

    const bare = tempDir('bare-source');
    mkdirSync(join(bare, 'src', 'lib'), { recursive: true });
    writeFileSync(join(bare, 'package.json'), '{"name":"ibc-contract-tracker"}');
    writeFileSync(join(bare, 'src', 'lib', 'fields.ts'), 'export const x = 1;\n');

    await run.runRepair(requestFor('a failure that never reaches a gate', { sourceDir: bare }));
    await settle(() => run.repairStatus().phase === 'refused');

    // Refused long before any gate ran, and the directory is there anyway.
    const added = readdirSync(attemptsRoot).filter((name) => !before.has(name));
    expect(added).toHaveLength(1);
    expect(existsSync(join(attemptsRoot, added[0] ?? 'nothing'))).toBe(true);
  });

  it('reports one repair at a time rather than starting a second', async () => {
    state.saveState(state.emptyState());
    await run.runRepair(requestFor('first'));
    const second = await run.runRepair(requestFor('second'));
    expect(second).toBeDefined();
    await settle(() => !run.isRepairRunning());
  });

  it('never claims a promotion succeeded until the promoter says so', () => {
    const pending = {
      attemptId: 'attempt-unreported',
      signature: 'sig-x',
      startedAt: new Date().toISOString(),
      diffPath: null,
      workspace: join(state.workspacesDir(), 'attempt-unreported'),
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      changed: { added: 0, modified: 1, removed: 0 },
      gates: [],
      failure: { stage: 'build', code: 'X', message: 'y' },
    };
    state.saveState({ ...state.emptyState(), phase: 'promoting', pending });

    run.reconcilePromotion();
    // No result file: the promotion stays unresolved, and nothing downstream is
    // allowed to read that as success.
    expect(state.loadState().phase).toBe('promoting');
    expect(state.loadState().pending).not.toBeNull();

    mkdirSync(state.attemptDir(pending.attemptId), { recursive: true });
    writeFileSync(
      join(state.attemptDir(pending.attemptId), 'result.txt'),
      'status=reverted\ndetail=it did not answer\nat=now\n',
    );
    run.reconcilePromotion();
    expect(state.loadState().phase).toBe('failed');
    expect(state.loadState().pending).toBeNull();
    expect(audit.recentRepairAudit(1)[0]?.action).toBe('repair_failed');
  });

  it('clears the allowance for a failure it actually fixed', () => {
    const sig = 'sig-fixed';
    const pending = {
      attemptId: 'attempt-fixed',
      signature: sig,
      startedAt: new Date().toISOString(),
      diffPath: null,
      workspace: join(state.workspacesDir(), 'attempt-fixed'),
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      changed: { added: 0, modified: 2, removed: 0 },
      gates: [],
      failure: { stage: 'build', code: 'X', message: 'y' },
    };
    state.saveState({
      ...state.emptyState(),
      phase: 'promoting',
      attempts: { [sig]: 2 },
      pending,
    });
    mkdirSync(state.attemptDir(pending.attemptId), { recursive: true });
    writeFileSync(
      join(state.attemptDir(pending.attemptId), 'result.txt'),
      'status=applied\ndetail=live on port 47821\nat=now\n',
    );

    run.reconcilePromotion();
    const after = state.loadState();
    expect(after.phase).toBe('succeeded');
    expect(after.attempts[sig]).toBeUndefined();
    expect(audit.recentRepairAudit(1)[0]?.action).toBe('repair_applied');
  });
});

/* ════════════════════════ the audit trail ═══════════════════════════ */

describe('the audit trail', () => {
  it('records a repair without attaching it to any contract', () => {
    // These rows must never appear inside a contract's history: a repair is not
    // an event in the life of a contract, and the timeline queries filter on ids
    // this deliberately leaves null.
    audit.recordRepairEvent({
      action: 'repair_started',
      signature: 'sig-audit',
      summary: 'Attempt 1 of 3.',
      detail: 'workspace=/tmp/x',
    });
    const rows = audit.recentRepairAudit(5);
    expect(rows[0]?.action).toBe('repair_started');
    expect(rows[0]?.signature).toBe('sig-audit');
  });

  it('keeps the diff, capped', () => {
    const diffText = `${new Array(5_000).fill('+a line of a very long diff').join('\n')}\n`;
    audit.recordRepairEvent({
      action: 'repair_applied',
      signature: 'sig-diff',
      summary: 'Applied.',
      diff: diffText,
    });
    expect(audit.recentRepairAudit(1)[0]?.action).toBe('repair_applied');
  });

  it('redacts a key that reached it through a log', () => {
    audit.recordRepairEvent({
      action: 'repair_failed',
      signature: 'sig-secret',
      summary: 'Failed.',
      detail: 'x-api-key: sk-ant-abcdefghijklmnopqrst',
    });
    const detail = audit.recentRepairAudit(1)[0]?.detail ?? '';
    expect(detail).not.toContain('sk-ant-abcdefghijklmnopqrst');
  });

  it('summarises every outcome in her language', () => {
    const record = {
      id: 'x',
      signature: 's',
      attempt: 1,
      startedAt: '',
      finishedAt: '',
      failure: { stage: 'build', code: 'X', message: 'y' },
      changed: { added: 1, modified: 2, removed: 0 },
      violations: [{ path: 'tests/a.test.ts', reason: 'the tests' }],
      gates: [],
      engineCode: null,
      detail: 'because',
      diffPath: null,
      workspace: null,
    };
    for (const outcome of [
      'applied',
      'gate-failed',
      'protected-path',
      'no-changes',
      'engine-failed',
      'promote-failed',
      'deferred',
    ] as const) {
      const summary = audit.summariseAttempt({ ...record, outcome });
      expect(summary.length).toBeGreaterThan(10);
      expect(summary).not.toContain('undefined');
    }
    expect(audit.summariseAttempt({ ...record, outcome: 'protected-path' })).toContain('Nothing was applied');
  });
});

/* ═══════════════════════════ repair.sh ══════════════════════════════ */

/**
 * The part of the script that moves files, lifted out and run on its own.
 *
 * Everything above it talks to launchd, and a test must never stop the server on
 * the machine running it. The slice starts at the protected-path guard because
 * the copy functions call it, and a harness without it would prove the opposite
 * of what these tests are for.
 */
function copyFunctionsOf(body: string): string {
  const start = body.indexOf('RP_PROTECTED_RE=');
  const end = body.indexOf('rp_apply() {');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

describe('repair.sh', () => {
  const body = readFileSync(REPAIR_SH, 'utf8');

  it('parses under POSIX sh', () => {
    // A syntax error here is a silent no-op inside a launchd job: nothing runs,
    // nothing is logged, and the repair simply never happens.
    expect(() => execFileSync('/bin/sh', ['-n', REPAIR_SH], { stdio: 'pipe' })).not.toThrow();
  });

  it('declares /bin/sh and uses no bash-only construct', () => {
    expect(body.split('\n')[0]).toBe('#!/bin/sh');
    expect(body).not.toMatch(/\[\[/);
    expect(body).not.toMatch(/^\s*local\s/m);
    expect(body).not.toMatch(/^\s*declare\s/m);
  });

  it('is plain ASCII', () => {
    const offending = [...body].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7e);
    expect(offending).toEqual([]);
  });

  it('is executable', () => {
    expect(statSync(REPAIR_SH).mode & 0o111).not.toBe(0);
  });

  it('never trusts launchctl to have done what it was asked', () => {
    // The launcher's bug, which cost 90 seconds of blank screen: launchd returns
    // 0 having merely ACCEPTED the request. Every state change here is confirmed
    // by asking the port.
    expect(body).toMatch(/launchctl kickstart[\s\S]{0,200}rp_wait_up/);
    expect(body).toMatch(/launchctl bootout "\$SERVER_DOMAIN"[\s\S]{0,300}rp_wait_down/);
  });

  it('puts the previous version back when the fix does not answer', () => {
    expect(body).toContain('rp_restore');
    expect(body).toMatch(/rp_restore[\s\S]{0,400}rp_start_server/);
    expect(body).toContain('status=%s');
  });

  it('backs up before it copies anything in', () => {
    const backupAt = body.indexOf('if ! rp_backup');
    const copyAt = body.indexOf('rp_copy_in || COPIED=0');
    expect(backupAt).toBeGreaterThan(0);
    expect(copyAt).toBeGreaterThan(0);
    expect(backupAt).toBeLessThan(copyAt);
  });

  it('carries a deletion across, not just a change', () => {
    // A fix that removes a file passed the gates with it gone. Leaving it behind
    // would mean the live tree stops matching the tree that was proven.
    expect(body).toContain('elif [ -f "$_dst" ]; then');
    expect(body).toMatch(/elif \[ -f "\$_dst" \]; then[\s\S]{0,400}rm -f "\$_dst"/);
  });

  it('refuses to promote a candidate that was never built', () => {
    expect(body).toContain('.next/BUILD_ID');
  });

  it('applies a change, an addition and a deletion -- and puts all three back', () => {
    // The three copy functions are extracted and run on their own: everything
    // above them in the script talks to launchd, and a test must never stop the
    // server on the machine running it.
    const live = tempDir('live');
    const ws = tempDir('ws');
    const backup = join(tempDir('backups'), 'backup');
    mkdirSync(join(live, 'src'), { recursive: true });
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(live, 'src', 'a.ts'), 'old\n');
    writeFileSync(join(live, 'src', 'gone.ts'), 'delete me\n');
    writeFileSync(join(ws, 'src', 'a.ts'), 'new\n');
    writeFileSync(join(ws, 'src', 'added.ts'), 'added\n');

    const listFile = join(ws, 'files.txt');
    writeFileSync(listFile, 'src/a.ts\nsrc/added.ts\nsrc/gone.ts\n');

    const copyFunctions = copyFunctionsOf(body);
    const harness = join(ws, 'harness.sh');
    writeFileSync(
      harness,
      [
        '#!/bin/sh',
        'set -u',
        `PLAN_LIVE='${live}'`,
        `PLAN_WORKSPACE='${ws}'`,
        `PLAN_BACKUP='${backup}'`,
        `PLAN_FILES='${listFile}'`,
        'ibc_log() { :; }',
        copyFunctions,
        'rp_backup || exit 10',
        'rp_copy_in || exit 11',
        'printf "applied:%s:%s:%s\\n" "$(cat "$PLAN_LIVE/src/a.ts")" "$(cat "$PLAN_LIVE/src/added.ts")" "$([ -f "$PLAN_LIVE/src/gone.ts" ] && echo kept || echo removed)"',
        'rp_restore',
        'printf "restored:%s:%s:%s\\n" "$(cat "$PLAN_LIVE/src/a.ts")" "$([ -f "$PLAN_LIVE/src/added.ts" ] && echo kept || echo removed)" "$([ -f "$PLAN_LIVE/src/gone.ts" ] && echo back || echo missing)"',
      ].join('\n'),
    );

    const out = execFileSync('/bin/sh', [harness], { encoding: 'utf8' });
    expect(out).toContain('applied:new:added:removed');
    // Restore is the whole safety net: it has to undo all three, including
    // bringing back a file the fix deleted.
    expect(out).toContain('restored:old:removed:back');
  });

  it('re-checks the protected paths itself instead of trusting the list', () => {
    // The Node process that checked the diff has exited by the time this script
    // runs. The only guard left on the plan is the plan, so the plan is checked
    // again here -- two independent checks, because this one is load-bearing.
    const probe = join(tempDir('shguard'), 'probe.sh');
    const candidates = [
      'src/lib/watch.ts',
      'src/app/page.tsx',
      'src/lib/fields.ts',
      'SRC/LIB/FIELDS.TS',
      'src/lib/extraction/verify.ts',
      'src/lib/util/dates.ts',
      'src/lib/repair/protected.ts',
      'tests/repair.test.ts',
      'evals/run.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'next.config.ts',
      'vitest.config.ts',
      'packaging/app-template/bin/repair.sh',
      'node_modules/vitest/vitest.mjs',
      '.next/BUILD_ID',
      '/etc/hosts',
      '../../../Users/bonnie/Documents/secret.pdf',
      'src/../src/lib/fields.ts',
      'src/a\tb.ts',
    ];
    writeFileSync(
      probe,
      [
        '#!/bin/sh',
        'set -u',
        'ibc_log() { :; }',
        copyFunctionsOf(body),
        'while IFS= read -r P; do',
        '  if rp_path_ok "$P"; then printf "allow\\n"; else printf "refuse\\n"; fi',
        'done',
      ].join('\n'),
    );

    const out = execFileSync('/bin/sh', [probe], {
      encoding: 'utf8',
      input: `${candidates.join('\n')}\n`,
    })
      .trim()
      .split('\n');

    expect(out).toEqual([
      'allow',
      'allow',
      ...new Array(candidates.length - 2).fill('refuse'),
    ]);
  });

  it('refuses a plan whose filename splits into two paths', () => {
    // LOW 12, end to end. The plan is newline-delimited, so a filename containing
    // a newline is two entries to this script and one to whatever checked it.
    // Node refuses to write such a name at all; this proves the shell would
    // refuse to act on it even if something did.
    const live = tempDir('split-live');
    const ws = tempDir('split-ws');
    const backup = join(tempDir('split-backups'), 'backup');
    mkdirSync(join(live, 'src', 'lib'), { recursive: true });
    mkdirSync(join(ws, 'src', 'lib'), { recursive: true });
    writeFileSync(join(live, 'src', 'lib', 'fields.ts'), 'the field contract\n');
    writeFileSync(join(ws, 'src', 'lib', 'fields.ts'), 'rewritten by the model\n');

    // Exactly what stagePromotion() would emit for a single "path" carrying a
    // newline in the middle of it.
    const listFile = join(ws, 'files.txt');
    writeFileSync(listFile, 'src/app/page.tsx\nsrc/lib/fields.ts\n');

    const harness = join(ws, 'harness.sh');
    writeFileSync(
      harness,
      [
        '#!/bin/sh',
        'set -u',
        `PLAN_LIVE='${live}'`,
        `PLAN_WORKSPACE='${ws}'`,
        `PLAN_BACKUP='${backup}'`,
        `PLAN_FILES='${listFile}'`,
        'ibc_log() { :; }',
        copyFunctionsOf(body),
        'if rp_backup; then printf "backed-up\\n"; else printf "refused\\n"; fi',
        'if rp_copy_in; then printf "copied\\n"; else printf "not-copied\\n"; fi',
        'printf "fields:%s\\n" "$(cat "$PLAN_LIVE/src/lib/fields.ts")"',
      ].join('\n'),
    );

    const out = execFileSync('/bin/sh', [harness], { encoding: 'utf8' });
    // The whole plan is refused at backup, before anything is touched.
    expect(out).toContain('refused');
    expect(out).toContain('not-copied');
    expect(out).toContain('fields:the field contract');
  });

  it('tells a human when neither version will start, and never otherwise', () => {
    expect(body).toContain('ibc_dialog');
    // A dialog for a routine outcome would train her to dismiss the one that matters.
    const dialogs = body.split('ibc_dialog').length - 1;
    expect(dialogs).toBeLessThanOrEqual(4);
  });

  it('leaves the decision about what happens next to the app', () => {
    expect(body).toContain('"action":"resume"');
    expect(body).toContain('/api/repair');
  });

  it('takes its own agent away once nothing is owed', () => {
    expect(body).toContain('rp_unschedule_self');
    expect(body).toMatch(/'"phase":"succeeded"'/);
  });
});
