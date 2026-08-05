import { z } from 'zod';

import { conflict, notFound, parse, readJson, route } from '@/app/api/_lib/http';
import {
  approvalBlockers,
  approvalStatusBlocker,
  approvalStatusMessage,
  approveDocument,
  getContract,
  getDocument,
} from '@/lib/db/queries';
import { FIELDS } from '@/lib/fields';
import { log } from '@/lib/logger';
import { toEngineError, type SerialisedEngineError } from '@/lib/providers/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One backfill session, not one working set. Higher than she will ever select by
 * hand, low enough that a malformed request cannot ask for an unbounded loop.
 */
const MAX_IDS = 500;

const Body = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_IDS),
});

interface Approved {
  id: string;
  contractId: string;
  counterparty: string | null;
}

interface Failed {
  id: string;
  filename: string | null;
  error: SerialisedEngineError;
}

/**
 * Approve many documents in one request.
 *
 * The promise the product makes is that a human approves every record -- not
 * that she approves them one screen at a time. So this is a loop over the same
 * single-document approve, with the same required-field gate, and it refuses
 * exactly what the one-at-a-time route refuses.
 *
 * Each document gets its own transaction and its own catch. Twelve agreements
 * where the fourth has a missing party must leave eleven in the repository and
 * one still in the Inbox -- a batch that rolls back on one bad document is how a
 * backfill of two hundred becomes unusable.
 */
export async function POST(req: Request): Promise<Response> {
  return route('api.documents.bulk-approve', async () => {
    const body = parse(Body, await readJson(req), 'bulk approve');
    // Dedupe rather than reject: the same id twice is a UI slip, and the second
    // pass would report "already approved" as a failure against itself.
    const ids = [...new Set(body.ids)];

    const approved: Approved[] = [];
    const failed: Failed[] = [];

    for (const id of ids) {
      const document = getDocument(id);
      try {
        if (!document) throw notFound('document');

        // Same gate as the single-document route, and it lands in failed[] rather
        // than aborting the batch: selecting a rejected document by mistake must
        // cost her that one row, not the other eleven.
        const blockedBy = approvalStatusBlocker(id);
        if (blockedBy !== null) {
          throw conflict(approvalStatusMessage(blockedBy), {
            remedy: { action: 'none', label: 'Open it' },
          });
        }

        const unresolved = approvalBlockers(id);
        const first = unresolved[0];
        if (first !== undefined) {
          throw conflict(
            unresolved.length === 1
              ? `${FIELDS[first].label} still needs an answer.`
              : `${unresolved.length} required fields still need an answer.`,
            {
              remedy: {
                action: 'enter-manually',
                label: 'Open it',
                hint: 'Fill them in, or mark them "Not in document" if the agreement is silent.',
              },
            },
          );
        }

        // Already a transaction, and idempotent: a document that was approved
        // between the click and this loop returns its existing contract id.
        const contractId = approveDocument(id);
        const contract = getContract(contractId);
        approved.push({ id, contractId, counterparty: contract?.counterparty ?? null });
      } catch (e) {
        failed.push({
          id,
          filename: document?.filename ?? null,
          error: toEngineError(e).toJSON(),
        });
      }
    }

    log.info('documents.bulk-approved', {
      requested: ids.length,
      approved: approved.length,
      failed: failed.length,
    });
    return { approved, failed };
  });
}
