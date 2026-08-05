/**
 * The paths an AI repair may not touch, and the matcher that enforces it.
 *
 * Two separate mechanisms, on purpose:
 *
 *   1. The list is written into the prompt, so the model knows.
 *   2. The list is checked against the diff of the working tree afterwards, so it
 *      does not matter whether the model was listening.
 *
 * Only (2) is a guarantee. (1) is a courtesy. A repair that touches anything here
 * is rejected before the gates run and before anything is promoted, and the
 * rejection is recorded with the offending paths.
 *
 * Pure: no fs, no process. Every rule is a string test, which is what makes the
 * whole guard testable without a repair having to happen.
 */

import type { ProtectedViolation } from './types';

export interface ProtectedRule {
  /** Glob against a POSIX path relative to the source root. `**` and `*` only. */
  pattern: string;
  /** Why, in one sentence. Goes into the prompt and into the audit trail. */
  reason: string;
}

/**
 * Why a configuration file is as protected as the code it configures.
 *
 * The gates are the only thing standing between a model's guess and her system of
 * record, and every one of them is defined by a config file rather than by this
 * app. `tsconfig.json` decides what `strict` and `noUncheckedIndexedAccess` mean,
 * and which files are in the program at all; `vitest.config.ts` decides which
 * tests exist; `next.config.ts` decides what a build is. Rewriting one of those
 * turns a failing gate into a passing one without touching the bug -- which is
 * not repairing the fault, it is editing the ruler instead of the thing measured.
 */
const RULER_REASON = 'the strictness the correctness core is checked against';

/**
 * The list Ayush was promised, plus the additions marked below.
 *
 * Everything here is either (a) the part of the product that makes an extraction
 * repeatable and citable, or (b) the machinery that would let a repair widen its
 * own permissions. A fix that needs to change any of it is not a fix a machine
 * gets to make unattended.
 */
export const PROTECTED_RULES: readonly ProtectedRule[] = [
  {
    pattern: 'src/lib/extraction/**',
    reason:
      'the extraction pipeline, OCR and verify.ts -- the citation guard that proves every value came out of the document',
  },
  {
    pattern: 'src/lib/util/dates.ts',
    reason: 'both clocks and all term arithmetic; every expiry date in the tracker is computed here',
  },
  { pattern: 'src/lib/fields.ts', reason: 'the field contract the whole app agrees on' },
  { pattern: 'src/lib/db/schema.sql', reason: 'the database schema' },
  { pattern: 'src/lib/db/migrate.ts', reason: 'the migration path for an existing database' },
  { pattern: 'src/lib/providers/errors.ts', reason: 'the error taxonomy and its remedies' },
  { pattern: 'evals/**', reason: 'the accuracy harness a repair has to satisfy' },
  {
    pattern: 'tests/**',
    reason: 'the tests a repair has to pass; a repair that edits them is not a repair',
  },

  /*
   * Beyond the required list, and each for its own reason.
   */
  {
    // A repair agent that can edit its own guard rails is not a guard rail.
    pattern: 'src/lib/repair/**',
    reason: 'the repair machinery itself, including this list',
  },
  {
    // Nothing may be installed on her Mac unattended. A dependency change needs a
    // network fetch, a lockfile resolution and a human.
    pattern: 'package.json',
    reason: 'the dependency list; nothing gets installed on this Mac unattended',
  },
  { pattern: 'package-lock.json', reason: 'the pinned dependency tree' },
  {
    // The installer, the launcher and the LaunchAgents. A bad edit here is not
    // recoverable from inside the app.
    pattern: 'packaging/**',
    reason: 'the installer and the launch scripts, which run before the app can defend itself',
  },
  {
    // Not source. Copying it is how promote works; letting the model write into it
    // would mean shipping bytes no gate ever saw.
    pattern: 'node_modules/**',
    reason: 'installed dependencies, which are not source',
  },
  { pattern: '.next/**', reason: 'build output, which is regenerated rather than edited' },

  /*
   * The gates' own definitions. See RULER_REASON.
   *
   * `tsconfig.*.json` is here as well as `tsconfig.json` because tsc will happily
   * be pointed at a second one, and a rule that only names the file we expect is
   * a rule that can be walked around by adding a file we did not.
   */
  { pattern: 'tsconfig.json', reason: RULER_REASON },
  { pattern: 'tsconfig.*.json', reason: RULER_REASON },
  { pattern: 'next.config.ts', reason: RULER_REASON },
  { pattern: 'vitest.config.ts', reason: RULER_REASON },
];

/**
 * Match one POSIX path against one glob. Supports `**` (any depth, including
 * none) and `*` (one segment, no slash). Nothing else -- a bigger glob dialect
 * is more ways to write a rule that does not mean what it looks like.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(path);
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `a/**` matches `a/b` and `a/b/c`; `**/x` matches `x` and `a/x`.
        const trailing = pattern[i + 2] === '/';
        out += trailing ? '(?:.*/)?' : '.*';
        i += trailing ? 2 : 1;
        continue;
      }
      out += '[^/]*';
      continue;
    }
    out += ch === undefined ? '' : ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  /*
   * Case-INSENSITIVE, to agree with repair.sh's `grep -qiE` and with the disk.
   * macOS is case-insensitive by default, so SRC/LIB/FIELDS.TS and src/lib/fields.ts
   * are one file; a case-sensitive matcher here would refuse the second spelling and
   * wave the first one through to the same bytes. The two guards disagreeing is worse
   * than either being wrong alone -- it is a walk-around that looks like defence in
   * depth.
   */
  return new RegExp(`${out}$`, 'i');
}

/**
 * NUL through unit separator, plus DEL. Written as escapes so this file stays
 * plain ASCII and the range stays readable.
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * A path carrying a control character -- a newline, a tab, a NUL, an escape.
 *
 * No file this app ships has one, so a legitimate repair never produces one. A
 * crafted one, though, is how a protected path gets promoted: the plan handed to
 * repair.sh is a newline-delimited list, and a filename containing a newline
 * splits into two lines, only the first of which was ever checked. The shell
 * re-checks the list for the same reason, but the plan should never be written
 * with such a name in it in the first place.
 *
 * Tested on the raw string, before any normalisation: `trim()` would quietly
 * remove a trailing newline and hand back a path that looks clean.
 */
export function hasControlCharacters(path: string): boolean {
  return CONTROL_CHARACTER.test(path);
}

/**
 * A path safe to put in a log line or an audit row.
 *
 * A raw control character in the audit trail is the same trick played on a
 * second reader: a newline inside a path makes one row look like two.
 */
export function describePath(path: string): string {
  return path.replace(new RegExp(CONTROL_CHARACTER.source, 'g'), (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

/**
 * Normalise whatever a caller hands us into a POSIX path relative to the source
 * root, or null when it cannot be one.
 *
 * A path that escapes the root is not "not protected", it is worse -- so callers
 * treat null as a violation rather than as a pass.
 */
export function normaliseRelPath(path: string): string | null {
  if (hasControlCharacters(path)) return null;
  const posix = path.replace(/\\/g, '/').trim();
  if (posix === '') return null;
  if (posix.startsWith('/')) return null;
  const parts: string[] = [];
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/** The rule that forbids this path, or null. */
export function protectedRuleFor(path: string): ProtectedRule | null {
  const rel = normaliseRelPath(path);
  if (rel === null) return null;
  for (const rule of PROTECTED_RULES) {
    if (matchGlob(rule.pattern, rel)) return rule;
  }
  return null;
}

/**
 * Every reason these changes may not be applied. Empty means clean.
 *
 * A path that will not normalise -- absolute, or climbing out of the tree with
 * `..` -- is reported as a violation of its own. The model works inside a
 * workspace; a change outside it is not something to reason about, it is
 * something to refuse.
 */
export function protectedViolations(paths: readonly string[]): ProtectedViolation[] {
  const out: ProtectedViolation[] = [];
  for (const path of paths) {
    // Checked first and reported on its own: this is not "a path we could not
    // read", it is a path built to be read twice, and the record has to say so.
    if (hasControlCharacters(path)) {
      out.push({
        path: describePath(path),
        reason:
          'the change is a filename containing a control character, which is how one path is made to look like two',
      });
      continue;
    }
    const rel = normaliseRelPath(path);
    if (rel === null) {
      out.push({ path, reason: 'the change is outside the repair workspace' });
      continue;
    }
    const rule = protectedRuleFor(rel);
    if (rule !== null) out.push({ path: rel, reason: rule.reason });
  }
  return out;
}

/** The list as the model sees it. One line per rule, no prose around it. */
export function protectedPathsForPrompt(): string {
  return PROTECTED_RULES.map((r) => `  ${r.pattern}  -- ${r.reason}`).join('\n');
}
