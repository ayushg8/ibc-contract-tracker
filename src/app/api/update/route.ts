/**
 * GET  /api/update   what version is running, what is available, what happened last
 * POST /api/update   { action: 'check' | 'apply' | 'rollback' }
 *
 * This is the one route in the app whose POST causes different code to run on the
 * machine afterwards, so it carries a guard no other route needs.
 *
 * The app listens on 127.0.0.1 with no authentication -- correct for a single-user
 * local tool, and it means any web page open in Bonnie's browser can POST to it.
 * For every other route the worst case is an unwanted export. Here it would be a
 * page on the internet triggering an install. It cannot choose WHAT gets
 * installed (the source is a file on disk, deliberately not settable over HTTP --
 * see src/lib/update/source.ts), but it should not be able to trigger one at all,
 * so a cross-origin POST is refused. Browsers always send Origin on POST, and the
 * app's own fetches carry its own loopback origin.
 */

import { z } from 'zod';

import { ApiError, parse, readJson, route } from '@/app/api/_lib/http';
import { maybeAutoRun, runCheck, startApply, startRollback, updateStatus } from '@/lib/update';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  action: z.enum(['check', 'apply', 'rollback']),
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function assertSameMachine(req: Request): void {
  const origin = req.headers.get('origin');
  // Absent is fine: that is a non-browser caller (the doctor script, curl during
  // a repair), which is already on the machine and does not need protecting from.
  if (origin === null || origin === 'null') return;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = '';
  }
  if (LOOPBACK_HOSTS.has(host)) return;
  throw new ApiError(403, 'UNKNOWN', {
    message: 'That request did not come from the tracker.',
    retryable: false,
    remedy: { action: 'none', label: 'OK' },
    detail: 'cross-origin POST to /api/update refused',
  });
}

export async function GET(): Promise<Response> {
  return route('api.update.get', async () => {
    // Fire and forget. This is what makes "Ayush pushes, Bonnie gets it" true
    // without her pressing anything: the app polls this route, and the check runs
    // at most once per configured interval behind the answer.
    maybeAutoRun();
    return updateStatus();
  });
}

export async function POST(req: Request): Promise<Response> {
  return route('api.update.post', async () => {
    assertSameMachine(req);
    const { action } = parse(Body, await readJson(req), 'update action');

    switch (action) {
      case 'check':
        return { accepted: true, deferred: null, status: await runCheck() };
      case 'apply':
        return startApply();
      case 'rollback':
        return startRollback();
    }
  });
}
