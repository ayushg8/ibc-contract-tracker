import { z } from 'zod';

import { parse, route } from '@/app/api/_lib/http';
import { listArchivedContracts, listContracts } from '@/lib/db/queries';
import { DOC_TYPES } from '@/lib/fields';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUERY_CHARS = 200;
const MAX_LIMIT = 1000;

/** Whitelisted, so a sort param can never reach the query builder as free text. */
const SORT_KEYS = [
  'counterparty',
  'docType',
  'contractName',
  'effectiveDate',
  'terminationDate',
  'confidentialityEnd',
  'governingLaw',
  'approvedAt',
  'status',
] as const;

/**
 * `?archived=1` switches the list to the Removed view. A flag rather than a second
 * route because every other parameter -- search, doc type, sort, paging -- means
 * exactly the same thing on both sides, and duplicating them is how the two lists
 * would end up sorting differently.
 */
const Archived = z.enum(['0', '1', 'true', 'false']).nullable();

const Query = z.object({
  search: z.string().max(MAX_QUERY_CHARS).optional(),
  filter: z.enum(['all', 'active', 'expiring', 'expired', 'unknown']).default('all'),
  docType: z.enum([...DOC_TYPES, 'all']).default('all'),
  sort: z.enum(SORT_KEYS).default('approvedAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: Request): Promise<Response> {
  return route('api.contracts.list', async () => {
    const sp = new URL(req.url).searchParams;
    const query = parse(
      Query,
      {
        search: sp.get('q') ?? undefined,
        filter: sp.get('filter') ?? undefined,
        docType: sp.get('docType') ?? undefined,
        sort: sp.get('sort') ?? undefined,
        dir: sp.get('dir') ?? undefined,
        limit: sp.get('limit') ?? undefined,
        offset: sp.get('offset') ?? undefined,
      },
      'contract search',
    );

    const raw = parse(Archived, sp.get('archived'), 'archived');
    const archived = raw === '1' || raw === 'true';

    // The archived rows carry `archivedAt`; the live ones do not. `archived` is
    // echoed so the client never has to infer which list it is holding.
    if (archived) {
      const removed = listArchivedContracts(query);
      return { contracts: removed.rows, total: removed.total, archived: true };
    }

    const page = listContracts(query);
    return { contracts: page.rows, total: page.total, archived: false };
  });
}
