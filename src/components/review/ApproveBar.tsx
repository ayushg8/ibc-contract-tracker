'use client';

import { ArrowSquareOut, Check, Prohibit, WarningCircle } from '@phosphor-icons/react';
import { Button, Pill, Tooltip } from '@/components/ui';
import type { FieldKey } from '@/lib/db/types';

export interface ApproveBlocker {
  key: FieldKey;
  label: string;
}

export interface ApproveBarProps {
  /** Required fields with neither a value nor an explicit "not in document". */
  blockers: readonly ApproveBlocker[];
  onApprove: () => void;
  onReject: () => void;
  onJumpToBlocker: (key: FieldKey) => void;
  approving?: boolean;
  rejecting?: boolean;
  approved?: boolean;
  onOpenRecord?: () => void;
}

export function ApproveBar({
  blockers,
  onApprove,
  onReject,
  onJumpToBlocker,
  approving = false,
  rejecting = false,
  approved = false,
  onOpenRecord,
}: ApproveBarProps) {
  if (approved) {
    return (
      <div className="flex items-center gap-[8px]">
        <Pill tone="ok" leading={<Check size={10} weight="bold" />}>
          Approved
        </Pill>
        {onOpenRecord !== undefined && (
          <Button
            size="sm"
            icon={<ArrowSquareOut size={12} />}
            onClick={onOpenRecord}
          >
            Open record
          </Button>
        )}
      </div>
    );
  }

  const blocked = blockers.length > 0;
  const first = blockers[0];
  const reason = blocked
    ? blockers.length === 1
      ? `${first?.label ?? 'One field'} still needs an answer`
      : `${blockers.length} required fields still need an answer`
    : null;

  return (
    <div className="flex items-center gap-[6px]">
      {reason !== null && (
        // A disabled button cannot explain itself, so the reason is its own
        // control and it goes straight to the field that is blocking.
        <Button
          size="sm"
          variant="ghost"
          icon={<WarningCircle size={12} weight="fill" />}
          onClick={() => first !== undefined && onJumpToBlocker(first.key)}
          className="text-warn"
        >
          {reason}
        </Button>
      )}

      <Button
        size="sm"
        variant="ghost"
        icon={<Prohibit size={12} />}
        loading={rejecting}
        onClick={onReject}
      >
        <span className="text-bad">Reject</span>
      </Button>

      <Tooltip
        content={reason ?? 'Write this into the repository'}
        keys={reason === null ? ['\u2318', '\u21B5'] : undefined}
      >
        <Button
          size="sm"
          variant="primary"
          icon={<Check size={12} weight="bold" />}
          disabled={blocked}
          loading={approving}
          onClick={onApprove}
        >
          Approve
        </Button>
      </Tooltip>
    </div>
  );
}
