/**
 * The API-key engine: calls Anthropic directly.
 *
 * Its decisive advantage over the CLI is structured outputs — the response shape is
 * guaranteed by the server, not requested politely in a prompt. It is also the only
 * engine that can read a scanned page, because it can be handed images.
 *
 * Server-only: constructs an SDK client and reads the key from the keychain.
 */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import type { DocType, FieldKey } from '../fields';
import { EngineError, toEngineError, type EngineErrorCode } from './errors';
import {
  estimateCostUsd,
  LIMITS,
  modelFor,
  DEFAULT_TIER,
  type ExtractOptions,
  type ExtractionRequest,
  type ExtractionResponse,
  type HealthCheck,
  type Provider,
  type ProviderHealth,
  type RawFieldAnswer,
} from './types';
import { getKey, keychainStatus, type ApiKeySource } from './keychain';
import {
  buildAnswerJsonSchema,
  buildExtractionPrompt,
  buildRepairInstruction,
  buildSelfTestRequest,
  countVerifiableQuotes,
  extractDocType,
  extractJson,
  SELF_TEST_FIELDS,
  SELF_TEST_TEXT,
  validateAnswer,
} from './parse';

/**
 * Generous on purpose, and the ceiling is free when unused. Structured outputs make
 * the model spell out every key for every field, and on current models max_tokens
 * caps thinking plus text together -- a tight ceiling truncates the answer, which is
 * a whole wasted request. `effort` would be the cheaper lever but it is rejected on
 * Haiku 4.5, so the room comes from max_tokens and the real guard is the timeout.
 */
const MAX_TOKENS = 32_000;

const MAX_CONCURRENCY = 3;

/* ─────────────────────────── error mapping ─────────────────────── */

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

const OFFLINE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
]);

const BILLING_RE =
  /\b(credit balance|insufficient (?:credit|funds|balance)|billing|payment (?:required|method)|out of credits?|spend limit|quota exhausted)\b/i;

const PROXY_RE = /\b(certificate|self[- ]signed|tls|ssl|proxy|man[- ]in[- ]the[- ]middle)\b/i;

function errorCodeOf(e: unknown): string | null {
  if (typeof e !== 'object' || e === null || !('code' in e)) return null;
  const code: unknown = e.code;
  return typeof code === 'string' ? code : null;
}

function causeChain(e: unknown, depth = 0): unknown[] {
  if (typeof e !== 'object' || e === null || depth > 5) return [];
  const out: unknown[] = [e];
  if ('cause' in e) out.push(...causeChain(e.cause, depth + 1));
  return out;
}

function classifyTransport(e: unknown): EngineErrorCode {
  for (const link of causeChain(e)) {
    const code = errorCodeOf(link);
    if (code !== null) {
      if (TLS_ERROR_CODES.has(code)) return 'PROXY_BLOCKED';
      if (OFFLINE_ERROR_CODES.has(code)) return 'NETWORK_UNAVAILABLE';
      if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'API_TIMEOUT';
    }
    if (link instanceof Error && PROXY_RE.test(link.message)) return 'PROXY_BLOCKED';
  }
  return 'NETWORK_UNAVAILABLE';
}

function retryAfterMs(err: APIError): number | undefined {
  const header = err.headers?.get('retry-after');
  if (header === null || header === undefined) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Every SDK failure becomes a named EngineError with a remedy. Exported for tests. */
export function mapApiError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;

  if (e instanceof APIUserAbortError) {
    return new EngineError('API_TIMEOUT', { detail: 'Cancelled before it finished.', cause: e });
  }
  if (e instanceof APIConnectionTimeoutError) {
    return new EngineError('API_TIMEOUT', { detail: e.message, cause: e });
  }
  if (e instanceof APIConnectionError) {
    return new EngineError(classifyTransport(e), { detail: e.message, cause: e });
  }

  if (e instanceof APIError) {
    const status = e.status;
    const message = e.message;

    if (BILLING_RE.test(message)) {
      return new EngineError('API_CREDIT_EXHAUSTED', { detail: message, cause: e });
    }

    switch (status) {
      case 401:
        return new EngineError('API_KEY_INVALID', { detail: message, cause: e });
      case 403:
        return new EngineError('API_FORBIDDEN', { detail: message, cause: e });
      case 404:
        return new EngineError('MODEL_UNAVAILABLE', { detail: message, cause: e });
      case 413:
        return new EngineError('PDF_TOO_LARGE', { detail: message, cause: e });
      case 429: {
        const ms = retryAfterMs(e);
        return new EngineError('API_RATE_LIMITED', {
          detail: message,
          cause: e,
          ...(ms === undefined ? {} : { retryAfterMs: ms }),
        });
      }
      case 529:
        return new EngineError('API_OVERLOADED', { detail: message, cause: e });
      default:
        break;
    }
    if (status !== undefined && status >= 500) {
      return new EngineError('API_SERVER_ERROR', { detail: message, cause: e });
    }
    return new EngineError('UNKNOWN', { detail: `HTTP ${String(status)}: ${message}`, cause: e });
  }

  const transportCode = errorCodeOf(e);
  if (transportCode !== null) {
    if (TLS_ERROR_CODES.has(transportCode)) {
      return new EngineError('PROXY_BLOCKED', { detail: transportCode, cause: e });
    }
    if (OFFLINE_ERROR_CODES.has(transportCode)) {
      return new EngineError('NETWORK_UNAVAILABLE', { detail: transportCode, cause: e });
    }
  }
  return toEngineError(e);
}

/* ───────────────────────────── the engine ──────────────────────── */

export class ApiProvider implements Provider {
  readonly id = 'api' as const;
  readonly maxConcurrency = MAX_CONCURRENCY;
  readonly supportsVision = true;

  private async client(): Promise<{ client: Anthropic; source: ApiKeySource }> {
    const { key, source } = await getKey();
    if (key === null) {
      throw new EngineError('API_KEY_MISSING', {
        detail: 'No API key in the keychain, the fallback file, or ANTHROPIC_API_KEY.',
      });
    }
    return {
      client: new Anthropic({
        apiKey: key,
        timeout: LIMITS.apiTimeoutMs,
        // We do our own retry policy: the queue knows about halt vs retry and the
        // user sees an honest error instead of a request that silently took 4x
        // longer than the timeout it was given.
        maxRetries: 0,
      }),
      source,
    };
  }

  async extract(req: ExtractionRequest, opts: ExtractOptions = {}): Promise<ExtractionResponse> {
    const started = Date.now();

    if (req.fieldsToFill.length === 0) {
      throw new EngineError('SCHEMA_INVALID', { detail: 'No fields were requested.' });
    }
    const usingImages = req.text === null;
    if (usingImages && (req.images === null || req.images.length === 0)) {
      throw new EngineError('PDF_EMPTY', { detail: 'Neither text nor page images were supplied.' });
    }
    if (!usingImages) {
      if (req.text !== null && req.text.length > LIMITS.maxTextChars) {
        throw new EngineError('PDF_TOO_LARGE', {
          detail: `${req.text.length} characters exceeds the ${LIMITS.maxTextChars} single-pass budget.`,
        });
      }
      if (req.pageCount > LIMITS.maxPages) {
        throw new EngineError('PDF_TOO_LARGE', {
          detail: `${req.pageCount} pages exceeds the ${LIMITS.maxPages} page budget.`,
        });
      }
    }

    const { client } = await this.client();
    const model = modelFor(req.tier);
    const schema = buildAnswerJsonSchema(req.fieldsToFill);
    const basePrompt = buildExtractionPrompt(req);

    let prompt = basePrompt;
    let repairAttempts = 0;
    let lastResponse = '';
    let lastIssues: string[] = [];

    for (let attempt = 0; attempt <= LIMITS.maxRepairAttempts; attempt += 1) {
      if (attempt > 0) {
        repairAttempts = attempt;
        opts.onProgress?.('repairing');
      } else {
        opts.onProgress?.('sending');
      }

      const message = await this.send({ client, req, model: model.id, prompt, schema, opts });

      opts.onProgress?.('parsing');
      lastResponse = collectText(message.content);

      const json = extractJson(lastResponse);
      if (json === null) {
        lastIssues = ['The reply contained no JSON object.'];
        if (attempt === LIMITS.maxRepairAttempts) {
          throw new EngineError('SCHEMA_INVALID', { detail: lastIssues.join(' ') });
        }
        prompt = basePrompt + buildRepairInstruction(lastIssues);
        continue;
      }

      const validated = validateAnswer(json, req.fieldsToFill);
      if (!validated.ok) {
        lastIssues = validated.issues;
        if (attempt === LIMITS.maxRepairAttempts) {
          throw new EngineError('SCHEMA_INVALID', { detail: lastIssues.join(' ') });
        }
        prompt = basePrompt + buildRepairInstruction(validated.issues);
        continue;
      }

      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;

      return this.buildResponse({
        req,
        modelId: model.id,
        fields: validated.data,
        docType: extractDocType(json),
        prompt,
        response: lastResponse,
        repairAttempts,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - started,
      });
    }

    throw new EngineError('SCHEMA_INVALID', {
      detail: lastIssues.join(' ') || 'Exhausted repair attempts.',
    });
  }

  /** One round trip. Streams, because a 16k answer risks an HTTP timeout otherwise. */
  private async send(args: {
    client: Anthropic;
    req: ExtractionRequest;
    model: string;
    prompt: string;
    schema: Record<string, unknown>;
    opts: ExtractOptions;
  }): Promise<Anthropic.Messages.Message> {
    const content = buildUserContent(args.req, args.prompt);

    try {
      const stream = args.client.messages.stream(
        {
          model: args.model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content }],
          // Structured outputs: the shape is enforced server-side, which is the
          // whole reason this engine needs no prompt-level begging.
          output_config: { format: { type: 'json_schema', schema: args.schema } },
          // Deliberately absent: temperature, top_p, top_k and thinking budgets are
          // all rejected on current models. There is also no assistant prefill.
        },
        {
          ...(args.opts.signal === undefined ? {} : { signal: args.opts.signal }),
          timeout: args.opts.timeoutMs ?? LIMITS.apiTimeoutMs,
        },
      );

      args.opts.onProgress?.('waiting');
      const message = await stream.finalMessage();

      // Stop reason before content, always: a refusal or a truncation leaves
      // content that looks parseable but is not the answer.
      if (message.stop_reason === 'refusal') {
        throw new EngineError('MODEL_REFUSED', {
          detail: message.stop_details?.explanation ?? 'The model declined to answer.',
        });
      }
      if (message.stop_reason === 'max_tokens') {
        throw new EngineError('OUTPUT_TRUNCATED', {
          detail: `Hit the ${MAX_TOKENS}-token output ceiling.`,
        });
      }
      if (message.stop_reason === 'model_context_window_exceeded') {
        throw new EngineError('PDF_TOO_LARGE', {
          detail: 'The document did not fit in the model context window.',
        });
      }

      return message;
    } catch (e) {
      throw mapApiError(e);
    }
  }

  private buildResponse(args: {
    req: ExtractionRequest;
    modelId: string;
    fields: Partial<Record<FieldKey, RawFieldAnswer>>;
    docType: DocType | null;
    prompt: string;
    response: string;
    repairAttempts: number;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number;
  }): ExtractionResponse {
    return {
      fields: args.fields,
      docType: args.docType,
      usage: {
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        costUsd: estimateCostUsd(args.req.tier, args.inputTokens, args.outputTokens),
      },
      raw: {
        provider: 'api',
        model: args.modelId,
        promptVersion: args.req.promptVersion,
        prompt: args.prompt,
        // Verbatim. notice_email is a tracker field, so redacting the response here
        // would destroy the evidence the reviewer is asked to check.
        response: args.response,
        repairAttempts: args.repairAttempts,
      },
      durationMs: args.durationMs,
    };
  }

  async health(): Promise<ProviderHealth> {
    const checks: HealthCheck[] = [];
    const storage = await keychainStatus();
    const { key, source } = await getKey();

    if (key === null) {
      checks.push({
        id: 'api-key',
        label: 'API key',
        state: 'fail',
        detail: 'No key stored.',
        errorCode: 'API_KEY_MISSING',
      });
      return { provider: 'api', state: 'fail', summary: 'No API key', checks };
    }

    checks.push({
      id: 'api-key',
      label: 'API key',
      state: source === 'keychain' ? 'ok' : 'warn',
      detail: describeSource(source, storage.detail),
    });

    const model = modelFor(DEFAULT_TIER);
    try {
      // Free, side-effect-free, and it exercises the whole path: key, network, TLS,
      // and whether this key can even see the model we default to.
      const client = new Anthropic({ apiKey: key, timeout: 20_000, maxRetries: 0 });
      const info = await client.models.retrieve(model.id);
      checks.push({
        id: 'api-model',
        label: 'Model available',
        state: 'ok',
        detail: `${info.display_name} (${info.id})`,
      });
    } catch (e) {
      const err = mapApiError(e);
      checks.push({
        id: 'api-model',
        label: 'Model available',
        state: 'fail',
        detail: err.info.message,
        errorCode: err.code,
      });
      return {
        provider: 'api',
        state: 'fail',
        summary: err.info.message,
        checks,
      };
    }

    const warned = checks.some((c) => c.state === 'warn');
    return {
      provider: 'api',
      state: warned ? 'warn' : 'ok',
      summary: `Key valid - ${model.label} available`,
      checks,
    };
  }

  async selfTest(opts: ExtractOptions = {}): Promise<{
    ok: boolean;
    durationMs: number;
    fieldsFound: number;
    fieldsTotal: number;
    costUsd: number | null;
    error?: EngineError;
  }> {
    const started = Date.now();
    const req = buildSelfTestRequest({ promptVersion: 'selftest', tier: 'fast' });
    try {
      const res = await this.extract(req, opts);
      const fieldsFound = countVerifiableQuotes(SELF_TEST_TEXT, res.fields);
      return {
        ok: fieldsFound > 0,
        durationMs: Date.now() - started,
        fieldsFound,
        fieldsTotal: SELF_TEST_FIELDS.length,
        costUsd: res.usage.costUsd,
      };
    } catch (e) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        fieldsFound: 0,
        fieldsTotal: SELF_TEST_FIELDS.length,
        costUsd: null,
        error: mapApiError(e),
      };
    }
  }
}

/* ──────────────────────────── helpers ──────────────────────────── */

function describeSource(source: ApiKeySource, storageDetail: string): string {
  switch (source) {
    case 'keychain':
      return 'Stored in the macOS keychain.';
    case 'file':
      return `Stored in a local file, not the keychain. ${storageDetail}`;
    case 'env':
      return 'Read from the ANTHROPIC_API_KEY environment variable, not stored by the app.';
    case 'none':
      return 'No key stored.';
  }
}

function buildUserContent(
  req: ExtractionRequest,
  prompt: string,
): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  if (req.text === null && req.images !== null) {
    for (const page of req.images.slice(0, LIMITS.maxVisionPages)) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: page.mediaType, data: page.base64 },
      });
    }
  }

  // The prompt goes last and is byte-identical to the one the CLI engine sends, so
  // the same document cannot read differently just because the engine changed.
  blocks.push({ type: 'text', text: prompt });
  return blocks;
}

function collectText(content: readonly Anthropic.Messages.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n');
}
