import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * The layout, end to end, against a real ingest.
 *
 * Everything else about this feature is unit-tested. This is the one that says
 * the thing she will actually see in Finder is the thing that was designed: a
 * folder per contract, named after the file, holding the original bytes.
 */

let dir: string;
const original = process.env['IBC_DATA_DIR'];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ibc-e2e-'));
  process.env['IBC_DATA_DIR'] = dir;
});

afterAll(() => {
  if (original === undefined) delete process.env['IBC_DATA_DIR'];
  else process.env['IBC_DATA_DIR'] = original;
  rmSync(dir, { recursive: true, force: true });
});

const PDF = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

describe('a dropped contract, on disk', () => {
  it('lands in a folder of its own, holding the original bytes', async () => {
    const { ingestPdf } = await import('@/lib/ingest');
    const res = await ingestPdf({ bytes: PDF, filename: 'Helios Anode NDA.pdf' });
    expect(res.outcome).toBe('accepted');

    const root = join(dir, 'archive');
    const entries = readdirSync(root, { withFileTypes: true }).filter(
      (e) => !e.name.startsWith('.'),
    );

    // A folder, not a file dropped in the pile.
    expect(entries.length).toBe(1);
    expect(entries[0]!.isDirectory()).toBe(true);
    // Named after what she dropped in, with the extension gone.
    expect(entries[0]!.name).toBe('Helios Anode NDA');

    const folder = join(root, entries[0]!.name);
    const files = readdirSync(folder).filter((n) => !n.startsWith('.'));
    expect(files).toContain('Helios Anode NDA.pdf');

    // Byte for byte. The archived copy is the authoritative one.
    const stored = new Uint8Array(readFileSync(join(folder, 'Helios Anode NDA.pdf')));
    expect(stored).toEqual(PDF);
    expect(statSync(join(folder, 'Helios Anode NDA.pdf')).size).toBe(PDF.byteLength);
  });

  it('gives a second contract with the same name its own folder', async () => {
    const { ingestPdf } = await import('@/lib/ingest');
    // Different bytes, same name: an amended agreement filed under the same title.
    const other = new TextEncoder().encode(`${new TextDecoder().decode(PDF)}\n% amended\n`);
    const res = await ingestPdf({ bytes: other, filename: 'Helios Anode NDA.pdf' });
    expect(res.outcome).toBe('accepted');

    const root = join(dir, 'archive');
    const names = readdirSync(root).filter((n) => !n.startsWith('.')).sort();
    // Neither one overwrote the other, and one of them is a signed contract.
    expect(names).toEqual(['Helios Anode NDA', 'Helios Anode NDA (2)']);
  });
});
