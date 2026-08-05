'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Warning, X } from '@phosphor-icons/react';

import clsx from 'clsx';

import { Button, IconButton, useToast } from '@/components/ui';
import { copySupportBundle } from '@/lib/client/api';
import { refreshHealth, useHealth, useSettings } from '@/lib/client/useSettings';
import { errorInfo, type EngineErrorCode, type Remedy } from '@/lib/providers/errors';

/**
 * The codes whose catalog entry sets halt: true, listed so a string from the
 * server can be narrowed into the union without a cast. Typed as
 * EngineErrorCode[], so deleting a code from the taxonomy breaks this build
 * rather than this banner.
 */
const HALTING_CODES: readonly EngineErrorCode[] = [
  'CLI_NOT_FOUND',
  'CLI_NOT_AUTHENTICATED',
  'CLI_VERSION_UNSUPPORTED',
  'CLI_PERMISSION_PROMPT',
  'CLI_USAGE_LIMIT',
  'API_KEY_MISSING',
  'API_KEY_INVALID',
  'API_FORBIDDEN',
  'API_CREDIT_EXHAUSTED',
  'MODEL_UNAVAILABLE',
  'NETWORK_UNAVAILABLE',
  'PROXY_BLOCKED',
  'DB_CORRUPT',
  'DISK_FULL',
  'FOLDER_MISSING',
  'FOLDER_UNREADABLE',
  'KEYCHAIN_UNAVAILABLE',
];

/** Beyond this, a logged failure is history rather than a live condition. */
const RECENT_WINDOW_MS = 15 * 60_000;

function halting(code: string | undefined): EngineErrorCode | null {
  if (code === undefined) return null;
  return HALTING_CODES.find((c) => c === code) ?? null;
}

function withinWindow(at: string): boolean {
  const then = Date.parse(at);
  return Number.isFinite(then) && Date.now() - then < RECENT_WINDOW_MS;
}

function resetLabel(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(at),
  );
  return `Resets around ${time}.`;
}

/**
 * Maps a remedy onto something that actually happens. Shared so the banner, the
 * inbox cards and the failure card all answer the same button the same way.
 */
export function useRemedy(): (remedy: Remedy) => void {
  const router = useRouter();
  const { toast } = useToast();
  const { settings, save } = useSettings();

  return useCallback(
    (remedy: Remedy) => {
      switch (remedy.action) {
        case 'retry':
        case 'wait-and-retry':
          refreshHealth();
          toast({ title: 'Rechecking the engine.' });
          return;

        case 'switch-to-api':
          // Only flip it when there is a key to flip to; otherwise she lands on
          // the screen that can give her one.
          if (settings?.hasApiKey === true) {
            void save({ provider: 'api' }).then((error) => {
              toast(
                error === null
                  ? { title: 'Now using the API key.', tone: 'ok' }
                  : { title: error.message, tone: 'bad' },
              );
            });
            return;
          }
          router.push('/settings?tab=engine');
          return;

        case 'switch-to-cli':
          void save({ provider: 'cli' }).then((error) => {
            toast(
              error === null
                ? { title: 'Now using the Claude subscription.', tone: 'ok' }
                : { title: error.message, tone: 'bad' },
            );
          });
          return;

        case 'enter-api-key':
        case 'open-engine-settings':
        case 'install-cli':
        case 'login-cli':
        case 'update-cli':
          router.push('/settings?tab=engine');
          return;

        case 'open-folder-settings':
        case 'choose-folder':
          router.push('/settings?tab=folders');
          return;

        case 'contact-support':
          void copySupportBundle().then((result) => {
            toast(
              result.error !== undefined
                ? { title: result.error.message, tone: 'bad' }
                : {
                    title: 'Support details copied.',
                    description: 'Paste them into an email to whoever set this up.',
                    tone: 'ok',
                  },
            );
          });
          return;

        case 'reveal-file':
        case 'enter-manually':
        case 'none':
          return;
      }
    },
    [router, save, settings?.hasApiKey, toast],
  );
}

/**
 * ONE banner. A usage limit hit halfway through a folder would otherwise show
 * the same message on forty cards, which reads as forty problems.
 */
export function HaltBanner() {
  const health = useHealth();
  const runRemedy = useRemedy();
  const [dismissed, setDismissed] = useState<string | null>(null);

  const engine = health.data?.engine ?? null;

  const fromEngine =
    engine !== null && engine.state === 'fail'
      ? halting(engine.checks.find((c) => halting(c.errorCode) !== null)?.errorCode)
      : null;

  const recent = health.data?.recentErrors.find(
    (row) => halting(row.code) !== null && withinWindow(row.at),
  );

  const code = fromEngine ?? halting(recent?.code);
  if (code === null || code === dismissed) return null;

  const info = errorInfo(code);
  const reset = resetLabel(engine?.limitResetsAt);
  const showRemedy = info.remedy.action !== 'none';

  return (
    <div className="px-[16px] pt-[12px]">
      {/* One tinted plane on the canvas, not a card: a bordered box holding the
          message and a button inside another bordered pane is the nesting this
          rebuild exists to remove. Amber for "wait and it clears", red for
          "nothing happens until you act". */}
      <section
        role="alert"
        className={clsx(
          'sq flex items-start gap-[10px] rounded-card px-[14px] py-[11px]',
          info.retryable ? 'bg-warn-quiet' : 'bg-bad-quiet',
        )}
      >
        <Warning
          size={18}
          weight="fill"
          className={info.retryable ? 'mt-[-1px] shrink-0 text-warn' : 'mt-[-1px] shrink-0 text-bad'}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <p className="text-body font-medium text-label">{info.message}</p>
          {(info.remedy.hint !== undefined || reset !== null) && (
            <p className="text-callout text-label-secondary">
              {[info.remedy.hint, reset].filter((s) => s !== null && s !== undefined).join(' ')}
            </p>
          )}
        </div>
        {showRemedy && (
          <Button size="sm" variant="primary" onClick={() => runRemedy(info.remedy)}>
            {info.remedy.label}
          </Button>
        )}
        <IconButton
          label="Dismiss"
          size="sm"
          onClick={() => setDismissed(code)}
          className="shrink-0"
        >
          <X size={14} />
        </IconButton>
      </section>
    </div>
  );
}
