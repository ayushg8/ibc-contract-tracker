/**
 * The repeatability guarantee.
 *
 * Same bytes + same model + same prompt version + same field list => the same
 * answer, forever, at zero cost. This is what lets someone re-open a contract in a
 * year and see exactly what was extracted, and it is why the key includes the field
 * list: a run that only asked for three fields must not satisfy a run that asks for
 * twelve.
 *
 * A corrupt or half-written row is treated as a miss. A cache is never allowed to be
 * the reason an extraction fails.
 */

import { createHash } from 'node:crypto';

import type { FieldKey } from '@/lib/fields';
import { toEngineError } from '@/lib/providers/errors';
import type { ExtractionResponse } from '@/lib/providers/types';
import { getCachedExtraction, putCachedExtraction } from '@/lib/db/queries';

export interface CacheOptions {
  /** The retry path sets this: the user asked for a fresh answer, not the stored one. */
  bypass?: boolean;
}

/**
 * Canonical string, then sha256. Fields are sorted so caller order cannot fork the
 * key, and the separator cannot occur in any component.
 */
export function cacheKey(
  fileHash: string,
  model: string,
  promptVersion: string,
  fieldsToFill: readonly FieldKey[],
): string {
  const canonical = [fileHash, model, promptVersion, [...fieldsToFill].sort().join(',')].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function getCached(key: string, opts: CacheOptions = {}): ExtractionResponse | null {
  if (opts.bypass) return null;
  const row = getCachedExtraction(key);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.responseJson);
    return isExtractionResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function putCached(
  key: string,
  meta: { fileHash: string; model: string; promptVersion: string },
  response: ExtractionResponse,
): void {
  try {
    putCachedExtraction({
      cacheKey: key,
      fileHash: meta.fileHash,
      model: meta.model,
      promptVersion: meta.promptVersion,
      responseJson: JSON.stringify(response),
    });
  } catch (e) {
    // A cache write must never fail an extraction that already succeeded.
    const err = toEngineError(e);
    if (err.code === 'DISK_FULL' || err.code === 'DB_CORRUPT') throw err;
  }
}

/**
 * Structural check on a stored row. Deliberately shallow: it proves the row is the
 * right kind of object, and the pipeline validates the fields themselves.
 */
function isExtractionResponse(v: unknown): v is ExtractionResponse {
  if (typeof v !== 'object' || v === null) return false;
  if (!('fields' in v) || typeof v.fields !== 'object' || v.fields === null) return false;
  if (!('usage' in v) || typeof v.usage !== 'object' || v.usage === null) return false;
  if (!('raw' in v) || typeof v.raw !== 'object' || v.raw === null) return false;
  if (!('docType' in v)) return false;
  return true;
}
