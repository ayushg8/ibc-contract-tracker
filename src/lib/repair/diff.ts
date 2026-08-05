/**
 * What actually changed in the workspace.
 *
 * Nothing here asks the model what it did. The tree is fingerprinted before
 * Claude runs and again after, and the difference between the two fingerprints is
 * the only account of the change anyone downstream trusts. That is what makes the
 * protected-path guard a guarantee rather than an instruction.
 *
 * Two detectors, because one size does not fit both halves of the tree:
 *
 *   * Source is hashed. Exact, and it yields a real diff for the audit trail.
 *   * node_modules and .next are swept by mtime. Hashing half a gigabyte of
 *     dependencies on a CFO's Mac to prove nobody edited them is not a trade
 *     worth making; a write there is forbidden outright, so detecting it is
 *     enough and the path alone is the whole report.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface FileEntry {
  sha256: string;
  bytes: number;
  /**
   * Set only for a symbolic link, and holding its target exactly as recorded on
   * disk -- unresolved, because resolving is following, and following is the one
   * thing this file must never do.
   */
  link?: string;
}

export type Manifest = Record<string, FileEntry>;

/** Never walked when fingerprinting source. Swept by mtime instead. */
export const HEAVY_DIRS: readonly string[] = ['node_modules', '.next'];

/** Never walked at all: not source, not shipped, and noisy. */
export const IGNORED_DIRS: readonly string[] = ['.git', '.gstack', '.turbo', '.vercel'];

/** Files that change on every run and mean nothing. */
const IGNORED_FILES: readonly string[] = ['.DS_Store', 'tsconfig.tsbuildinfo'];

/** A single file bigger than this is fingerprinted by size alone. */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

export interface ScanOptions {
  /** Directory names skipped wherever they appear. */
  skipDirs?: readonly string[];
  /** Stop after this many files. A runaway tree must not wedge a repair. */
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 20_000;

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Hash every source file under `root`, keyed by POSIX path relative to it.
 *
 * Unreadable files are recorded with an empty hash rather than skipped: a file
 * that becomes unreadable between the two scans is a change, and silently
 * dropping it would hide exactly that.
 */
export function scanTree(root: string, opts: ScanOptions = {}): Manifest {
  const skip = new Set([...(opts.skipDirs ?? [...HEAVY_DIRS, ...IGNORED_DIRS])]);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const out: Manifest = {};
  let count = 0;

  const walk = (dir: string): void => {
    if (count >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(full);
        continue;
      }
      // A symlink is RECORDED and never followed.
      //
      // Not following it is obvious: following one out of the workspace is the
      // escape the protected check exists to stop. Recording it is the part that
      // was missing. A link pointing back into the tree is harmless to skip,
      // because a write through it still shows up as a change to the real file --
      // but a link pointing OUT was simply never seen, so `escape -> /tmp/outside`
      // plus a write to `escape/src/lib/extraction/verify.ts` modified a file
      // outside the workspace with nothing reported at all. The link's target is
      // its content; that is what is fingerprinted, so repointing one is a change.
      if (entry.isSymbolicLink()) {
        out[toPosix(relative(root, full))] = linkFingerprint(full);
        count += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORED_FILES.includes(entry.name)) continue;
      const rel = toPosix(relative(root, full));
      out[rel] = fingerprint(full);
      count += 1;
    }
  };

  walk(root);
  return out;
}

function fingerprint(file: string): FileEntry {
  try {
    const bytes = statSync(file).size;
    if (bytes > MAX_HASH_BYTES) return { sha256: `size:${bytes}`, bytes };
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    return { sha256: hash, bytes };
  } catch {
    return { sha256: '', bytes: -1 };
  }
}

/**
 * A link's identity is where it points, not what is at the other end.
 *
 * Hashing the bytes it resolves to would make a link indistinguishable from the
 * file it names -- and would mean reading a file outside the workspace to decide
 * whether something outside the workspace had been read.
 */
function linkFingerprint(file: string): FileEntry {
  let target: string;
  try {
    target = readlinkSync(file);
  } catch {
    // A link we cannot read is still a link, and an unreadable one is a change
    // worth reporting rather than an entry to drop.
    target = '';
  }
  return { sha256: `symlink:${target}`, bytes: target.length, link: target };
}

export interface SymlinkViolation {
  /** POSIX path of the link itself, relative to the workspace root. */
  path: string;
  /** Its target, verbatim. */
  target: string;
  reason: string;
}

/**
 * Every symlink in the candidate tree that has no business being there.
 *
 * Three kinds, and each is refused in its own right rather than being followed
 * and inspected:
 *
 *   * created by the repair -- a fix does not need to invent a link;
 *   * repointed by the repair -- same;
 *   * resolving outside the workspace root, whether or not the repair made it --
 *     because that is a door into the rest of her Mac, and the diff of the tree
 *     cannot see through it.
 *
 * Resolution is done on the path alone. Nothing here opens, reads or stats the
 * target: a guard that has to touch what it is guarding against is not a guard.
 */
export function symlinkViolations(
  root: string,
  before: Manifest,
  after: Manifest,
): SymlinkViolation[] {
  const rootPath = resolve(root);
  const out: SymlinkViolation[] = [];

  for (const [path, entry] of Object.entries(after)) {
    const target = entry.link;
    if (target === undefined) continue;

    const reasons: string[] = [];
    const previous = before[path]?.link;
    if (previous === undefined) reasons.push('a symbolic link the repair created');
    else if (previous !== target) reasons.push('a symbolic link the repair repointed');
    if (escapesRoot(rootPath, path, target)) {
      reasons.push('a symbolic link that leads out of the repair workspace');
    }
    if (reasons.length > 0) out.push({ path, target, reason: reasons.join('; ') });
  }

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function escapesRoot(rootPath: string, rel: string, target: string): boolean {
  // resolve() ignores the base when the target is absolute, which is exactly the
  // behaviour of the link itself.
  const landing = resolve(dirname(resolve(rootPath, rel)), target);
  return landing !== rootPath && !landing.startsWith(`${rootPath}${sep}`);
}

export interface ManifestDelta {
  added: string[];
  modified: string[];
  removed: string[];
}

/** Sorted, so the audit trail and the prompt read the same way every time. */
export function compareManifests(before: Manifest, after: Manifest): ManifestDelta {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, entry] of Object.entries(after)) {
    const previous = before[path];
    if (previous === undefined) added.push(path);
    else if (previous.sha256 !== entry.sha256) modified.push(path);
  }
  for (const path of Object.keys(before)) {
    if (after[path] === undefined) removed.push(path);
  }

  added.sort();
  modified.sort();
  removed.sort();
  return { added, modified, removed };
}

/** Every path the delta touches, in one sorted list. */
export function changedPaths(d: ManifestDelta): string[] {
  return [...d.added, ...d.modified, ...d.removed].sort();
}

/**
 * Build caches inside node_modules. Running the tests writes here, and running
 * the tests is something the repair session is explicitly allowed to do -- so
 * treating a cache write as tampering would reject every well-behaved fix.
 */
export const CACHE_DIRS: readonly string[] = ['.vite', '.vitest', '.cache', '.tmp', '.turbo'];

/**
 * Files under `root` written since `sinceMs`.
 *
 * Used only on the heavy directories, where a write is forbidden outright and
 * the path is the entire finding. `cap` bounds the work: once a handful of
 * violations are known the verdict cannot change.
 */
export function findWritesSince(
  root: string,
  sinceMs: number,
  opts: { cap?: number; skipDirs?: readonly string[] } = {},
): string[] {
  const cap = opts.cap ?? 50;
  const skip = new Set(opts.skipDirs ?? CACHE_DIRS);
  const found: string[] = [];

  const walk = (dir: string): void => {
    if (found.length >= cap) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= cap) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (statSync(full).mtimeMs >= sinceMs) found.push(toPosix(relative(root, full)));
      } catch {
        continue;
      }
    }
  };

  walk(root);
  return found.sort();
}

/* ──────────────────────────── unified diff ───────────────────────────── */

/** Beyond this a file is summarised rather than diffed. */
const MAX_DIFF_LINES = 4_000;

/** A NUL byte is the standard "this is not text" signal, and the cheapest. */
function isBinary(text: string): boolean {
  return text.includes('\u0000');
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Longest common subsequence over lines, as a table. O(n*m) in time and space,
 * which is why MAX_DIFF_LINES exists: the files this runs on are source files,
 * and a 4000-line ceiling is 16M cells worst case, once, in a background job.
 */
function lcsTable(a: readonly string[], b: readonly string[]): Int32Array {
  const cols = b.length + 1;
  const table = new Int32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + (j + 1)] ?? 0);
    }
  }
  return table;
}

type OpKind = ' ' | '-' | '+';

interface Op {
  kind: OpKind;
  text: string;
}

function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const cols = b.length + 1;
  const table = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + (j + 1)] ?? 0)) {
      ops.push({ kind: '-', text: a[i] ?? '' });
      i += 1;
    } else {
      ops.push({ kind: '+', text: b[j] ?? '' });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) ops.push({ kind: '-', text: a[i] ?? '' });
  for (; j < b.length; j += 1) ops.push({ kind: '+', text: b[j] ?? '' });
  return ops;
}

/** Index ranges of ops that belong to one hunk, context included. */
function hunkRanges(ops: readonly Op[], context: number): { start: number; end: number }[] {
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]?.kind !== ' ') changes.push(i);
  }
  if (changes.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  let first = changes[0] ?? 0;
  let last = first;
  for (const index of changes.slice(1)) {
    // Two edits closer than twice the context share a hunk; otherwise the
    // context blocks would run into each other and read as one anyway.
    if (index - last > context * 2) {
      ranges.push({ start: Math.max(0, first - context), end: Math.min(ops.length, last + context + 1) });
      first = index;
    }
    last = index;
  }
  ranges.push({ start: Math.max(0, first - context), end: Math.min(ops.length, last + context + 1) });
  return ranges;
}

/**
 * A unified diff of one file, with three lines of context.
 *
 * Not a general-purpose diff: no rename detection, no word-level highlighting.
 * It exists so the audit row can carry what Claude actually changed, and so the
 * next attempt's prompt can show the model its own previous edit.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const header = `--- a/${path}\n+++ b/${path}`;

  if (isBinary(before) || isBinary(after)) {
    return `${header}\n@@ binary file changed (${before.length} -> ${after.length} bytes) @@`;
  }

  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `${header}\n@@ file too large to diff (${a.length} -> ${b.length} lines) @@`;
  }

  const ops = diffOps(a, b);

  // Line numbers are 1-based and count only the lines each side actually has.
  const aLineAt: number[] = new Array(ops.length + 1).fill(0);
  const bLineAt: number[] = new Array(ops.length + 1).fill(0);
  let aLine = 1;
  let bLine = 1;
  for (let i = 0; i < ops.length; i += 1) {
    aLineAt[i] = aLine;
    bLineAt[i] = bLine;
    const kind = ops[i]?.kind;
    if (kind !== '+') aLine += 1;
    if (kind !== '-') bLine += 1;
  }
  aLineAt[ops.length] = aLine;
  bLineAt[ops.length] = bLine;

  const chunks: string[] = [];
  for (const range of hunkRanges(ops, context)) {
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let i = range.start; i < range.end; i += 1) {
      const op = ops[i];
      if (op === undefined) continue;
      body.push(`${op.kind}${op.text}`);
      if (op.kind !== '+') aCount += 1;
      if (op.kind !== '-') bCount += 1;
    }
    // An empty side is written as line 0 by convention, so a pure addition to an
    // empty file does not claim to start at line 1 of nothing.
    const aStart = aCount === 0 ? 0 : (aLineAt[range.start] ?? 1);
    const bStart = bCount === 0 ? 0 : (bLineAt[range.start] ?? 1);
    chunks.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@\n${body.join('\n')}`);
  }

  return chunks.length === 0 ? '' : `${header}\n${chunks.join('\n')}`;
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The whole change, as one diff.
 *
 * `beforeRoot` is the pristine tree and `afterRoot` the one Claude worked in.
 */
export function buildUnifiedDiff(beforeRoot: string, afterRoot: string, d: ManifestDelta): string {
  const parts: string[] = [];
  for (const path of d.added) {
    parts.push(unifiedDiff(path, '', readText(join(afterRoot, path))));
  }
  for (const path of d.modified) {
    parts.push(unifiedDiff(path, readText(join(beforeRoot, path)), readText(join(afterRoot, path))));
  }
  for (const path of d.removed) {
    parts.push(unifiedDiff(path, readText(join(beforeRoot, path)), ''));
  }
  return parts.filter((p) => p !== '').join('\n');
}
