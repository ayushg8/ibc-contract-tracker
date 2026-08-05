import { conflict, notFound, route } from '@/app/api/_lib/http';
import { getDocument, insertAudit, markDocumentQueued } from '@/lib/db/queries';
import { extractionQueue } from '@/lib/extraction/queue';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Undo a rejection.
 *
 * Rejecting is a state, not a delete, so coming back is a status change rather
 * than a re-import: the archived PDF, the extracted fields and every audit row
 * are still there. The extraction is re-queued anyway because a document can
 * also be rejected out of `failed`, and the cache is keyed by file hash, so a
 * document whose result is still good costs one cache hit rather than a call.
 */
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.reopen', async () => {
    const { id } = await ctx.params;
    const existing = getDocument(id);
    if (!existing) throw notFound('document');

    // An approved document has a contract hanging off it; putting it back in the
    // queue would leave the repository row pointing at a document being re-read.
    // Unapproving is that path, and it is the repository's button, not this one.
    if (existing.status === 'approved') {
      throw conflict('That document is already in the repository.', {
        remedy: { action: 'none', label: 'Open the record' },
      });
    }

    const document = markDocumentQueued(id);
    if (!document) throw notFound('document');

    insertAudit({ documentId: id, action: 'reopened', detail: `from ${existing.status}` });
    extractionQueue.add(id);

    log.info('document.reopened', { documentId: id, from: existing.status });
    return { document };
  });
}
