/**
 * The archived copy of an upload is written atomically.
 *
 * The defect: the upload route wrote straight to the final path. A backup walks
 * that same folder and copies whatever it finds, so there was a window in which
 * the final name existed holding half a PDF -- and a backup taken in that window
 * captured the half and reported success.
 *
 * The fix has two halves and this file tests both: the bytes land under a
 * dot-prefixed temp name and are renamed into place (atomic within a directory),
 * and the temp name is dot-prefixed precisely so lib/backup.ts, which skips
 * dotfiles, cannot see it even if a crash leaves one behind.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

/** Collected inside the mock factory, which is hoisted above everything else. */
const fsCalls = vi.hoisted(() => ({ writes: [] as string[], renames: [] as [string, string][] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    async writeFile(
      path: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) {
      fsCalls.writes.push(String(path));
      return actual.writeFile(path, data, options);
    },
    async rename(from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) {
      fsCalls.renames.push([String(from), String(to)]);
      return actual.rename(from, to);
    },
  };
});

// pdfjs and the extraction queue are not what this file is about, and importing
// them would pull a PDF renderer into a filesystem test.
vi.mock('@/lib/extraction/pdf', () => ({
  sha256: (bytes: Uint8Array) => `hash-${bytes.byteLength}`,
  renderThumbnail: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
}));
vi.mock('@/lib/extraction/queue', () => ({
  extractionQueue: { add: () => undefined },
}));

const dir = mkdtempSync(join(tmpdir(), 'ibc-upload-'));
process.env['IBC_DATA_DIR'] = dir;

const { POST } = await import('@/app/api/documents/route');
const q = await import('@/lib/db');

afterAll(() => {
  try {
    q.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), 1, 2, 3, 4, 5, 6, 7, 8]);

async function upload(filename: string): Promise<Response> {
  const form = new FormData();
  form.append('files', new File([PDF], filename, { type: 'application/pdf' }));
  return POST(new Request('http://localhost/api/documents', { method: 'POST', body: form }));
}

describe('archived upload', () => {
  it('writes to a temp name and renames into place', async () => {
    const res = await upload('Mutual NDA.pdf');
    expect(res.status).toBe(200);

    const archiveDir = join(dir, 'archive');
    const files = readdirSync(archiveDir);
    const final = files.find((name) => name.endsWith('Mutual NDA.pdf'));
    expect(final).toBeDefined();
    const finalPath = join(archiveDir, final!);

    // The final name was never a write target. This is the whole defect: the
    // moment that name exists it is visible to a backup, so it may only ever
    // appear via rename, complete.
    expect(fsCalls.writes).not.toContain(finalPath);

    const rename = fsCalls.renames.find(([, to]) => to === finalPath);
    expect(rename).toBeDefined();
    const [from] = rename!;
    expect(fsCalls.writes).toContain(from);
    expect(from.endsWith('.partial')).toBe(true);

    expect(new Uint8Array(readFileSync(finalPath))).toEqual(PDF);
  });

  it('gives the temp file a dot prefix, which is what a backup skips', async () => {
    await upload('Second.pdf');

    for (const [from] of fsCalls.renames) {
      const base = from.slice(from.lastIndexOf('/') + 1);
      expect(base.startsWith('.'), `${base} would be visible to a backup`).toBe(true);
    }

    // Nothing partial survives a successful upload, in either folder.
    for (const folder of ['archive', 'thumbnails']) {
      expect(readdirSync(join(dir, folder)).filter((n) => n.includes('.partial'))).toEqual([]);
    }
  });

  it('writes the thumbnail the same way', async () => {
    await upload('Third.pdf');

    const thumbs = readdirSync(join(dir, 'thumbnails')).filter((n) => n.endsWith('.png'));
    expect(thumbs.length).toBeGreaterThan(0);
    for (const name of thumbs) {
      const path = join(dir, 'thumbnails', name);
      expect(fsCalls.writes).not.toContain(path);
      expect(fsCalls.renames.some(([, to]) => to === path)).toBe(true);
    }
  });
});
