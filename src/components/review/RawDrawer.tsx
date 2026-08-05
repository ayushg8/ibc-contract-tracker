'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Copy, X } from '@phosphor-icons/react';
import { Button, IconButton, Pill, SPRING_SNAPPY, SectionHeader } from '@/components/ui';
import type { DocumentDetail } from '@/lib/db/types';
import { PROVIDER_LABELS } from '@/lib/providers/types';

export interface RawDrawerProps {
  open: boolean;
  onClose: () => void;
  document: DocumentDetail;
}

function tokens(value: number | null): string {
  return value === null ? '\u2014' : value.toLocaleString('en-US');
}

function cost(value: number | null): string {
  if (value === null) return '\u2014';
  // A subscription run has no marginal cost, and "$0.0000" reads like a bug.
  if (value === 0) return 'included';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function seconds(value: number | null): string {
  return value === null ? '\u2014' : `${(value / 1000).toFixed(1)}s`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-[1px]">
      <span className="eyebrow">{label}</span>
      <span className="tabular truncate text-callout text-label" title={value}>
        {value}
      </span>
    </div>
  );
}

function CopyBlock({ title, body }: { title: string; body: string | null }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (body === null) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard permission is the browser's call. The text is on screen either way.
      setCopied(false);
    }
  }, [body]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[6px]">
      <SectionHeader
        title={title}
        trailing={
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy size={11} />}
            disabled={body === null}
            onClick={() => void copy()}
          >
            <span className="text-label-secondary">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        }
      />
      <div className="surface sq min-h-0 flex-1 overflow-auto rounded-card p-[10px]">
        <pre className="whitespace-pre-wrap break-words font-mono text-footnote text-label-secondary">
          {body ?? 'Nothing was recorded for this run.'}
        </pre>
      </div>
    </div>
  );
}

/**
 * The answer to "the AI is a black box": provider, model, prompt version, cost,
 * and the exact bytes both ways. Deliberately reads as an audit trail rather
 * than a debug panel -- she should be able to hand this to an auditor.
 */
export function RawDrawer({ open, onClose, document }: RawDrawerProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          role="dialog"
          aria-label="How this document was read"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={SPRING_SNAPPY}
          // Container query, not viewport: the drawer lives inside a pane she can
          // drag down to a quarter of the window, and a media query cannot see that.
          className="@container hairline-t absolute inset-x-0 bottom-0 z-20 flex h-[68%] flex-col gap-[10px] bg-sunken p-[14px] shadow-e3"
        >
          <div className="flex items-center justify-between gap-[8px]">
            <div className="flex items-center gap-[6px]">
              <h2 className="text-title-3 font-medium text-label">How this was read</h2>
              {document.promptVersion !== null && (
                <Pill tone="quiet" mono>
                  prompt {document.promptVersion}
                </Pill>
              )}
              {document.repairAttempts > 0 && (
                <Pill tone="warn">
                  {document.repairAttempts === 1
                    ? '1 repair attempt'
                    : `${document.repairAttempts} repair attempts`}
                </Pill>
              )}
            </div>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <X size={13} />
            </IconButton>
          </div>

          <div className="grid grid-cols-3 gap-[10px] @[560px]:grid-cols-6">
            <Stat
              label="Engine"
              value={document.provider === null ? '\u2014' : PROVIDER_LABELS[document.provider]}
            />
            <Stat label="Model" value={document.model ?? '\u2014'} />
            <Stat label="In" value={tokens(document.inputTokens)} />
            <Stat label="Out" value={tokens(document.outputTokens)} />
            <Stat label="Cost" value={cost(document.costUsd)} />
            <Stat label="Took" value={seconds(document.durationMs)} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-[10px] @[620px]:flex-row">
            <CopyBlock title="Prompt" body={document.rawPrompt} />
            <CopyBlock title="Response" body={document.rawResponse} />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
