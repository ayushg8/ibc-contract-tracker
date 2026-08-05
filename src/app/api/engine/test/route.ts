import { route } from '@/app/api/_lib/http';
import { log } from '@/lib/logger';
import { selfTest } from '@/lib/providers';
import { LIMITS } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return route('api.engine.test', async () => {
    const result = await selfTest(undefined, { timeoutMs: LIMITS.apiTimeoutMs });

    log.info('engine.selftest', {
      provider: result.provider,
      ok: result.ok,
      durationMs: result.durationMs,
      fieldsFound: result.fieldsFound,
    });

    // selfTest hands back a live EngineError; only its serialised form may cross the wire.
    return {
      provider: result.provider,
      ok: result.ok,
      durationMs: result.durationMs,
      fieldsFound: result.fieldsFound,
      fieldsTotal: result.fieldsTotal,
      costUsd: result.costUsd,
      error: result.error ? result.error.toJSON() : null,
    };
  });
}
