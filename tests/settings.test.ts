/**
 * PATCH /api/settings, against the real route and a real database.
 *
 * THE DEFECT THIS FILE EXISTS FOR: the route validates with a zod `strictObject`
 * and `appearance` was not in it. Choosing Dark answered HTTP 400 -- "The app
 * sent something the tracker could not read" -- the control snapped back to
 * Light, and a reload undid it. The theme could not be saved at all.
 *
 * The strictObject is right: a key the client sends and the route does not know
 * about SHOULD fail loudly rather than be dropped in silence. That makes the
 * schema and `SettingsPatch` in components/settings/SettingsTabs.tsx two halves
 * of one contract, and a key in one and not the other a 400 on a control that
 * looks like it works. So the sweep below does not test the keys someone
 * remembered to list here -- it reads the client's list off disk and sends every
 * one of them. A key added to the client and not to the route fails this file.
 *
 * IBC_DATA_DIR is set before the route is imported: paths.ts reads it at call
 * time and the database opens on first use.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'ibc-settings-'));
process.env['IBC_DATA_DIR'] = dir;

const route = await import('@/app/api/settings/route');
const q = await import('@/lib/db');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TABS = join(ROOT, 'src', 'components', 'settings', 'SettingsTabs.tsx');

/** Folders the route insists on being able to read or write before it stores them. */
const watchFolder = join(dir, 'watched');
const archiveFolder = join(dir, 'archive-elsewhere');
const exportFolder = join(dir, 'exports-elsewhere');
for (const folder of [watchFolder, archiveFolder, exportFolder]) {
  mkdirSync(folder, { recursive: true });
}

afterAll(() => {
  try {
    q.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/* ─────────────────────────── calling the route ──────────────────────────── */

interface Answer {
  status: number;
  settings: Record<string, unknown> | null;
  message: string | null;
}

async function read(res: Response): Promise<Answer> {
  const body: unknown = await res.json();
  const root = typeof body === 'object' && body !== null ? body : {};
  const settings: unknown = Reflect.get(root, 'settings');
  const error: unknown = Reflect.get(root, 'error');
  const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : null;
  return {
    status: res.status,
    settings: typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : null,
    message: typeof message === 'string' ? message : null,
  };
}

async function patch(body: unknown): Promise<Answer> {
  return read(
    await route.PATCH(
      new Request('http://127.0.0.1/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function current(): Promise<Answer> {
  return read(await route.GET());
}

/* ───────────────────────────────── theme ────────────────────────────────── */

describe('the theme can be saved', () => {
  it('accepts dark and keeps it', async () => {
    const saved = await patch({ appearance: 'dark' });
    // The measured failure was 400 with "The app sent something the tracker
    // could not read (settings)". Assert the status and the value, because a
    // route that answers 200 and stores nothing is the same bug one layer down.
    expect(saved.status, saved.message ?? '').toBe(200);
    expect(saved.settings?.['appearance']).toBe('dark');

    // Read back through GET: this is the request the screen makes on the reload
    // that used to revert her to Light.
    const reloaded = await current();
    expect(reloaded.settings?.['appearance']).toBe('dark');
  });

  it('accepts every appearance the client offers, and nothing else', async () => {
    for (const value of ['system', 'light', 'dark']) {
      expect((await patch({ appearance: value })).status, value).toBe(200);
    }
    // A value outside the union is a bug in the caller, and is still refused.
    expect((await patch({ appearance: 'midnight' })).status).toBe(400);
  });
});

/* ────────────────────── the client's list, key by key ───────────────────── */

/**
 * The keys SettingsTabs.tsx declares the client may send. Read off disk rather
 * than listed here: a list in a test is exactly the thing that was already
 * remembered once and not again.
 */
function clientPatchKeys(): string[] {
  const source = readFileSync(TABS, 'utf8');
  const at = source.indexOf('export type SettingsPatch');
  expect(at, 'SettingsPatch is no longer declared in SettingsTabs.tsx').toBeGreaterThan(-1);
  const block = source.slice(at, source.indexOf('>;', at));
  return [...block.matchAll(/'([a-zA-Z]+)'/g)]
    .map((m) => m[1] ?? '')
    .filter((k) => k !== '');
}

/** One value per key that the route must accept and store. */
const VALUES: Record<string, unknown> = {
  provider: 'api',
  tier: 'deep',
  watchFolder,
  archiveFolder,
  exportFolder,
  autoExtract: false,
  appearance: 'dark',
  glassIntensity: 0.5,
  density: 'compact',
  escalateOnLowYield: false,
  onboardingComplete: true,
};

describe('every key the client can send', () => {
  const keys = clientPatchKeys();

  it('is one the route knows about', () => {
    // Fails the moment a key joins SettingsPatch without a value here, which is
    // what makes the per-key test below unable to quietly skip the new one.
    expect(keys.length).toBeGreaterThan(5);
    expect([...keys].sort()).toEqual(Object.keys(VALUES).sort());
  });

  it.each(keys)('%s is accepted and stored', async (key) => {
    const value = VALUES[key];
    const saved = await patch({ [key]: value });
    expect(saved.status, `${key}: ${saved.message ?? ''}`).toBe(200);
    expect(saved.settings?.[key], `${key} was accepted but not stored`).toEqual(value);
  });

  it('takes them all at once, as the onboarding wizard does', async () => {
    const saved = await patch(VALUES);
    expect(saved.status, saved.message ?? '').toBe(200);
    for (const [key, value] of Object.entries(VALUES)) {
      expect(saved.settings?.[key], key).toEqual(value);
    }
  });

  it('allows watchFolder to be cleared, which is the one nullable one', async () => {
    const saved = await patch({ watchFolder: null });
    expect(saved.status, saved.message ?? '').toBe(200);
    expect(saved.settings?.['watchFolder']).toBeNull();
  });
});

/* ─────────────────────────── still refusing loudly ──────────────────────── */

describe('what the route still refuses', () => {
  it.each(['hasApiKey', 'apiKeySource', 'lastExportedAt'])('%s is derived, never set', async (key) => {
    // The other half of strictObject, and the reason it is worth keeping: these
    // three are computed, and a caller trying to set one has a bug that has to
    // surface rather than be dropped on the floor.
    const saved = await patch({ [key]: 'anything' });
    expect(saved.status).toBe(400);
  });

  it('never lets the database imply that an API key exists', async () => {
    const saved = await patch({ appearance: 'light' });
    expect(saved.settings?.['hasApiKey']).toBe(false);
    expect(saved.settings?.['apiKeySource']).toBe('none');
  });

  it('rejects a patch that changes nothing', async () => {
    const saved = await patch({});
    expect(saved.status).toBe(400);
    expect(saved.message).toBe('That request changed nothing.');
  });

  it('refuses a watch folder that is not there, before extraction time', async () => {
    const saved = await patch({ watchFolder: join(dir, 'not-a-folder') });
    expect(saved.status).toBeGreaterThanOrEqual(400);
    expect(saved.settings).toBeNull();
  });

  it('never leaks a stack', async () => {
    const res = await route.PATCH(
      new Request('http://127.0.0.1/api/settings', { method: 'PATCH', body: 'not json' }),
    );
    const body = await res.text();
    expect(res.status).toBe(400);
    expect(body).not.toContain('at Object.');
    expect(body).not.toContain('.ts:');
  });
});

/* ─────────────────── the Updates tab's status row ───────────────────────── */

/*
 * Here rather than in tests/updates.test.ts, which is about the update mechanism
 * -- the manifest, the shell script, the agent. This is about one Settings
 * screen telling the truth about itself, which is what the rest of this file is
 * about too.
 *
 * THE DEFECT: pressing "Check for updates" on a copy with no source configured
 * -- the shipped state -- rendered a green CheckCircle reading "Up to date",
 * with the failure admitted in small text underneath. "Up to date" is the whole
 * answer she reads off that row.
 */

const { checkState, describeCheck } = await import('@/components/settings/UpdatesTab');
type UpdateView = import('@/components/settings/UpdatesTab').UpdateView;

function updateView(patchView: Partial<UpdateView> = {}): UpdateView {
  return {
    currentVersion: '1.0.0',
    supported: true,
    unsupportedReason: null,
    source: { configured: false, label: 'Not configured', autoApply: false, checkIntervalHours: 336 },
    available: null,
    lastCheckedAt: '2026-07-20T09:00:00.000Z',
    lastCheckError: null,
    phase: 'idle',
    progress: null,
    lastResult: null,
    previousVersion: null,
    canRollback: false,
    busy: null,
    ...patchView,
  };
}

describe('the Updates tab never ticks a check that failed', () => {
  const failed = updateView({ lastCheckError: 'There is nowhere to check. Ask Ayush.' });

  it('reports the failure rather than being up to date', () => {
    expect(checkState(failed, false)).toBe('failed');
    expect(describeCheck('failed', failed).title).toBe('The check did not get through');
    // Her words for what went wrong are the error itself, not a paraphrase.
    expect(describeCheck('failed', failed).description).toBe(failed.lastCheckError);
  });

  it('stays failed however recently the check ran', () => {
    // The old branch keyed the tick off lastCheckedAt alone, so a check that ran
    // and failed one second ago drew the tick.
    for (const at of [null, '2026-07-29T09:00:00.000Z', new Date().toISOString()]) {
      expect(checkState(updateView({ lastCheckError: 'nope', lastCheckedAt: at }), false)).toBe(
        'failed',
      );
    }
  });

  it('says up to date only for a check that got through', () => {
    expect(checkState(updateView(), false)).toBe('current');
    expect(describeCheck('current', updateView()).title).toBe('Up to date');
    expect(checkState(updateView({ lastCheckedAt: null }), false)).toBe('never');
    expect(describeCheck('never', updateView()).title).toBe('Not checked yet');
  });

  it('puts the tracker being unreachable ahead of everything', () => {
    expect(checkState(failed, true)).toBe('offline');
    expect(describeCheck('offline', failed).title).toBe('Cannot reach the tracker');
  });

  it('draws the green tick from one state and nowhere else', () => {
    // A source assertion, because the icon is JSX and this suite has no DOM:
    // CheckCircle may appear exactly once, in the branch keyed on 'current'.
    const source = readFileSync(join(ROOT, 'src', 'components', 'settings', 'UpdatesTab.tsx'), 'utf8');
    const uses = [...source.matchAll(/<CheckCircle/g)];
    expect(uses.length).toBe(1);
    const at = source.indexOf('<CheckCircle');
    const before = source.slice(Math.max(0, at - 200), at);
    expect(before).toContain("state === 'current'");
  });
});
