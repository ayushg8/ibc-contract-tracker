'use client';

import { Button, Segmented } from '@/components/ui';

/**
 * The three tabs, named the way the server names them. The membership of each is
 * the server's answer (`groups` on GET /api/documents); this file only decides
 * what they are called and in what order they read.
 */
export type InboxGroup = 'pending' | 'attention' | 'rejected';

export const INBOX_GROUPS: readonly InboxGroup[] = ['pending', 'attention', 'rejected'];

const LABEL: Record<InboxGroup, string> = {
  pending: 'Pending',
  attention: 'Needs attention',
  rejected: 'Rejected',
};

/** Escaped so the source stays ASCII. */
const MIDDOT = '\u00B7';

export interface InboxFilterProps {
  value: InboxGroup;
  onChange: (group: InboxGroup) => void;
  counts: Record<InboxGroup, number>;
  /** Absent when there is nothing left to select in the current tab. */
  selectAll?: { count: number; onSelect: () => void } | undefined;
}

export function InboxFilter({ value, onChange, counts, selectAll }: InboxFilterProps) {
  const options = INBOX_GROUPS.map((group) => ({
    value: group,
    // The count is part of the label rather than a badge: a segmented control
    // has one text slot, and a zero that reads as "nothing here" is worth more
    // than a chip that has to be decoded.
    label: counts[group] > 0 ? `${LABEL[group]} ${MIDDOT} ${counts[group]}` : LABEL[group],
  }));

  return (
    <div className="flex flex-wrap items-center justify-between gap-[12px]">
      <Segmented
        options={options}
        value={value}
        onChange={onChange}
        ariaLabel="Filter the Inbox"
        size="sm"
      />
      {selectAll !== undefined && (
        <Button size="sm" variant="ghost" className="text-accent" onClick={selectAll.onSelect}>
          {`Select all ready (${selectAll.count})`}
        </Button>
      )}
    </div>
  );
}
