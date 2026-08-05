'use client';

import { useEffect, useState } from 'react';
import { ArrowClockwise, Copy, WarningCircle } from '@phosphor-icons/react';

import { Button, Card } from '@/components/ui';
import { copySupportBundle } from '@/lib/client/api';

/**
 * What Bonnie sees if we ship a bug. No stack trace, no "unhandled exception",
 * no red. The three things that matter: her records are safe, one button that
 * usually fixes it, and one button that gets a human the detail.
 */
export function FailureCard({
  title,
  body,
  digest,
  onRetry,
  retryLabel = 'Reload',
}: {
  title: string;
  body: string;
  digest?: string | undefined;
  onRetry: () => void;
  retryLabel?: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');

  useEffect(() => {
    if (copied !== 'done' && copied !== 'failed') return;
    const timer = window.setTimeout(() => setCopied('idle'), 3_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setCopied('busy');
    const result = await copySupportBundle();
    setCopied(result.error !== undefined ? 'failed' : 'done');
  }

  return (
    <div className="grid h-full w-full place-items-center bg-canvas p-[24px]">
      <Card padding="lg" elevated className="w-full max-w-[420px]">
        <div className="flex flex-col items-center gap-[10px] text-center">
          <WarningCircle size={28} weight="regular" className="text-bad" />
          <h1 className="text-title-2 font-semibold text-label">{title}</h1>
          <p className="text-callout text-label-secondary">{body}</p>

          <div className="mt-[10px] flex items-center gap-[8px]">
            <Button
              variant="primary"
              icon={<ArrowClockwise size={14} />}
              onClick={onRetry}
            >
              {retryLabel}
            </Button>
            <Button
              icon={<Copy size={14} />}
              loading={copied === 'busy'}
              onClick={() => void copy()}
            >
              {copied === 'done'
                ? 'Copied'
                : copied === 'failed'
                  ? 'Could not copy'
                  : 'Copy support bundle'}
            </Button>
          </div>

          {digest !== undefined && (
            <p className="mt-[4px] font-mono text-footnote text-label-tertiary">
              Reference {digest}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function ScreenError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <FailureCard
      title="This screen stopped working."
      body="Nothing was lost - every document and record is still saved on this Mac. Reloading the screen usually clears it."
      digest={error.digest}
      onRetry={reset}
      retryLabel="Reload this screen"
    />
  );
}
