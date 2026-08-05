/**
 * The database layer's single entry point. Server-only: importing this pulls in
 * node:sqlite, so a client component must import `@/lib/db/types` instead, which
 * is types alone and safe in the browser bundle.
 */

export * from './types';
export * from './queries';
export { close, databaseFile, db, exec, inTransaction, sqliteError, tx } from './client';
export { SCHEMA_VERSION, migrate, rebuildSearchIndex } from './migrate';
