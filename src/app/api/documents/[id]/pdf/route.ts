import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { headerFilename, notFound, readArchived, resolveInside, route } from '@/app/api/_lib/http';
import { getDocument } from '@/lib/db/queries';
import { archiveDir, archivedPdfPath } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Archived files are keyed by document id, so their bytes never change under a URL. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

/**
 * The stored path, confined to the archive, or null.
 *
 * Non-throwing on purpose, unlike resolveInside: `archive_path` is a column, and a
 * value that no longer points inside the archive is a stale row rather than an
 * attack. It still must never be opened, so it is dropped rather than refused --
 * and the derived path below takes over.
 */
function insideArchive(candidate: string): string | null {
  const base = resolve(archiveDir());
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep) ? target : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // Missing, or a directory we cannot walk. Either way this is not the copy to
    // serve; the caller falls through to the derived path, which readArchived
    // then turns into the right error rather than this catch guessing at one.
    return false;
  }
}

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  return route('api.document.pdf', async () => {
    const { id } = await ctx.params;
    const document = getDocument(id);
    if (!document) throw notFound('document');

    /*
     * TWO SHAPES, IN THIS ORDER.
     *
     * `archive_path` is stored absolute, so a repository restored by the printed
     * RESTORE steps into a data directory at a different path -- a new Mac, a
     * different account, an external drive -- carries rows pointing at the OLD
     * location. The PDFs are there, byte-identical, under the names the backup
     * wrote; only the column disagrees. Serving nothing in that case means a
     * restore that "worked" and a repository where no document can be opened,
     * which is the failure this fallback exists to make impossible.
     *
     * archivedPdfPath() reproduces exactly the name the archive holds --
     * `<id>-<safe filename>` -- so it is the same file, found by construction
     * rather than by a path written down on another machine.
     */
    const stored = document.archivePath === null ? null : insideArchive(document.archivePath);
    const path =
      stored !== null && (await isFile(stored))
        ? stored
        : resolveInside(archiveDir(), archivedPdfPath(document.id, document.filename));

    // Not found here means neither shape is on disk: a genuine 404, and the only
    // one this route may answer with.
    const bytes = await readArchived(path, 'PDF');

    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename="${headerFilename(document.filename)}"`,
        'Cache-Control': IMMUTABLE,
      },
    });
  });
}
