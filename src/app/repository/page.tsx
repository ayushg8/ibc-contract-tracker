'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  Archive,
  ArrowCounterClockwise,
  MagnifyingGlass,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';

import { ContractTable } from '@/components/repository/ContractTable';
import type { Density } from '@/components/repository/ContractTable';
import { DetailSheet } from '@/components/repository/DetailSheet';
import { FilterTabs } from '@/components/repository/FilterTabs';
import type { RepositoryFilter } from '@/components/repository/FilterTabs';
import { localDay } from '@/components/repository/format';
import { SearchBar } from '@/components/repository/SearchBar';
import { Button, Card, EmptyState, Row, Segmented, Spinner } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import { api } from '@/lib/client/api';
import {
  listRemoved,
  useRecordActions,
  type RecordAction,
  type RemovedRecord,
} from '@/lib/client/useRecordActions';
import { useSettings } from '@/lib/client/useSettings';
import type { ContractSortKey, ContractSummary } from '@/lib/db/types';
import { DOC_TYPE_LABELS } from '@/lib/fields';

/**
 * Two lists, not two screens. Removed records are the same records with a date
 * in one more column, and burying them behind a route she has to know about is
 * what left "Undo" on a ten-second toast as the only way back.
 */
type View = 'repository' | 'removed';

const VIEWS: readonly SegmentedOption<View>[] = [
  { value: 'repository', label: 'Repository' },
  { value: 'removed', label: 'Removed' },
];

const FILTER_EMPTY: Record<RepositoryFilter, { title: string; body: string }> = {
  all: {
    title: 'No contracts yet',
    body: 'Approve a document in the Inbox and its record appears here.',
  },
  active: {
    title: 'Nothing currently active',
    body: 'Every record on file has either lapsed or has no end date.',
  },
  expiring: {
    title: 'Nothing expiring soon',
    body: 'No agreement on file reaches its end date in the next 90 days.',
  },
  expired: {
    title: 'Nothing has lapsed',
    body: 'Every agreement on file is still inside its term.',
  },
};

export default function RepositoryPage() {
  const router = useRouter();

  const [view, setView] = useState<View>('repository');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<RepositoryFilter>('all');
  /** null asks the server for its own order: relevance while searching, newest otherwise. */
  const [sort, setSort] = useState<ContractSortKey | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  const [rows, setRows] = useState<ContractSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  const [removed, setRemoved] = useState<RemovedRecord[]>([]);
  const [removedLoading, setRemovedLoading] = useState(false);
  const [removedFailure, setRemovedFailure] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);

  const { settings } = useSettings();
  const density: Density = settings?.density ?? 'comfortable';

  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const actions = useRecordActions(reload);

  /**
   * A record acted on from the table is a record that has left the table, so the
   * sheet behind it -- if it happens to be this row -- closes with it.
   */
  const act = useCallback(
    (action: RecordAction, row: ContractSummary) => {
      const target = {
        contractId: row.id,
        documentId: row.documentId,
        label: row.counterparty ?? row.contractName ?? DOC_TYPE_LABELS[row.docType],
      };
      setOpenId((current) => (current === row.id ? null : current));
      if (action === 'unapprove') void actions.sendBackToInbox(target);
      else if (action === 'reextract') void actions.reread(target);
      else void actions.remove(target);
    },
    [actions],
  );

  const restore = useCallback(
    (row: RemovedRecord) => {
      if (restoring !== null) return;
      setRestoring(row.id);
      void actions
        .restore({
          contractId: row.id,
          documentId: row.documentId,
          label: row.counterparty ?? row.contractName ?? DOC_TYPE_LABELS[row.docType],
        })
        .then(() => setRestoring(null));
    },
    [actions, restoring],
  );

  useEffect(() => {
    if (view !== 'repository') return;
    let cancelled = false;
    setLoading(true);
    void api
      .contracts({
        filter,
        ...(search.length > 0 ? { q: search } : {}),
        ...(sort !== null ? { sort, dir } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        if (result.error !== undefined) {
          setFailure(result.error.message);
        } else {
          setRows(result.data.contracts);
          setTotal(result.data.total);
          setFailure(null);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, search, filter, sort, dir, reloads]);

  useEffect(() => {
    if (view !== 'removed') return;
    let cancelled = false;
    setRemovedLoading(true);
    void listRemoved(search).then((result) => {
      if (cancelled) return;
      setRemoved(result.rows);
      setRemovedFailure(result.error);
      setRemovedLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [view, search, reloads]);

  function changeSearch(next: string) {
    setSearch(next);
    // A search re-ranks the whole set, so an explicit column sort would bury the
    // best match on page two. Hand ordering back to the server's relevance score.
    if (next.length > 0) setSort(null);
  }

  const showing = view === 'repository' ? total : removed.length;
  const busy = view === 'repository' ? loading : removedLoading;
  const empty = view === 'repository' ? !loading && rows.length === 0 : false;
  const emptyRemoved = view === 'removed' && !removedLoading && removed.length === 0;
  const problem = view === 'repository' ? failure : removedFailure;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {/* No title here: the window titlebar already names the section. */}
      <header className="hairline-b shrink-0 px-[20px] pb-[12px] pt-[14px]">
        <SearchBar value={search} onChange={changeSearch} />
        <div className="mt-[10px] flex items-center justify-between gap-[12px]">
          <div className="flex min-w-0 items-center gap-[10px]">
            <Segmented
              options={VIEWS}
              value={view}
              onChange={setView}
              ariaLabel="Show the repository or the records removed from it"
              size="sm"
            />
            {view === 'repository' && <FilterTabs value={filter} onChange={setFilter} />}
          </div>
          <p className="tabular shrink-0 text-callout text-label-secondary">
            {busy && showing === 0 ? (
              <Spinner size={13} />
            ) : view === 'removed' ? (
              <>
                {showing} removed
              </>
            ) : (
              <>
                {showing} {showing === 1 ? 'row' : 'rows'}
                {search.length > 0 && sort === null && (
                  <span className="text-label-tertiary"> - best match first</span>
                )}
              </>
            )}
          </p>
        </div>
      </header>

      <div
        aria-busy={busy}
        className={clsx(
          'min-h-0 flex-1 overflow-auto px-[20px] py-[16px] transition-opacity duration-[var(--dur-fast)] ease-fast',
          busy && showing > 0 && 'opacity-60',
        )}
      >
        {problem !== null && (
          <div className="surface sq flex items-start gap-[10px] rounded-card p-[14px]">
            <WarningCircle size={18} className="mt-[1px] shrink-0 text-bad" />
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-label">{problem}</p>
              <Button size="sm" className="mt-[8px]" onClick={reload}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {problem === null && view === 'repository' && empty && search.length > 0 && (
          <EmptyState
            icon={MagnifyingGlass}
            title={`No matches for "${search}"`}
            body="Search covers every party, contract name and signer."
            action={<Button onClick={() => changeSearch('')}>Clear search</Button>}
          />
        )}

        {problem === null && view === 'repository' && empty && search.length === 0 && (
          <EmptyState
            icon={Archive}
            title={FILTER_EMPTY[filter].title}
            body={FILTER_EMPTY[filter].body}
            action={
              filter === 'all' ? (
                <Button variant="primary" onClick={() => router.push('/inbox')}>
                  Go to the Inbox
                </Button>
              ) : (
                <Button onClick={() => setFilter('all')}>Show all records</Button>
              )
            }
          />
        )}

        {problem === null && view === 'repository' && rows.length > 0 && (
          <ContractTable
            rows={rows}
            sort={sort}
            dir={dir}
            onSortChange={(nextSort, nextDir) => {
              setSort(nextSort);
              setDir(nextDir);
            }}
            selectedId={openId}
            onSelect={setOpenId}
            density={density}
            onAction={act}
          />
        )}

        {problem === null && emptyRemoved && (
          <EmptyState
            icon={Trash}
            title={
              search.length > 0 ? `No removed records match "${search}"` : 'Nothing has been removed'
            }
            body="A record you remove waits here. Nothing is deleted from your Mac, and you can put any of them back."
            action={
              search.length > 0 ? (
                <Button onClick={() => changeSearch('')}>Clear search</Button>
              ) : (
                <Button onClick={() => setView('repository')}>Back to the repository</Button>
              )
            }
          />
        )}

        {problem === null && view === 'removed' && removed.length > 0 && (
          // One surface with hairlines between the rows, the same object the
          // table is. Not a card per record.
          <Card as="ul" padding="none" divided>
            {removed.map((row) => (
              <Row
                key={row.id}
                as="li"
                title={row.counterparty ?? row.contractName ?? DOC_TYPE_LABELS[row.docType]}
                subtitle={`${DOC_TYPE_LABELS[row.docType]} \u00b7 removed ${localDay(
                  row.archivedAt,
                )}`}
                trailing={
                  <Button
                    size="sm"
                    icon={<ArrowCounterClockwise size={12} />}
                    loading={restoring === row.id}
                    onClick={() => restore(row)}
                  >
                    Restore
                  </Button>
                }
                className="px-[14px]"
              />
            ))}
          </Card>
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
