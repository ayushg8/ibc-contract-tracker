/**
 * Every repair attempt, in the audit trail she already has.
 *
 * The rules the audit table sets for itself are kept exactly: append only, never
 * updated, never deleted. Two details are worth stating outright because they
 * look like liberties and are not:
 *
 *   1. `action` is a repair verb ('repair_applied' and friends), which is not in
 *      AUDIT_ACTIONS. That union lives in queries.ts, which this agent does not
 *      own, and the alternative -- reusing 'edited' or 'restored' for something
 *      an AI did to the application's own source -- would be a worse lie than a
 *      new verb. The column is TEXT and nothing reads it as an enum.
 *   2. contract_id and document_id are both NULL. A repair is not an event in the
 *      life of any contract, and the two timeline queries in the app both filter
 *      on one of those columns, so these rows can never appear inside a contract's
 *      history and change what it looks like happened to a contract.
 *
 * Everything written here also goes to the journal file, which does not need the
 * database to open. A repair that runs because the database migration broke must
 * still leave a record of itself.
 */

import { db } from '@/lib/db/client';
import { log } from '@/lib/logger';
import { redact } from '@/lib/providers/errors';

import { journal } from './state';
import { MAX_AUDIT_DIFF_BYTES, REPAIR_ACTOR, type AttemptRecord } from './types';

export const REPAIR_AUDIT_ACTIONS = [
  /** A repair started. Carries the failure it is answering. */
  'repair_started',
  /** Stopped on the subscription cap; resumeAt says when it picks up. */
  'repair_deferred',
  /** Claude touched a protected path. Nothing was applied. */
  'repair_rejected',
  /** The candidate failed a gate. Nothing was applied. */
  'repair_gate_failed',
  /** The candidate passed every gate and is live. Carries the diff. */
  'repair_applied',
  /** The attempt ended without a candidate: no changes, or the engine failed. */
  'repair_failed',
  /** Refused before it began: rollback unhealthy, or the gates cannot run here. */
  'repair_refused',
  /** The cap for this failure is spent. There will be no more attempts. */
  'repair_exhausted',
] as const;

export type RepairAuditAction = (typeof REPAIR_AUDIT_ACTIONS)[number];

/** Detail is a support field, not a document store. */
const MAX_DETAIL_CHARS = 4_000;

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... truncated, ${text.length - max} more characters`;
}

export interface RepairAuditEvent {
  action: RepairAuditAction;
  /** The failure signature. Stored in field_key so it can be grouped in SQL. */
  signature: string;
  /** One sentence, plain English. Goes in detail alongside the technical note. */
  summary: string;
  /** The technical account. Redacted and capped. */
  detail?: string;
  /** The actual diff, for 'repair_applied' and 'repair_rejected'. Capped. */
  diff?: string;
  /** What the version was before this attempt, when known. */
  fromVersion?: string | null;
  toVersion?: string | null;
}

/**
 * Write one row. Never throws: a repair must not fail because the audit insert
 * failed, and the journal has already taken the same record.
 */
export function recordRepairEvent(event: RepairAuditEvent): void {
  const detail = cap(
    redact([event.summary, event.detail].filter((s) => s !== undefined && s !== '').join(' | ')) ??
      event.summary,
    MAX_DETAIL_CHARS,
  );
  const diff = event.diff === undefined ? null : cap(redact(event.diff) ?? '', MAX_AUDIT_DIFF_BYTES);

  journal(event.action, {
    signature: event.signature,
    summary: event.summary,
    detail: event.detail ?? null,
    diffBytes: event.diff === undefined ? 0 : event.diff.length,
  });

  try {
    db()
      .prepare(
        `INSERT INTO audit (contract_id, document_id, action, field_key, old_value, new_value, actor, detail, at)
         VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.action,
        event.signature,
        event.fromVersion ?? null,
        // The diff goes in new_value: it is what the tracker would look like after
        // this change, which is exactly what that column means everywhere else.
        diff ?? event.toVersion ?? null,
        REPAIR_ACTOR,
        detail,
        new Date().toISOString(),
      );
  } catch (e) {
    // The journal line above is the durable record. Losing the row is bad; losing
    // the repair because of it would be worse.
    log.error('repair.audit.insert-failed', { action: event.action, error: e });
  }
}

/** One line summarising an attempt, for the audit detail and for the UI. */
export function summariseAttempt(record: AttemptRecord): string {
  const changed = `${record.changed.added} added, ${record.changed.modified} modified, ${record.changed.removed} removed`;
  switch (record.outcome) {
    case 'applied':
      return `Fixed and applied (${changed}); every gate passed.`;
    case 'gate-failed': {
      const failed = record.gates.filter((g) => !g.ok).map((g) => g.id);
      return `Discarded: ${failed.join(', ') || 'a gate'} failed. Still on the rolled-back version.`;
    }
    case 'protected-path':
      return `Rejected: the fix touched ${record.violations.length} protected file(s). Nothing was applied.`;
    case 'no-changes':
      return 'Claude changed nothing. Nothing was applied.';
    case 'engine-failed':
      return `Claude Code could not finish (${record.engineCode ?? 'unknown'}). Nothing was applied.`;
    case 'promote-failed':
      return 'The fix passed every gate but would not come up live; the previous version was put back.';
    case 'deferred':
      return 'Paused on the Claude subscription limit. It will pick up where it left off.';
    case 'refused':
      return record.detail;
    default:
      return record.detail;
  }
}

/** Read back what repair has done. Used by the API and by support. */
export function recentRepairAudit(limit = 20): {
  action: string;
  signature: string | null;
  detail: string | null;
  at: string;
}[] {
  try {
    const rows = db()
      .prepare(
        `SELECT action, field_key, detail, at FROM audit
          WHERE actor = ? AND action LIKE 'repair_%'
          ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(REPAIR_ACTOR, Math.max(1, Math.min(limit, 100)));
    return rows.map((row) => ({
      action: String(row['action'] ?? ''),
      signature: typeof row['field_key'] === 'string' ? row['field_key'] : null,
      detail: typeof row['detail'] === 'string' ? row['detail'] : null,
      at: String(row['at'] ?? ''),
    }));
  } catch (e) {
    log.error('repair.audit.read-failed', { error: e });
    return [];
  }
}
