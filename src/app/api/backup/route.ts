import { z } from 'zod';

import { ApiError, headerFilename, parse, route } from '@/app/api/_lib/http';
import { createBackup, dataOverview, MAX_BACKUP_BYTES } from '@/lib/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ZIP_MIME = 'application/zip';

/**
 * The uncompressed size the build expects to emit. The Data tab divides the
 * bytes it has received by this to draw a determinate progress bar, which it
 * cannot get from Content-Length: the archive is produced as it is sent, so its
 * real size is not known until the last byte has left.
 */
const ESTIMATE_HEADER = 'X-Backup-Estimated-Bytes';

/**
 * `?info=1` answers with what the Data tab shows -- paths, counts, sizes, when
 * the last backup was taken. Anything else builds and streams the archive.
 *
 * One route rather than two because the two answers are two views of the same
 * thing, and because the info call is what tells the tab whether the archive is
 * even buildable before she presses the button.
 */
const Query = z.object({ info: z.literal('1').optional() });

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export async function GET(req: Request): Promise<Response> {
  return route('api.backup', async () => {
    const url = new URL(req.url);
    const { info } = parse(Query, Object.fromEntries(url.searchParams), 'backup query');

    if (info === '1') return dataOverview();

    // Refused before anything is read, and refused with the one instruction that
    // actually works at that size: copy the folder in Finder.
    const overview = await dataOverview();
    if (overview.tooLarge) {
      throw new ApiError(413, 'UNKNOWN', {
        message: `There is too much here for one backup file (${gigabytes(overview.bytes.backup)}).`,
        retryable: false,
        remedy: {
          action: 'reveal-file',
          label: 'OK',
          hint: `Copy ${overview.dataDir} to a drive in Finder instead.`,
        },
        detail: `backup content ${overview.bytes.backup} exceeds ${MAX_BACKUP_BYTES}`,
      });
    }

    // Resolves once the database snapshot exists -- so a locked or damaged
    // database is still a JSON error with a remedy. The archive itself is
    // produced entry by entry as the browser reads it.
    //
    // req.signal, not just the stream's cancel(): a download she abandons has to
    // stop the build somewhere the stamp cannot be reached, and cancel() is not
    // reliably called when a transfer is truncated. It is the difference between
    // the app saying a backup exists and one existing.
    const backup = await createBackup(req.signal);

    return new Response(backup.stream, {
      headers: {
        'Content-Type': ZIP_MIME,
        'Content-Disposition': `attachment; filename="${headerFilename(backup.filename)}"`,
        'Cache-Control': 'no-store',
        [ESTIMATE_HEADER]: String(backup.contentBytes),
      },
    });
  });
}
