import { z } from 'zod';

import { conflict, notFound, parse, route } from '@/app/api/_lib/http';
import {
  archiveContract,
  contractArchiveState,
  getContract,
  liveContractIdForDocument,
  restoreContract,
} from '@/lib/db/queries';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** `?undo=1` reverses the archive, which is what the toast's Undo button calls. */
const Undo = z.enum(['0', '1', 'true', 'false']).nullable();

/**
 * Soft delete, and its undo.
 *
 * Archiving takes the record out of the repository table, the expiring list, the
 * counts and the Excel export -- every read goes through CONTRACT_SQL, which
 * filters `archived_at IS NULL`. Nothing is destroyed: the contract row, its
 * evidence, its audit trail and the PDF in the archive all stay exactly where
 * they are, which is the difference between a record leaving a report and a
 * record leaving the system. The document behind it moves to 'rejected', so it
 * stays reachable in the Inbox instead of sitting behind an "Approved" pill that
 * points at a record no read in the app can find.
 *
 * The undo here is the same operation the Removed view's Restore button performs
 * (POST /api/contracts/[id]/restore): one function, one audit action, so the two
 * paths cannot diverge. This route stays because the toast already calls it -- it
 * is simply no longer the only way back.
 *
 * The inline SQL that used to live in this file is gone; both halves are named
 * functions in queries.ts now, which is where the document-status half belongs.
 *
 * Both directions are idempotent, because the caller is a toast button that a
 * person can press twice.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  return route('api.contract.archive', async () => {
    const { id } = await ctx.params;
    const raw = parse(Undo, new URL(req.url).searchParams.get('undo'), 'undo');
    const restore = raw === '1' || raw === 'true';

    // Not getContract(): that read already hides archived rows, so it cannot tell
    // "never existed" from "already archived" -- and undo needs the difference.
    const state = contractArchiveState(id);
    if (state === null) throw notFound('record');

    if (restore) {
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
        log.info('contract.restored', { contractId: id, via: 'undo' });
      }
      const contract = getContract(id);
      if (!contract) throw notFound('record');
      return { contractId: id, archived: false, contract };
    }

    archiveContract(id);
    log.info('contract.archived', { contractId: id, documentId: state.documentId });
    return { contractId: id, archived: true, contract: null };
  });
}
