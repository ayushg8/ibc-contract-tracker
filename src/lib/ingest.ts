/**
 * One ingest, two doors.
 *
 * A PDF arrives either because Bonnie dragged it onto the Inbox or because it
 * appeared in the watched folder. Those two doors have to produce the same
 * record: the same content hash, the same duplicate decision, the same reopening
 * of a document she had rejected, the same archived copy written the same atomic
 * way, the same thumbnail, the same queue entry. Two implementations of that
 * would drift, and the drift would surface as "the folder did something the drop
 * did not" -- which is the exact class of non-determinism this product exists to
 * refuse.
 *
 * So the upload route and the watcher both call ingestPdf(), and neither of them
 * owns a copy of the rules.
 */

import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  createDocument,
  getDocument,
  getDocumentByHash,
  setDocumentFileMeta,
  updateDocument,
} from '@/lib/db/queries';
import type { DocumentDetail, DocumentSummary } from '@/lib/db/types';
import { renderThumbnail, sha256 } from '@/lib/extraction/pdf';
import { extractionQueue } from '@/lib/extraction/queue';
import { log } from '@/lib/logger';
import { archivedPdfPath, ensureDirs, fsError, thumbnailPath } from '@/lib/paths';
import { EngineError } from '@/lib/providers/errors';

/** The largest file either door will take. One number, two error messages. */
export const MAX_INGEST_BYTES = 64 * 1024 * 1024;

/** A %PDF- header can sit behind a little junk, but not behind a whole file. */
export const HEADER_SEARCH_BYTES = 1024;

export function isPdfName(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, HEADER_SEARCH_BYTES));
  return head.includes('%PDF-');
}

/**
 * Write, then rename into place. Never write to the final name directly.
 *
 * A backup walks the archive folder and copies whatever it finds under a real
 * name. Writing straight to the final path means there is a window in which that
 * name exists holding half a PDF -- and a backup taken in that window captures
 * the half and reports success, which is the one thing a backup may never do.
 *
 * rename(2) within a directory is atomic, so the final name appears only once
 * every byte is on disk. The temp name is dot-prefixed because that is exactly
 * what lib/backup.ts skips when it lists the folder, so even a temp file left
 * behind by a crash is invisible to a backup rather than zipped as data.
 */
export async function writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.partial`);
  try {
    // flush: true -- rename orders the directory entry, not the data behind it.
    await writeFile(temp, bytes, { flush: true });
    await rename(temp, target);
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw fsError(e, target);
  }
}

/**
 * `accepted`  a new document row exists and is queued.
 * `reopened`  a rejected document came back and is queued again.
 * `duplicate` these bytes are already in the tracker; nothing was written.
 */
export type IngestOutcome = 'accepted' | 'reopened' | 'duplicate';

export interface IngestResult {
  outcome: IngestOutcome;
  documentId: string;
  filename: string;
  /** The new row, on `accepted` only. Null otherwise, and null if it could not be read back. */
  document: DocumentSummary | null;
}

export interface IngestInput {
  bytes: Uint8Array;
  /** The name as the user sees it, not a path. Used for the archived copy's name. */
  filename: string;
  /** Where the bytes came from, when that is a place on disk. Recorded, never read from again. */
  originPath?: string | null;
  /**
   * Should a rejected record be brought back by these bytes?
   *
   * Default yes, because a human dragging the file in again IS the request to
   * reconsider it. The watcher supplies a stricter predicate -- see the comment
   * on `reopenable` in lib/watch.ts for why a folder scan must not reopen a
   * rejection on its own.
   */
  reopenRejected?: (existing: DocumentDetail) => boolean;
}

export async function ingestPdf(input: IngestInput): Promise<IngestResult> {
  const { bytes, filename } = input;

  if (!looksLikePdf(bytes)) {
    throw new EngineError('PDF_UNREADABLE', {
      detail: `${filename}: no %PDF- header in the first ${HEADER_SEARCH_BYTES} bytes`,
    });
  }

  ensureDirs();

  // Identity is the hash, so the same bytes are the same document however they
  // arrived and however many times they arrive. Checked before anything is written.
  const hash = sha256(bytes);
  const existing = getDocumentByHash(hash);
  if (existing) {
    const reopen = input.reopenRejected ?? (() => true);
    // A REJECTED record is not a duplicate to refuse -- rejecting is meant to be
    // reversible, and the natural way to reconsider a document is to present it
    // again. Blocking that left a file permanently un-addable with no way back
    // except the Reopen link on a toast that had long since gone.
    if (existing.status === 'rejected' && reopen(existing)) {
      updateDocument(existing.id, {
        status: 'queued',
        errorCode: null,
        errorDetail: null,
        updatedAt: new Date().toISOString(),
      });
      extractionQueue.add(existing.id);
      return { outcome: 'reopened', documentId: existing.id, filename, document: null };
    }
    return { outcome: 'duplicate', documentId: existing.id, filename, document: null };
  }

  const created = createDocument({
    fileHash: hash,
    filename,
    byteSize: bytes.byteLength,
    originPath: input.originPath ?? null,
    status: 'queued',
  });
  // Also covers the same file appearing twice inside one drop, and two watcher
  // passes racing on the same folder.
  if (created.duplicate) {
    return { outcome: 'duplicate', documentId: created.id, filename, document: null };
  }

  const pdfPath = archivedPdfPath(created.id, filename);
  await writeAtomic(pdfPath, bytes);

  let thumbnail: string | null = null;
  try {
    const png = await renderThumbnail(bytes);
    const target = thumbnailPath(created.id);
    // Same rule: thumbnails travel in the backup too, and a half-written PNG in
    // an archive is a file that will not open on the day it is needed.
    await writeAtomic(target, png);
    thumbnail = target;
  } catch (e) {
    // A missing thumbnail is cosmetic. It must never cost her the document.
    log.warn('thumbnail.failed', { filename, error: e });
  }

  setDocumentFileMeta(created.id, {
    archivePath: pdfPath,
    thumbnailPath: thumbnail,
    byteSize: bytes.byteLength,
  });

  // Enqueue only. The model must never be on the critical path of a drop or a scan.
  extractionQueue.add(created.id);

  return {
    outcome: 'accepted',
    documentId: created.id,
    filename,
    document: getDocument(created.id),
  };
}
