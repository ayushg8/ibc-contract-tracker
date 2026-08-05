/**
 * The single place an exception becomes a response.
 *
 * Bonnie must never see a stack trace, so every handler body runs inside `route()`
 * and every failure leaves here as `{ error: SerialisedEngineError }` with a status
 * that matches the cause. Underscore-prefixed folder => Next never routes this.
 *
 * The error taxonomy is an *engine* taxonomy: it has no code for "you asked for a
 * record that isn't there". ApiError fills that gap by subclassing EngineError and
 * overriding only the presentation, so `toEngineError()` still passes it through
 * untouched and the response shape stays identical.
 */

import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { ZodType, output as ZodOutput } from 'zod';

import { log } from '@/lib/logger';
import {
  EngineError,
  toEngineError,
  type EngineErrorCode,
  type Remedy,
  type SerialisedEngineError,
} from '@/lib/providers/errors';

export class ApiError extends EngineError {
  readonly status: number;
  /** Extra top-level keys merged into the response body, e.g. unresolvedFields. */
  readonly extra: Record<string, unknown>;
  private readonly presentation: {
    message: string | undefined;
    remedy: Remedy | undefined;
    retryable: boolean | undefined;
  };

  constructor(
    status: number,
    code: EngineErrorCode,
    opts: {
      message?: string;
      remedy?: Remedy;
      retryable?: boolean;
      detail?: string;
      cause?: unknown;
      extra?: Record<string, unknown>;
    } = {},
  ) {
    super(code, { detail: opts.detail, cause: opts.cause });
    this.status = status;
    this.extra = opts.extra ?? {};
    this.presentation = {
      message: opts.message,
      remedy: opts.remedy,
      retryable: opts.retryable,
    };
  }

  override toJSON(): SerialisedEngineError {
    const base = super.toJSON();
    return {
      ...base,
      message: this.presentation.message ?? base.message,
      remedy: this.presentation.remedy ?? base.remedy,
      retryable: this.presentation.retryable ?? base.retryable,
      retryAfterMs: null,
      halt: false,
    };
  }
}

export function badRequest(message: string, detail?: string): ApiError {
  return new ApiError(400, 'UNKNOWN', {
    message,
    retryable: false,
    remedy: { action: 'contact-support', label: 'Copy support bundle' },
    detail,
  });
}

export function notFound(what: string): ApiError {
  return new ApiError(404, 'UNKNOWN', {
    message: `That ${what} is no longer in the tracker.`,
    retryable: false,
    remedy: { action: 'none', label: 'Go back' },
  });
}

export function conflict(
  message: string,
  opts: {
    remedy?: Remedy;
    extra?: Record<string, unknown>;
    detail?: string;
    code?: EngineErrorCode;
  } = {},
): ApiError {
  return new ApiError(409, opts.code ?? 'CONFLICT', {
    message,
    retryable: false,
    remedy: opts.remedy ?? { action: 'none', label: 'OK' },
    extra: opts.extra,
    detail: opts.detail,
  });
}

/** Anything not listed is an engine or environment failure: 503. */
const STATUS_BY_CODE: Partial<Record<EngineErrorCode, number>> = {
  PDF_UNREADABLE: 400,
  PDF_ENCRYPTED: 400,
  PDF_NO_TEXT_LAYER: 400,
  PDF_TOO_LARGE: 400,
  PDF_EMPTY: 400,
  VISION_UNSUPPORTED: 400,
  DB_CORRUPT: 500,
  UNKNOWN: 500,
};

function statusFor(e: EngineError): number {
  if (e instanceof ApiError) return e.status;
  return STATUS_BY_CODE[e.code] ?? 503;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Run a handler body. Returning a plain object serialises it as JSON; returning a
 * Response (files, spreadsheets) passes it straight through.
 */
export async function route(
  event: string,
  fn: () => Promise<object>,
): Promise<Response> {
  try {
    const out = await fn();
    if (out instanceof Response) return out;
    return Response.json(out, { headers: NO_STORE });
  } catch (e) {
    const err = toEngineError(e);
    const status = statusFor(err);
    const body: Record<string, unknown> = { error: err.toJSON() };
    if (err instanceof ApiError) Object.assign(body, err.extra);

    log[status >= 500 ? 'error' : 'warn'](event, {
      status,
      code: err.code,
      detail: err.detail,
    });
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export function parse<S extends ZodType>(schema: S, value: unknown, what: string): ZodOutput<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : what}: ${i.message}`)
    .join('; ');
  throw badRequest(`The app sent something the tracker could not read (${what}).`, detail);
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (e) {
    throw badRequest('That request arrived without a readable body.', String(e));
  }
}

export function errnoCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : '';
}

/**
 * Every path that comes from a request is confined to a base directory before it is
 * opened. Document ids are opaque, but the paths stored against them are not, so this
 * is the boundary that stops `../../../etc/passwd` from ever being read.
 */
export function resolveInside(baseDir: string, candidate: string): string {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  if (target !== base && !target.startsWith(base + sep)) {
    throw badRequest(
      'That file is not inside the tracker archive.',
      'path outside base directory rejected',
    );
  }
  return target;
}

/**
 * Returns a Uint8Array rather than a Buffer: node's Buffer is typed over
 * ArrayBufferLike, which the DOM's BodyInit will not accept.
 */
export async function readArchived(path: string, what: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT' || code === 'EISDIR') throw notFound(what);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new EngineError('FOLDER_UNREADABLE', { detail: `${code} while reading ${what}`, cause: e });
    }
    throw toEngineError(e);
  }
}

/** Content-Disposition is a header; anything outside printable ASCII breaks it. */
export function headerFilename(name: string): string {
  const cleaned = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  return cleaned.length > 0 ? cleaned : 'document.pdf';
}
