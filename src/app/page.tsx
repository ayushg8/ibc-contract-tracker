import { redirect } from 'next/navigation';

import { currentSettings } from '@/app/api/_lib/settings';

export const dynamic = 'force-dynamic';

/**
 * There is no home screen: the Inbox is what she opens the app to do. The one
 * decision made here is whether setup has happened yet, and a broken database
 * answers "no" -- onboarding is the screen that can explain that.
 */
export default async function Home() {
  let onboarded = false;
  try {
    onboarded = (await currentSettings()).onboardingComplete;
  } catch {
    onboarded = false;
  }
  redirect(onboarded ? '/inbox' : '/onboarding');
}
