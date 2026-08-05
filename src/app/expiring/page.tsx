'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';

import { TitlebarActions } from '@/components/layout/Titlebar';
import { DetailSheet } from '@/components/repository/DetailSheet';
import { collectExpiring, ExpiringList } from '@/components/repository/ExpiringList';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { api } from '@/lib/client/api';
import type { ContractSummary } from '@/lib/db/types';
import { EXPIRING_WINDOW_DAYS } from '@/lib/status';

export default function ExpiringPage() {
  const [rows, setRows] = useState<ContractSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  // The whole set, not filter=expiring: that filter reads the agreement clock
  // only, and a lapsed evaluation agreement whose confidentiality obligation is
  // still running has to appear here too.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.contracts({ filter: 'all' }).then((result) => {
      if (cancelled) return;
      if (result.error !== undefined) setFailure(result.error.message);
      else {
        setRows(result.data.contracts);
        setFailure(null);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const items = useMemo(() => collectExpiring(rows), [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <TitlebarActions>
        {loading ? (
          <Spinner size={13} />
        ) : (
          <span className="tabular text-callout text-label-secondary">
            {items.length} within {EXPIRING_WINDOW_DAYS} days
          </span>
        )}
      </TitlebarActions>

      <div className="min-h-0 flex-1 overflow-y-auto px-[20px] py-[16px]">
        {failure !== null && (
          <div className="surface sq flex items-start gap-[10px] rounded-card p-[14px]">
            <WarningCircle size={18} className="mt-[1px] shrink-0 text-bad" />
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-label">{failure}</p>
              <Button size="sm" className="mt-[8px]" onClick={reload}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {failure === null && !loading && items.length === 0 && (
          <EmptyState
            icon={CheckCircle}
            title="Nothing needs renewing"
            body="Every agreement on file is comfortably inside its term, and so is every confidentiality obligation."
          />
        )}

        {failure === null && items.length > 0 && (
          <ExpiringList items={items} onSelect={setOpenId} />
        )}
      </div>

      <DetailSheet
        contractId={openId}
        open={openId !== null}
        onOpenChange={(next) => {
          if (!next) setOpenId(null);
        }}
        onEdited={reload}
      />
    </div>
  );
}
