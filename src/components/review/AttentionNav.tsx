'use client';

import { CaretLeft, CaretRight, SealCheck, WarningCircle } from '@phosphor-icons/react';
import { IconButton, Kbd, Tooltip } from '@/components/ui';

export interface AttentionNavProps {
  /** Fields that are model-guessed or missing. Never the settled ones. */
  count: number;
  /** 0-based position in that list, or -1 before she starts walking it. */
  index: number;
  onPrev: () => void;
  onNext: () => void;
}

export function AttentionNav({ count, index, onPrev, onNext }: AttentionNavProps) {
  return (
    // Glass, so the fields scroll under it instead of stopping at a hard edge.
    <div className="glass hairline-b sticky top-0 z-10 flex items-center justify-between gap-[8px] px-[14px] py-[8px]">
      {count === 0 ? (
        <p className="flex items-center gap-[6px] text-callout text-label-secondary">
          <SealCheck size={14} weight="fill" className="text-ok" />
          Every field is accounted for
        </p>
      ) : (
        <p className="flex items-center gap-[6px] text-callout text-label">
          <WarningCircle size={14} weight="fill" className="text-warn" />
          {count === 1 ? '1 field needs attention' : `${count} fields need attention`}
        </p>
      )}

      {count > 0 && (
        <div className="flex items-center gap-[2px]">
          <Tooltip content="Previous" keys={['K']}>
            <IconButton label="Previous field needing attention" size="sm" onClick={onPrev}>
              <CaretLeft size={13} weight="bold" />
            </IconButton>
          </Tooltip>
          <span className="tabular min-w-[52px] text-center text-footnote text-label-secondary">
            {index < 0 ? `${count} left` : `${index + 1} of ${count}`}
          </span>
          <Tooltip content="Next" keys={['J']}>
            <IconButton label="Next field needing attention" size="sm" onClick={onNext}>
              <CaretRight size={13} weight="bold" />
            </IconButton>
          </Tooltip>
          <span className="ml-[4px]">
            <Kbd keys={['J', 'K']} />
          </span>
        </div>
      )}
    </div>
  );
}
