import { readFile } from 'node:fs/promises';

import { notFound, route } from '@/app/api/_lib/http';
import { clearCache, clearDocumentError, getDocument } from '@/lib/db/queries';
import { sha256 } from '@/lib/extraction/pdf';
import { extractionQueue } from '@/lib/extraction/queue';
import { log } from '@/lib/logger';
import { archivedPdfPath } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * A retry that replayed the cache would be a lie: the cache exists so the same file
 * yields the same answer forever, which is the opposite of what Retry is for. The
 * entry is keyed by file hash, so re-hashing the archived copy is how we find it.
 */
async function dropCachedResult(archivePath: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(archivePath));
  clearCache(sha256(bytes));
}

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.retry', async () => {
    const { id } = await ctx.params;
    const existing = getDocument(id);
    if (!existing) throw notFound('document');

    const archivePath = existing.archivePath ?? archivedPdfPath(existing.id, existing.filename);
    try {
      await dropCachedResult(archivePath);
    } catch (e) {
      // Worst case the run is served from cache. Failing the retry outright is worse.
      log.warn('retry.cache.not-cleared', { documentId: id, error: e });
    }

    // Clear the old reason first so the Inbox card stops showing a failure that is
    // no longer true while the retry is in flight.
    clearDocumentError(id);
    extractionQueue.add(id);

    const document = getDocument(id);
    if (!document) throw notFound('document');
    log.info('document.retry', { documentId: id });
    return { document };
  });
}
