'use client';

import clsx from 'clsx';
import { Info, WarningCircle } from '@phosphor-icons/react';

import type { ProvenanceNotice } from '@/lib/client/provenance';

export interface ProvenanceNotesProps {
  notices: readonly ProvenanceNotice[];
  className?: string;
}

/**
 * How this document was read, said next to the evidence rather than buried in
 * History.
 *
 * One washed block for all of them, not a card each: two caveats about the same
 * document are one paragraph, and stacking boxes is how a warning turns into
 * chrome. The wash goes amber only when something in the list is a caveat about
 * the evidence itself -- an OCR disclosure on its own is a fact, not an alarm.
 */
export function ProvenanceNotes({ notices, className }: ProvenanceNotesProps) {
  if (notices.length === 0) return null;
  const caveat = notices.some((notice) => notice.tone === 'warn');

  return (
    <div
      className={clsx(
        'sq rounded-row px-[12px] py-[9px]',
        caveat ? 'bg-warn-quiet' : 'bg-neutral-quiet',
        className,
      )}
    >
      <ul className="flex flex-col gap-[7px]">
        {notices.map((notice) => (
          <li key={notice.id} className="flex items-start gap-[7px]">
            {notice.tone === 'warn' ? (
              <WarningCircle
                size={13}
                weight="fill"
                aria-hidden
                className="mt-[2px] shrink-0 text-warn"
              />
            ) : (
              <Info size={13} weight="fill" aria-hidden className="mt-[2px] shrink-0 text-neutral" />
            )}
            <p className="min-w-0 text-callout">
              <span className="font-medium text-label">{notice.title}</span>{' '}
              <span className="text-label-secondary">{notice.body}</span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
