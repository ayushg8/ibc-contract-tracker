/**
 * The one database handle. Server-only (node:sqlite).
 *
 * Three things this file exists to guarantee:
 *   1. One connection per process, surviving Next's dev hot-reload. Reopening the
 *      file on every edit is how you get a WAL lock and a "database is locked"
 *      error that looks like a bug in the app.
 *   2. Every SQLite failure leaves here as an EngineError with a remedy. Bonnie
 *      never sees SQLITE_BUSY.
 *   3. tx() is a real transaction and it is re-entrant. node:sqlite rejects a
 *      nested BEGIN, so a nested call joins the outer transaction instead --
 *      which is what the approve path needs, since it calls smaller writers that
 *      each want their own transaction when used alone.
 */

import { DatabaseSync } from 'node:sqlite';

import { EngineError, toEngineError } from '../providers/errors';
import { dbPath, ensureDirs } from '../paths';
import { migrate } from './migrate';

interface DbHandle {
  db: DatabaseSync;
  /** Depth of nested tx() calls. 0 means no transaction is open. */
  depth: number;
  /** Set when a nested level threw, so the outer level cannot commit a broken write. */
  poisoned: boolean;
  path: string;
}

/*
 * Stashed on globalThis rather than in a module-level `let`: Next replaces the
 * module registry on hot-reload, which would otherwise open a second handle to
 * the same WAL file. Declared rather than cast so the slot is typed.
 */
declare global {
  var __ibcTrackerDb: DbHandle | undefined;
}

function open(): DbHandle {
  const file = dbPath();
  ensureDirs();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (e) {
    throw sqliteError(e);
  }
  const handle: DbHandle = { db, depth: 0, poisoned: false, path: file };
  globalThis.__ibcTrackerDb = handle;
  try {
    migrate(db);
  } catch (e) {
    // A half-migrated file is worse than no file; drop the handle so the next
    // call retries from scratch instead of querying tables that do not exist.
    try {
      db.close();
    } catch {
      /* already closed or never opened; the original error is the interesting one */
    }
    globalThis.__ibcTrackerDb = undefined;
    throw toEngineError(e, 'DB_CORRUPT');
  }
  return handle;
}

function handle(): DbHandle {
  return globalThis.__ibcTrackerDb ?? open();
}

/** The live connection. Opens and migrates on first use. */
export function db(): DatabaseSync {
  return handle().db;
}

/** Absolute path of the open database file. For Diagnostics and the support bundle. */
export function databaseFile(): string {
  return handle().path;
}

/**
 * Run fn inside a transaction. Rolls back on ANY throw, including a throw from
 * something fn called three levels down.
 *
 * Nested calls join the enclosing transaction: only the outermost issues
 * BEGIN/COMMIT. If an inner level throws and an outer level swallows it, the
 * transaction is poisoned and the outer commit is refused -- silently committing
 * a partial approve is the one failure mode this file will not allow.
 */
export function tx<T>(fn: () => T): T {
  const h = handle();

  if (h.depth > 0) {
    h.depth += 1;
    try {
      const out = fn();
      h.depth -= 1;
      return out;
    } catch (e) {
      h.depth -= 1;
      h.poisoned = true;
      throw toEngineError(e);
    }
  }

  h.poisoned = false;
  exec('BEGIN IMMEDIATE');
  h.depth = 1;
  let out: T;
  try {
    out = fn();
  } catch (e) {
    h.depth = 0;
    rollback(h);
    throw toEngineError(e);
  }
  if (h.poisoned) {
    h.depth = 0;
    rollback(h);
    throw new EngineError('UNKNOWN', {
      detail: 'transaction poisoned by a swallowed error in a nested tx()',
    });
  }
  h.depth = 0;
  try {
    exec('COMMIT');
  } catch (e) {
    rollback(h);
    throw sqliteError(e);
  }
  return out;
}

function rollback(h: DbHandle): void {
  try {
    if (h.db.isTransaction) h.db.exec('ROLLBACK');
  } catch {
    /* nothing left to do; the caller is already receiving the real error */
  }
  h.poisoned = false;
}

/** Are we inside a transaction right now? Used by writers that must be atomic. */
export function inTransaction(): boolean {
  return handle().depth > 0;
}

/** Multi-statement SQL. Not for anything with user input -- use prepared statements. */
export function exec(sql: string): void {
  try {
    db().exec(sql);
  } catch (e) {
    throw sqliteError(e);
  }
}

/**
 * Close the handle. Called by tests and the app's shutdown path; the next db()
 * reopens. Never called in a request.
 */
export function close(): void {
  const h = globalThis.__ibcTrackerDb;
  if (!h) return;
  try {
    if (h.db.isTransaction) h.db.exec('ROLLBACK');
    h.db.close();
  } catch (e) {
    throw sqliteError(e);
  } finally {
    globalThis.__ibcTrackerDb = undefined;
  }
}

/* ──────────────────────────── Error mapping ────────────────────────────── */

/** SQLite primary result codes we care about. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;

/**
 * node:sqlite throws a plain Error carrying `errcode` (the SQLite primary code)
 * and `errstr`. Extended codes are the primary code plus a high byte, so mask.
 */
export function sqliteError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;

  const errcode = numberProp(e, 'errcode');
  const primary = errcode == null ? null : errcode & 0xff;
  const message = e instanceof Error ? e.message : String(e);
  const detail = `${stringProp(e, 'errstr') ?? 'sqlite'}: ${message}`;

  switch (primary) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return new EngineError('DB_LOCKED', { detail, cause: e });
    case SQLITE_CORRUPT:
    case SQLITE_NOTADB:
      return new EngineError('DB_CORRUPT', { detail, cause: e });
    case SQLITE_FULL:
      return new EngineError('DISK_FULL', { detail, cause: e });
    case SQLITE_READONLY:
      return new EngineError('FOLDER_UNREADABLE', { detail, cause: e });
    default:
      break;
  }

  // Some failures arrive as an fs errno before SQLite ever sees them, and the
  // string forms show up in older messages. Cheap to check, expensive to miss.
  const code = stringProp(e, 'code');
  if (code === 'ENOSPC' || /SQLITE_FULL|disk is full|database or disk is full/i.test(detail)) {
    return new EngineError('DISK_FULL', { detail, cause: e });
  }
  if (/SQLITE_BUSY|database is locked/i.test(detail)) {
    return new EngineError('DB_LOCKED', { detail, cause: e });
  }
  if (/SQLITE_CORRUPT|NOTADB|file is not a database|malformed/i.test(detail)) {
    return new EngineError('DB_CORRUPT', { detail, cause: e });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new EngineError('FOLDER_UNREADABLE', { detail, cause: e });
  }

  return new EngineError('UNKNOWN', { detail, cause: e });
}

/** Read a property off an unknown throwable. Reflect.get keeps this cast-free. */
function prop(e: unknown, key: string): unknown {
  if (typeof e !== 'object' || e === null) return undefined;
  // The declared `unknown` return is what keeps Reflect.get's `any` from leaking.
  return Reflect.get(e, key);
}

function numberProp(e: unknown, key: string): number | null {
  const v = prop(e, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stringProp(e: unknown, key: string): string | null {
  const v = prop(e, key);
  return typeof v === 'string' ? v : null;
}
