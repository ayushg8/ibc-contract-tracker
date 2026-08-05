import { z } from 'zod';

import { conflict, notFound, parse, readJson, route } from '@/app/api/_lib/http';
import {
  getContractByDocument,
  getDocument,
  getDocumentFields,
  rejectDocument,
  setDocumentType,
} from '@/lib/db/queries';
import { DOC_TYPES } from '@/lib/fields';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ docType: z.enum(DOC_TYPES) });

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.get', async () => {
    const { id } = await ctx.params;
    const document = getDocument(id);
    if (!document) throw notFound('document');
    return {
      document,
      fields: getDocumentFields(id),
      contract: getContractByDocument(id),
    };
  });
}

/**
 * Correct a misclassified document.
 *
 * The type is not a label: it decides which sheet the record exports onto and
 * which columns that sheet carries. Review has offered the selector since the
 * first build and there was no handler behind it, so an evaluation agreement read
 * as an NDA could never be corrected and landed on the wrong tab of the workbook.
 *
 * Refused once the document is approved. The contract copied the type at approval
 * and the export reads it from there, so changing it here would move a record
 * between sheets while the contract still said otherwise. Send it back to the
 * Inbox and the selector unlocks with it.
 */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.patch', async () => {
    const { id } = await ctx.params;
    const body = parse(Body, await readJson(req), 'document type');
    const document = getDocument(id);
    if (!document) throw notFound('document');
    if (document.status === 'approved') {
      throw conflict(
        'That document has already been approved, so its type is fixed. Send it back to the Inbox to change it.',
        { detail: `docType change refused for approved document ${id}` },
      );
    }

    setDocumentType(id, body.docType);
    log.info('document.type.set', { documentId: id, docType: body.docType });

    return {
      document: getDocument(id),
      fields: getDocumentFields(id),
      contract: getContractByDocument(id),
    };
  });
}

/** Soft: status becomes 'rejected'. Nothing but cache is ever hard-deleted. */
export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.reject', async () => {
    const { id } = await ctx.params;
    if (!getDocument(id)) throw notFound('document');
    rejectDocument(id);
    log.info('document.rejected', { documentId: id });
    return { ok: true };
  });
}
