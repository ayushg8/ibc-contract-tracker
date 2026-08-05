import { route } from '@/app/api/_lib/http';
import { documentCountsByStatus, getStats, usageRollup } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route('api.stats', async () => {
    const stats = getStats();
    const usage = usageRollup();
    const byStatus = documentCountsByStatus();

    return {
      inbox: stats.inbox,
      // "Pending" is the number waiting on Bonnie, not the number in the folder.
      pending: (byStatus['ready'] ?? 0) + (byStatus['needs_attention'] ?? 0),
      contracts: stats.contracts,
      expiring: stats.expiring,
      usage: {
        month: usage.month,
        documents: usage.documents,
        costUsd: usage.costUsd,
        points: usage.daily.map((d) => d.costUsd),
      },
    };
  });
}
