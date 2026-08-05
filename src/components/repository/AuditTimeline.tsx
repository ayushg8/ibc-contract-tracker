'use client';

import type { AuditEntry } from '@/lib/db/types';
import { FIELD_LIST } from '@/lib/fields';
import { localStamp } from './format';

/** fieldKey arrives as a plain string, so the lookup has to accept one. */
const FIELD_LABELS: Map<string, string> = new Map(FIELD_LIST.map((f) => [f.key, f.label]));

/**
 * Every action the trail can hold. A slug missing from this map is printed raw,
 * so "reextracted" reached the history of any record she asked to re-read --
 * which is the one place the history is read most.
 */
const ACTIONS: Map<string, string> = new Map([
  ['extracted', 'Read by Claude'],
  ['reextracted', 'Read again by Claude'],
  ['edited', 'Edited'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['reopened', 'Reopened for another read'],
  ['unapproved', 'Returned for review'],
  ['archived', 'Removed from the repository'],
  ['unarchived', 'Put back in the repository'],
  ['restored', 'Put back in the repository'],
  ['exported', 'Exported'],
]);

/** Exported so a test can hold the map against the actions the routes write. */
export function describeAudit(entry: Pick<AuditEntry, 'action' | 'fieldKey'>): string {
  const action = ACTIONS.get(entry.action) ?? entry.action;
  if (entry.fieldKey === null) return action;
  return `${action} ${FIELD_LABELS.get(entry.fieldKey) ?? entry.fieldKey}`;
}

export interface AuditTimelineProps {
  entries: readonly AuditEntry[];
}

/**
 * History is a list of facts, not a visualisation. The first build drew a dotted
 * rail with a colour per action, which put five status colours on a record whose
 * whole point is that it was already approved.
 */
export function AuditTimeline({ entries }: AuditTimelineProps) {
  if (entries.length === 0) {
    return <p className="text-callout text-label-tertiary">Nothing recorded yet.</p>;
  }

  return (
    <ol>
      {entries.map((entry, index) => (
        <li
          key={entry.id}
          className={index < entries.length - 1 ? 'hairline-b py-[8px]' : 'py-[8px]'}
        >
          <div className="flex items-baseline justify-between gap-[12px]">
            <p className="min-w-0 truncate text-body text-label">{describeAudit(entry)}</p>
            <p className="tabular shrink-0 text-callout text-label-secondary">
              {localStamp(entry.at)}
            </p>
          </div>

          {(entry.oldValue !== null || entry.newValue !== null) && (
            <p className="mt-[2px] text-callout text-label-secondary">
              <span className="line-through decoration-label-quaternary">
                {entry.oldValue ?? 'empty'}
              </span>
              {' \u2192 '}
              <span className="text-label">{entry.newValue ?? 'empty'}</span>
            </p>
          )}

          <p className="mt-[2px] text-footnote text-label-tertiary">
            {entry.detail !== null ? `${entry.detail} \u00b7 ${entry.actor}` : entry.actor}
          </p>
        </li>
      ))}
    </ol>
  );
}
