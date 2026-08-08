import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * Every top-level page needs a title in AppFrame's SECTIONS list.
 *
 * That list is hand-maintained and `sectionTitle` falls back to 'Inbox' for
 * anything missing from it, so a new page does not fail -- it silently renders
 * under the wrong name in the window title and the titlebar. The Files section
 * shipped exactly that way and was caught by looking at a screenshot, which is
 * not a repeatable check.
 *
 * Hand-maintained lists with a silent fallback are the recurring shape of this
 * bug in this repository -- it is why the installer iterates bin/ rather than
 * naming its scripts. This test derives the expectation from the routes that
 * exist instead of from a second list that would need maintaining too.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'src', 'app');
const FRAME = join(HERE, '..', 'src', 'components', 'layout', 'AppFrame.tsx');

/**
 * Routes that render inside the app chrome and therefore need a title.
 *
 * `/onboarding` is excluded because AppFrame drops the sidebar and titlebar for
 * it entirely -- it is the one screen with no chrome, so it has no section name
 * to be wrong about. The exclusion is checked against the code below rather than
 * simply asserted here, so it cannot quietly cover a future regression.
 */
export const CHROMELESS = ['onboarding'];

function pageRoutes(): string[] {
  return readdirSync(APP, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => n !== 'api' && !n.startsWith('(') && !n.startsWith('_') && !n.startsWith('['))
    .filter((n) => existsSync(join(APP, n, 'page.tsx')))
    .filter((n) => !CHROMELESS.includes(n))
    .sort();
}

describe('section titles', () => {
  const source = readFileSync(FRAME, 'utf8');

  it('finds the routes it is meant to be checking', () => {
    // Guards the test itself: if this ever returns nothing, the assertions below
    // would pass vacuously forever.
    const routes = pageRoutes();
    expect(routes.length).toBeGreaterThan(2);
    expect(routes).toContain('inbox');
  });

  it.each(pageRoutes())('/%s has its own title', (route) => {
    expect(
      source.includes(`prefix: '/${route}'`),
      `/${route} is missing from SECTIONS in AppFrame.tsx, so it renders as "Inbox"`,
    ).toBe(true);
  });

  it('still falls back rather than throwing on an unknown path', () => {
    // The fallback is correct behaviour for a path with no section; the bug is
    // only ever a real page relying on it.
    expect(source).toContain("?? 'Inbox'");
  });
});

describe('the chromeless exclusion', () => {
  const source = readFileSync(FRAME, 'utf8');

  /*
   * The list above is only allowed to exclude a route that AppFrame genuinely
   * renders without chrome. Without this, adding a name to CHROMELESS would be a
   * way to silence the test rather than fix the page.
   */
  it.each(CHROMELESS)('/%s really is rendered without the frame', (route) => {
    expect(
      source.includes(`pathname.startsWith('/${route}')`),
      `/${route} is excluded from the title check but AppFrame does not special-case it`,
    ).toBe(true);
  });
});
