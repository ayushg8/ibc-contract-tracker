import { notFound, route } from '@/app/api/_lib/http';
import { getContract, getDocumentSummary, unapproveContract } from '@/lib/db/queries';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Send an approved record back to the Inbox.
 *
 * This is the Undo target for a bulk approve, so it has to be safe to fire twice:
 * the contract row is gone after the first call, `getContract` stops finding it,
 * and the second call is a clean 404 rather than a 500 out of the write path.
 *
 * The document's own field rows were never touched by approve, so Review reopens
 * exactly as it was left.
 */
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.contract.unapprove', async () => {
    const { id } = await ctx.params;
    if (!getContract(id)) throw notFound('record');

    // Drops the contract, its parties and its frozen evidence, moves the document
    // back to `ready` and writes the audit row -- all in one transaction.
    const documentId = unapproveContract(id);

    const document = getDocumentSummary(documentId);
    if (!document) throw notFound('document');

    log.info('contract.unapproved', { contractId: id, documentId });
    return { contractId: id, documentId, document };
  });
}
