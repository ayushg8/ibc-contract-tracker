import { readFile } from 'node:fs/promises';

import { notFound, route } from '@/app/api/_lib/http';
import {
  clearCache,
  clearDocumentError,
  getContract,
  getDocument,
  getDocumentSummary,
  insertAudit,
  unapproveContract,
} from '@/lib/db/queries';
import { sha256 } from '@/lib/extraction/pdf';
import { PROMPT_VERSION } from '@/lib/extraction/prompt';
import { extractionQueue } from '@/lib/extraction/queue';
import { log } from '@/lib/logger';
import { archivedPdfPath } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Same reasoning as the retry route: the cache exists so an unchanged file, model
 * and prompt version give the same answer forever, which is the opposite of what
 * "read this again" means. The entry is keyed by file hash, so re-hashing the
 * archived copy is how we find it.
 */
async function dropCachedResult(archivePath: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(archivePath));
  clearCache(sha256(bytes));
}

/**
 * Re-read an approved document with the current prompt and model, and put the
 * record back in the Inbox for review.
 *
 * Unapprove has to happen first and is not optional: a contract carries a frozen
 * copy of the evidence taken at approval, so leaving the row in place while the
 * document is re-read would leave the repository showing values the document's
 * own fields no longer agree with. The record comes back when she approves the
 * new read, which is the point -- a re-read is a proposal, not a silent rewrite.
 */
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.contract.reextract', async () => {
    const { id } = await ctx.params;
    const contract = getContract(id);
    if (!contract) throw notFound('record');

    const before = getDocument(contract.documentId);
    if (!before) throw notFound('document');
    const previousPromptVersion = before.promptVersion;

    const documentId = unapproveContract(id);

    const archivePath = before.archivePath ?? archivedPdfPath(before.id, before.filename);
    try {
      await dropCachedResult(archivePath);
    } catch (e) {
      // Worst case the run is served from cache and the fields come back identical.
      // Refusing the re-read outright over a missing cache entry is worse.
      log.warn('reextract.cache.not-cleared', { documentId, error: e });
    }

    insertAudit({
      documentId,
      action: 'reextracted',
      detail:
        previousPromptVersion === PROMPT_VERSION
          ? `prompt ${PROMPT_VERSION}`
          : `prompt ${previousPromptVersion ?? 'unknown'} -> ${PROMPT_VERSION}`,
    });

    // Clear the old failure before queueing, so the Inbox card does not show a
    // reason that is no longer true while the new read is in flight.
    clearDocumentError(documentId);
    extractionQueue.add(documentId);

    const document = getDocumentSummary(documentId);
    if (!document) throw notFound('document');

    log.info('contract.reextract', { contractId: id, documentId, promptVersion: PROMPT_VERSION });
    return {
      contractId: id,
      documentId,
      document,
      previousPromptVersion,
      promptVersion: PROMPT_VERSION,
    };
  });
}
