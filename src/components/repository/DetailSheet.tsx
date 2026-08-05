'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  ArrowSquareOut,
  ArrowUUpLeft,
  ArrowsClockwise,
  DotsThree,
  FilePdf,
  Quotes,
  Trash,
} from '@phosphor-icons/react';

import { AuditTimeline } from '@/components/repository/AuditTimeline';
import { ProvenanceNotes } from '@/components/provenance/ProvenanceNotes';
import {
  Button,
  DataList,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Quote,
  SectionHeader,
  Sheet,
  Spinner,
  StatTile,
  TextArea,
  useToast,
} from '@/components/ui';
import type { DataListItem, StatTone } from '@/components/ui';
import { api, type ContractResponse } from '@/lib/client/api';
import {
  citationCounts,
  citationSummary,
  citationVerdict,
  provenanceNotices,
  type ProvenanceInput,
} from '@/lib/client/provenance';
import { useRecordActions, type RecordTarget } from '@/lib/client/useRecordActions';
import type {
  AgreementStatus,
  ContractDetail,
  DocumentDetail,
  FieldKey,
  FieldRecord,
} from '@/lib/db/types';
import { PROMPT_VERSION } from '@/lib/extraction/prompt';
import { DOC_TYPE_LABELS } from '@/lib/fields';
import { STATUS_LABELS } from '@/lib/status';
import { formatDate, parseDateIso, parseDuration } from '@/lib/util/dates';
import { displayTitle, localDay, MISSING, partyTag, relativeDays, sentenceCase } from './format';

/** Her choice of clean vs evidence outlives the sheet, the row and the session. */
const SOURCES_KEY = 'ibc.sources';

/**
 * The order fields are read in, top to bottom. A quote is printed under the
 * FIRST field that carries it and nowhere else: party A and party B routinely
 * cite the same preamble sentence, and printing it twice, twenty pixels apart,
 * is how the old sheet advertised that nobody had looked at it.
 */
const READING_ORDER: readonly FieldKey[] = [
  'contract_name',
  'party_a',
  'party_a_signer',
  'party_a_address',
  'party_b',
  'party_b_signer',
  'party_b_address',
  'party_c',
  'effective_date',
  'term',
  'termination_date',
  'confidentiality_term',
  'governing_law',
  'ibc_form',
  'notice_email',
  'notice_address',
];

const PARTY_KEYS: Record<'a' | 'b' | 'c', { name: FieldKey; signer?: FieldKey; address?: FieldKey }> =
  {
    a: { name: 'party_a', signer: 'party_a_signer', address: 'party_a_address' },
    b: { name: 'party_b', signer: 'party_b_signer', address: 'party_b_address' },
    c: { name: 'party_c' },
  };

const CLOCK_TONE: Record<AgreementStatus, StatTone> = {
  active: 'ok',
  expiring: 'warn',
  expired: 'bad',
  unknown: 'default',
};

function clockHeadline(status: AgreementStatus, days: number | null): string {
  if (status === 'expiring' && days !== null) {
    return days === 1 ? '1 day left' : `${days} days left`;
  }
  return STATUS_LABELS[status];
}

export interface DetailSheetProps {
  contractId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired after a saved edit, and after any of the record actions, so the list
   * behind can pick up recomputed dates or drop a record that has left it.
   */
  onEdited?: () => void;
}

/**
 * The repository record, from the right. A sheet rather than a route so the list
 * keeps its scroll position and its selection.
 *
 * Two modes. CLEAN is the default and shows the record the way a person would
 * write it down: two clocks, two parties, one column of terms. EVIDENCE adds the
 * verbatim quote under every value that has one. The receipt is available on
 * demand and never louder than the answer.
 */
export function DetailSheet({ contractId, open, onOpenChange, onEdited }: DetailSheetProps) {
  const { toast } = useToast();
  const [data, setData] = useState<ContractResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sources, setSources] = useSources();
  /**
   * The document behind the record. Null until it arrives.
   *
   * Fetched whenever the sheet opens rather than when the menu does, because how
   * the document was read is a caveat about every value on screen -- it cannot
   * live behind a menu. The prompt version rides along on the same read.
   */
  const [doc, setDoc] = useState<(DocumentDetail & ProvenanceInput) | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = useCallback(() => onEdited?.(), [onEdited]);
  const actions = useRecordActions(changed);

  const load = useCallback(async (id: string): Promise<void> => {
    const result = await api.contract(id);
    if (result.error !== undefined) {
      setFailure(result.error.message);
      return;
    }
    setData(result.data);
    setFailure(null);
  }, []);

  useEffect(() => {
    if (!open || contractId === null) return;
    let cancelled = false;
    setData(null);
    setDoc(null);
    setLoading(true);
    setFailure(null);
    void load(contractId).then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, contractId, load]);

  const documentId = data?.contract.documentId ?? null;

  useEffect(() => {
    if (!open || documentId === null) return;
    let cancelled = false;
    void api.document(documentId).then((result) => {
      // A failure here costs the provenance line and the prompt note, not the
      // record: the sheet has already rendered everything the contract knows.
      if (cancelled || result.error !== undefined) return;
      setDoc(result.data.document);
    });
    return () => {
      cancelled = true;
    };
  }, [open, documentId]);

  const fields = useMemo(() => {
    const map = new Map<FieldKey, FieldRecord>();
    for (const field of data?.fields ?? []) map.set(field.key, field);
    return map;
  }, [data]);

  /** The fields whose quote is theirs to print. See READING_ORDER. */
  const quoteOwner = useMemo(() => {
    const owners = new Set<FieldKey>();
    const seen = new Set<string>();
    for (const key of READING_ORDER) {
      const quote = fields.get(key)?.quote;
      if (quote === undefined || quote === null) continue;
      const normalised = quote.replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalised.length === 0 || seen.has(normalised)) continue;
      seen.add(normalised);
      owners.add(key);
    }
    return owners;
  }, [fields]);

  /**
   * A record in the repository has already been approved, so a confidence dot on
   * every row is decoration. The one thing still worth saying is that a value we
   * are showing was not traced back to the document -- not that a model, rather
   * than a regex, is what read it.
   *
   * Counted on the verdict, not on `=== false`. The old test made this line read
   * zero for the documents that need it most: a scan read as page images stores
   * every citation as "not checked", and none of those are false.
   */
  const uncertain = useMemo(() => citationCounts(fields.values()), [fields]);
  const uncertainLine = citationSummary(uncertain);

  /** How this record's document was read, as sentences. */
  const notices = useMemo(() => (doc === null ? [] : provenanceNotices(doc)), [doc]);

  /**
   * The rows a re-read would carry across: everything a human typed or marked as
   * not applicable. Counted from the record itself so the menu can say what will
   * survive before she presses it, rather than after.
   */
  const handFilled = useMemo(
    () => [...fields.values()].filter((f) => f.method === 'manual' || f.method === 'na').length,
    [fields],
  );

  const save = useCallback(
    async (key: FieldKey, value: string | null): Promise<boolean> => {
      if (contractId === null) return false;
      const result = await api.editContractField(contractId, key, value);
      if (result.error !== undefined) {
        toast({
          title: 'That change was not saved',
          description: result.error.message,
          tone: 'bad',
        });
        return false;
      }
      // Re-read rather than merge: the edit writes an audit row and may move the
      // computed dates, and the history has to show that immediately.
      await load(contractId);
      onEdited?.();
      return true;
    },
    [contractId, load, onEdited, toast],
  );

  const contract = data?.contract ?? null;

  /** Every action leaves the record somewhere else, so the sheet closes behind it. */
  const run = useCallback(
    (action: (target: RecordTarget) => Promise<boolean>) => {
      if (contract === null || busy) return;
      const target: RecordTarget = {
        contractId: contract.id,
        documentId: contract.documentId,
        label: contract.counterparty ?? displayTitle(contract.contractName) ?? contract.filename,
      };
      setBusy(true);
      void action(target).then((ok) => {
        setBusy(false);
        if (ok) onOpenChange(false);
      });
    },
    [busy, contract, onOpenChange],
  );

  function evidence(key: FieldKey): ReactNode {
    if (!sources) return undefined;
    if (!quoteOwner.has(key)) return undefined;
    const field = fields.get(key);
    if (field?.quote == null) return undefined;
    return (
      <Quote
        text={field.quote}
        density="inline"
        clamp={2}
        {...(field.page !== null ? { page: field.page } : {})}
        // All three states. `!== false` used to be here, so a quote off a scan
        // that nobody had checked rendered as a proven one.
        verified={citationVerdict(field)}
      />
    );
  }

  function editable(key: FieldKey, options?: { display?: string | null }): ReactNode {
    const field = fields.get(key);
    if (field === undefined) return <span className="text-label-tertiary">{MISSING}</span>;
    return (
      <EditableValue
        field={field}
        display={options?.display ?? field.value}
        onSave={save}
      />
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={contract?.counterparty ?? 'Contract'}
      surface="paper"
      toolbar={
        contract === null ? undefined : (
          <>
            <Button
              size="sm"
              variant={sources ? 'secondary' : 'ghost'}
              aria-pressed={sources}
              icon={<Quotes size={13} weight={sources ? 'fill' : 'regular'} />}
              onClick={() => setSources(!sources)}
            >
              Sources
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="More actions for this record" size="sm" loading={busy}>
                  <DotsThree size={16} weight="bold" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end" minWidth={252}>
                <MenuItem
                  icon={ArrowUUpLeft}
                  onSelect={() => run(actions.sendBackToInbox)}
                >
                  Send back to the Inbox
                </MenuItem>
                <MenuItem
                  icon={ArrowsClockwise}
                  onSelect={() => run((target) => actions.reread(target, handFilled))}
                >
                  Re-read this document
                </MenuItem>
                <RereadNote
                  readWith={doc === null ? null : (doc.promptVersion ?? '')}
                  handFilled={handFilled}
                />
                <MenuSeparator />
                <MenuItem destructive icon={Trash} onSelect={() => run(actions.remove)}>
                  Remove from the repository
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        )
      }
    >
      {loading && (
        <div className="flex items-center justify-center gap-[8px] py-[40px] text-label-secondary">
          <Spinner size={16} />
          <span className="text-callout">Opening the record...</span>
        </div>
      )}

      {failure !== null && (
        <div className="py-[8px] text-callout">
          <p className="font-medium text-label">{failure}</p>
          <p className="mt-[4px] text-label-secondary">Close the sheet and open the row again.</p>
        </div>
      )}

      {contract !== null && data !== null && (
        <div className="pb-[8px]">
          <h2 className="text-title-1 font-medium text-label-secondary">
            {displayTitle(contract.contractName) ?? DOC_TYPE_LABELS[contract.docType]}
          </h2>

          {uncertainLine !== null && !sources && (
            <p className="mt-[4px] text-callout text-label-tertiary">
              {uncertainLine}{' '}
              <button
                type="button"
                onClick={() => setSources(true)}
                className="text-accent underline-offset-2 hover:underline"
              >
                Show sources
              </button>
            </p>
          )}

          {/* Next to the evidence, not in History: a record read off a scan is
              carrying a caveat on every value, and a caveat filed under a
              timeline entry is a caveat nobody reads. */}
          <ProvenanceNotes notices={notices} className="mt-[12px]" />

          {/* The two clocks. Full-bleed so the tiles divide the sheet rather than
              sitting in boxes on it: a 90-day evaluation agreement can carry a
              five-year duty of confidence, and one status line cannot say so. */}
          <div className="hairline-t hairline-b -mx-[16px] mt-[14px] grid grid-cols-1 divide-y-[0.5px] divide-separator sm:grid-cols-2 sm:divide-x-[0.5px] sm:divide-y-0">
            <StatTile
              label="Agreement"
              value={clockHeadline(contract.agreementStatus, contract.daysRemaining)}
              tone={CLOCK_TONE[contract.agreementStatus]}
              supporting={agreementSupport(contract)}
            />
            <ConfidentialityTile contract={contract} />
          </div>

          <Section title="Parties">
            <div className="flex flex-col gap-[14px]">
              {contract.parties.map((party) => {
                const keys = PARTY_KEYS[party.role];
                return (
                  <div key={party.role}>
                    <div className="flex items-baseline justify-between gap-[10px]">
                      <div className="min-w-0 flex-1 text-title-3 font-medium text-label">
                        {editable(keys.name, { display: party.name })}
                      </div>
                      <span className="eyebrow shrink-0">{partyTag(party)}</span>
                    </div>
                    {party.signer !== null && keys.signer !== undefined && (
                      <div className="mt-[2px] text-body text-label-secondary">
                        {editable(keys.signer, { display: party.signer })}
                      </div>
                    )}
                    {party.address !== null && keys.address !== undefined && (
                      <div className="mt-[1px] text-callout text-label-secondary">
                        {editable(keys.address, { display: party.address })}
                      </div>
                    )}
                    {evidence(keys.name)}
                    {keys.signer !== undefined && evidence(keys.signer)}
                    {keys.address !== undefined && evidence(keys.address)}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Terms">
            <DataList items={terms(contract, editable, evidence)} labelWidth={148} />
          </Section>

          <Section title="Notice">
            <div className="text-body text-label">
              {contract.noticeEmail === null ? (
                <span className="text-label-tertiary">No notice email in the document</span>
              ) : (
                editable('notice_email')
              )}
            </div>
            {evidence('notice_email')}
            <div className="mt-[2px] text-callout text-label-secondary">
              {contract.noticeAddress === null ? (
                <span className="text-label-tertiary">No notice address in the document</span>
              ) : (
                editable('notice_address')
              )}
            </div>
            {evidence('notice_address')}
          </Section>

          <Section title="Document">
            <div className="flex items-center gap-[12px]">
              <Thumbnail documentId={contract.documentId} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-label">{contract.filename}</p>
                <p className="tabular mt-[2px] text-callout text-label-secondary">
                  Approved {localDay(contract.approvedAt)}
                  {contract.editedAt !== null && ` \u00b7 edited ${localDay(contract.editedAt)}`}
                </p>
              </div>
              <Button
                size="sm"
                icon={<ArrowSquareOut size={13} />}
                onClick={() => window.open(contract.pdfUrl, '_blank', 'noopener')}
              >
                Open
              </Button>
            </div>
          </Section>

          <Section title="History">
            <AuditTimeline entries={data.audit} />
          </Section>
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------- Pieces ------------------------------- */

/**
 * Sits under "Re-read this document" and is the whole argument for pressing it:
 * a record read by an older prompt may be missing something the current one
 * finds, and what she typed herself survives the read either way. Indented to
 * the item's label rather than its icon, so it reads as a footnote to that line
 * and not as a fourth action.
 *
 * One paragraph rather than two lines: a four-item menu cannot carry two
 * footnotes without turning into a document.
 */
function RereadNote({ readWith, handFilled }: { readWith: string | null; handFilled: number }) {
  // null = not fetched yet, '' = the document has no stored version.
  const version = readWith === null || readWith.length === 0 ? null : readWith;
  const stale = version !== null && version !== PROMPT_VERSION;

  const prompt =
    version === null
      ? null
      : stale
        ? `Read with prompt ${version}. ${PROMPT_VERSION} is current.`
        : `Read with prompt ${version}, the current one.`;

  const kept =
    handFilled === 0
      ? null
      : handFilled === 1
        ? 'The one field you filled in by hand is kept.'
        : `The ${handFilled} fields you filled in by hand are kept.`;

  if (prompt === null && kept === null) return null;

  return (
    <p
      className={clsx(
        'px-[8px] pb-[4px] pl-[30px] text-footnote',
        stale ? 'text-warn' : 'text-label-tertiary',
      )}
    >
      {[prompt, kept].filter((part) => part !== null).join(' ')}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-[20px]">
      <SectionHeader title={title} rule as="h3" className="mb-[8px]" />
      {children}
    </section>
  );
}

function agreementSupport(contract: ContractDetail): string {
  const end = formatDate(contract.terminationDate);
  const relative = relativeDays(contract.daysRemaining);
  if (end.length === 0) return contract.term ?? 'No end date on file';
  return relative === null ? end : `${end} \u00b7 ${relative}`;
}

/**
 * The obligation outlives the agreement often enough that "no end date" is a
 * headline, not a gap. Perpetual is the answer, not a missing value.
 */
function ConfidentialityTile({ contract }: { contract: ContractDetail }) {
  const term = contract.confidentialityTerm?.trim() ?? '';
  const perpetual = parseDuration(term)?.kind === 'perpetual';

  if (contract.confidentialityEnd !== null) {
    const relative = relativeDays(contract.confidentialityDaysRemaining);
    const end = formatDate(contract.confidentialityEnd);
    return (
      <StatTile
        label="Confidentiality"
        value={clockHeadline(
          contract.confidentialityStatus,
          contract.confidentialityDaysRemaining,
        )}
        tone={CLOCK_TONE[contract.confidentialityStatus]}
        supporting={relative === null ? end : `${end} \u00b7 ${relative}`}
      />
    );
  }

  return (
    <StatTile
      label="Confidentiality"
      value={term.length > 0 ? sentenceCase(term) : 'Not stated'}
      supporting={
        perpetual
          ? 'No end date \u00b7 still bound'
          : term.length > 0
            ? 'No end date could be computed'
            : 'No confidentiality clause was found'
      }
    />
  );
}

function terms(
  contract: ContractDetail,
  editable: (key: FieldKey, options?: { display?: string | null }) => ReactNode,
  evidence: (key: FieldKey) => ReactNode,
): DataListItem[] {
  const rows: { key: FieldKey; label: string; display: string | null }[] = [
    { key: 'effective_date', label: 'Effective', display: dateText(contract.effectiveDate) },
    { key: 'term', label: 'Term', display: durationText(contract.term) },
    { key: 'termination_date', label: 'Expires', display: dateText(contract.terminationDate) },
    {
      key: 'confidentiality_term',
      label: 'Confidentiality',
      display: durationText(contract.confidentialityTerm),
    },
    { key: 'governing_law', label: 'Governing law', display: contract.governingLaw },
    { key: 'ibc_form', label: 'IBC form', display: contract.ibcForm },
  ];

  return rows.map(({ key, label, display }) => {
    const hint = evidence(key);
    return {
      label,
      value: editable(key, { display }),
      ...(hint !== undefined ? { hint } : {}),
    };
  });
}

/** Dates read as prose in the sheet; the table is where they are columns. */
function dateText(iso: string | null): string | null {
  const formatted = formatDate(iso);
  return formatted.length > 0 ? formatted : iso;
}

/** So the row and the tile above it do not print "in perpetuity" two ways. */
function durationText(term: string | null): string | null {
  const trimmed = term?.trim() ?? '';
  return trimmed.length > 0 ? sentenceCase(trimmed) : null;
}

/**
 * Click the value, type, Enter. No pencil, no per-field card, no toolbar: the
 * value IS the control, which is how a record on a Mac behaves.
 */
function EditableValue({
  field,
  display,
  onSave,
}: {
  field: FieldRecord;
  display: string | null;
  onSave: (key: FieldKey, value: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);

  function start() {
    setDraft(field.value ?? '');
    setInvalid(false);
    setEditing(true);
  }

  async function commit() {
    const next = draft.trim();
    if (next === (field.value ?? '')) {
      setEditing(false);
      return;
    }
    /*
     * A date column feeds the termination and confidentiality arithmetic, so a
     * half-typed date is refused rather than silently stored as text.
     *
     * parseDateIso, not isIsoDate: Review accepted "March 1, 2024" and normalised it,
     * while this screen refused the same text -- under the identical footnote about
     * year-month-day. One field, two rules, one sentence explaining neither. Accept
     * what she can reasonably type and store the normalised form; refuse only what
     * genuinely is not a date.
     */
    let value: string | null = next.length > 0 ? next : null;
    if (field.type === 'date' && value !== null) {
      const iso = parseDateIso(value);
      if (iso === null) {
        setInvalid(true);
        return;
      }
      value = iso;
    }
    setSaving(true);
    const ok = await onSave(field.key, value);
    setSaving(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    const multiline = field.type === 'longtext';
    return (
      <span className="block py-[2px]">
        {multiline ? (
          <TextArea
            autoFocus
            autoResize
            rows={2}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void commit();
              }
            }}
          />
        ) : (
          <Input
            autoFocus
            value={draft}
            invalid={invalid}
            disabled={saving}
            placeholder={field.type === 'date' ? 'YYYY-MM-DD' : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                void commit();
              }
            }}
          />
        )}
        <span className="mt-[5px] flex items-center gap-[6px]">
          <Button size="sm" variant="primary" loading={saving} onClick={() => void commit()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <span className="text-footnote text-label-tertiary">
            {invalid
              ? 'Dates go in as year-month-day, e.g. 2027-11-05.'
              : field.readOnly
                ? 'Saving this marks the date as overridden.'
                : 'Every edit is logged.'}
          </span>
        </span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      title={`Edit ${field.label.toLowerCase()}`}
      className="sq -mx-[6px] block w-[calc(100%+12px)] rounded-row px-[6px] py-[1px] text-left transition-colors duration-[var(--dur-fast)] ease-fast hover:bg-hover"
    >
      <span
        className={clsx(
          'block whitespace-pre-wrap break-words',
          display === null && 'text-label-tertiary',
        )}
      >
        {display ?? MISSING}
      </span>
    </button>
  );
}

function Thumbnail({ documentId }: { documentId: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="sq grid h-[72px] w-[56px] shrink-0 place-items-center rounded-row bg-sunken">
        <FilePdf size={20} className="text-label-tertiary" />
      </div>
    );
  }
  return (
    <img
      src={`/api/documents/${documentId}/thumbnail`}
      alt="First page of the signed agreement"
      onError={() => setBroken(true)}
      className="sq h-[72px] w-[56px] shrink-0 rounded-row object-cover object-top shadow-e1"
    />
  );
}

/**
 * Persisted because it is a preference, not a mode: someone who wants to see the
 * provenance wants it on the next record too, and re-arming a toggle sixteen
 * times is how a feature gets abandoned.
 */
function useSources(): [boolean, (value: boolean) => void] {
  const [on, setOn] = useState(false);

  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(SOURCES_KEY) === '1');
    } catch {
      // Private windows refuse storage; the default is the right fallback.
    }
  }, []);

  const set = useCallback((value: boolean) => {
    setOn(value);
    try {
      window.localStorage.setItem(SOURCES_KEY, value ? '1' : '0');
    } catch {
      // Ignored for the same reason.
    }
  }, []);

  return [on, set];
}
