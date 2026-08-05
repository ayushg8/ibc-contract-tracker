'use client';

import { FailureCard } from './error';
import './globals.css';

/**
 * The root layout itself failed, so this replaces the whole document -- html,
 * body and stylesheet included. Same card as error.tsx on purpose: a second
 * visual language for the rarer failure would only make it look worse.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* This component replaces the whole document, so the root layout's
            pre-paint script is gone with it. Same key, same default: a person
            who chose dark should not meet a white screen on the worst screen. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('ibc-appearance')||'light';document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`,
          }}
        />
      </head>
      <body className="h-full">
        <FailureCard
          title="The tracker could not start."
          body="Your documents and records are untouched. Reopening usually clears it; if it does not, copy the support bundle and send it on."
          digest={error.digest}
          onRetry={() => window.location.reload()}
          retryLabel="Reopen"
        />
      </body>
    </html>
  );
}
