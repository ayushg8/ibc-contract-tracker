import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { z } from 'zod';

import { parse, readJson, route } from '@/app/api/_lib/http';
import { currentSettings } from '@/app/api/_lib/settings';
import { log } from '@/lib/logger';
import { errorInfo, type EngineErrorCode } from '@/lib/providers/errors';
import { deleteKey, looksLikeAnthropicKey, normaliseKey, setKey } from '@/lib/providers/keychain';
import { modelFor } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 20_000;

const Body = z.object({ key: z.string().min(8).max(400) });

/**
 * One real round trip against the model she has selected. An endpoint ping would
 * pass for a key that has no access to the model, which is the exact failure this
 * screen exists to catch. max_tokens 1 keeps the cost at a rounding error.
 */
async function probe(key: string, model: string): Promise<EngineErrorCode | null> {
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: PROBE_TIMEOUT_MS });
  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return null;
  } catch (e) {
    return classify(e);
  }
}

/** TLS interception looks like a connection failure but needs a different remedy. */
function looksLikeProxy(e: APIConnectionError): boolean {
  const cause = e.cause;
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : '';
  return /certificate|self[- ]signed|CERT_|unable to verify/i.test(detail);
}

function classify(e: unknown): EngineErrorCode {
  // Timeout is a subclass of APIConnectionError, so it has to be tested first.
  if (e instanceof APIConnectionTimeoutError) return 'API_TIMEOUT';
  if (e instanceof APIConnectionError) {
    return looksLikeProxy(e) ? 'PROXY_BLOCKED' : 'NETWORK_UNAVAILABLE';
  }
  if (e instanceof AuthenticationError) return 'API_KEY_INVALID';
  if (e instanceof PermissionDeniedError) {
    return e.type === 'billing_error' ? 'API_CREDIT_EXHAUSTED' : 'API_FORBIDDEN';
  }
  if (e instanceof NotFoundError) return 'MODEL_UNAVAILABLE';
  if (e instanceof RateLimitError) return 'API_RATE_LIMITED';
  if (e instanceof InternalServerError) {
    return e.type === 'overloaded_error' ? 'API_OVERLOADED' : 'API_SERVER_ERROR';
  }
  if (e instanceof BadRequestError) {
    return e.type === 'billing_error' ? 'API_CREDIT_EXHAUSTED' : 'UNKNOWN';
  }
  if (e instanceof APIError) return 'API_SERVER_ERROR';
  return 'UNKNOWN';
}

export async function POST(req: Request): Promise<Response> {
  return route('api.settings.apikey.set', async () => {
    const body = parse(Body, await readJson(req), 'API key');

    // A rejection is an answer, not a failure: 200 with valid=false so the field can
    // show a red dot instead of an error dialog.
    const key = normaliseKey(body.key);
    if (key === null) {
      return { valid: false, detail: 'That key has a space in it, so the paste picked up extra text.' };
    }

    const settings = await currentSettings();
    const model = modelFor(settings.tier);

    // The real gate is the round trip, never the shape: rejecting on a prefix would
    // lock her out of a valid key in an unfamiliar format.
    const failure = await probe(key, model.id);
    if (failure) {
      log.warn('apikey.rejected', { code: failure, tier: settings.tier });
      const hint = looksLikeAnthropicKey(key)
        ? ''
        : ' It also does not look like an Anthropic key, which start "sk-ant-".';
      return { valid: false, detail: `${errorInfo(failure).message}${hint}` };
    }

    // Only a key that has actually worked once is allowed near the keychain.
    const source = await setKey(key);
    log.info('apikey.stored', { tier: settings.tier, source });
    return { valid: true, detail: `Key accepted. ${model.label} is available.` };
  });
}

export async function DELETE(): Promise<Response> {
  return route('api.settings.apikey.delete', async () => {
    await deleteKey();
    log.info('apikey.removed');
    return { ok: true };
  });
}
