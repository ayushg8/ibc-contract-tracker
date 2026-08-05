'use client';

import { AnimatePresence, motion } from 'motion/react';
import { Check } from '@phosphor-icons/react';
import { Button, Glass, SPRING_SNAPPY } from '@/components/ui';

export interface SelectionBarProps {
  count: number;
  approving: boolean;
  onApprove: () => void;
  onClear: () => void;
}

/**
 * The bar that appears once anything is ticked.
 *
 * Bottom-centre, which is also where toasts land: a toast that covers it for ten
 * seconds is the right trade, because at the moment a toast fires it is the more
 * important message and the selection is still underneath when it clears.
 */
export function SelectionBar({ count, approving, onApprove, onClear }: SelectionBarProps) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 28, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={SPRING_SNAPPY}
          className="fixed bottom-[24px] left-1/2 z-40 -translate-x-1/2"
        >
          <Glass
            radius="card"
            role="group"
            aria-label="Selected documents"
            className="sq flex items-center gap-[12px] px-[14px] py-[10px] shadow-e2"
          >
            <span className="tabular whitespace-nowrap text-body font-medium text-label">
              {count === 1 ? '1 selected' : `${count} selected`}
            </span>
            <Button
              size="sm"
              variant="primary"
              icon={<Check size={12} weight="bold" />}
              loading={approving}
              onClick={onApprove}
            >
              {`Approve ${count}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClear} disabled={approving}>
              Clear
            </Button>
          </Glass>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
