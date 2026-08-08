import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMoves, groupFor, planMoves, readTree, type Filable } from '@/lib/organize';

/*
 * These functions move signed contracts around a disk, so the tests are weighted
 * towards the refusals rather than the happy path. Everything here is built on one
 * separation: planning never touches the disk, and applying never decides
 * anything -- it re-checks the plan it was handed, because that plan crossed an
 * HTTP boundary and, for a free-text arrangement, was shaped by a model.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), 'ibc-org-'));
  dirs.push(d);
  return d;
}

function contract(root: string, folder: string, file = 'a.pdf'): string {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, file), 'pdf');
  return join(root, folder, file);
}

const base = (over: Partial<Filable>): Filable => ({
  documentId: 'd1',
  archivePath: '/x/Acme/a.pdf',
  counterparty: 'Acme Cells GmbH',
  effectiveDate: '2024-02-29',
  ...over,
});

describe('groupFor', () => {
  it('files by the year it was signed', () => {
    expect(groupFor(base({}), { kind: 'year' })).toBe('2024');
  });

  it.each([null, '', 'sometime', '2024', '29/02/2024'])(
    'puts %j in "No date yet" rather than inventing a year',
    (d) => {
      expect(groupFor(base({ effectiveDate: d }), { kind: 'year' })).toBe('No date yet');
    },
  );

  it('files by counterparty, made safe for a filesystem', () => {
    expect(groupFor(base({ counterparty: 'Acme/Cells: GmbH' }), { kind: 'counterparty' })).toBe(
      'Acme_Cells_ GmbH',
    );
  });

  it('never groups under flat', () => {
    expect(groupFor(base({}), { kind: 'flat' })).toBeNull();
  });

  it('takes an explicit group', () => {
    expect(groupFor(base({}), { kind: 'explicit', groupFor: { d1: '2024 NDAs' } })).toBe('2024 NDAs');
  });

  /*
   * An explicit group can come from her typing, or from a model reading her
   * instruction. Either way it names ONE folder and is never allowed to be a
   * path: what matters is not how it is spelled afterwards, but that it can no
   * longer climb out of the contracts folder.
   */
  it.each(['../escape', '../../etc', 'a/b', 'a\\b', '..', '.'])(
    'flattens %j into a name that cannot traverse',
    (nasty) => {
      const got = groupFor(base({}), { kind: 'explicit', groupFor: { d1: nasty } });
      expect(got).not.toBeNull();
      expect(got).not.toContain('/');
      expect(got).not.toContain('\\');
      expect(got === '..' || got === '.').toBe(false);
    },
  );

  it('treats an unknown or blank explicit group as the top level', () => {
    expect(groupFor(base({}), { kind: 'explicit', groupFor: {} })).toBeNull();
    expect(groupFor(base({}), { kind: 'explicit', groupFor: { d1: '  ' } })).toBeNull();
  });
});

describe('planMoves', () => {
  it('proposes a move into the year folder', () => {
    const root = '/root';
    const moves = planMoves(
      [base({ archivePath: '/root/Acme Cells GmbH - 2024-02-29/a.pdf' })],
      { kind: 'year' },
      root,
    );
    expect(moves).toEqual([
      {
        documentId: 'd1',
        from: '/root/Acme Cells GmbH - 2024-02-29',
        to: '/root/2024/Acme Cells GmbH - 2024-02-29',
        group: '2024',
      },
    ]);
  });

  it('proposes nothing for a contract already filed correctly', () => {
    // The preview must show only what would actually change, or she cannot tell
    // a real rearrangement from a no-op.
    const moves = planMoves(
      [base({ archivePath: '/root/2024/Acme - 2024-02-29/a.pdf' })],
      { kind: 'year' },
      '/root',
    );
    expect(moves).toEqual([]);
  });

  it('brings a grouped contract back to the top level under flat', () => {
    const moves = planMoves(
      [base({ archivePath: '/root/2024/Acme/a.pdf' })],
      { kind: 'flat' },
      '/root',
    );
    expect(moves[0]?.to).toBe('/root/Acme');
  });

  it('leaves a pre-1.2.0 document sitting in the root alone', () => {
    // Its "folder" IS the root. Moving it would move every other contract.
    const moves = planMoves([base({ archivePath: '/root/old-flat.pdf' })], { kind: 'year' }, '/root');
    expect(moves).toEqual([]);
  });

  it('ignores a document stored outside the contracts folder', () => {
    const moves = planMoves(
      [base({ archivePath: '/somewhere/else/Acme/a.pdf' })],
      { kind: 'year' },
      '/root',
    );
    expect(moves).toEqual([]);
  });

  it('ignores a document with no archived copy', () => {
    expect(planMoves([base({ archivePath: '' })], { kind: 'year' }, '/root')).toEqual([]);
  });
});

describe('applyMoves', () => {
  let root: string;
  beforeEach(() => {
    root = sandbox();
  });

  it('moves the whole folder and reports where it went', () => {
    contract(root, 'Acme - 2024-02-29');
    writeFileSync(join(root, 'Acme - 2024-02-29', 'What the reader saw.txt'), 'text');
    const updates: [string, string][] = [];

    const res = applyMoves(
      [
        {
          documentId: 'd1',
          from: join(root, 'Acme - 2024-02-29'),
          to: join(root, '2024', 'Acme - 2024-02-29'),
          group: '2024',
        },
      ],
      root,
      (id, p) => updates.push([id, p]),
    );

    expect(res[0]?.ok).toBe(true);
    expect(existsSync(join(root, '2024', 'Acme - 2024-02-29', 'a.pdf'))).toBe(true);
    // Everything travels, not just the PDF.
    expect(existsSync(join(root, '2024', 'Acme - 2024-02-29', 'What the reader saw.txt'))).toBe(true);
    expect(existsSync(join(root, 'Acme - 2024-02-29'))).toBe(false);
    expect(updates).toEqual([['d1', join(root, '2024', 'Acme - 2024-02-29')]]);
  });

  it('refuses a target outside the contracts folder', () => {
    // The plan crossed an HTTP boundary and may have been shaped by a model.
    // This is the check that makes that survivable.
    contract(root, 'Acme');
    const outside = sandbox();
    const res = applyMoves(
      [{ documentId: 'd1', from: join(root, 'Acme'), to: join(outside, 'Acme'), group: null }],
      root,
      () => {
        throw new Error('must not report a move');
      },
    );
    expect(res[0]?.ok).toBe(false);
    expect(res[0]?.reason).toContain('outside');
    expect(existsSync(join(root, 'Acme', 'a.pdf'))).toBe(true);
  });

  it('refuses to merge into a folder that already exists', () => {
    // Two contracts in one folder is two records pointing at files nothing can
    // tell apart afterwards.
    contract(root, 'Acme');
    contract(root, 'Other');
    mkdirSync(join(root, '2024'), { recursive: true });
    mkdirSync(join(root, '2024', 'Acme'), { recursive: true });
    writeFileSync(join(root, '2024', 'Acme', 'existing.pdf'), 'already here');

    const res = applyMoves(
      [{ documentId: 'd1', from: join(root, 'Acme'), to: join(root, '2024', 'Acme'), group: '2024' }],
      root,
      () => {
        throw new Error('must not report a move');
      },
    );
    expect(res[0]?.ok).toBe(false);
    expect(readFileSync(join(root, '2024', 'Acme', 'existing.pdf'), 'utf8')).toBe('already here');
    expect(existsSync(join(root, 'Acme', 'a.pdf'))).toBe(true);
  });

  it('refuses to move the contracts folder itself', () => {
    const res = applyMoves(
      [{ documentId: 'd1', from: root, to: join(root, 'nested'), group: null }],
      root,
      () => {
        throw new Error('must not report a move');
      },
    );
    expect(res[0]?.ok).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('refuses to move a folder inside itself', () => {
    contract(root, 'Acme');
    const res = applyMoves(
      [{ documentId: 'd1', from: join(root, 'Acme'), to: join(root, 'Acme', 'deeper'), group: null }],
      root,
      () => {
        throw new Error('must not report a move');
      },
    );
    expect(res[0]?.ok).toBe(false);
    expect(existsSync(join(root, 'Acme', 'a.pdf'))).toBe(true);
  });

  it('reports a missing source rather than throwing', () => {
    const res = applyMoves(
      [{ documentId: 'd1', from: join(root, 'Gone'), to: join(root, '2024', 'Gone'), group: '2024' }],
      root,
      () => {
        throw new Error('must not report a move');
      },
    );
    expect(res[0]?.ok).toBe(false);
    expect(res[0]?.reason).toContain('no longer there');
  });

  it('carries on after a refusal, so one bad move cannot strand the rest', () => {
    contract(root, 'Good');
    const moved: string[] = [];
    const res = applyMoves(
      [
        { documentId: 'bad', from: join(root, 'Missing'), to: join(root, '2024', 'Missing'), group: '2024' },
        { documentId: 'good', from: join(root, 'Good'), to: join(root, '2024', 'Good'), group: '2024' },
      ],
      root,
      (id) => moved.push(id),
    );
    expect(res.map((r) => r.ok)).toEqual([false, true]);
    expect(moved).toEqual(['good']);
    expect(existsSync(join(root, '2024', 'Good', 'a.pdf'))).toBe(true);
  });
});

describe('readTree', () => {
  it('reads a flat set of contract folders', () => {
    const root = sandbox();
    contract(root, 'Acme');
    contract(root, 'Helios');
    const t = readTree(root);
    expect(t.children.map((c) => c.name)).toEqual(['Acme', 'Helios']);
    expect(t.children[0]?.kind).toBe('contract');
    expect(t.children[0]?.children.map((f) => f.name)).toEqual(['a.pdf']);
    expect(t.count).toBe(2);
  });

  it('reads groups, and counts the contracts inside them', () => {
    const root = sandbox();
    mkdirSync(join(root, '2024'), { recursive: true });
    contract(root, join('2024', 'Acme'));
    contract(root, join('2024', 'Helios'));
    contract(root, 'Loose');

    const t = readTree(root);
    const group = t.children.find((c) => c.name === '2024');
    expect(group?.kind).toBe('group');
    expect(group?.count).toBe(2);
    expect(group?.children.map((c) => c.name)).toEqual(['Acme', 'Helios']);
    expect(t.count).toBe(3);
  });

  it('hides dotfiles, so .DS_Store never reads as a contract', () => {
    const root = sandbox();
    contract(root, 'Acme');
    writeFileSync(join(root, '.DS_Store'), 'junk');
    writeFileSync(join(root, 'Acme', '.DS_Store'), 'junk');
    const t = readTree(root);
    expect(t.children.map((c) => c.name)).toEqual(['Acme']);
    expect(t.children[0]?.children.map((f) => f.name)).toEqual(['a.pdf']);
  });

  it('returns an empty tree for a folder that is not there', () => {
    expect(readTree('/no/such/folder').children).toEqual([]);
  });
});
