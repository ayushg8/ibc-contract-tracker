/**
 * Builds the workbook, writes it to the export destination, and hands the browser
 * a copy of the same bytes.
 *
 * The write is the part that was missing. Settings showed an "Export destination"
 * with a Change button, the Export tab showed its path, and /api/health ran a
 * writability check on it, while every export went to the browser's downloads
 * folder and left that one empty. Three screens describing a folder nothing ever
 * wrote to is the same class of defect as a value that looks verified and is not.
 */

import { join } from 'node:path';

import { badRequest, parse, route } from '@/app/api/_lib/http';
import { currentSettings } from '@/app/api/_lib/settings';
import { exportFilename, exportWorkbook } from '@/lib/excel/export';
import { DOC_TYPES, type DocType } from '@/lib/fields';
import { writeAtomic } from '@/lib/ingest';
import { log } from '@/lib/logger';
import { checkFolderWritable, ensureDir } from '@/lib/paths';

import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Her workbook has these two tabs. 'other' ships only when it is asked for. */
const DEFAULT_SHEETS: DocType[] = ['nda', 'evaluation'];

const Sheet = z.enum(DOC_TYPES);

function parseSheets(raw: string): DocType[] {
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parse(Sheet, s, 'sheets'));

  if (requested.length === 0) throw badRequest('No sheets were selected for the export.');

  const wanted = new Set<DocType>(requested);
  // Emit in FIELD/DOC order rather than the order the caller happened to type.
  return DOC_TYPES.filter((t) => wanted.has(t));
}

export async function GET(req: Request): Promise<Response> {
  return route('api.export', async () => {
    const raw = new URL(req.url).searchParams.get('sheets');
    const sheets = raw === null ? DEFAULT_SHEETS : parseSheets(raw);

    const settings = await currentSettings();
    const folder = settings.exportFolder;
    const filename = exportFilename();

    // Checked BEFORE the workbook is built, because building it stamps
    // lastExportedAt and writes an 'exported' audit row per contract. A
    // destination that cannot be written to has to stop this before any of that
    // says an export happened.
    ensureDir(folder);
    const unwritable = checkFolderWritable(folder);
    if (unwritable !== null) throw unwritable;

    const buffer = await exportWorkbook(sheets);

    // Written under a dot-prefixed temp name and renamed into place, so the real
    // name never exists holding half a workbook -- she opens this file straight
    // out of Finder, and a half file that opens is worse than no file.
    await writeAtomic(join(folder, filename), buffer);
    log.info('export.saved', { filename, bytes: buffer.byteLength });

    // Buffer is typed over ArrayBufferLike, which BodyInit rejects.
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Length': String(buffer.byteLength),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}
