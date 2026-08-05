/**
 * Engine health on its own, plus the named CLI verdict.
 *
 * `/api/health` answers "is the whole app well?" -- database, folders, keychain,
 * the active engine. This route answers the narrower question the Engine step and
 * Settings -> Diagnostics both ask: what is true about BOTH engines right now, and
 * which of the five Claude Code failures is this one.
 *
 * It is a separate route because the wizard needs the inactive engine too. Showing
 * her only the engine she happens to have selected makes switching a guess.
 */

import { route } from '@/app/api/_lib/http';
import { diagnoseCli } from '@/lib/providers/cli';
import { healthAll } from '@/lib/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route('api.engine.health', async () => {
    // healthAll() re-probes the machine and refills the discovery caches, so the
    // diagnosis that follows costs no extra process spawns. Order matters here.
    const all = await healthAll();
    const cliDiagnosis = await diagnoseCli();

    return {
      active: all.active,
      cli: all.cli,
      api: all.api,
      cliDiagnosis,
    };
  });
}
