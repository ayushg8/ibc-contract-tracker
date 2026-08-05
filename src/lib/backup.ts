/**
 * The backup archive. Server-only (node:fs, node:zlib, node:sqlite via the db).
 *
 * Everything this app knows lives in one folder on one Mac. This file turns that
 * folder into a single portable file that can go on a drive, into Dropbox, or to
 * whoever maintains the app next. Without it, one lost folder is every reviewed
 * contract.
 *
 * Four decisions worth knowing:
 *
 *   1. The zip is written here rather than pulled in as a dependency. A zip with
 *      no encryption and no zip64 is a well specified container (APPNOTE 6.3.x)
 *      and node already ships both deflate and crc32, so a package would add a
 *      supply chain and buy nothing. The trade is that the format's 32-bit sizes
 *      cap us -- see MAX_BACKUP_BYTES, which is checked before anything is read.
 *
 *   2. The archive is PRODUCED AS IT IS SENT. This is a single process: while a
 *      backup runs, every other route, the health poll, the extraction queue's
 *      timers and the Inbox poll are waiting on the same event loop. The old
 *      build held every entry in an array, concatenated the lot into one buffer
 *      and handed that to the Response -- three references to the same content,
 *      with deflateRawSync blocking the loop over each one. Two years of scanned
 *      NDAs stalled the app for a minute or more. Now each entry is emitted as it
 *      is produced, one 256 KB chunk at a time, and the loop gets a turn between
 *      chunks and between entries. Peak residency is one chunk plus the central
 *      directory, not the whole archive.
 *
 *   3. The database is snapshotted with VACUUM INTO, never byte-copied. The file
 *      runs in WAL mode, so a copy taken while any writer is live yields a
 *      database that opens cleanly and is silently missing the last commits.
 *      VACUUM INTO exists for exactly this and takes its own read transaction.
 *
 *   4. The API key is not in here and never will be. It lives in the OS keychain,
 *      which is why a backup on a USB stick cannot be used to spend money.
 *
 * The manifest describes what was actually captured, not what was on disk when
 * the build started. Every entry is size-checked against the listing it came
 * from and anything that moved is named in manifest.json rather than quietly
 * zipped half-written -- a backup that claims to hold a PDF it only half holds
 * is worse than one that admits the gap.
 *
 * Restore is deliberately NOT implemented in the app. Overwriting a live database
 * from inside the process that has it open is how you get half a repository; the
 * safe procedure is a file copy with the app closed, and describeRestore() is the
 * text the UI shows to walk through it.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32, createDeflateRaw, deflateRaw } from 'node:zlib';

import { db, sqliteError } from '@/lib/db/client';
import { SCHEMA_VERSION } from '@/lib/db/migrate';
import { getSetting, getSettings, getStats, tableCounts } from '@/lib/db/queries';
import { PROMPT_VERSION } from '@/lib/extraction/prompt';
import { log } from '@/lib/logger';
import { archiveDir, dataDir, dbPath, fsError, thumbDir } from '@/lib/paths';
import { EngineError, toEngineError } from '@/lib/providers/errors';

/* ────────────────────────────── The contract ────────────────────────────── */

/** Entry names inside the archive. Restoring is "copy these into the data dir". */
const DB_ENTRY = 'tracker.db';
const ARCHIVE_ENTRY = 'archive';
const THUMB_ENTRY = 'thumbnails';
const MANIFEST_ENTRY = 'manifest.json';
const SETTINGS_ENTRY = 'settings.json';
const RESTORE_ENTRY = 'RESTORE.txt';

/** Bumped if the layout above changes in a way a reader would have to know about. */
const BACKUP_FORMAT = 1;

/**
 * Refuse rather than emit a file nobody can use.
 *
 * The server no longer holds the archive in memory, so this is not a server
 * limit any more. Two things still bind. Sizes and offsets in a plain zip are
 * 32-bit. And the browser assembles the download into one Blob before it can
 * save it, so a build the server streams happily is still a build the tab has to
 * hold whole. Past this the honest answer is "copy the folder in Finder
 * instead", which is exactly what the route says.
 */
export const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;

/** One entry that was listed but not captured, and why, in her words. */
export interface SkippedFile {
  /** The entry name it would have had. */
  name: string;
  /** Bytes the directory listing said it had. */
  expectedBytes: number;
  /** Bytes actually found, or null if it could not be opened at all. */
  actualBytes: number | null;
  reason: string;
}

/**
 * Does the set of archived PDFs match the documents table in the snapshot? The
 * database half and the PDF half are captured by different mechanisms, so the
 * manifest states outright whether they agree.
 */
export interface ArchiveCrossCheck {
  checked: boolean;
  /** Archived copies the database points at that are not in this archive. */
  missing: string[];
  /** Files in the archive folder no document row points at. */
  unreferenced: string[];
  note: string;
}

export interface BackupSummary {
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  promptVersion: string;
  counts: { contracts: number; documents: number; archivedPdfs: number; thumbnails: number };
  /** Uncompressed bytes the build expected to include. */
  contentBytes: number;
  /** Uncompressed bytes it actually captured. Lower than contentBytes if anything moved. */
  capturedBytes: number;
}

/**
 * A backup that has been planned but not yet built. Nothing has been read except
 * the database snapshot; the archive is produced while `stream` is consumed.
 */
export interface BackupStream {
  filename: string;
  /**
   * Uncompressed bytes this build expects to emit. The Data tab divides by it to
   * draw a progress bar; it is an estimate because the database deflates and
   * anything that moves mid-build is dropped.
   */
  contentBytes: number;
  stream: ReadableStream<Uint8Array>;
}

export interface RestoreGuide {
  /** The folder the files go back into. */
  dataDir: string;
  steps: readonly string[];
  /** Why the key is missing, in her words, so its absence never reads as a bug. */
  apiKeyNote: string;
}

export interface DataOverview {
  dataDir: string;
  databasePath: string;
  archivePath: string;
  counts: { contracts: number; documents: number; archivedPdfs: number };
  bytes: {
    database: number;
    archive: number;
    thumbnails: number;
    /** Everything under the data dir, including logs and past exports. */
    total: number;
    /** What a backup would carry, uncompressed. */
    backup: number;
  };
  lastBackupAt: string | null;
  /** True when the archive would exceed what one zip can safely hold. */
  tooLarge: boolean;
  restore: RestoreGuide;
}

/* ──────────────────────────── lastBackupAt ──────────────────────────────── */

/*
 * It lives in the settings KV table but NOT on AppSettings: db/types.ts is a
 * fixed contract and this pass does not get to widen it. getSetting() is the
 * sanctioned raw read; the write is the same upsert updateSettings() performs,
 * done here because queries.ts exposes no raw setter.
 */
const LAST_BACKUP_KEY = 'lastBackupAt';

export function lastBackupAt(): string | null {
  const raw = getSetting(LAST_BACKUP_KEY);
  return raw === null || raw === '' ? null : raw;
}

function recordBackup(at: string): void {
  try {
    db()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(LAST_BACKUP_KEY, at, at);
  } catch (e) {
    throw sqliteError(e);
  }
}

/* ───────────────────────────── Restore steps ────────────────────────────── */

/**
 * The exact keystrokes, not a description of them. Whoever reads this is doing it
 * on the worst day, on a Mac that may not be the one the tracker ran on.
 */
export function describeRestore(): RestoreGuide {
  const dir = dataDir();
  return {
    dataDir: dir,
    steps: [
      'Quit the tracker. Nothing may be running while these files are replaced.',
      `Unzip the backup. You get ${DB_ENTRY}, an ${ARCHIVE_ENTRY} folder, a ${THUMB_ENTRY} folder, and ${MANIFEST_ENTRY}, ${SETTINGS_ENTRY} and this file.`,
      `In Finder press Command-Shift-G, paste ${dir} and press Return. If that folder does not exist yet, open the tracker once to create it, then quit again.`,
      `Drag anything already in that folder to the Desktop, then copy ${DB_ENTRY}, ${ARCHIVE_ENTRY} and ${THUMB_ENTRY} in from the unzipped backup.`,
      'Open the tracker. Every approved contract and every PDF is back.',
      'Settings, Engine: enter the Anthropic API key again if the tracker uses one.',
    ],
    apiKeyNote:
      "The API key is deliberately not in the backup. It stays in this Mac's keychain, so a backup file that ends up on a drive or in an email cannot be used to spend money.",
  };
}

/* ─────────────────────────────── Overview ───────────────────────────────── */

interface DiskFile {
  path: string;
  name: string;
  bytes: number;
  modified: Date;
}

/**
 * One directory, files only. Missing is not a failure -- it means nothing is in
 * it yet.
 *
 * Dot-prefixed names are skipped, and that is load bearing rather than cosmetic:
 * the upload route writes each archived PDF to a dot-prefixed temp name in this
 * same folder and renames it into place, so the only files this can see under
 * their real names are complete ones.
 */
async function listFiles(dir: string): Promise<DiskFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (errno(e) === 'ENOENT') return [];
    throw fsError(e, dir);
  }

  const out: DiskFile[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // .DS_Store, and half-written uploads
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      out.push({ path, name, bytes: st.size, modified: st.mtime });
    } catch (e) {
      // A file that vanished between readdir and stat is not worth failing over.
      if (errno(e) === 'ENOENT') continue;
      throw fsError(e, path);
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Recursive byte total. Used only for "size on disk", so a missing dir is 0. */
async function dirBytes(dir: string): Promise<number> {
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (errno(e) === 'ENOENT') return 0;
    throw fsError(e, dir);
  }

  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(path);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await stat(path)).size;
    } catch (e) {
      if (errno(e) !== 'ENOENT') throw fsError(e, path);
    }
  }
  return total;
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (e) {
    if (errno(e) === 'ENOENT') return 0;
    throw fsError(e, path);
  }
}

function totalBytes(files: readonly DiskFile[]): number {
  return files.reduce((sum, f) => sum + f.bytes, 0);
}

/**
 * Everything the Data tab shows without building anything. Cheap enough to call
 * on every visit: a handful of stats and one recursive walk of a folder that
 * holds PDFs, not a filesystem.
 */
export async function dataOverview(): Promise<DataOverview> {
  const [archive, thumbs] = await Promise.all([listFiles(archiveDir()), listFiles(thumbDir())]);
  // The -wal file counts. In WAL mode a freshly written database can be 4 KB on
  // disk with half a megabyte of committed data still in the log, so measuring
  // tracker.db alone reports a backup an order of magnitude smaller than the one
  // VACUUM INTO will actually produce.
  const [main, wal, total] = await Promise.all([
    fileBytes(dbPath()),
    fileBytes(`${dbPath()}-wal`),
    dirBytes(dataDir()),
  ]);
  const database = main + wal;

  const archiveBytes = totalBytes(archive);
  const thumbBytes = totalBytes(thumbs);
  const backup = database + archiveBytes + thumbBytes;

  return {
    dataDir: dataDir(),
    databasePath: dbPath(),
    archivePath: archiveDir(),
    counts: {
      contracts: getStats().contracts,
      documents: tableCounts().find((t) => t.table === 'documents')?.rows ?? 0,
      archivedPdfs: archive.length,
    },
    bytes: { database, archive: archiveBytes, thumbnails: thumbBytes, total, backup },
    lastBackupAt: lastBackupAt(),
    tooLarge: backup > MAX_BACKUP_BYTES,
    restore: describeRestore(),
  };
}

/* ─────────────────────────── The database snapshot ──────────────────────── */

interface Snapshot {
  /** The uncompressed VACUUM INTO output. */
  path: string;
  bytes: number;
  crc: number;
  /** The deflated copy, or null when deflating did not pay. */
  deflatedPath: string | null;
  deflatedBytes: number;
}

/**
 * A clean, fully checkpointed copy of the database, already deflated onto disk.
 *
 * Deflating here rather than while streaming is what keeps a 200 MB database off
 * the heap: a zip entry's compressed size has to be in its local header, and the
 * only ways to know it are to buffer the compressed output or to write it
 * somewhere first. We have a private temp directory either way, so it goes
 * there, and the entry is then copied out chunk by chunk.
 */
async function snapshotDatabase(into: string): Promise<Snapshot> {
  const path = join(into, DB_ENTRY);
  try {
    // Synchronous, and the one place a build still blocks the loop: node:sqlite
    // has no async API, and a plain byte copy of a WAL database is silently
    // short of its last commits. Everything after this point yields.
    db().prepare('VACUUM INTO ?').run(path);
  } catch (e) {
    throw sqliteError(e);
  }

  const deflatedPath = `${path}.deflated`;
  let crc = 0;
  let bytes = 0;
  // A pass-through that measures what goes in, so the crc and the uncompressed
  // size come from the same read as the compression rather than a second one.
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      crc = crc32(chunk, crc);
      bytes += chunk.byteLength;
      done(null, chunk);
    },
  });

  try {
    // createDeflateRaw compresses on the libuv threadpool. deflateRawSync did it
    // on the loop, which is what stalled every other route for the duration.
    await pipeline(
      createReadStream(path),
      measure,
      createDeflateRaw(),
      createWriteStream(deflatedPath),
    );
  } catch (e) {
    throw fsError(e, deflatedPath);
  }

  const deflatedBytes = await fileBytes(deflatedPath);
  const worthIt = deflatedBytes > 0 && deflatedBytes < bytes;
  return {
    path,
    bytes,
    crc: crc >>> 0,
    deflatedPath: worthIt ? deflatedPath : null,
    deflatedBytes,
  };
}

/**
 * Which archived PDFs the snapshot's documents table points at, by filename.
 *
 * Read from the snapshot rather than the live database on purpose: the manifest
 * describes this archive, and the live table can have moved on since VACUUM INTO
 * took its read transaction. Compared by basename because a restored data dir
 * leaves the stored absolute paths pointing at the old Mac.
 */
function referencedArchiveNames(snapshotPath: string): Set<string> | null {
  let conn: DatabaseSync;
  try {
    conn = new DatabaseSync(snapshotPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = conn
      .prepare(
        `SELECT archive_path FROM documents WHERE archive_path IS NOT NULL AND archive_path <> ''`,
      )
      .all();
    const names = new Set<string>();
    for (const row of rows) {
      const value: unknown = Reflect.get(row, 'archive_path');
      if (typeof value === 'string' && value !== '') names.add(basename(value));
    }
    return names;
  } catch {
    // The cross-check is a statement about the archive, not a reason to lose it.
    return null;
  } finally {
    try {
      conn.close();
    } catch {
      /* already closed; nothing here is worth failing a backup over */
    }
  }
}

function crossCheck(snapshotPath: string, capturedNames: ReadonlySet<string>): ArchiveCrossCheck {
  const referenced = referencedArchiveNames(snapshotPath);
  if (referenced === null) {
    return {
      checked: false,
      missing: [],
      unreferenced: [],
      note: 'The documents table in this snapshot could not be read, so the PDFs were not cross-checked against it.',
    };
  }
  const missing = [...referenced].filter((name) => !capturedNames.has(name)).sort();
  const unreferenced = [...capturedNames].filter((name) => !referenced.has(name)).sort();
  return {
    checked: true,
    missing,
    unreferenced,
    note:
      missing.length === 0
        ? 'Every archived PDF the database points at is in this backup.'
        : 'The database points at archived PDFs that are not in this backup. They are listed under "missing".',
  };
}

/* ────────────────────────────── Small pieces ────────────────────────────── */

async function appVersion(): Promise<string> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const version: unknown = Reflect.get(parsed, 'version');
      if (typeof version === 'string') return version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The settings as plain JSON, for a human opening the zip. The app's own copy is
 * inside tracker.db; this is a readable duplicate, and it is built from the
 * default key state so it cannot even imply that a key exists.
 */
function settingsJson(): string {
  const { hasApiKey: _has, apiKeySource: _source, ...rest } = getSettings();
  return `${JSON.stringify(
    {
      note: 'For reading. The tracker loads its settings from tracker.db, not from this file. The API key is not here by design.',
      settings: rest,
    },
    null,
    2,
  )}\n`;
}

/** "1 contract", "4 contracts". This file is read by a person on a bad day. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Readable and unambiguous. UTC because a backup can be opened anywhere. */
function readableTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(ms))} UTC`;
}

function restoreText(
  guide: RestoreGuide,
  summary: BackupSummary,
  skipped: readonly SkippedFile[],
): string {
  const lines = [
    'IBC Contract Tracker - how to restore this backup',
    '='.repeat(52),
    '',
    `Taken ${readableTime(summary.createdAt)}`,
    [
      plural(summary.counts.contracts, 'contract'),
      plural(summary.counts.documents, 'document'),
      `${plural(summary.counts.archivedPdfs, 'archived PDF')}.`,
    ].join(', '),
    '',
  ];

  if (skipped.length > 0) {
    lines.push(
      `${plural(skipped.length, 'file')} could not be copied and ${skipped.length === 1 ? 'is' : 'are'} NOT in this backup:`,
      ...skipped.map((s) => `  - ${s.name}: ${s.reason}`),
      'manifest.json lists them again with sizes. Everything else below is intact.',
      '',
    );
  }

  lines.push(
    ...guide.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    guide.apiKeyNote,
    '',
    `Everything goes back into: ${guide.dataDir}`,
    '',
  );
  return lines.join('\n');
}

function filenameFor(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `IBC-Contracts-Backup-${y}-${m}-${d}.zip`;
}

function manifestJson(
  summary: BackupSummary,
  skipped: readonly SkippedFile[],
  archiveCrossCheck: ArchiveCrossCheck,
): string {
  return `${JSON.stringify(
    {
      app: 'IBC Contract Tracker',
      backupFormat: BACKUP_FORMAT,
      createdAt: summary.createdAt,
      appVersion: summary.appVersion,
      schemaVersion: summary.schemaVersion,
      promptVersion: summary.promptVersion,
      counts: summary.counts,
      bytes: { expected: summary.contentBytes, captured: summary.capturedBytes },
      // Written after the last entry was on the wire, so these are facts about
      // this file rather than intentions recorded before it was built.
      integrity: {
        note: 'What this archive actually holds. Every entry was size-checked as it was copied.',
        complete: skipped.length === 0 && archiveCrossCheck.missing.length === 0,
        skipped,
        archiveCrossCheck,
      },
      dataDir: dataDir(),
      contains: {
        [DB_ENTRY]: 'The SQLite database: contracts, documents, evidence, audit trail, settings.',
        [`${ARCHIVE_ENTRY}/`]: "The tracker's own copy of every PDF it has read.",
        [`${THUMB_ENTRY}/`]: 'First-page thumbnails. Not regenerated automatically, so they travel.',
        [SETTINGS_ENTRY]: 'The settings, as readable JSON. The app reads its own from tracker.db.',
        [RESTORE_ENTRY]: 'How to put this back.',
      },
      excludes: {
        apiKey: 'Never included. It lives in the macOS keychain.',
        logs: 'Not data of record. Use the support bundle in Settings, Diagnostics.',
        exports: 'Regenerated from the database at any time.',
      },
    },
    null,
    2,
  )}\n`;
}

/* ──────────────────────────────── The zip ───────────────────────────────── */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 3 = unix in the high byte, 3.0 in the low. Makes the unix mode below meaningful. */
const VERSION_MADE_BY = 0x031e;
const VERSION_NEEDED = 20;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Bit 11: the name is UTF-8. Set only when it has to be, for older readers. */
const UTF8_FLAG = 0x0800;
const UNIX_FILE_MODE = 0o100644 << 16;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
/** The EOCD counts entries in 16 bits. */
const MAX_ENTRIES = 0xffff;
const MAX_UINT32 = 0xffffffff;
/** Below this, deflate costs more in header than it ever saves. */
const DEFLATE_FLOOR = 64;
/** How much of a file is in memory at once. */
const CHUNK_BYTES = 256 * 1024;

const encoder = new TextEncoder();
const deflateRawAsync = promisify(deflateRaw);

function encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Zip paths are forward-slashed and never absolute or relative-escaping. */
function zipSafeName(name: string): string {
  return basename(name).replace(/\\/g, '_');
}

/** MS-DOS date and time. Two-second resolution, and nothing before 1980 exists. */
function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time:
      ((d.getHours() & 0x1f) << 11) |
      ((d.getMinutes() & 0x3f) << 5) |
      ((d.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

interface EntryHeader {
  name: string;
  modified: Date;
  method: number;
  crc: number;
  compressedBytes: number;
  uncompressedBytes: number;
}

/**
 * A STORE/DEFLATE zip written in one pass. No zip64, no encryption, no data
 * descriptors: every size is known before its entry's local header is emitted,
 * which is what lets the payload go straight out without being held.
 *
 * The only thing retained across the whole build is the central directory --
 * 46 bytes plus a name per entry, capped at 65535 entries by the format itself.
 */
class ZipDirectory {
  private readonly central: Uint8Array[] = [];
  private offset = 0;
  count = 0;

  /**
   * The local header for one entry. The caller must emit exactly
   * `compressedBytes` immediately after it, and every caller counts what it
   * emits and throws if the count disagrees -- once this header is on the wire
   * the offsets in the central directory are committed.
   */
  header(e: EntryHeader): Uint8Array {
    if (this.count >= MAX_ENTRIES) {
      throw new EngineError('UNKNOWN', { detail: `backup exceeds ${MAX_ENTRIES} files` });
    }

    const name = encode(e.name);
    const flags = isAscii(e.name) ? 0 : UTF8_FLAG;
    const { time, date } = dosStamp(e.modified);

    const local = new Uint8Array(LOCAL_HEADER_BYTES + name.byteLength);
    const lv = view(local);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.compressedBytes, true);
    lv.setUint32(22, e.uncompressedBytes, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true);
    local.set(name, LOCAL_HEADER_BYTES);

    const central = new Uint8Array(CENTRAL_HEADER_BYTES + name.byteLength);
    const cv = view(central);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, VERSION_MADE_BY, true);
    cv.setUint16(6, VERSION_NEEDED, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.compressedBytes, true);
    cv.setUint32(24, e.uncompressedBytes, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, UNIX_FILE_MODE, true);
    cv.setUint32(42, this.offset, true);
    central.set(name, CENTRAL_HEADER_BYTES);

    this.central.push(central);
    this.offset += local.byteLength + e.compressedBytes;
    this.count += 1;

    if (this.offset > MAX_UINT32) {
      throw new EngineError('UNKNOWN', { detail: 'backup exceeded the 4 GB zip offset limit' });
    }
    return local;
  }

  /** The central directory and the end-of-central-directory record. */
  finish(): Uint8Array {
    const directoryBytes = this.central.reduce((sum, c) => sum + c.byteLength, 0);
    const out = new Uint8Array(directoryBytes + EOCD_BYTES);
    let at = 0;
    for (const chunk of this.central) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }

    const ev = new DataView(out.buffer, out.byteOffset + at, EOCD_BYTES);
    ev.setUint32(0, EOCD_SIG, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, directoryBytes, true);
    ev.setUint32(16, this.offset, true);
    ev.setUint16(20, 0, true);
    return out;
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function errno(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const code: unknown = Reflect.get(e, 'code');
  return typeof code === 'string' ? code : null;
}

/* ─────────────────────────── Producing the entries ──────────────────────── */

/** Give the event loop a turn. The health poll and the queue's timers live here too. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The whole file, from the start, in chunks. The read buffer is reused, so each
 * chunk is copied out before it is yielded -- a yielded chunk may still be
 * queued in the response when the next read lands.
 */
async function* readChunks(handle: FileHandle): AsyncGenerator<Uint8Array, void, undefined> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield new Uint8Array(buffer.subarray(0, bytesRead));
  }
}

/** A small entry we already hold: the manifest, the restore note, the settings. */
async function* memoryEntry(
  dir: ZipDirectory,
  name: string,
  bytes: Uint8Array,
  modified: Date,
): AsyncGenerator<Uint8Array, void, undefined> {
  let method = METHOD_STORE;
  let payload = bytes;
  if (bytes.byteLength >= DEFLATE_FLOOR) {
    // Async: this is small, but deflateRawSync anywhere on this path is the
    // habit that produced the stall.
    const packed = new Uint8Array(await deflateRawAsync(bytes));
    if (packed.byteLength < bytes.byteLength) {
      method = METHOD_DEFLATE;
      payload = packed;
    }
  }
  yield dir.header({
    name,
    modified,
    method,
    crc: crc32(bytes) >>> 0,
    compressedBytes: payload.byteLength,
    uncompressedBytes: bytes.byteLength,
  });
  yield payload;
}

/** The database, streamed out of the temp copy snapshotDatabase already made. */
async function* snapshotEntry(
  dir: ZipDirectory,
  snapshot: Snapshot,
  modified: Date,
): AsyncGenerator<Uint8Array, void, undefined> {
  const deflated = snapshot.deflatedPath;
  const path = deflated ?? snapshot.path;
  const compressedBytes = deflated === null ? snapshot.bytes : snapshot.deflatedBytes;

  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (e) {
    throw fsError(e, path);
  }
  try {
    yield dir.header({
      name: DB_ENTRY,
      modified,
      method: deflated === null ? METHOD_STORE : METHOD_DEFLATE,
      crc: snapshot.crc,
      compressedBytes,
      uncompressedBytes: snapshot.bytes,
    });
    let emitted = 0;
    for await (const chunk of readChunks(handle)) {
      emitted += chunk.byteLength;
      yield chunk;
    }
    if (emitted !== compressedBytes) {
      throw new EngineError('UNKNOWN', {
        detail: `snapshot emitted ${emitted} of ${compressedBytes} bytes`,
      });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * One archived PDF or thumbnail, STORE, straight from disk.
 *
 * Both are already compressed formats, so deflate would burn CPU to grow the
 * file. STORE also means the bytes never have to be held: the entry is read
 * twice through ONE file handle -- once to compute the crc and the true length,
 * once to emit -- and a handle keeps pointing at the same inode even if the file
 * is replaced under its name, so the two passes cannot disagree.
 *
 * Anything that does not match the listing it came from is skipped and named,
 * never zipped as if it were whole.
 */
async function* storedFileEntry(
  dir: ZipDirectory,
  name: string,
  file: DiskFile,
  skipped: SkippedFile[],
): AsyncGenerator<Uint8Array, void, undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file.path, 'r');
  } catch (e) {
    if (errno(e) === 'ENOENT') {
      skipped.push({
        name,
        expectedBytes: file.bytes,
        actualBytes: null,
        reason: 'It was removed while the backup was being built.',
      });
      return;
    }
    throw fsError(e, file.path);
  }

  const changed = (actualBytes: number): void => {
    skipped.push({
      name,
      expectedBytes: file.bytes,
      actualBytes,
      reason:
        'It changed size while the backup was being built, so only part of it would have been copied.',
    });
  };

  try {
    // fstat on the handle, not the path: this is the size of the bytes we are
    // about to read, whatever has since been renamed over the name.
    const live = await handle.stat();
    if (!live.isFile() || live.size !== file.bytes) {
      changed(live.isFile() ? live.size : 0);
      return;
    }

    let crc = 0;
    let counted = 0;
    for await (const chunk of readChunks(handle)) {
      crc = crc32(chunk, crc);
      counted += chunk.byteLength;
    }
    if (counted !== file.bytes) {
      changed(counted);
      return;
    }

    yield dir.header({
      name,
      modified: file.modified,
      method: METHOD_STORE,
      crc: crc >>> 0,
      compressedBytes: counted,
      uncompressedBytes: counted,
    });

    let emitted = 0;
    for await (const chunk of readChunks(handle)) {
      emitted += chunk.byteLength;
      // The header is already on the wire and declares `counted` bytes. If that
      // is no longer the length, the archive cannot be made valid, so fail the
      // whole build rather than ship a zip that will not open.
      if (emitted > counted) {
        throw new EngineError('UNKNOWN', { detail: `${name} grew while it was being copied` });
      }
      yield chunk;
    }
    if (emitted !== counted) {
      throw new EngineError('UNKNOWN', { detail: `${name} shrank while it was being copied` });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/* ─────────────────────────────── The build ──────────────────────────────── */

interface BuildContext {
  now: Date;
  createdAt: string;
  temp: string;
  snapshot: Snapshot;
  archive: DiskFile[];
  thumbs: DiskFile[];
  contentBytes: number;
  appVersion: string;
  contracts: number;
  documents: number;
  /** The request behind this build. Null when nothing can abandon it. */
  signal: AbortSignal | null;
}

/**
 * Has the browser gone?
 *
 * Throwing rather than returning, for two reasons. The generator's `finally` runs
 * either way -- so the temp snapshot goes and `recordBackup` is never reached --
 * but a clean `return` would close the stream tidily, and a tidy close of a
 * half-written zip is a file the browser is entitled to save. Erroring the stream
 * is what makes it discard the partial download instead.
 */
function abortIfGone(signal: AbortSignal | null): void {
  if (signal?.aborted !== true) return;
  throw new EngineError('UNKNOWN', { detail: 'the backup download was abandoned' });
}

async function* buildArchive(ctx: BuildContext): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    const dir = new ZipDirectory();
    const skipped: SkippedFile[] = [];
    const capturedNames = new Set<string>();
    let capturedThumbs = 0;
    let capturedBytes = ctx.snapshot.bytes;

    yield* snapshotEntry(dir, ctx.snapshot, ctx.now);
    await yieldToLoop();

    for (const file of ctx.archive) {
      // Between entries, on the request's own signal. `cancel()` on the stream is
      // still wired up below, but it is not the only path any more: a download
      // that was truncated at 30 KB of a 650 KB archive still ran to completion
      // here and still stamped lastBackupAt, so the app claimed a backup that
      // existed on disk nowhere. One abort signal that never fires is one silent
      // false claim, and this is the file she would restore from.
      abortIfGone(ctx.signal);
      const before = dir.count;
      yield* storedFileEntry(dir, `${ARCHIVE_ENTRY}/${zipSafeName(file.name)}`, file, skipped);
      if (dir.count > before) {
        capturedNames.add(file.name);
        capturedBytes += file.bytes;
      }
      await yieldToLoop();
    }

    for (const file of ctx.thumbs) {
      abortIfGone(ctx.signal);
      const before = dir.count;
      yield* storedFileEntry(dir, `${THUMB_ENTRY}/${zipSafeName(file.name)}`, file, skipped);
      if (dir.count > before) {
        capturedThumbs += 1;
        capturedBytes += file.bytes;
      }
      await yieldToLoop();
    }

    abortIfGone(ctx.signal);

    // Written last on purpose: a manifest emitted first could only describe what
    // the build intended to copy, which is exactly the claim that turned out to
    // be untrue. Zip readers use the central directory, so entry order is free.
    const summary: BackupSummary = {
      createdAt: ctx.createdAt,
      appVersion: ctx.appVersion,
      schemaVersion: SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      counts: {
        contracts: ctx.contracts,
        documents: ctx.documents,
        archivedPdfs: capturedNames.size,
        thumbnails: capturedThumbs,
      },
      contentBytes: ctx.contentBytes,
      capturedBytes,
    };

    const checked = crossCheck(ctx.snapshot.path, capturedNames);
    yield* memoryEntry(dir, MANIFEST_ENTRY, encode(manifestJson(summary, skipped, checked)), ctx.now);
    yield* memoryEntry(
      dir,
      RESTORE_ENTRY,
      encode(restoreText(describeRestore(), summary, skipped)),
      ctx.now,
    );
    yield* memoryEntry(dir, SETTINGS_ENTRY, encode(settingsJson()), ctx.now);

    yield dir.finish();

    // Only now, and only if the request that asked for it is still there. Every
    // byte before this line could still have been lost to a dropped connection or
    // a browser that gave up, and a lastBackupAt written before that is the app
    // telling her a backup exists when none does.
    abortIfGone(ctx.signal);
    recordBackup(ctx.createdAt);
    log.info('backup.created', {
      entries: dir.count,
      contentBytes: ctx.contentBytes,
      capturedBytes,
      skipped: skipped.length,
    });
  } finally {
    // Runs on success, on failure, and when the browser cancels the download.
    // A leftover snapshot is a second copy of the whole database.
    await rm(ctx.temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function streamFrom(gen: AsyncGenerator<Uint8Array, void, undefined>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    // Demand-driven, so a slow client never makes the archive pile up in memory,
    // and awaiting each step hands the loop back between chunks.
    async pull(controller) {
      let next: IteratorResult<Uint8Array, void>;
      try {
        next = await gen.next();
      } catch (e) {
        // The response headers went out long ago, so this cannot become a JSON
        // error. Erroring the stream aborts the transfer, which is what makes
        // the browser discard the partial file instead of saving a broken zip.
        controller.error(toEngineError(e));
        return;
      }
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      // The SECOND path, not the only one. It runs the generator's finally --
      // the temp snapshot goes and recordBackup is never reached -- but it only
      // fires when the runtime bothers to cancel the stream, and the measured
      // failure was a truncated download where it did not. The request's own
      // abort signal, checked between entries, is the first path.
      await gen.return(undefined).catch(() => undefined);
    },
  });
}

/**
 * Plan a backup and hand back the stream that produces it.
 *
 * The database snapshot is taken here, before the response starts, so a locked
 * or damaged database still becomes a proper JSON error with a remedy rather
 * than a truncated download. Everything else happens as the stream is read.
 *
 * `signal` is the request's own. Pass it: it is the difference between "the
 * download finished" and "the generator was allowed to run to the end", and only
 * the first of those may stamp lastBackupAt.
 */
export async function createBackup(signal?: AbortSignal): Promise<BackupStream> {
  const now = new Date();
  const createdAt = now.toISOString();
  const abortSignal = signal ?? null;
  // Before VACUUM INTO writes a second copy of the whole database for a request
  // that has already gone.
  abortIfGone(abortSignal);

  let temp: string;
  try {
    temp = await mkdtemp(join(tmpdir(), 'ibc-backup-'));
  } catch (e) {
    throw fsError(e, tmpdir());
  }

  let ctx: BuildContext;
  try {
    const snapshot = await snapshotDatabase(temp);
    const [archive, thumbs] = await Promise.all([listFiles(archiveDir()), listFiles(thumbDir())]);
    const contentBytes = snapshot.bytes + totalBytes(archive) + totalBytes(thumbs);

    // Checked before a single PDF is read. The route catches this first and says
    // it in plain English; this is the guard that cannot be bypassed.
    if (contentBytes > MAX_BACKUP_BYTES) {
      throw new EngineError('UNKNOWN', {
        detail: `backup content ${contentBytes} bytes exceeds the ${MAX_BACKUP_BYTES} byte limit`,
      });
    }

    ctx = {
      now,
      createdAt,
      temp,
      snapshot,
      archive,
      thumbs,
      contentBytes,
      appVersion: await appVersion(),
      contracts: getStats().contracts,
      documents: tableCounts().find((t) => t.table === 'documents')?.rows ?? 0,
      signal: abortSignal,
    };
  } catch (e) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw toEngineError(e);
  }

  return {
    filename: filenameFor(now),
    contentBytes: ctx.contentBytes,
    stream: streamFrom(buildArchive(ctx)),
  };
}
