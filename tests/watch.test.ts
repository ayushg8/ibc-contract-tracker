/**
 * The watched folder.
 *
 * The defect this covers: settings.watchFolder was stored, validated,
 * health-checked and named in three screens, and nothing read it. The Settings
 * copy promised "New PDFs dropped here are picked up automatically" and no code
 * anywhere polled, watched or scanned.
 *
 * The failure mode that actually costs money is not the missing feature though --
 * it is ingesting a PDF that Google Drive is still writing. A truncated PDF either
 * fails extraction (noise) or extracts cleanly from the pages that did arrive,
 * which is a wrong answer that looks right. So the first tests here are the
 * chunked-writer ones, and the rule they pin is: nothing is read until the same
 * size and mtime have been observed several times running, over a window longer
 * than the poll interval hands out for free.
 *
 * That second half is not theory. With "two identical observations at least 2s
 * apart" and a 3s poll, the scheduler satisfied the gap by itself, so any writer
 * pausing between chunks looked stable between every pair of them: one PDF
 * written in ten chunks 4s apart produced nine documents and nine truncated PDFs
 * in the archive. The headline test below writes a file exactly that way and
 * demands one document holding the whole file.
 *
 * The rest is the promise that a restart is not an event: re-scanning a folder must
 * produce duplicates, never doubles, and must never resurrect a document she chose
 * to reject -- and that whatever else happens, her folder is left exactly as it was.
 */

import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Collected inside the hoisted mock factories, which run before any import. */
const queue = vi.hoisted(() => ({
  added: [] as string[],
  paused: false,
  halted: false,
}));

// The real queue would try to reach Claude. The real pdf module would pull a PDF
// renderer into what is a filesystem test. sha256 has to stay real: duplicate
// detection is the whole point of several of these cases.
vi.mock('@/lib/extraction/queue', () => ({
  extractionQueue: {
    add: (id: string) => {
      queue.added.push(id);
    },
    status: () => ({
      running: 0,
      queued: 0,
      paused: queue.paused,
      haltReason: queue.halted ? { code: 'CLI_USAGE_LIMIT' } : null,
      completed: 0,
      failed: 0,
    }),
  },
}));

vi.mock('@/lib/extraction/pdf', async () => {
  const { createHash } = await import('node:crypto');
  return {
    sha256: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    renderThumbnail: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  };
});

const dataDir = mkdtempSync(join(tmpdir(), 'ibc-watch-data-'));
process.env['IBC_DATA_DIR'] = dataDir;

const { FolderWatcher, STABLE_SCANS, shouldIgnore } = await import('@/lib/watch');
const db = await import('@/lib/db');

const folders: string[] = [];

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ibc-watch-folder-'));
  folders.push(dir);
  return dir;
}

/**
 * pollMs 0 collapses the settle window to stableMs, which isolates the
 * "how many observations" half of the rule from the clock; the timing half gets
 * its own tests below, driven by an injected clock. fs.watch is off because these
 * scans are driven by hand -- an accelerant that fired mid-assertion would make
 * the test lie.
 */
function watcherOn(dir: string, stableMs = 0) {
  return new FolderWatcher({ folder: () => dir, pollMs: 0, stableMs, useFsWatch: false });
}

/** The scans an unchanging file needs before it is read. */
async function settle(watcher: { scan: () => Promise<unknown> }, scans = STABLE_SCANS) {
  for (let i = 0; i < scans; i += 1) await watcher.scan();
}

const HEAD = new TextEncoder().encode('%PDF-1.7\n');
const TAIL = new Uint8Array([0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a]);

function pdfBytes(marker: string): Uint8Array {
  const body = new TextEncoder().encode(`\n${marker}\n`);
  return new Uint8Array([...HEAD, ...body, ...TAIL]);
}

/**
 * A PDF big enough to arrive in pieces. The first piece carries the %PDF- header
 * on purpose: a prefix that parses is the dangerous case, because it becomes a
 * document that looks complete rather than a file that fails to open.
 */
function chunkedPdf(parts: number): { whole: Uint8Array; chunks: Uint8Array[] } {
  const body = new TextEncoder().encode(`\nmutual nda\n${'page of the agreement\n'.repeat(40)}`);
  const whole = new Uint8Array([...HEAD, ...body, ...TAIL]);
  const size = Math.ceil(whole.byteLength / parts);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < whole.byteLength; at += size) chunks.push(whole.subarray(at, at + size));
  return { whole, chunks };
}

function documentCount(): number {
  return db.listDocuments({}).length;
}

function archivedNames(): string[] {
  return readdirSync(join(dataDir, 'archive')).filter((n) => !n.startsWith('.'));
}

/** Name, size and mtime of everything in her folder, for the "never touched it" test. */
function folderState(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const info = statSync(join(dir, name));
      return `${name} ${info.size} ${info.mtimeMs}`;
    });
}

afterAll(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dataDir, { recursive: true, force: true });
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  queue.added.length = 0;
  queue.paused = false;
  queue.halted = false;
});

describe('a file that is still being written', () => {
  it('is not ingested until its size has stopped changing', async () => {
    const dir = freshFolder();
    const path = join(dir, 'Half Synced NDA.pdf');
    const before = documentCount();

    // Chunk one: a valid header, but not the whole document. This is exactly what
    // Drive leaves on disk part way through a sync.
    writeFileSync(path, Buffer.from(HEAD));

    const watcher = watcherOn(dir);
    await watcher.scan();
    expect(documentCount(), 'a first sighting must never be ingested').toBe(before);
    expect(watcher.status().settling).toBe(1);

    // Chunk two lands part way through the run of identical observations.
    appendFileSync(path, Buffer.from(pdfBytes('body of the agreement').subarray(HEAD.length)));

    await watcher.scan();
    expect(documentCount(), 'the size changed, so the run starts over').toBe(before);

    await settle(watcher, STABLE_SCANS - 2);
    expect(documentCount(), 'an unfinished run is not stability').toBe(before);

    await watcher.scan();
    expect(documentCount()).toBe(before + 1);

    // And what landed in the archive is the whole file, not the first chunk.
    const archived = archivedNames().find((n) => n.endsWith('Half Synced NDA.pdf'));
    expect(archived).toBeDefined();
    const stored = new Uint8Array(readFileSync(join(dataDir, 'archive', archived ?? '')));
    expect(stored.byteLength).toBe(readFileSync(path).byteLength);
    expect(queue.added).toHaveLength(1);
  });

  it('needs more than two identical observations, however wide the gap between them', async () => {
    const dir = freshFolder();
    writeFileSync(join(dir, 'Twice Seen.pdf'), Buffer.from(pdfBytes('twice seen')));
    const before = documentCount();

    // The settle window is zero here, so this pins the count rule on its own.
    // Two observations was the old rule, and a writer that pauses across one poll
    // boundary produces two identical observations for free.
    const watcher = watcherOn(dir);
    await watcher.scan();
    await watcher.scan();
    expect(documentCount(), 'two is what a pause between chunks buys').toBe(before);
    expect(watcher.status().settling).toBe(1);

    await watcher.scan();
    expect(documentCount()).toBe(before + 1);
  });

  it('is not ingested by a burst of scans that arrive inside the settle window', async () => {
    const dir = freshFolder();
    writeFileSync(join(dir, 'Rushed.pdf'), Buffer.from(pdfBytes('rushed')));
    const before = documentCount();

    // fs.watch is allowed to bring the next observation forward. This is the rule
    // that stops it from bringing it forward far enough to be meaningless.
    const watcher = watcherOn(dir, 60_000);
    await settle(watcher, STABLE_SCANS + 3);

    expect(documentCount()).toBe(before);
    expect(watcher.status().settling).toBe(1);
  });

  it('produces one document, holding the whole file, from a chunked slow writer', async () => {
    const dir = freshFolder();
    const path = join(dir, 'Signed NDA.pdf');
    const before = documentCount();
    const archivedBefore = archivedNames().length;

    // The cadence that broke it: Drive appends a chunk every 4s, the watcher lists
    // the folder every 3s. Under "two observations at least 2s apart" the file was
    // stable between every pair of chunks, because consecutive polls are 3s apart
    // by construction -- ten chunks, nine documents, nine truncated PDFs archived,
    // four of them extracting cleanly enough to reach 'ready' and pass a one-click
    // bulk approve into the repository.
    const pollMs = 3_000;
    const chunkEveryMs = 4_000;
    const { whole, chunks } = chunkedPdf(10);

    let clock = 1_700_000_000_000;
    const watcher = new FolderWatcher({
      folder: () => dir,
      pollMs,
      useFsWatch: false,
      now: () => clock,
    });

    let written = 0;
    let nextChunkAt = clock;
    // Enough polls for ten chunks 4s apart plus the settle window after the last.
    for (let i = 0; i < 40; i += 1) {
      const chunk = chunks[written];
      if (chunk !== undefined && clock >= nextChunkAt) {
        appendFileSync(path, Buffer.from(chunk));
        written += 1;
        nextChunkAt = clock + chunkEveryMs;
      }
      await watcher.scan();
      // Asserted every pass, not just at the end: the defect was nine documents
      // appearing DURING the write, and a check that only ran afterwards would
      // have passed on a watcher that ingested each prefix and then deduplicated.
      expect(documentCount(), `after poll ${i}`).toBeLessThanOrEqual(before + 1);
      clock += pollMs;
    }

    expect(written, 'every chunk was written').toBe(chunks.length);
    expect(documentCount()).toBe(before + 1);
    expect(watcher.status().ingested).toBe(1);
    expect(queue.added, 'one document, read once').toHaveLength(1);

    const archived = archivedNames();
    expect(archived.length).toBe(archivedBefore + 1);
    const name = archived.find((n) => n.endsWith('Signed NDA.pdf'));
    expect(name).toBeDefined();
    const stored = new Uint8Array(readFileSync(join(dataDir, 'archive', name ?? '')));
    // Byte-for-byte the finished file, signature page and all -- not a prefix.
    expect(stored.byteLength).toBe(whole.byteLength);
    expect([...stored]).toEqual([...whole]);
  });
});

describe('what the watcher refuses to open', () => {
  it('ignores dotfiles, .DS_Store, Office temp files and anything not a PDF', async () => {
    const dir = freshFolder();
    writeFileSync(join(dir, '.DS_Store'), 'finder');
    writeFileSync(join(dir, '.com.google.Chrome.a1b2c3'), 'drive partial');
    writeFileSync(join(dir, '~$Mutual NDA.pdf'), 'office scratch');
    writeFileSync(join(dir, 'notes.txt'), 'not a pdf');
    writeFileSync(join(dir, 'Signed.pdf.crdownload'), Buffer.from(pdfBytes('partial download')));

    const before = documentCount();
    const watcher = watcherOn(dir);
    await settle(watcher);

    expect(documentCount()).toBe(before);
    // Ignored is not the same as skipped: an ignored name is never opened, so it
    // has no error to report and must not clutter the Settings screen.
    expect(watcher.status().skipped).toEqual([]);
    expect(watcher.status().settling).toBe(0);
  });

  it('agrees with shouldIgnore on each of those names', () => {
    for (const name of [
      '.DS_Store',
      '._Mutual NDA.pdf',
      '.com.google.Chrome.a1b2c3',
      '~$Mutual NDA.pdf',
      'notes.txt',
      'Signed.pdf.crdownload',
      'scan.PDF.part',
    ]) {
      expect(shouldIgnore(name), name).toBe(true);
    }
    for (const name of ['Mutual NDA.pdf', 'MUTUAL NDA.PDF', 'nda (1).pdf']) {
      expect(shouldIgnore(name), name).toBe(false);
    }
  });

  it('reports a file over the size cap rather than failing silently', async () => {
    const dir = freshFolder();
    const path = join(dir, 'Enormous.pdf');
    writeFileSync(path, Buffer.from(HEAD));
    // Sparse: the size is what matters and the bytes are never read.
    truncateSync(path, 65 * 1024 * 1024);

    const before = documentCount();
    const watcher = watcherOn(dir);
    await settle(watcher);

    expect(documentCount()).toBe(before);
    const skipped = watcher.status().skipped;
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.filename).toBe('Enormous.pdf');
    // An existing code with an existing remedy, not new copy invented here.
    expect(skipped[0]?.error.code).toBe('PDF_TOO_LARGE');
    expect(skipped[0]?.error.remedy.action).toBe('enter-manually');
  });
});

describe('her folder', () => {
  it('is never moved, renamed, emptied or written to', async () => {
    const dir = freshFolder();
    writeFileSync(join(dir, 'Kept In Place.pdf'), Buffer.from(pdfBytes('kept in place')));
    writeFileSync(join(dir, 'notes.txt'), 'not a pdf');
    writeFileSync(join(dir, '.DS_Store'), 'finder');
    const before = folderState(dir);

    const watcher = watcherOn(dir);
    await settle(watcher);
    expect(watcher.status().ingested).toBe(1);
    // A scan after the ingest too: nothing is tidied up on the way out either.
    await settle(watcher);

    // Same names, same sizes, same modification times. The archived copy lives in
    // the data directory; the original is hers and is left exactly as it was.
    expect(folderState(dir)).toEqual(before);
  });
});

describe('the same bytes twice', () => {
  it('does not create a second document', async () => {
    const dir = freshFolder();
    const bytes = Buffer.from(pdfBytes('one agreement'));
    writeFileSync(join(dir, 'Original.pdf'), bytes);

    const watcher = watcherOn(dir);
    await settle(watcher);
    const after = documentCount();
    expect(watcher.status().ingested).toBe(1);

    // The same content under a different name is still the same document.
    copyFileSync(join(dir, 'Original.pdf'), join(dir, 'Copy of Original.pdf'));
    await settle(watcher);

    expect(documentCount()).toBe(after);
    expect(watcher.status().ingested).toBe(1);
    expect(watcher.status().duplicates).toBe(1);
  });

  it('does not re-ingest anything after a restart', async () => {
    const dir = freshFolder();
    writeFileSync(join(dir, 'Survivor A.pdf'), Buffer.from(pdfBytes('survivor a')));
    writeFileSync(join(dir, 'Survivor B.pdf'), Buffer.from(pdfBytes('survivor b')));

    const first = watcherOn(dir);
    await settle(first);
    expect(first.status().ingested).toBe(2);
    const after = documentCount();
    const archived = archivedNames().length;

    // A new process: no memory of the folder at all, only the database.
    queue.added.length = 0;
    const second = watcherOn(dir);
    await settle(second);

    expect(second.status().ingested).toBe(0);
    expect(second.status().duplicates).toBe(2);
    expect(documentCount()).toBe(after);
    expect(archivedNames().length, 'no second archive copy').toBe(archived);
    expect(queue.added, 'nothing re-queued for extraction').toEqual([]);
  });
});

describe('a document she rejected', () => {
  it('stays rejected across a restart, and comes back when the file is replaced', async () => {
    const dir = freshFolder();
    const path = join(dir, 'Set Aside.pdf');
    writeFileSync(path, Buffer.from(pdfBytes('set aside')));

    const first = watcherOn(dir);
    await settle(first);
    const id = db.listDocuments({}).find((d) => d.filename === 'Set Aside.pdf')?.id;
    expect(id).toBeDefined();

    db.rejectDocument(id ?? '', { reason: 'not an NDA' });
    expect(db.getDocument(id ?? '')?.status).toBe('rejected');

    // A restart re-reads the whole folder. The file has not changed since she
    // rejected it, so her decision has to survive.
    queue.added.length = 0;
    const second = watcherOn(dir);
    await settle(second);

    expect(db.getDocument(id ?? '')?.status).toBe('rejected');
    expect(second.status().reopened).toBe(0);
    expect(queue.added).toEqual([]);

    // Now the file is genuinely replaced, after the rejection. That is the same
    // event as dragging it in again, and it reopens the record.
    const later = new Date(Date.now() + 60_000);
    writeFileSync(path, Buffer.from(pdfBytes('set aside')));
    const { utimesSync } = await import('node:fs');
    utimesSync(path, later, later);

    const third = watcherOn(dir);
    await settle(third);

    expect(db.getDocument(id ?? '')?.status).toBe('queued');
    expect(third.status().reopened).toBe(1);
    expect(queue.added).toEqual([id]);
  });
});

describe('when the engine has halted', () => {
  it('backs off instead of polling the folder every three seconds', async () => {
    const dir = freshFolder();
    const watcher = new FolderWatcher({
      folder: () => dir,
      stableMs: 0,
      useFsWatch: false,
      pollMs: 3_000,
      haltedPollMs: 30_000,
    });

    await watcher.scan();
    expect(watcher.status().backedOff).toBe(false);
    expect(watcher.status().intervalMs).toBe(3_000);

    queue.paused = true;
    queue.halted = true;
    await watcher.scan();
    expect(watcher.status().backedOff).toBe(true);
    expect(watcher.status().intervalMs).toBe(30_000);

    // Resume clears it on the very next pass; nothing has to be restarted.
    queue.paused = false;
    queue.halted = false;
    await watcher.scan();
    expect(watcher.status().backedOff).toBe(false);
  });
});

describe('the folder itself', () => {
  it('reports an unreachable folder with a code the UI already renders', async () => {
    const dir = freshFolder();
    rmSync(dir, { recursive: true, force: true });

    const watcher = watcherOn(dir);
    watcher.start();
    const status = await watcher.scan();
    watcher.stop();

    expect(status.error?.code).toBe('FOLDER_MISSING');
    expect(status.error?.remedy.action).toBe('choose-folder');
    expect(status.running, 'a folder it cannot read is not "watching"').toBe(false);
  });

  it('is simply idle when no folder is configured', async () => {
    const watcher = new FolderWatcher({ folder: () => null, stableMs: 0, useFsWatch: false });
    const status = await watcher.scan();
    expect(status.folder).toBeNull();
    expect(status.error).toBeNull();
    expect(status.running).toBe(false);
  });

  it('picks up a folder change without being restarted', async () => {
    const before = freshFolder();
    const after = freshFolder();
    writeFileSync(join(after, 'Moved In.pdf'), Buffer.from(pdfBytes('moved in')));

    let current = before;
    const watcher = new FolderWatcher({
      folder: () => current,
      pollMs: 0,
      stableMs: 0,
      useFsWatch: false,
    });
    await watcher.scan();
    expect(watcher.status().folder).toBe(before);

    current = after;
    // The retarget forgets everything it knew, so the new folder's files start
    // their run from one -- they are not carried over as already settled.
    await watcher.scan();
    expect(watcher.status().folder).toBe(after);
    expect(watcher.status().ingested).toBe(0);

    await settle(watcher, STABLE_SCANS - 1);
    expect(watcher.status().ingested).toBe(1);
  });
});
