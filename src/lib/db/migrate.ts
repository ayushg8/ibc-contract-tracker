/**
 * Apply the schema, then the FTS triggers. Idempotent -- runs on every open.
 *
 * schema.sql declares `contract_search` but deliberately not the triggers that
 * fill it: the haystack spans two tables (contracts + parties) and the rule for
 * what goes in it is application policy, not schema. It lives here, in one place,
 * so the index cannot drift from the source of truth.
 */

import type { DatabaseSync } from 'node:sqlite';

import { EngineError } from '../providers/errors';
import { SCHEMA_SQL } from './schema';

/**
 * Bumped only when schema.sql changes in a way that needs a real migration.
 *
 * v2: audit.contract_id ON DELETE CASCADE -> SET NULL (the trail used to die with
 *     the contract), idx_contracts_document made partial on archived_at IS NULL,
 *     documents gains text_source / ocr_confidence / pages_read.
 *   v3: documents gains pages_read_ranges / rejected_ocr_confidence. The page COUNT
 *       cannot describe a head+tail read, and the banner built on it told the reviewer
 *       the signature block had not been read when in fact it had.
 */
export const SCHEMA_VERSION = 3;

/**
 * The search haystack. Every party name, every signer, the normalised keys, the
 * contract name and the governing law -- so "octilion", "Ntrium" and "Delaware"
 * all reach the same row, and the LIKE fallback has the same text to scan.
 */
const HAYSTACK_SQL = `
  coalesce(c.contract_name, '') || ' ' ||
  coalesce(c.counterparty, '') || ' ' ||
  coalesce(c.governing_law, '') || ' ' ||
  coalesce(
    (SELECT group_concat(
       p.name || ' ' || p.normalised || ' ' || coalesce(p.signer, ''), ' ')
     FROM parties p WHERE p.contract_id = c.id),
    '')
`;

/**
 * Rebuild-on-write rather than incremental patching. A contract has at most three
 * parties, so the cost is nothing, and a full rebuild of the row cannot leave a
 * stale fragment behind the way six independent INSERT/DELETE triggers can.
 */
function reindex(idExpr: string): string {
  return `
  DELETE FROM contract_search WHERE contract_id = ${idExpr};
  INSERT INTO contract_search(contract_id, haystack)
    SELECT c.id, ${HAYSTACK_SQL} FROM contracts c WHERE c.id = ${idExpr};`;
}

const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS contracts_search_ai AFTER INSERT ON contracts BEGIN
  ${reindex('new.id')}
END;

CREATE TRIGGER IF NOT EXISTS contracts_search_au AFTER UPDATE ON contracts BEGIN
  DELETE FROM contract_search WHERE contract_id = old.id;
  ${reindex('new.id')}
END;

CREATE TRIGGER IF NOT EXISTS contracts_search_ad AFTER DELETE ON contracts BEGIN
  DELETE FROM contract_search WHERE contract_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS parties_search_ai AFTER INSERT ON parties BEGIN
  ${reindex('new.contract_id')}
END;

CREATE TRIGGER IF NOT EXISTS parties_search_au AFTER UPDATE ON parties BEGIN
  DELETE FROM contract_search WHERE contract_id = old.contract_id;
  ${reindex('new.contract_id')}
END;

CREATE TRIGGER IF NOT EXISTS parties_search_ad AFTER DELETE ON parties BEGIN
  ${reindex('old.contract_id')}
END;
`;

/**
 * Bring an open connection up to date. Safe to call on every open; safe to call
 * twice. Throws EngineError only.
 *
 * The schema arrives as a bundled string (see schema.ts). It used to be read from
 * schema.sql at runtime, which cost us two real defects: Next traced the entire
 * project because of the readFileSync, and a build run from anywhere other than the
 * source tree could not find the file at all.
 */
export function migrate(database: DatabaseSync): void {
  const schema = SCHEMA_SQL;

  try {
    database.exec(schema);
    // schema.sql is CREATE ... IF NOT EXISTS throughout, so it cannot change a
    // table that already exists. Everything a v1 file needs happens here.
    upgradeToV2(database);
    database.exec(TRIGGERS_SQL);
    recordVersion(database);
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError('DB_CORRUPT', {
      detail: `migration failed: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
}

/* ════════════════════════════ v1 -> v2 upgrade ══════════════════════════ */

/**
 * Every v2 change, each guarded by a check of what the file actually contains
 * rather than by the recorded version number. Feature detection, not a version
 * gate, because a database written by a half-shipped build can sit at version 1
 * with some of v2 already applied -- and because every step below has to be a
 * no-op on a database schema.sql just created from scratch.
 */
function upgradeToV2(database: DatabaseSync): void {
  addColumnIfMissing(database, 'documents', 'text_source', 'TEXT');
  addColumnIfMissing(database, 'documents', 'ocr_confidence', 'REAL');
  addColumnIfMissing(database, 'documents', 'pages_read', 'INTEGER');
  addColumnIfMissing(database, 'documents', 'pages_read_ranges', 'TEXT');
  addColumnIfMissing(database, 'documents', 'rejected_ocr_confidence', 'REAL');
  makeDocumentIndexPartial(database);
  rebuildAuditWithoutCascade(database);
}

/** Table and column names here are literals in this file, never caller input. */
function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c['name'] === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

/**
 * v1 declared idx_contracts_document UNIQUE over every row, archived or not, so a
 * document whose record had been removed could never be approved again. Rebuilt as
 * a partial index: one live record per document, archived ones unconstrained.
 */
function makeDocumentIndexPartial(database: DatabaseSync): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get('idx_contracts_document');
  const sql = row === undefined ? null : row['sql'];
  if (typeof sql === 'string' && /archived_at/i.test(sql)) return;
  database.exec(`
    DROP INDEX IF EXISTS idx_contracts_document;
    CREATE UNIQUE INDEX idx_contracts_document
      ON contracts(document_id) WHERE archived_at IS NULL;`);
}

/** The v2 shape of audit. Identical to v1 apart from the contract_id delete rule. */
const AUDIT_V2_TABLE = `
CREATE TABLE audit_v2 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id   TEXT REFERENCES contracts(id) ON DELETE SET NULL,
  document_id   TEXT REFERENCES documents(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  field_key     TEXT,
  old_value     TEXT,
  new_value     TEXT,
  actor         TEXT NOT NULL DEFAULT 'local',
  detail        TEXT,
  at            TEXT NOT NULL
);`;

/*
 * The copy does two repairs on the way across:
 *   - document_id is backfilled from the contract, because v1 wrote several kinds
 *     of row (archived, exported) with only a contract_id. Once contract_id is
 *     allowed to go NULL those rows would otherwise become unattributable.
 *   - a contract_id or document_id pointing at a row that no longer exists is
 *     nulled, so the foreign_key_check below cannot fail on damage we inherited.
 */
const AUDIT_V2_COPY = `
INSERT INTO audit_v2
  (id, contract_id, document_id, action, field_key, old_value, new_value, actor, detail, at)
SELECT a.id,
       CASE WHEN EXISTS (SELECT 1 FROM contracts c WHERE c.id = a.contract_id)
            THEN a.contract_id ELSE NULL END,
       CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.id = coalesce(
              a.document_id,
              (SELECT c2.document_id FROM contracts c2 WHERE c2.id = a.contract_id)))
            THEN coalesce(
              a.document_id,
              (SELECT c3.document_id FROM contracts c3 WHERE c3.id = a.contract_id))
            ELSE NULL END,
       a.action, a.field_key, a.old_value, a.new_value, a.actor, a.detail, a.at
  FROM audit a;`;

const AUDIT_V2_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_audit_contract ON audit(contract_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_document ON audit(document_id, at DESC);`;

/**
 * The 12-step table rebuild from the SQLite ALTER TABLE documentation. SQLite
 * cannot change a foreign key in place, and this one has to change: with
 * ON DELETE CASCADE, dropping a contract took its whole approval history with it.
 *
 * PRAGMA foreign_keys is a no-op inside a transaction, so it is toggled outside
 * one; the destructive half runs inside a transaction, and foreign_key_check runs
 * before the commit so a rebuild that would leave a dangling reference rolls back
 * rather than landing.
 */
function rebuildAuditWithoutCascade(database: DatabaseSync): void {
  if (!auditCascades(database)) return;

  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('DROP TABLE IF EXISTS audit_v2');
      database.exec(AUDIT_V2_TABLE);
      database.exec(AUDIT_V2_COPY);
      database.exec('DROP TABLE audit');
      database.exec('ALTER TABLE audit_v2 RENAME TO audit');
      database.exec(AUDIT_V2_INDEXES);

      const violations = database.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new EngineError('DB_CORRUPT', {
          detail: `audit rebuild left ${violations.length} dangling reference(s)`,
        });
      }
      database.exec('COMMIT');
    } catch (e) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* the original error is the one worth reporting */
      }
      throw e;
    }
  } finally {
    // Must come back on whatever happened: every write after this point relies on
    // the schema's referential integrity being enforced.
    database.exec('PRAGMA foreign_keys = ON');
  }
}

/** True while audit.contract_id still carries the v1 cascade. */
function auditCascades(database: DatabaseSync): boolean {
  const keys = database.prepare("PRAGMA foreign_key_list('audit')").all();
  for (const k of keys) {
    if (k['from'] === 'contract_id' && k['table'] === 'contracts') {
      return k['on_delete'] !== 'SET NULL';
    }
  }
  return false;
}

function recordVersion(database: DatabaseSync): void {
  const row = database.prepare('SELECT max(version) AS v FROM schema_meta').get();
  const current = row && typeof row['v'] === 'number' ? row['v'] : 0;
  if (current >= SCHEMA_VERSION) return;
  database
    .prepare('INSERT INTO schema_meta (version, applied_at) VALUES (?, ?)')
    .run(SCHEMA_VERSION, new Date().toISOString());
}

/**
 * Rebuild the whole search index from scratch. Not part of the normal path --
 * exposed for Diagnostics, and for the case where someone restores a database
 * file that was written before the triggers existed.
 */
export function rebuildSearchIndex(database: DatabaseSync): number {
  database.exec('DELETE FROM contract_search');
  database.exec(`INSERT INTO contract_search(contract_id, haystack)
    SELECT c.id, ${HAYSTACK_SQL} FROM contracts c`);
  const row = database.prepare('SELECT count(*) AS n FROM contract_search').get();
  return row && typeof row['n'] === 'number' ? row['n'] : 0;
}
