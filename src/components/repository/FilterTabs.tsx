'use client';

import { Segmented } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import type { ContractFilter } from '@/lib/db/types';
import { EXPIRING_WINDOW_DAYS } from '@/lib/status';

/**
 * 'unknown' is a real status but not a chip: a record with no end date needs
 * fixing, not filtering, and it already reads as Unknown in the Status column.
 */
export type RepositoryFilter = Exclude<ContractFilter, 'unknown'>;

const OPTIONS: readonly SegmentedOption<RepositoryFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'expiring', label: `Expiring ${EXPIRING_WINDOW_DAYS}d` },
  { value: 'expired', label: 'Expired' },
];

export interface FilterTabsProps {
  value: RepositoryFilter;
  onChange: (value: RepositoryFilter) => void;
}

export function FilterTabs({ value, onChange }: FilterTabsProps) {
  return (
    <Segmented
      options={OPTIONS}
      value={value}
      onChange={onChange}
      ariaLabel="Filter contracts by status"
      size="sm"
    />
  );
}
