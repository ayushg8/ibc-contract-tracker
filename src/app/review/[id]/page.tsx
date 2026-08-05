'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Prohibit, WarningCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { Button, EmptyState, Spinner, useToast } from '@/components/ui';
import { ReviewLayout } from '@/components/review/ReviewLayout';
import { api, usePoll, type DocumentResponse } from '@/lib/client/api';
import { refreshStats } from '@/lib/client/useStats';
import { FIELD_KEYS } from '@/lib/fields';
import type { DocType, DocumentStatus, FieldKey } from '@/lib/db/types';
import type { SerialisedEngineError } from '@/lib/providers/errors';

const IN_FLIGHT: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'queued',
  'hashing',
  'reading',
  'extracting',
]);

const POLL_MS = 2_000;
/** Ten minutes. Past that the queue is stuck, and polling is not the answer. */
const MAX_POLLS = 300;

/** The 409 from approve names the fields that blocked it. */
function firstUnresolvedKey(extra: Record<string, unknown>): FieldKey | null {
  const list = extra['unresolvedFields'];
  if (!Array.isArray(list)) return null;
  const first: unknown = list[0];
  if (typeof first !== 'object' || first === null || !('key' in first)) return null;
  const key = (first as { key: unknown }).key;
  return FIELD_KEYS.find((k) => k === key) ?? null;
}

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();

  const [detail, setDetail] = useState<DocumentResponse | null>(null);
  const [loadError, setLoadError] = useState<SerialisedEngineError | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<FieldKey>>(new Set());
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [docTypeSaving, setDocTypeSaving] = useState(false);
  const [manualOverride, setManualOverride] = useState(false);
  /**
   * Approve came back blocked on a field the panel thought was filled -- a stale
   * view. The key is parked until the fields have been re-read, then jumped to.
   */
  const [pendingFocus, setPendingFocus] = useState<FieldKey | null>(null);

  const polls = useRef(0);

  const load = useCallback(async () => {
    const result = await api.document(id);
    if (result.error !== undefined) {
      setLoadError(result.error);
      return;
    }
    setDetail(result.data);
    setLoadError(null);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const working = detail !== null && IN_FLIGHT.has(detail.document.status);

  useEffect(() => {
    polls.current = 0;
  }, [working]);

  usePoll(() => {
    if (!working) return;
    polls.current += 1;
    if (polls.current > MAX_POLLS) return;
    void load();
  }, POLL_MS);

  const patchField = useCallback(
    async (key: FieldKey, value: string | null, method: 'manual' | 'na') => {
      setSaving((current) => new Set(current).add(key));
      const result = await api.editField(id, key, value, method);
      if (result.error !== undefined) {
        toast({
          tone: 'bad',
          title: 'That change was not saved',
          description: result.error.message,
        });
        // Re-read rather than guess: the row on screen must match the database.
        await load();
      } else {
        setDetail((current) =>
          current === null ? current : { ...current, fields: result.data.fields },
        );
      }
      setSaving((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
    [id, load, toast],
  );

  /**
   * The one write with no endpoint in the HTTP contract yet. Sent in the shape a
   * PATCH on the document resource will take, so this becomes correct the moment
   * the route handler grows a PATCH; until then the value reverts and she is told.
   */
  const onDocTypeChange = useCallback(
    async (docType: DocType) => {
      const previous = detail?.document.docType ?? null;
      setDetail((current) =>
        current === null ? current : { ...current, document: { ...current.document, docType } },
      );
      setDocTypeSaving(true);
      const res = await fetch(`/api/documents/${id}`, {
        method: 'PATCH',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docType }),
      }).catch(() => null);
      if (res === null || !res.ok) {
        setDetail((current) =>
          current === null
            ? current
            : { ...current, document: { ...current.document, docType: previous } },
        );
        toast({
          tone: 'warn',
          title: 'The document type could not be saved',
          description: 'It still reads the way the extraction found it.',
        });
      }
      setDocTypeSaving(false);
    },
    [detail?.document.docType, id, toast],
  );

  const onApprove = useCallback(async () => {
    setApproving(true);
    const result = await api.approve(id);
    if (result.error !== undefined) {
      const blocker = firstUnresolvedKey(result.extra);
      toast({
        tone: 'bad',
        title: 'That could not be approved yet',
        description: result.error.message,
      });
      await load();
      if (blocker !== null) setPendingFocus(blocker);
      setApproving(false);
      return;
    }
    const { contract } = result.data;
    toast({
      tone: 'ok',
      title: `${contract.counterparty ?? 'That agreement'} is in the repository`,
      description: 'Its fields and quotes were saved with it.',
      action: { label: 'Open record', onClick: () => router.push('/repository') },
    });
    refreshStats();
    router.push('/inbox');
  }, [id, load, router, toast]);

  const onReject = useCallback(async () => {
    setRejecting(true);
    const result = await api.rejectDocument(id);
    if (result.error !== undefined) {
      toast({
        tone: 'bad',
        title: 'That could not be rejected',
        description: result.error.message,
      });
      setRejecting(false);
      return;
    }
    toast({
      title: `${detail?.document.filename ?? 'That document'} was rejected`,
      description: 'It is out of the Inbox. Nothing was deleted from the archive.',
      action: {
        label: 'Reopen',
        onClick: () => {
          void api.retryDocument(id).then(() => {
            refreshStats();
            router.push(`/review/${id}`);
          });
        },
      },
    });
    refreshStats();
    router.push('/inbox');
  }, [detail?.document.filename, id, router, toast]);

  const onRetry = useCallback(async () => {
    setRetrying(true);
    const result = await api.retryDocument(id);
    if (result.error !== undefined) {
      toast({
        tone: 'bad',
        title: 'That document could not be re-read',
        description: result.error.message,
      });
    } else {
      setManualOverride(false);
      await load();
      refreshStats();
    }
    setRetrying(false);
  }, [id, load, toast]);

  const back = useCallback(() => router.push('/inbox'), [router]);

  if (detail === null) {
    return loadError === null ? (
      <ReviewSkeleton onBack={back} />
    ) : (
      <TerminalState
        icon={WarningCircle}
        title={loadError.message}
        body={loadError.remedy.hint}
        onBack={back}
        action={
          loadError.retryable ? <Button onClick={() => void load()}>Try again</Button> : undefined
        }
      />
    );
  }

  const { document, fields, contract } = detail;

  if (document.status === 'rejected') {
    return (
      <TerminalState
        icon={Prohibit}
        title="This document was rejected."
        body="Reopening it reads the document again from scratch."
        onBack={back}
        action={
          <Button loading={retrying} onClick={() => void onRetry()}>
            Reopen
          </Button>
        }
      />
    );
  }

  if (document.status === 'failed' && !manualOverride) {
    return (
      <TerminalState
        icon={WarningCircle}
        title={document.errorMessage ?? 'This document could not be read.'}
        body="Nothing was saved against it, so trying again costs nothing."
        onBack={back}
        action={
          <div className="flex items-center gap-[8px]">
            <Button variant="primary" loading={retrying} onClick={() => void onRetry()}>
              Try again
            </Button>
            <Button onClick={() => setManualOverride(true)}>Fill in manually</Button>
            <Button variant="ghost" onClick={() => router.push('/settings')}>
              Open Settings
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <ReviewLayout
      document={document}
      fields={fields}
      contract={contract}
      phase={IN_FLIGHT.has(document.status) ? 'extracting' : 'review'}
      focusKey={pendingFocus}
      onFocusHandled={() => setPendingFocus(null)}
      onCommitField={(key, value) => void patchField(key, value, 'manual')}
      onNotApplicable={(key) => void patchField(key, null, 'na')}
      onDocTypeChange={(type) => void onDocTypeChange(type)}
      onApprove={() => void onApprove()}
      onReject={() => void onReject()}
      onRetry={() => void onRetry()}
      onBack={back}
      onOpenRecord={() => router.push('/repository')}
      savingKeys={saving}
      approving={approving}
      rejecting={rejecting}
      retrying={retrying}
      docTypeSaving={docTypeSaving}
    />
  );
}

/* ─────────────────────────────── sub-states ─────────────────────────────── */

function BackHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="hairline-b flex shrink-0 items-center gap-[10px] px-[12px] py-[8px]">
      <Button size="sm" variant="ghost" icon={<ArrowLeft size={12} />} onClick={onBack}>
        Inbox
      </Button>
    </header>
  );
}

function TerminalState({
  icon,
  title,
  body,
  onBack,
  action,
}: {
  icon: Icon;
  title: string;
  body?: string;
  onBack: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BackHeader onBack={onBack} />
      <div className="grid min-h-0 flex-1 place-items-center">
        <EmptyState icon={icon} title={title} body={body} action={action} />
      </div>
    </div>
  );
}

function ReviewSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BackHeader onBack={onBack} />
      <div className="flex min-h-0 flex-1">
        <div className="grid flex-[58] place-items-center bg-sunken">
          <Spinner size={18} label="Opening the document" className="text-label-tertiary" />
        </div>
        <span aria-hidden className="w-[0.5px] bg-separator" />
        <div aria-hidden className="flex flex-[42] flex-col gap-[18px] bg-surface p-[16px]">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex flex-col gap-[6px]">
              <div className="h-[11px] w-[80px] rounded-full bg-hover" />
              <div className="h-[13px] w-[70%] rounded-full bg-hover" />
              <div className="h-[24px] w-full rounded-row bg-hover" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
