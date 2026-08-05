import { z } from 'zod';

import { badRequest, notFound, parse, readJson, route } from '@/app/api/_lib/http';
import { editDocumentField, getDocument } from '@/lib/db/queries';
import { FIELDS, FIELD_KEYS } from '@/lib/fields';
import { log } from '@/lib/logger';
import { parseDateIso } from '@/lib/util/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const MAX_VALUE_CHARS = 4000;

const Body = z.object({
  key: z.enum(FIELD_KEYS),
  value: z.string().max(MAX_VALUE_CHARS).nullable(),
  method: z.enum(['manual', 'na']),
});

function normalise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.field.patch', async () => {
    const { id } = await ctx.params;
    const body = parse(Body, await readJson(req), 'field edit');
    if (!getDocument(id)) throw notFound('document');

    // 'na' means "explicitly not in this document", which is a null with intent.
    const raw = body.method === 'na' ? null : normalise(body.value);

    /*
     * A date is stored as a date or it is not stored.
     *
     * The browser normalises this, but the browser is not the gate: PATCHing
     * "TBD" straight at the route returned 200 and stored it verbatim, and
     * approvalBlockers() only tests for null -- so a required date field was
     * satisfied by a word. The record then had no effective date, no computable
     * termination, a status of "unknown" and a blank Excel cell, while the Review
     * screen still displayed "TBD". Two screens disagreeing about the same field is
     * how she stops believing either.
     */
    let value = raw;
    if (raw !== null && FIELDS[body.key].type === 'date') {
      const iso = parseDateIso(raw);
      if (iso === null) {
        throw badRequest(
          `${FIELDS[body.key].label} has to be a date. Try year-month-day, e.g. 2027-11-05.`,
        );
      }
      value = iso;
    }

    // editDocumentField recomputes termination_date and the confidentiality clock
    // inside the same transaction, so the computed rows can never lag an edit.
    const fields = editDocumentField(id, body.key, value, { method: body.method });

    log.info('document.field.edited', {
      documentId: id,
      key: body.key,
      method: body.method,
      cleared: value === null,
    });
    return { fields };
  });
}
