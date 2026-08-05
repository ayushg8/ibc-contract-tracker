import { conflict, notFound, route } from '@/app/api/_lib/http';
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.approve', async () => {
    const { id } = await ctx.params;
    if (!getDocument(id)) throw notFound('document');

    // The status gate. `approveDocument` refuses on its own too -- this is here so
    // the refusal arrives as a 409 naming the actual status rather than a 500.
    // Rejecting a document only flips its status; its extracted fields survive, so
    // it has no unresolved fields and the field gate below waves it through.
    const blockedBy = approvalStatusBlocker(id);
    if (blockedBy !== null) {
      throw conflict(approvalStatusMessage(blockedBy), {
        remedy: { action: 'none', label: 'OK' },
        extra: { documentStatus: blockedBy },
      });
    }

    const unresolved = approvalBlockers(id);
    if (unresolved.length > 0) {
      // The UI points at these by key, so the list is the whole payload, not a hint.
      throw conflict(
        unresolved.length === 1
          ? 'One required field still needs an answer before this can be approved.'
          : `${unresolved.length} required fields still need an answer before this can be approved.`,
        {
          remedy: {
            action: 'enter-manually',
            label: 'Go to the first one',
            hint: 'Fill it in, or mark it "Not in document" if the agreement is silent.',
          },
          extra: {
            unresolvedFields: unresolved.map((key) => ({ key, label: FIELDS[key].label })),
          },
        },
      );
    }

    const contractId = approveDocument(id);
    const contract = getContract(contractId);
    if (!contract) throw notFound('contract');

    log.info('document.approved', { documentId: id, contractId });
    return { contract };
  });
}
