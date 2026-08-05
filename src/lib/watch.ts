/**
 * The watched folder. Server-only (node:fs).
 *
 * `settings.watchFolder` was stored, zod-validated, readability-checked,
 * health-checked, named in the Inbox and given its own step in the onboarding
 * wizard -- and nothing read it. This is the thing that reads it.
 *
 * ── Why polling, and not fs.watch ──────────────────────────────────────────
 * Her folder is a Google Drive folder. Drive (and Dropbox, and Box) do not write
 * a file the way a text editor does: they stream it in chunks under a temp name
 * and rename it over the top, sometimes more than once as a document settles.
 * macOS reports that as a burst of FSEvents that coalesce unpredictably, and on a
 * network volume may not report it at all. Acting on an event therefore means
 * reading a half-synced PDF -- the single worst thing this file could do, because
 * a truncated PDF either fails extraction (noise) or extracts cleanly from the
 * pages that did arrive (a wrong answer that looks right).
 *
 * So the signal is the directory listing, not the event. A file is ingested only
 * when its size AND mtime are identical on STABLE_SCANS consecutive observations
 * AND that unchanged run has lasted at least settleMs(), a window derived from the
 * poll interval rather than guessed. fs.watch is still attached, purely to bring
 * the next observation forward: it can make the watcher faster, never louder.
 * That is why an elapsed test exists at all -- without one, two
 * fs.watch-driven scans milliseconds apart could call a file that is still being
 * written "stable".
 *
 * ── Why three observations, and not two ────────────────────────────────────
 * Two observations "at least 2s apart" was no test at all: consecutive polls are
 * POLL_MS = 3s apart, so the scheduler satisfied the gap for free and the only
 * real requirement left was that the file happened not to change during one 3s
 * window. Any writer whose chunks land further apart than the poll interval --
 * the ordinary cadence of a Drive sync -- looks stable between EVERY pair of
 * chunks. Measured: one PDF written in ten chunks 4s apart produced nine
 * documents, four of them extracted cleanly from a truncated file that was
 * missing its signature page.
 *
 * So the run has to be longer than one poll gap in both dimensions: at least
 * STABLE_SCANS identical observations, and at least settleMs() of wall clock,
 * where that window covers the whole run at the current cadence and can never be
 * shorter than STABLE_MS. A file that is genuinely finished pays that once; a
 * file that is still arriving cannot fake it, because any chunk landing inside
 * the window resets the run to one.
 *
 * ── Why there is no "already imported" list on disk ────────────────────────
 * The content hash is already the identity of a document, and getDocumentByHash
 * already decides duplicates for the drag-and-drop path. A restart therefore
 * re-reads the folder, re-hashes it, and finds that every file is a duplicate.
 * The two maps below are a cache that saves the re-read within one process; they
 * are never consulted for correctness. Inventing a second source of truth for
 * "have I seen this" is how the two answers start to disagree.
 *
 * ── What this never does ───────────────────────────────────────────────────
 * Move, rename, delete or write anything inside her folder. It is her Drive. The
 * only syscalls aimed at it are readdir, stat and read.
 */

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getDocumentAudit, getSettings } from '@/lib/db/queries';
import type { DocumentDetail } from '@/lib/db/types';
import { extractionQueue } from '@/lib/extraction/queue';
import { MAX_INGEST_BYTES, ingestPdf, isPdfName } from '@/lib/ingest';
import { log } from '@/lib/logger';
import { checkFolder, fsError } from '@/lib/paths';
import { EngineError, toEngineError, type SerialisedEngineError } from '@/lib/providers/errors';

/** How often the folder is listed when the engine is healthy. */
const POLL_MS = 3_000;

/**
 * How often it is listed while the extraction queue is halted (usage limit, no
 * network, bad key). Nothing is lost by slowing down -- a document ingested
 * during a halt would only sit in the queue as `queued` anyway -- and a watcher
 * that keeps listing a folder every three seconds against a dead engine is the
 * spin this is here to avoid. The queue clearing the halt restores POLL_MS on the
 * very next pass.
 */
const HALTED_POLL_MS = 30_000;

/**
 * How many consecutive observations of the identical size and mtime a file must
 * survive before a single byte of it is read. Three is the smallest number that
 * cannot be satisfied by a writer pausing across one poll boundary.
 */
export const STABLE_SCANS = 3;

/**
 * Floor on the age of that unchanged run. Deliberately far longer than POLL_MS:
 * this is the number that has to outlast the pause between two chunks of a Drive
 * sync, not the number that has to outlast the scheduler.
 */
const STABLE_MS = 15_000;

/** Rejections kept for the Settings screen. Oldest fall off. */
const MAX_SKIPS = 20;

/** Microsoft Office scratch files: "~$Mutual NDA.pdf". */
const OFFICE_TEMP = /^~\$/;

/**
 * Everything the watcher refuses to even open.
 *
 * The dotfile rule is doing most of the work and is deliberately broad: it covers
 * `.DS_Store`, AppleDouble `._name` sidecars, and the partial-download artifacts
 * Google Drive and Dropbox leave behind (`.com.google.Chrome.*`, entries under
 * `.tmp.drivedownload`), all of which are dot-prefixed by design so that Finder
 * hides them. Anything not ending in `.pdf` is out regardless, which sweeps up
 * `.crdownload`, `.part` and `.download` without needing to name them.
 */
export function shouldIgnore(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (OFFICE_TEMP.test(name)) return true;
  return !isPdfName(name);
}

/**
 * Rejecting a document is a decision, and a restart must not undo it.
 *
 * The drag-and-drop path reopens a rejected record unconditionally, because a
 * human dragging the file in again IS the request to reconsider it. A folder scan
 * carries no such intent: after a restart the watcher re-reads the entire folder,
 * and under the drop rule every document she had set aside whose file still sits
 * there would come straight back, forever.
 *
 * So the watcher reopens only when the file itself is newer than the rejection --
 * that is, it was re-saved or replaced after she set it aside. A file that has not
 * changed since stays rejected however many times the folder is scanned. Note that
 * a Finder copy preserves the modification date, so re-copying the identical file
 * will not reopen it; the Reopen button on the Rejected tab remains the explicit
 * way back, and it is unaffected by any of this.
 */
export function reopenable(doc: DocumentDetail, mtimeMs: number): boolean {
  // getDocumentAudit returns newest first, so this is the most recent rejection.
  const entry = getDocumentAudit(doc.id).find((e) => e.action === 'rejected');
  if (!entry) return false; // no record of the decision: do not second-guess it
  const rejectedAt = Date.parse(entry.at);
  return Number.isFinite(rejectedAt) && mtimeMs > rejectedAt;
}

/** One file rejected before it became a document, and why. */
export interface WatchSkip {
  filename: string;
  error: SerialisedEngineError;
  at: string;
}

export interface WatchStatus {
  /** True only when a folder is configured, reachable, and the loop is alive. */
  running: boolean;
  /** True once start() has been called, whatever the folder situation is. */
  started: boolean;
  folder: string | null;
  scanning: boolean;
  lastScanAt: string | null;
  /** Current cadence. Rises to HALTED_POLL_MS while the queue is halted. */
  intervalMs: number;
  backedOff: boolean;
  /** Files seen but not yet unchanged for long enough to be read. */
  settling: number;
  ingested: number;
  reopened: number;
  duplicates: number;
  /** Folder-level failure: missing, unreadable, unmounted. Carries its own remedy. */
  error: SerialisedEngineError | null;
  skipped: WatchSkip[];
}

interface Observation {
  size: number;
  mtimeMs: number;
  /**
   * Epoch ms this size/mtime pair was FIRST seen. Never refreshed while the pair
   * holds -- it is the start of the unchanged run, so the elapsed test measures
   * how long the file has been still, not how recently it was looked at.
   */
  at: number;
  /** How many consecutive observations have carried exactly this size and mtime. */
  seen: number;
}

export interface WatcherOptions {
  /** Where the folder comes from. Overridden by tests; production reads settings. */
  folder?: () => string | null;
  pollMs?: number;
  haltedPollMs?: number;
  /** Floor on the settle window. The window used is max(stableMs, pollMs * (STABLE_SCANS - 1)). */
  stableMs?: number;
  /** The fs.watch accelerant. Off in tests, where scans are driven by hand. */
  useFsWatch?: boolean;
  now?: () => number;
}

function configuredFolder(): string | null {
  const raw = getSettings().watchFolder;
  return raw !== null && raw.trim().length > 0 ? raw.trim() : null;
}

export class FolderWatcher {
  private readonly folderOf: () => string | null;
  private readonly pollMs: number;
  private readonly haltedPollMs: number;
  private readonly stableMs: number;
  private readonly useFsWatch: boolean;
  private readonly now: () => number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private fsWatcher: FSWatcher | null = null;
  private folder: string | null = null;
  private started = false;
  private scanning = false;
  /** A scan arrived while one was running; run exactly one more when it finishes. */
  private queued = false;
  private lastScanAt: string | null = null;
  private backedOff = false;
  private lastError: EngineError | null = null;
  private skips: WatchSkip[] = [];
  private counts = { ingested: 0, reopened: 0, duplicates: 0 };
  /** Last observation per path. Kept after ingest so a manual rescan is immediate. */
  private observations = new Map<string, Observation>();
  /** Paths this process has already ingested, at the size/mtime it ingested them. */
  private handled = new Map<string, Observation>();

  constructor(options: WatcherOptions = {}) {
    this.folderOf = options.folder ?? configuredFolder;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.haltedPollMs = options.haltedPollMs ?? HALTED_POLL_MS;
    this.stableMs = options.stableMs ?? STABLE_MS;
    this.useFsWatch = options.useFsWatch ?? true;
    this.now = options.now ?? Date.now;
  }

  /* ────────────────────────── public surface ───────────────────────────── */

  /** Idempotent: the server may call this more than once per process. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Read the folder synchronously so the very first status() is already honest
    // rather than saying "not configured" until the first scan lands.
    this.retarget(this.readFolder());
    log.info('watch.started', { folder: this.folder });
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.detach();
  }

  /** One pass over the folder. Never throws: failures land in `error` instead. */
  async scan(): Promise<WatchStatus> {
    if (this.scanning) {
      this.queued = true;
      return this.status();
    }
    this.scanning = true;
    try {
      await this.pass();
    } catch (e) {
      this.lastError = toEngineError(e);
      log.warn('watch.scan.failed', { code: this.lastError.code, detail: this.lastError.detail });
    } finally {
      this.scanning = false;
      this.lastScanAt = new Date().toISOString();
    }
    if (this.queued) {
      this.queued = false;
      return this.scan();
    }
    return this.status();
  }

  /**
   * "Scan now". Forgets what this process has already ingested and looks again.
   *
   * Safe to press at any time: the content hash still decides whether a file
   * becomes a record, so re-reading everything produces duplicates, not doubles.
   * Its real use is after fixing a folder that was unreachable, or retrying a file
   * that was skipped for a transient reason. The stability rule is NOT bypassed --
   * a file still has to have been observed unchanged, which it will have been if it
   * has simply been sitting there.
   */
  async rescan(): Promise<WatchStatus> {
    if (!this.started) this.start();
    this.handled.clear();
    this.skips = [];
    return this.scan();
  }

  status(): WatchStatus {
    let settling = 0;
    for (const path of this.observations.keys()) if (!this.handled.has(path)) settling += 1;
    return {
      running: this.started && this.folder !== null && this.lastError === null,
      started: this.started,
      folder: this.folder,
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      intervalMs: this.interval(),
      backedOff: this.backedOff,
      settling,
      ingested: this.counts.ingested,
      reopened: this.counts.reopened,
      duplicates: this.counts.duplicates,
      error: this.lastError === null ? null : this.lastError.toJSON(),
      skipped: this.skips,
    };
  }

  /* ─────────────────────────── the poll loop ───────────────────────────── */

  private interval(): number {
    return this.backedOff ? this.haltedPollMs : this.pollMs;
  }

  /**
   * How old the unchanged run has to be before the file is read.
   *
   * The elapsed test only means anything if it outlasts what the schedule hands
   * out for free. Consecutive polls are already pollMs apart, so a window
   * narrower than the run itself (pollMs * (STABLE_SCANS - 1)) is satisfied by
   * the scheduler rather than by the file. stableMs is the floor under that.
   */
  private settleMs(): number {
    return Math.max(this.stableMs, this.pollMs * (STABLE_SCANS - 1));
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan().finally(() => this.schedule(this.interval()));
    }, delayMs);
    // Node's Timeout has unref(); the browser's number does not. A pending scan
    // must never be the only reason a process stays alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private readFolder(): string | null {
    try {
      return this.folderOf();
    } catch (e) {
      // Settings live in the database, so this is a database failure, not a
      // folder one. It is reported the same way: as the watcher's error.
      this.lastError = toEngineError(e);
      return null;
    }
  }

  /** The configured folder changed under us. Everything remembered was about the old one. */
  private retarget(folder: string | null): void {
    this.folder = folder;
    this.observations.clear();
    this.handled.clear();
    this.skips = [];
    this.lastError = null;
    this.detach();
    if (folder !== null && this.useFsWatch) this.attach(folder);
  }

  private attach(folder: string): void {
    try {
      const watcher = fsWatch(folder, { persistent: false }, () => {
        // Accelerant only. It brings the next observation forward; it can never
        // promote a file on its own, because STABLE_SCANS identical observations
        // spanning settleMs() are still required before a single byte is read.
        this.schedule(Math.min(250, this.pollMs));
      });
      // A folder that is unmounted takes its watch with it. Polling notices, and
      // reports the FOLDER_* error with its remedy; the watch is simply dropped.
      watcher.on('error', () => this.detach());
      this.fsWatcher = watcher;
    } catch {
      // Not fatal and not worth a message: polling is the real signal.
      this.fsWatcher = null;
    }
  }

  private detach(): void {
    if (this.fsWatcher === null) return;
    try {
      this.fsWatcher.close();
    } catch {
      /* already closed */
    }
    this.fsWatcher = null;
  }

  /* ───────────────────────────── one pass ──────────────────────────────── */

  private async pass(): Promise<void> {
    const folder = this.readFolder();
    if (folder !== this.folder) {
      log.info('watch.folder.changed', { folder });
      this.retarget(folder);
    }

    // One queue, and it decides the cadence. See HALTED_POLL_MS.
    const queue = extractionQueue.status();
    this.backedOff = queue.paused && queue.haltReason !== null;

    if (folder === null) {
      this.lastError = null;
      return;
    }

    // An external drive that was ejected, or a Drive account signed out, is an
    // existing FOLDER_* code with an existing remedy. Nothing new is invented.
    const problem = checkFolder(folder);
    if (problem !== null) {
      this.lastError = problem;
      return;
    }

    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (e) {
      this.lastError = fsError(e, folder);
      return;
    }
    this.lastError = null;

    const present = new Set<string>();
    for (const entry of entries) {
      // Directories are not descended into and symlinks are not followed: the
      // folder is a staging tray, not a tree, and following a link is a way to
      // read something she never put there.
      if (!entry.isFile()) continue;
      if (shouldIgnore(entry.name)) continue;
      const path = join(folder, entry.name);
      present.add(path);
      await this.consider(path, entry.name);
    }

    // Forget files that have left the folder, so neither map grows without bound.
    for (const path of [...this.observations.keys()]) {
      if (!present.has(path)) this.observations.delete(path);
    }
    for (const path of [...this.handled.keys()]) {
      if (!present.has(path)) this.handled.delete(path);
    }
  }

  private async consider(path: string, name: string): Promise<void> {
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return;
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      // Vanished between readdir and stat. Nothing to do, nothing to report.
      this.observations.delete(path);
      return;
    }

    const done = this.handled.get(path);
    if (done !== undefined && done.size === size && done.mtimeMs === mtimeMs) return;

    const now = this.now();

    // Zero bytes is what a Drive placeholder, a just-created file and a file
    // whose first chunk has not landed all look like. None of them is ready, and
    // a run of them can never mature: the size has to change for it to be a PDF.
    if (size === 0) {
      this.observations.set(path, { size, mtimeMs, at: now, seen: 1 });
      return;
    }

    const previous = this.observations.get(path);
    if (previous === undefined || previous.size !== size || previous.mtimeMs !== mtimeMs) {
      // First sighting, or it changed since the last one: the run starts over at
      // one. A chunk landing anywhere inside the window costs the file the whole
      // window, which is the point.
      this.observations.set(path, { size, mtimeMs, at: now, seen: 1 });
      return;
    }

    // Same bytes as last time: extend the run, keeping the time it started.
    const seen = previous.seen + 1;
    this.observations.set(path, { size, mtimeMs, at: previous.at, seen });
    if (seen < STABLE_SCANS) return;
    if (now - previous.at < this.settleMs()) return;

    // Stable. The observation stays in the map so a manual rescan does not have to
    // wait for the file to settle all over again.
    this.handled.set(path, { size, mtimeMs, at: now, seen });
    await this.ingest(path, name, size, mtimeMs);
  }

  private async ingest(path: string, name: string, size: number, mtimeMs: number): Promise<void> {
    // The same cap the upload route enforces, from the same constant. A rejection
    // here is surfaced rather than swallowed: it lands on the watcher status with
    // its code and its remedy, which is what Settings renders.
    if (size > MAX_INGEST_BYTES) {
      this.skip(
        name,
        new EngineError('PDF_TOO_LARGE', {
          detail: `${name}: ${size} bytes is over the ${MAX_INGEST_BYTES} byte limit`,
        }),
      );
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch (e) {
      this.skip(name, fsError(e, path));
      return;
    }

    // It changed while we were reading it, so what we hold is not what we stat'ed.
    // Drop the claim and let the next pass observe it from scratch.
    if (bytes.byteLength !== size) {
      this.handled.delete(path);
      this.observations.delete(path);
      return;
    }

    try {
      const result = await ingestPdf({
        bytes,
        filename: name,
        originPath: path,
        reopenRejected: (existing) => reopenable(existing, mtimeMs),
      });
      if (result.outcome === 'accepted') this.counts.ingested += 1;
      else if (result.outcome === 'reopened') this.counts.reopened += 1;
      else this.counts.duplicates += 1;
      log.info('watch.ingested', {
        filename: name,
        outcome: result.outcome,
        documentId: result.documentId,
      });
    } catch (e) {
      this.skip(name, toEngineError(e));
    }
  }

  private skip(filename: string, error: EngineError): void {
    this.skips = [
      { filename, error: error.toJSON(), at: new Date().toISOString() },
      ...this.skips,
    ].slice(0, MAX_SKIPS);
    log.warn('watch.skipped', { filename, code: error.code, detail: error.detail });
  }
}

/*
 * One watcher per process, stashed on globalThis for the same reason the database
 * handle is: Next replaces the module registry on hot-reload, and a second poll
 * loop over the same folder would double every count on the screen.
 */
declare global {
  var __ibcFolderWatcher: FolderWatcher | undefined;
}

export function folderWatcher(): FolderWatcher {
  const existing = globalThis.__ibcFolderWatcher;
  if (existing !== undefined) return existing;
  const created = new FolderWatcher();
  globalThis.__ibcFolderWatcher = created;
  return created;
}
