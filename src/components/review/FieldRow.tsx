'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import clsx from 'clsx';
import { PencilSimple } from '@phosphor-icons/react';
import {
  Button,
  Dot,
  Input,
  Pill,
  Quote,
  Select,
  Spinner,
  TextArea,
} from '@/components/ui';
import { citationVerdict } from '@/lib/client/provenance';
import type { FieldKey, FieldRecord } from '@/lib/db/types';
import { parseDateIso } from '@/lib/util/dates';

export interface FieldRowProps {
  field: FieldRecord;
  onCommit: (key: FieldKey, value: string | null) => void;
  onNotApplicable: (key: FieldKey) => void;
  /** Jump the PDF to this field's citation. */
  onQuoteClick: (field: FieldRecord) => void;
  saving?: boolean;
  /** Approved records are read through this component too. */
  locked?: boolean;
  /** The row the attention navigator is parked on. */
  active?: boolean;
  /** Hairline above. Every row in a group but the first. */
  rule?: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Dates are stored ISO and read long. Built from the parts rather than parsed:
 * `new Date('2022-11-05')` is UTC midnight, which prints as the 4th west of
 * Greenwich.
 */
function prettyDate(value: string): string {
  const parts = ISO_DATE.exec(value);
  if (parts === null) return value;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return value;
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function display(field: FieldRecord): string {
  const value = field.value ?? '';
  return field.type === 'date' ? prettyDate(value) : value;
}

/** Word for word what DetailSheet says, so one product does not speak two ways. */
const BAD_DATE = 'Dates go in as year-month-day, e.g. 2027-11-05.';

export function FieldRow({
  field,
  onCommit,
  onNotApplicable,
  onQuoteClick,
  saving = false,
  locked = false,
  active = false,
  rule = false,
}: FieldRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const reverting = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const select = useRef<HTMLSelectElement>(null);

  const missing = field.value === null && field.method !== 'na';
  const notApplicable = field.method === 'na';
  const multiline = field.type === 'longtext';
  const choice = field.type === 'boolean';

  useEffect(() => {
    if (!editing) return;
    if (choice) {
      select.current?.focus();
      return;
    }
    const node = multiline ? textArea.current : input.current;
    node?.focus();
    node?.select();
  }, [editing, multiline, choice]);

  const begin = useCallback(() => {
    if (locked) return;
    setDraft(field.value ?? '');
    setInvalid(false);
    setEditing(true);
  }, [field.value, locked]);

  /**
   * A date leaves this row as ISO or it does not leave at all.
   *
   * "TBD" typed into Effective Date used to be stored verbatim, which is a
   * non-null value, which satisfied the required-field gate -- so Approve lit up
   * on a record that had no date, no termination, and two blank Excel cells,
   * while this pane went on showing "TBD". Two screens disagreeing about one
   * field is how she stops trusting the tracker.
   *
   * parseDateIso, not a format check: she types dates the way people type dates,
   * and "March 1, 2024" is a date we can resolve deterministically. What it
   * cannot resolve stays in edit state, marked invalid, with her text intact.
   */
  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setEditing(false);
      setInvalid(false);
      if (field.value !== null) onCommit(field.key, null);
      return;
    }

    let next = trimmed;
    if (field.type === 'date') {
      const iso = parseDateIso(trimmed);
      if (iso === null) {
        setInvalid(true);
        return;
      }
      next = iso;
    }

    setEditing(false);
    setInvalid(false);
    if (next !== field.value) onCommit(field.key, next);
  }, [draft, field.key, field.type, field.value, onCommit]);

  const handleBlur = useCallback(() => {
    if (reverting.current) {
      reverting.current = false;
      setEditing(false);
      setInvalid(false);
      return;
    }
    commit();
  }, [commit]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        reverting.current = true;
        setEditing(false);
        setInvalid(false);
        return;
      }
      // A newline is real content in an address, so a textarea commits on the
      // modifier instead.
      const enterCommits = event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey);
      if (enterCommits) {
        event.preventDefault();
        commit();
      }
    },
    [commit, multiline],
  );

  return (
    <div
      data-field-key={field.key}
      className={clsx(
        'sq scroll-mt-[64px] rounded-row px-[12px] py-[10px] transition-colors duration-[var(--dur-fast)] ease-fast',
        rule && 'hairline-t',
        active && 'bg-hover',
      )}
    >
      <div className="flex items-center justify-between gap-[8px]">
        <span className="text-subhead text-label-secondary">{field.label}</span>
        <span className="flex items-center gap-[6px]">
          {field.readOnly && <Pill tone="quiet">computed</Pill>}
          {saving ? (
            <Spinner size={11} className="text-label-tertiary" />
          ) : notApplicable ? (
            <Pill tone="quiet">N/A</Pill>
          ) : (
            <Dot confidence={field.confidence} />
          )}
        </span>
      </div>

      <div className="mt-[2px]">
        {editing ? (
          multiline ? (
            <TextArea
              ref={textArea}
              autoResize
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              aria-label={field.label}
            />
          ) : choice ? (
            <Select
              ref={select}
              size="sm"
              placeholder="Choose"
              options={[
                { value: 'Yes', label: 'Yes' },
                { value: 'No', label: 'No' },
              ]}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              aria-label={field.label}
            />
          ) : (
            // No box around the pair: the message is a footnote under the field,
            // the way the detail sheet writes it.
            <>
              <Input
                ref={input}
                size="sm"
                value={draft}
                invalid={invalid}
                placeholder={field.type === 'date' ? 'YYYY-MM-DD' : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setInvalid(false);
                }}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                aria-label={field.label}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? `${field.key}-date-hint` : undefined}
              />
              {invalid && (
                <p id={`${field.key}-date-hint`} className="mt-[4px] text-footnote text-bad">
                  {BAD_DATE}
                </p>
              )}
            </>
          )
        ) : missing || notApplicable ? (
          <div className="flex flex-wrap items-center gap-[6px]">
            <span className="text-body italic text-label-tertiary">
              {notApplicable ? 'Not in this document' : 'not found in document'}
            </span>
            {!locked && (
              <>
                <Button size="sm" variant="ghost" onClick={begin}>
                  <span className="text-accent">
                    {notApplicable ? 'Enter a value' : 'Enter manually'}
                  </span>
                </Button>
                {!notApplicable && (
                  <Button size="sm" variant="ghost" onClick={() => onNotApplicable(field.key)}>
                    <span className="text-label-secondary">Not applicable</span>
                  </Button>
                )}
              </>
            )}
          </div>
        ) : field.readOnly ? (
          <div className="flex items-center justify-between gap-[8px]">
            <span className="whitespace-pre-wrap text-body font-medium text-label">
              {display(field)}
            </span>
            {!locked && (
              // Overriding a derived date is allowed, but it has to be asked for:
              // a stray click must never silently detach it from the term.
              <Button
                size="sm"
                variant="ghost"
                icon={<PencilSimple size={11} />}
                onClick={begin}
                title="Override the computed value"
              >
                <span className="text-label-secondary">Override</span>
              </Button>
            )}
          </div>
        ) : (
          <button
            type="button"
            data-field-focus
            onClick={begin}
            disabled={locked}
            aria-label={`${field.label}: ${display(field)}`}
            className="sq -mx-[4px] block w-full rounded-control px-[4px] py-[1px] text-left transition-colors duration-[var(--dur-fast)] ease-fast hover:bg-hover disabled:hover:bg-transparent"
          >
            <span className="whitespace-pre-wrap text-body font-medium text-label">
              {display(field)}
            </span>
          </button>
        )}
      </div>

      {field.quote !== null && field.quote.length > 0 && (
        // Two lines, not three: the evidence supports the value above it and must
        // never take more of the row than the value does.
        <div className="mt-[6px] flex flex-col gap-[3px]">
          <Quote
            text={field.quote}
            page={field.page ?? undefined}
            // Straight through, all three states. `!== false` used to be here,
            // which rendered a quote nobody had checked as a proven one.
            verified={citationVerdict(field)}
            onClick={() => onQuoteClick(field)}
            clamp={2}
          />
          {field.citationVerified === false && (
            <p className="text-footnote text-label-tertiary">
              This wording is in the document, but the value does not clearly follow from it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
