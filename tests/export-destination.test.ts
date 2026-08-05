/**
 * The export destination holds the export.
 *
 * Settings shows an "Export destination" with a Change button, the Export tab shows
 * its path, and /api/health runs a writability check on it -- while the route built
 * the workbook, handed it to the browser as a download, and never touched the
 * folder. Three screens describing a place nothing was ever written to.
 *
 * This drives the real route against a throwaway data directory and looks in the
 * folder afterwards, because that is the check nobody was doing.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useEvalDataDir } from '../evals/cases/_harness';

// Before the route is imported: importing it opens the database.
const dataDir = useEvalDataDir();

const route = await import('../src/app/api/export/route');

describe('a successful export', () => {
  it('leaves the workbook in the export folder, not only in the browser', async () => {
    const res = await route.GET(new Request('http://127.0.0.1/api/export?sheets=nda'));
    expect(res.status).toBe(200);

    const downloaded = new Uint8Array(await res.arrayBuffer());
    expect(downloaded.byteLength).toBeGreaterThan(0);

    const folder = join(dataDir, 'exports');
    const written = readdirSync(folder);
    // One file, under the name the Export tab shows her, and not the temp name the
    // atomic write passes through on its way there.
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/^Tracker_\d{4}-\d{2}-\d{2}\.xlsx$/);

    const path = join(folder, written[0] ?? '');
    expect(existsSync(path)).toBe(true);
    // The same bytes she was handed, not a stub beside them.
    expect(statSync(path).size).toBe(downloaded.byteLength);
  });
});
