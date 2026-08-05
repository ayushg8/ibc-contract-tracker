'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Lock } from '@phosphor-icons/react';
import { SectionHeader } from '@/components/ui';
import { FIELD_GROUPS } from '@/lib/fields';
import type { FieldKey, FieldRecord } from '@/lib/db/types';
import { AttentionNav } from './AttentionNav';
import { FieldRow } from './FieldRow';

export interface FieldPanelHandle {
  /** Scroll a field into view and put the caret on it. */
  focusField: (key: FieldKey) => void;
}

export interface FieldPanelProps {
  fields: FieldRecord[];
  onCommit: (key: FieldKey, value: string | null) => void;
  onNotApplicable: (key: FieldKey) => void;
  onQuoteClick: (field: FieldRecord) => void;
  savingKeys?: ReadonlySet<FieldKey>;
  /** Approved records are read-only until she explicitly edits the contract. */
  locked?: boolean;
}

/** A settled field is one a human or a rule stands behind. */
function needsAttention(field: FieldRecord): boolean {
  return field.method !== 'na' && field.confidence !== 'high';
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export const FieldPanel = forwardRef<FieldPanelHandle, FieldPanelProps>(function FieldPanel(
  { fields, onCommit, onNotApplicable, onQuoteClick, savingKeys, locked = false },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = useState<FieldKey | null>(null);

  /**
   * Grouped order, not FIELD_KEYS order: J and K have to walk down the screen.
   * Following the schema order instead makes the caret jump between sections.
   */
  const groups = useMemo(
    () =>
      FIELD_GROUPS.map((group) => ({
        ...group,
        rows: fields.filter((f) => f.group === group.id),
      })).filter((group) => group.rows.length > 0),
    [fields],
  );

  const attention = useMemo(
    () => groups.flatMap((group) => group.rows.filter(needsAttention).map((f) => f.key)),
    [groups],
  );

  const focusField = useCallback((key: FieldKey) => {
    setActiveKey(key);
    const root = container.current;
    if (root === null) return;
    const row = root.querySelector<HTMLElement>(`[data-field-key="${key}"]`);
    if (row === null) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // The value control if there is one, otherwise whatever the row offers --
    // a missing field's first control is "Enter manually".
    const target =
      row.querySelector<HTMLElement>('[data-field-focus]') ??
      row.querySelector<HTMLElement>('button, input, textarea, select');
    target?.focus({ preventScroll: true });
  }, []);

  useImperativeHandle(ref, () => ({ focusField }), [focusField]);

  const step = useCallback(
    (delta: number) => {
      if (attention.length === 0) return;
      const at = activeKey === null ? -1 : attention.indexOf(activeKey);
      const next =
        at < 0
          ? delta > 0
            ? 0
            : attention.length - 1
          : (at + delta + attention.length) % attention.length;
      const key = attention[next];
      if (key !== undefined) focusField(key);
    },
    [attention, activeKey, focusField],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      event.preventDefault();
      step(key === 'j' ? 1 : -1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step]);

  const index = activeKey === null ? -1 : attention.indexOf(activeKey);

  return (
    // One surface for the whole panel. The header sits INSIDE the scroller so the
    // fields pass under its glass instead of stopping at a hard edge.
    <div ref={container} className="flex h-full min-h-0 flex-col bg-surface">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {locked ? (
          // An approved record has no fields "needing attention" -- she signed off
          // on every one of them. Saying otherwise is a false alarm.
          <div className="glass hairline-b sticky top-0 z-10 flex items-center gap-[6px] px-[14px] py-[8px]">
            <Lock size={13} className="text-label-tertiary" />
            <p className="text-callout text-label-secondary">
              Read only. This record is in the repository.
            </p>
          </div>
        ) : (
          <AttentionNav
            count={attention.length}
            index={index}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
          />
        )}

        <div className="px-[8px] pb-[32px]">
          {/* A group is a header and a rule, never a card. Nesting a bordered box
              per group inside a bordered panel is the mistake this rebuild exists
              to undo, so the only lines in here are hairlines. */}
          {groups.map((group, groupIndex) => (
            <section
              key={group.id}
              className={groupIndex === 0 ? 'pt-[16px]' : 'hairline-t mt-[20px] pt-[20px]'}
            >
              <SectionHeader title={group.label} className="px-[12px] pb-[6px]" />
              <div className="flex flex-col">
                {group.rows.map((field, index) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    onCommit={onCommit}
                    onNotApplicable={onNotApplicable}
                    onQuoteClick={onQuoteClick}
                    saving={savingKeys?.has(field.key)}
                    locked={locked}
                    active={activeKey === field.key}
                    rule={index > 0}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
});
