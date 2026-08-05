/**
 * What the watched folder is doing right now.
 *
 * GET is the honesty check behind the Settings copy: the screen may only say
 * "picked up automatically" when this says the loop is running against a folder
 * it can read. POST is the Scan now button.
 *
 * Neither takes a body, so there is nothing to zod-validate; the folder itself is
 * validated where it is set, by PATCH /api/settings.
 */

import { route } from '@/app/api/_lib/http';
import { folderWatcher } from '@/lib/watch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route('api.watch.status', async () => ({ watch: folderWatcher().status() }));
}

export async function POST(): Promise<Response> {
  return route('api.watch.rescan', async () => ({ watch: await folderWatcher().rescan() }));
}
