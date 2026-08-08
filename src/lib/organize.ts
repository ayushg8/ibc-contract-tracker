/**
 * Proposing and applying a filing arrangement for the contracts folder.
 *
 * The whole module is built on one separation: **planning never touches the disk,
 * and applying never decides anything.** `planMoves` is pure -- it takes the
 * contracts and a scheme and returns a list of intended moves, which the app can
 * render as a preview and she can read before agreeing to it. `applyMoves` takes
 * that list and nothing else, validates every single move again on its own terms,
 * and performs the ones that survive.
 *
 * That split is not tidiness. These are signed contracts, and a bug that moves one
 * somewhere unexpected is a bug that loses it. Everything below is therefore
 * written to fail closed: a move whose target it cannot fully account for is
 * dropped from the plan rather than attempted, and a move that fails at the last
 * moment leaves the original exactly where it was.
 *
 * Server-only: touches the filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isInside, safeFolder } from '@/lib/contracts-folder';

/** A contract, as much of it as filing needs to know. */
export interface Filable {
  documentId: string;
  /** Absolute path of the archived PDF. Its parent is the contract's folder. */
  archivePath: string;
  counterparty: string | null;
  effectiveDate: string | null;
  agreementStatus?: string | null;
}

/** One intended move. Nothing has happened yet. */
export interface PlannedMove {
  documentId: string;
  /** The contract's folder as it stands. */
  from: string;
  /** Where it should end up. Always root/<group>/<same folder name>. */
  to: string;
  /** The group folder this puts it in, or null for the top level. */
  group: string | null;
}

export type Scheme =
  | { kind: 'year' }
  | { kind: 'counterparty' }
  | { kind: 'flat' }
  /** Groups decided elsewhere -- by her, or by the model reading her instruction. */
  | { kind: 'explicit'; groupFor: Record<string, string | null> };

/**
 * Which group a contract belongs in, or null for the top level.
 *
 * Every scheme here is *stable*: the answer for a given contract does not change
 * on its own over time. A grouping by expiry status would move her contracts
 * between folders overnight as they lapsed, which is the one behaviour this
 * feature must not have -- she filed it somewhere and it has to still be there.
 */
export function groupFor(c: Filable, scheme: Scheme): string | null {
  switch (scheme.kind) {
    case 'flat':
      return null;
    case 'year': {
      const y = yearOf(c.effectiveDate);
      return y === null ? 'No date yet' : y;
    }
    case 'counterparty': {
      const name = (c.counterparty ?? '').trim();
      return name === '' ? 'No counterparty yet' : safeFolder(name);
    }
    case 'explicit': {
      const raw = scheme.groupFor[c.documentId];
      if (raw === undefined || raw === null) return null;
      const cleaned = raw.trim();
      return cleaned === '' ? null : safeFolder(cleaned);
    }
  }
}

function yearOf(iso: string | null): string | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(iso.trim());
  return m === null ? null : m[1]!;
}

/**
 * What would change, and nothing more.
 *
 * Pure: reads no disk state beyond the paths it was handed, writes nothing.
 * A contract already in the right place produces no move at all, so the preview
 * shows her only what would actually happen.
 */
export function planMoves(contracts: readonly Filable[], scheme: Scheme, root: string): PlannedMove[] {
  const moves: PlannedMove[] = [];
  for (const c of contracts) {
    if (typeof c.archivePath !== 'string' || c.archivePath === '') continue;

    const from = path.dirname(c.archivePath);
    // A pre-1.2.0 document sits directly in the root with no folder of its own.
    // Moving it would mean moving the root, so it is left alone entirely.
    if (path.resolve(from) === path.resolve(root)) continue;
    if (!isInside(root, from)) continue;

    const group = groupFor(c, scheme);
    const to = group === null ? path.join(root, path.basename(from)) : path.join(root, group, path.basename(from));

    if (path.resolve(to) === path.resolve(from)) continue; // already filed correctly
    moves.push({ documentId: c.documentId, from, to, group });
  }
  return moves;
}

export interface MoveResult {
  documentId: string;
  from: string;
  /** Where it actually ended up. Null when the move was refused or failed. */
  to: string | null;
  ok: boolean;
  reason?: string;
}

/**
 * Carry out a plan, re-checking every move on its own terms first.
 *
 * Deliberately does not trust the plan it was handed. The plan travelled through
 * an HTTP request and, in the free-text case, was shaped by a model; either could
 * name a target this must refuse. So each move is re-validated here -- inside the
 * root, source is a real directory, target does not already exist -- and anything
 * that fails a check is reported rather than attempted.
 *
 * `onMoved` is called for each success so the caller can update the stored path
 * inside its own transaction. Nothing is ever deleted.
 */
export function applyMoves(
  moves: readonly PlannedMove[],
  root: string,
  onMoved: (documentId: string, newArchivePath: string) => void,
  fsys: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'renameSync' | 'statSync'> = fs,
): MoveResult[] {
  const out: MoveResult[] = [];

  for (const m of moves) {
    const from = path.resolve(m.from);
    const to = path.resolve(m.to);

    const refuse = (reason: string): void => {
      out.push({ documentId: m.documentId, from: m.from, to: null, ok: false, reason });
    };

    if (!isInside(root, from) || !isInside(root, to)) {
      refuse('outside the contracts folder');
      continue;
    }
    if (from === path.resolve(root) || to === path.resolve(root)) {
      refuse('that is the contracts folder itself');
      continue;
    }
    if (!fsys.existsSync(from)) {
      refuse('the folder is no longer there');
      continue;
    }
    try {
      if (!fsys.statSync(from).isDirectory()) {
        refuse('not a folder');
        continue;
      }
    } catch {
      refuse('the folder could not be read');
      continue;
    }
    if (fsys.existsSync(to)) {
      // Never merge into an existing folder: two contracts in one folder is two
      // records pointing at files that are no longer told apart.
      refuse('something is already there');
      continue;
    }
    // A folder cannot be moved inside itself, and rename(2) would corrupt the
    // tree rather than refuse.
    if (isInside(from, to)) {
      refuse('cannot move a folder into itself');
      continue;
    }

    try {
      fsys.mkdirSync(path.dirname(to), { recursive: true });
      fsys.renameSync(from, to);
    } catch (e) {
      refuse(e instanceof Error ? e.message : 'the move failed');
      continue;
    }

    out.push({ documentId: m.documentId, from: m.from, to, ok: true });
    onMoved(m.documentId, to);
  }

  return out;
}

/* ────────────────────────────── the tree ────────────────────────────── */

export interface TreeNode {
  name: string;
  path: string;
  kind: 'group' | 'contract' | 'file';
  children: TreeNode[];
  /** Contracts at or below this node. Only meaningful on a group. */
  count: number;
}

/**
 * The contracts folder as it actually is on disk, two levels of folders deep.
 *
 * Read from the filesystem rather than from the database on purpose: this screen
 * exists to show her the truth about her own folder, including anything she moved
 * in Finder behind the app's back. A tree drawn from the database would show her
 * what the app believes instead, which is exactly the thing she would be opening
 * this screen to check.
 */
export function readTree(root: string, fsys: typeof fs = fs): TreeNode {
  const node: TreeNode = { name: path.basename(root), path: root, kind: 'group', children: [], count: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fsys.readdirSync(root, { withFileTypes: true });
  } catch {
    return node;
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (!e.isDirectory()) continue;

    const child: TreeNode = { name: e.name, path: full, kind: 'contract', children: [], count: 1 };
    let inner: fs.Dirent[] = [];
    try {
      inner = fsys.readdirSync(full, { withFileTypes: true });
    } catch {
      // Unreadable is still worth showing; an empty folder is information.
    }

    const subDirs = inner.filter((i) => i.isDirectory() && !i.name.startsWith('.'));
    if (subDirs.length > 0) {
      // Folders inside it means she has used this as a group.
      child.kind = 'group';
      child.count = 0;
      for (const d of subDirs.sort((a, b) => a.name.localeCompare(b.name))) {
        const cPath = path.join(full, d.name);
        const files: TreeNode[] = safeList(cPath, fsys).map((f) => ({
          name: f,
          path: path.join(cPath, f),
          kind: 'file' as const,
          children: [],
          count: 0,
        }));
        child.children.push({ name: d.name, path: cPath, kind: 'contract', children: files, count: 1 });
        child.count += 1;
      }
    } else {
      child.children = safeList(full, fsys).map((f) => ({
        name: f,
        path: path.join(full, f),
        kind: 'file' as const,
        children: [],
        count: 0,
      }));
    }

    node.children.push(child);
    node.count += child.count;
  }

  return node;
}

function safeList(dir: string, fsys: typeof fs): string[] {
  try {
    return fsys
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
