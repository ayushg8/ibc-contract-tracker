'use client';

import { Wizard } from '@/components/onboarding/Wizard';

/**
 * The only screen with no sidebar. AppFrame drops the chrome for /onboarding, so
 * the wizard sits on the window material with nothing to navigate away with --
 * and nothing stopping her either: every step can be skipped.
 */
export default function OnboardingPage() {
  return (
    <div className="grid h-full w-full place-items-center overflow-y-auto p-[24px]">
      <Wizard />
    </div>
  );
}
