import { z } from 'zod';

import { notFound, parse, readJson, route } from '@/app/api/_lib/http';
import {
  editContractField,
  getContract,
  getContractAudit,
  getContractFields,
} from '@/lib/db/queries';
import { FIELD_KEYS } from '@/lib/fields';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const MAX_VALUE_CHARS = 4000;

const Body = z.object({
  key: z.enum(FIELD_KEYS),
  value: z.string().max(MAX_VALUE_CHARS).nullable(),
});

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.contract.get', async () => {
    const { id } = await ctx.params;
    const contract = getContract(id);
    if (!contract) throw notFound('contract');
    return {
      contract,
      fields: getContractFields(id),
      audit: getContractAudit(id),
    };
  });
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  return route('api.contract.patch', async () => {
    const { id } = await ctx.params;
    const body = parse(Body, await readJson(req), 'contract edit');
    // Checked here so a bad id is a clean 404 rather than the write path's guard.
    if (!getContract(id)) throw notFound('contract');

    // editContractField writes the audit row and recomputes the derived dates in one
    // transaction; a silent edit to an approved record is what the trail exists to stop.
    const contract = editContractField(id, body.key, body.value);

    log.info('contract.field.edited', { contractId: id, key: body.key });
    return { contract, fields: getContractFields(id) };
  });
}
