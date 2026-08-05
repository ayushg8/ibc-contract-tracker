import { conflict, notFound, route } from '@/app/api/_lib/http';
import {
  contractArchiveState,
  getContract,
  getDocumentSummary,
  liveContractIdForDocument,
  restoreContract,
} from '@/lib/db/queries';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Bring a removed record back into the repository.
 *
 * This is the durable half of undo. The toast's Undo button expires with the
 * toast; this is the button on the Removed view, which is reachable for as long
 * as the record exists -- so "Remove" is finally a soft delete a person can walk
 * back rather than one only SQL can.
 *
 * Restoring also returns the document to 'approved', undoing the 'rejected' that
 * archive set. Refused when the document has since been re-read and approved into
 * a new record: two live records over one PDF is what the partial unique index
 * forbids, and the caller deserves to be told which one holds the slot.
 *
 * Idempotent, so a double click is harmless: a record that is already live is
 * returned unchanged.
 */
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.contract.restore', async () => {
    const { id } = await ctx.params;

    // contractArchiveState, not getContract: getContract hides archived rows, and
    // an archived row is the only thing this route is ever asked about.
    const state = contractArchiveState(id);
    if (state === null) throw notFound('record');

    if (state.archivedAt !== null) {
      const live = liveContractIdForDocument(state.documentId);
      if (live !== null) {
        throw conflict(
          'That document has been read again and approved since, so it already has a record in the repository.',
          {
            remedy: { action: 'none', label: 'Open the current record' },
            extra: { contractId: live },
          },
        );
      }
      restoreContract(id);
      log.info('contract.restored', { contractId: id, documentId: state.documentId });
    }

    const contract = getContract(id);
    if (!contract) throw notFound('record');

    return {
      contractId: id,
      archived: false,
      contract,
      document: getDocumentSummary(state.documentId),
    };
  });
}
