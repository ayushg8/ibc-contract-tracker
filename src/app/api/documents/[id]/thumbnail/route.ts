import { notFound, readArchived, resolveInside, route } from '@/app/api/_lib/http';
import { getDocument } from '@/lib/db/queries';
import { thumbDir, thumbnailPath } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const IMMUTABLE = 'private, max-age=31536000, immutable';

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.thumbnail', async () => {
    const { id } = await ctx.params;
    const document = getDocument(id);
    if (!document) throw notFound('document');

    /*
     * DERIVED, NEVER STORED, and that is what makes it survive a restore.
     *
     * The sibling PDF route had to grow a fallback because `archive_path` is
     * stored absolute: a repository restored into a data directory at a different
     * path serves nothing from the column. `thumbnail_path` is stored the same
     * way and is just as stale afterwards -- so it is not read here at all. The id
     * plus the current thumbnail folder name the same file the backup wrote, on
     * whichever Mac it is unzipped onto. Do not "simplify" this to the column.
     */
    const path = resolveInside(thumbDir(), thumbnailPath(document.id));
    const bytes = await readArchived(path, 'thumbnail');

    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': IMMUTABLE,
      },
    });
  });
}
