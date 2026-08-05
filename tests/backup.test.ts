/**
 * The backup archive, against a real database and a real folder of files.
 *
 * Every assertion here is one of the defects the audit found, written down so it
 * cannot come back:
 *
 *   - the archive is produced in chunks, not assembled whole in memory
 *   - PDFs are STOREd, so most of the bytes are copied and never compressed
 *   - lastBackupAt is stamped only once the last byte has been produced, and an
 *     abandoned download stamps nothing
 *   - a file that moved while the backup ran is NAMED in the manifest, never
 *     zipped half-written and counted as captured
 *   - the manifest cross-checks the PDFs against the documents table, so the two
 *     halves of the backup cannot claim different things
 *   - the API key is in none of it
 *
 * IBC_DATA_DIR is set before the modules are imported, because paths.ts reads it
 * at call time and client.ts opens on first use.
 */

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'ibc-backup-'));
process.env['IBC_DATA_DIR'] = dir;
// Present in the environment and therefore reachable by getSettings(); the
// archive still must not contain it anywhere.
const FAKE_KEY = 'sk-ant-api03-THIS-MUST-NEVER-REACH-A-BACKUP';
process.env['ANTHROPIC_API_KEY'] = FAKE_KEY;

const backup = await import('@/lib/backup');
const q = await import('@/lib/db');

const archiveDir = join(dir, 'archive');
const thumbDir = join(dir, 'thumbnails');
mkdirSync(archiveDir, { recursive: true });
mkdirSync(thumbDir, { recursive: true });

/** A second data directory, at a different path. The last test restores into it. */
const restored = mkdtempSync(join(tmpdir(), 'ibc-restored-'));

afterAll(() => {
  try {
    q.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(restored, { recursive: true, force: true });
});

/* ─────────────────────────── Fixtures on disk ───────────────────────────── */

/** A PDF-shaped blob of a given size. Content only has to be stable, not valid. */
function pdfBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode('%PDF-1.7\n'));
  for (let i = 9; i < size; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

interface Fixture {
  id: string;
  name: string;
  path: string;
  bytes: Uint8Array;
}

function seedDocument(filename: string, size: number, seed: number): Fixture {
  const { id } = q.createDocument({ fileHash: `hash-${filename}`, filename, byteSize: size });
  const name = `${id}-${filename}`;
  const path = join(archiveDir, name);
  const bytes = pdfBytes(size, seed);
  writeFileSync(path, bytes);
  // Absolute, exactly as the ingest pipeline stores it -- which is what makes
  // the restore test at the end of this file worth having.
  q.updateDocument(id, { archivePath: path });
  return { id, name, path, bytes };
}

// Large enough that a single-buffer build would show up as one chunk.
const big = seedDocument('Big.pdf', 1_500_000, 3);
const vanishes = seedDocument('Vanishes.pdf', 4_096, 7);
const truncates = seedDocument('Truncates.pdf', 8_192, 11);

// A row whose archived copy is not on disk at all: the cross-check has to say so.
const orphan = q.createDocument({ fileHash: 'hash-orphan', filename: 'Orphan.pdf', byteSize: 10 });
q.updateDocument(orphan.id, { archivePath: join(archiveDir, `${orphan.id}-Orphan.pdf`) });

const thumbName = `${big.name}.png`;
writeFileSync(join(thumbDir, thumbName), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

// The name the thumbnail route derives from the document id, which is the one
// the app actually writes. The line above is a differently-named neighbour, kept
// so the archive holds more than one thumbnail.
const thumbBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
writeFileSync(join(thumbDir, `${big.id}.png`), thumbBytes);

// What a half-written upload looks like on disk before its rename lands. The
// upload route writes exactly this name, and a backup must not see it.
writeFileSync(join(archiveDir, `.${big.name}.partial`), pdfBytes(2_048, 99));

/* ───────────────────────────── Reading a zip ────────────────────────────── */

interface ZipEntry {
  method: number;
  data: Uint8Array;
}

/**
 * A real reader: it walks the central directory, follows each local header, and
 * checks every crc. A zip that only this app can open would not be a backup.
 */
function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);

  const count = dv.getUint16(eocd + 10, true);
  const directoryBytes = dv.getUint32(eocd + 12, true);
  const directoryAt = dv.getUint32(eocd + 16, true);

  const entries = new Map<string, ZipEntry>();
  let p = directoryAt;
  for (let i = 0; i < count; i += 1) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const method = dv.getUint16(p + 10, true);
    const declaredCrc = dv.getUint32(p + 16, true);
    const compressed = dv.getUint32(p + 20, true);
    const uncompressed = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    expect(dv.getUint32(localAt, true)).toBe(0x04034b50);
    const payloadAt =
      localAt + 30 + dv.getUint16(localAt + 26, true) + dv.getUint16(localAt + 28, true);
    const raw = bytes.subarray(payloadAt, payloadAt + compressed);
    const data = method === 0 ? raw : new Uint8Array(inflateRawSync(raw));

    expect(data.byteLength).toBe(uncompressed);
    expect(crc32(data) >>> 0).toBe(declaredCrc);

    entries.set(name, { method, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  expect(p).toBe(directoryAt + directoryBytes);
  expect(entries.size).toBe(count);
  return entries;
}

interface Drained {
  bytes: Uint8Array;
  chunks: number[];
}

/** Read what is left, discarding it. Rejects if the stream errors. */
async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Drained> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) parts.push(value);
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return { bytes, chunks: parts.map((part) => part.byteLength) };
}

function text(entry: ZipEntry | undefined): string {
  expect(entry).toBeDefined();
  return new TextDecoder().decode(entry!.data);
}

function manifestOf(entries: Map<string, ZipEntry>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text(entries.get('manifest.json')));
  expect(typeof parsed).toBe('object');
  return parsed as Record<string, unknown>;
}

function integrityOf(entries: Map<string, ZipEntry>): Record<string, unknown> {
  const integrity: unknown = Reflect.get(manifestOf(entries), 'integrity');
  return integrity as Record<string, unknown>;
}

function skippedNames(entries: Map<string, ZipEntry>): string[] {
  const skipped: unknown = Reflect.get(integrityOf(entries), 'skipped');
  expect(Array.isArray(skipped)).toBe(true);
  return (skipped as { name: string }[]).map((s) => s.name);
}

/* ──────────────────────────────── The tests ─────────────────────────────── */

describe('backup', () => {
  // Runs first, while lastBackupAt is still null, because that is the only state
  // in which "an abandoned download stamps nothing" can be observed.
  it('claims nothing when the download is abandoned part way through', async () => {
    expect(backup.lastBackupAt()).toBeNull();

    const plan = await backup.createBackup();
    const reader = plan.stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();

    // The old build stamped lastBackupAt before the bytes reached the browser,
    // so a fetch that timed out left the app reporting a backup that never
    // arrived anywhere.
    expect(backup.lastBackupAt()).toBeNull();
  });

  it('stops on the request signal, not only on the stream being cancelled', async () => {
    expect(backup.lastBackupAt()).toBeNull();

    // What a truncated download looks like from in here: the connection goes,
    // the request aborts, and NOTHING cancels the stream. Measured on the real
    // thing -- a download cut off at 30 KB of a 650 KB archive ran the generator
    // to the end and stamped lastBackupAt, so the Data tab reported a backup she
    // did not have. For a CFO whose whole repository is one file, a backup she
    // believes in and does not have is worse than no backup at all.
    const request = new AbortController();
    const plan = await backup.createBackup(request.signal);
    const reader = plan.stream.getReader();
    expect((await reader.read()).done).toBe(false);
    request.abort();

    // Erroring, not ending tidily: a tidy end is a file the browser is entitled
    // to save, and what it would save is half a zip.
    await expect(readToEnd(reader)).rejects.toThrow();
    expect(backup.lastBackupAt()).toBeNull();
  });

  it('refuses to start a build for a request that has already gone', async () => {
    // Before VACUUM INTO writes a second copy of the whole database for nobody.
    const request = new AbortController();
    request.abort();
    await expect(backup.createBackup(request.signal)).rejects.toThrow();
    expect(backup.lastBackupAt()).toBeNull();
  });

  it('stamps lastBackupAt only after the last byte has been produced', async () => {
    const plan = await backup.createBackup();
    expect(backup.lastBackupAt()).toBeNull();

    await drain(plan.stream);
    const stamped = backup.lastBackupAt();
    expect(stamped).not.toBeNull();
    expect(Number.isNaN(Date.parse(stamped ?? ''))).toBe(false);
  });

  it('emits the archive in chunks instead of one buffer', async () => {
    const plan = await backup.createBackup();
    const { bytes, chunks } = await drain(plan.stream);

    // 1.5 MB of PDF alone is six reads. One chunk would mean the whole archive
    // was assembled before anything was sent, which is the defect.
    expect(chunks.length).toBeGreaterThan(6);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(256 * 1024);
    expect(bytes.byteLength).toBeGreaterThan(1_500_000);

    // The estimate the Data tab draws its progress bar against has to be in the
    // right order of magnitude or the bar is decoration.
    expect(plan.contentBytes).toBeGreaterThan(1_500_000);
    expect(plan.filename).toMatch(/^IBC-Contracts-Backup-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it(
    'stores PDFs and thumbnails, and deflates the database',
    async () => {
      const entries = readZip((await drain((await backup.createBackup()).stream)).bytes);

      const pdf = entries.get(`archive/${big.name}`);
      expect(pdf?.method).toBe(0); // STORE: already compressed, and never buffered
      expect(pdf?.data).toEqual(big.bytes);
      expect(entries.get(`thumbnails/${thumbName}`)?.method).toBe(0);

      const db = entries.get('tracker.db');
      expect(db?.method).toBe(8);
      expect(new TextDecoder().decode(db!.data.subarray(0, 15))).toBe('SQLite format 3');
    },
    // This one really deflates a multi-megabyte fixture, which is comfortably
    // more than the default 5s on a busy machine. Slow, not flaky -- so it gets
    // an honest bound of its own rather than a flag on the release command that
    // a plain local `vitest run` never sees.
    30_000,
  );

  it('never captures a dot-prefixed half-written upload', async () => {
    const entries = readZip((await drain((await backup.createBackup()).stream)).bytes);
    const names = [...entries.keys()];
    expect(names.some((n) => n.includes('.partial'))).toBe(false);

    const overview = await backup.dataOverview();
    expect(overview.counts.archivedPdfs).toBe(3);
  });

  it('names a file that vanished mid-build instead of counting it as captured', async () => {
    const plan = await backup.createBackup();
    // Deleted after the listing, before the entry is read -- exactly the window
    // the old build swallowed with an ENOENT skip and no record.
    rmSync(vanishes.path);

    const entries = readZip((await drain(plan.stream)).bytes);
    expect(entries.has(`archive/${vanishes.name}`)).toBe(false);
    expect(skippedNames(entries)).toContain(`archive/${vanishes.name}`);
    expect(Reflect.get(integrityOf(entries), 'complete')).toBe(false);

    const counts: unknown = Reflect.get(manifestOf(entries), 'counts');
    expect(Reflect.get(counts as object, 'archivedPdfs')).toBe(2);

    // And the human-readable half says the same thing.
    expect(text(entries.get('RESTORE.txt'))).toContain(vanishes.name);
  });

  it('refuses to zip a file whose size no longer matches the listing', async () => {
    const plan = await backup.createBackup();
    // A file that is present but short is what a non-atomic write looks like
    // from the outside. It must be skipped, not shipped as if it were whole.
    truncateSync(truncates.path, 16);

    const entries = readZip((await drain(plan.stream)).bytes);
    expect(entries.has(`archive/${truncates.name}`)).toBe(false);

    const skipped: unknown = Reflect.get(integrityOf(entries), 'skipped');
    const record = (skipped as { name: string; expectedBytes: number; actualBytes: number }[]).find(
      (s) => s.name === `archive/${truncates.name}`,
    );
    expect(record?.expectedBytes).toBe(8_192);
    expect(record?.actualBytes).toBe(16);
  });

  it('cross-checks the archived PDFs against the documents table in the snapshot', async () => {
    const entries = readZip((await drain((await backup.createBackup()).stream)).bytes);
    const check: unknown = Reflect.get(integrityOf(entries), 'archiveCrossCheck');
    const cross = check as { checked: boolean; missing: string[]; unreferenced: string[] };

    expect(cross.checked).toBe(true);
    // A document row pointing at a PDF that is not in the archive is a real gap
    // between the two halves of the backup, and the manifest has to state it.
    expect(cross.missing).toContain(`${orphan.id}-Orphan.pdf`);
    expect(cross.missing).toContain(vanishes.name);
    expect(cross.unreferenced).toEqual([]);
  });

  it('carries the API key nowhere, in any entry', async () => {
    const entries = readZip((await drain((await backup.createBackup()).stream)).bytes);

    for (const [name, entry] of entries) {
      const decoded = new TextDecoder('latin1').decode(entry.data);
      expect(decoded, `${name} contains the API key`).not.toContain(FAKE_KEY);
      expect(decoded, `${name} contains a key prefix`).not.toContain('sk-ant-');
    }

    const settings = text(entries.get('settings.json'));
    expect(settings).not.toContain('hasApiKey');
    expect(settings).not.toContain('apiKeySource');
  });

  it('caps a build well below the two gigabytes the process could not survive', () => {
    expect(backup.MAX_BACKUP_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024);
    expect(backup.MAX_BACKUP_BYTES).toBeLessThan(2 * 1024 * 1024 * 1024);
  });
});

/* ─────────────────────── Restoring it somewhere else ────────────────────── */

/*
 * The printed RESTORE steps, followed correctly, into a data directory at a
 * different path -- a new Mac, a different account, an external drive.
 *
 * THE DEFECT: the contracts came back, the PDF bytes on disk were byte-identical
 * to the ones that went in, and every GET /api/documents/<id>/pdf answered 404,
 * because `archive_path` is stored ABSOLUTE and every row still pointed at the
 * old location. A restore that is done right, ending in a repository where no
 * document can be opened, is the worst possible reward for following the
 * instructions.
 *
 * LAST IN THE FILE ON PURPOSE: it closes the database and repoints IBC_DATA_DIR,
 * so nothing above it may run afterwards.
 */
describe('a backup restored into a different folder', () => {
  it(
    'serves the PDFs and thumbnails from where they now are',
    async () => {
      const entries = readZip((await drain((await backup.createBackup()).stream)).bytes);

      // Step 4 of describeRestore(), done literally: unzip, and copy tracker.db,
      // archive/ and thumbnails/ into the (different) data directory.
      mkdirSync(join(restored, 'archive'), { recursive: true });
      mkdirSync(join(restored, 'thumbnails'), { recursive: true });
      for (const [name, entry] of entries) {
        if (name === 'tracker.db') {
          writeFileSync(join(restored, 'tracker.db'), entry.data);
        } else if (name.startsWith('archive/') || name.startsWith('thumbnails/')) {
          writeFileSync(join(restored, name), entry.data);
        }
      }

      // Quit the tracker, open it against the restored folder.
      q.close();
      process.env['IBC_DATA_DIR'] = restored;

      // Imported only now, so it resolves its paths against the restored folder.
      const pdfRoute = await import('@/app/api/documents/[id]/pdf/route');
      const thumbnailRoute = await import('@/app/api/documents/[id]/thumbnail/route');

      // The row is exactly as unhelpful as it was on the old Mac: absolute, and
      // pointing at a folder that is not this one. This is the condition, not an
      // artefact of the test.
      const row = q.getDocument(big.id);
      expect(row?.archivePath?.startsWith(dir)).toBe(true);
      expect(row?.archivePath?.startsWith(restored)).toBe(false);

      const pdf = await pdfRoute.GET(new Request('http://127.0.0.1/'), {
        params: Promise.resolve({ id: big.id }),
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
      expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(big.bytes);

      const thumbnail = await thumbnailRoute.GET(new Request('http://127.0.0.1/'), {
        params: Promise.resolve({ id: big.id }),
      });
      expect(thumbnail.status).toBe(200);
      expect(new Uint8Array(await thumbnail.arrayBuffer())).toEqual(thumbBytes);
    },
    // Builds and reads a whole archive, including the multi-megabyte fixture, on
    // the way to the assertion. Slow, not flaky -- so it declares its own bound
    // rather than relying on a flag the release command happens to pass.
    30_000,
  );

  it('still answers 404 for a document whose PDF is genuinely not there', async () => {
    // The fallback must not turn "the file is missing" into something else. It
    // is a second place to look, not a reason to stop saying no.
    const pdfRoute = await import('@/app/api/documents/[id]/pdf/route');
    const missing = await pdfRoute.GET(new Request('http://127.0.0.1/'), {
      params: Promise.resolve({ id: orphan.id }),
    });
    expect(missing.status).toBe(404);
  });
});
