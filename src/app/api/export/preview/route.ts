import { currentSettings } from '@/app/api/_lib/settings';
import { route } from '@/app/api/_lib/http';
import { exportCounts } from '@/lib/excel/export';
import { DOC_TYPES, DOC_TYPE_SHEET } from '@/lib/fields';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route('api.export.preview', async () => {
    const counts = exportCounts();
    const settings = await currentSettings();

    return {
      sheets: DOC_TYPES.map((id) => ({ id, label: DOC_TYPE_SHEET[id], rows: counts[id] })),
      lastExportedAt: settings.lastExportedAt,
    };
  });
}
