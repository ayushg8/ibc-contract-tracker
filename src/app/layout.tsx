import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';

import { AppFrame } from '@/components/layout/AppFrame';
import { currentSettings } from '@/app/api/_lib/settings';
import './globals.css';

export const metadata: Metadata = {
  title: 'IBC Contracts',
  description: 'Read, check and track International Battery Company NDAs.',
  // Local tool. Nothing here should ever be indexed or previewed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The window is the app; a pinch-zoomed source list is never what she wanted.
  maximumScale: 1,
  colorScheme: 'light dark',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  /*
   * The database is the backstop, and it has to be read HERE.
   *
   * The pre-paint script used to read localStorage and fall back to light. Clearing
   * the browser store -- a new profile, a cleared site, a different browser -- meant
   * she was silently returned to light on every screen, and the only thing that ever
   * repaired it was opening Settings > Appearance, whose effect is what writes the
   * key back. So the setting was stored, honoured on one screen, and ignored
   * everywhere else.
   */
  let storedAppearance: string | null = null;
  try {
    storedAppearance = (await currentSettings()).appearance ?? null;
  } catch {
    // First run, before the database exists. Light is the documented default.
  }

  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/*
          Runs before first paint, so a person who chose dark never sees a white
          flash on the way there. Reads the same key the settings route writes.
          Defaults to light: that is the product decision, not the OS's.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('ibc-appearance')||${JSON.stringify(storedAppearance)}||'light';document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`,
          }}
        />
      </head>
      {/*
        Transparent so a native vibrancy host can show through the sidebar's
        glass. AppFrame paints the canvas and the content surface.
      */}
      <body className="h-full bg-transparent antialiased">
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
