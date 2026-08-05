import { route } from '@/app/api/_lib/http';
import { buildSupportBundle } from '@/lib/support';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return route('api.support.bundle', async () => {
    const bundle = await buildSupportBundle();
    return { filename: bundle.filename, contents: bundle.contents };
  });
}
