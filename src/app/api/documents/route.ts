import { z } from 'zod';

import { badRequest, conflict, parse, route } from '@/app/api/_lib/http';
import {
  approvalBlockers,
  listDocumentIdsByStatus,
  listDocuments,
} from '@/lib/db/queries';
import type { DocumentStatus, DocumentSummary } from '@/lib/db/types';
import { MAX_INGEST_BYTES, ingestPdf, isPdfName } from '@/lib/ingest';
import { log } from '@/lib/logger';
import { ensureDirs } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The three buckets the Inbox filters by, and the only definition of them.
 * Splitting a document into a group is a product decision, not a UI one: if the
 * browser derived these from the status list it would be a second definition,
 * free to disagree with the counts rendered beside it.
 *
 * `pending` is everything still moving through the pipeline plus what came out
 * clean. `attention` is everything asking a human for a decision. `rejected` is
 * the recoverable graveyard -- visible, and one POST away from coming back.
 *
 * Approved and duplicate rows belong to no group: they have left the Inbox.
 */
const GROUPS = {
  pending: ['queued', 'hashing', 'reading', 'extracting', 'ready'],
  attention: ['needs_attention', 'failed'],
  rejected: ['rejected'],
} as const satisfies Record<string, readonly DocumentStatus[]>;

type InboxGroup = keyof typeof GROUPS;

/** 'all' means every group, not every row -- see GROUPS. */
const StatusQuery = z.enum(['pending', 'attention', 'rejected', 'all']).default('all');

/** Only these can be approved, so only these can be short of a required field. */
const APPROVABLE: readonly DocumentStatus[] = ['ready', 'needs_attention'];

function statusesFor(status: InboxGroup | 'all'): DocumentStatus[] {
  if (status !== 'all') return [...GROUPS[status]];
  return Object.values(GROUPS).flat();
}

/**
 * Every id in each group, across the whole table -- not just the ids in this
 * response. It is both halves of what the filter needs: membership for the
 * documents on screen, and a length for the count beside a tab that is not.
 * Sending counts as a second number would be the same fact written twice.
 */
function groupMembers(): Record<InboxGroup, string[]> {
  return {
    pending: listDocumentIdsByStatus([...GROUPS.pending]),
    attention: listDocumentIdsByStatus([...GROUPS.attention]),
    rejected: listDocumentIdsByStatus([...GROUPS.rejected]),
  };
}

export async function GET(req: Request): Promise<Response> {
  return route('api.documents.list', async () => {
    const raw = new URL(req.url).searchParams.get('status');
    const status = parse(StatusQuery, raw ?? undefined, 'status');
    const documents = listDocuments({ statuses: statusesFor(status) });

    // How many required fields each document is still short of. Bulk approve is
    // gated on this being zero, and the gate has to be the server's answer: the
    // browser only has confidence counts, and a medium-confidence value is
    // present, not missing. Status alone will not do either -- a document stays
    // 'needs_attention' after a human fills the last gap in Review.
    const unresolved: Record<string, number> = {};
    for (const doc of documents) {
      if (APPROVABLE.includes(doc.status)) unresolved[doc.id] = approvalBlockers(doc.id).length;
    }

    return { documents, groups: groupMembers(), unresolved };
  });
}

export async function POST(req: Request): Promise<Response> {
  return route('api.documents.upload', async () => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (e) {
      throw badRequest('That upload could not be read.', String(e));
    }

    const files = form.getAll('files').filter((v): v is File => v instanceof File);
    if (files.length === 0) throw badRequest('No PDF was attached to that upload.');

    for (const file of files) {
      if (!isPdfName(file.name)) {
        throw badRequest(`"${file.name}" is not a PDF. The tracker only reads PDFs.`);
      }
      if (file.size > MAX_INGEST_BYTES) {
        throw badRequest(`"${file.name}" is larger than 64 MB, which is more than the tracker takes.`);
      }
    }

    ensureDirs();

    const accepted: DocumentSummary[] = [];
    const duplicates: { filename: string; documentId: string }[] = [];
    /** Rejected records the drop brought back, so the response can say so. */
    const reopened: { filename: string; documentId: string }[] = [];

    for (const file of files) {
      // Byte-for-byte the same path the watched folder takes -- see lib/ingest.ts.
      // A drop and a folder scan may never disagree about what a document is.
      const result = await ingestPdf({
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
      });
      switch (result.outcome) {
        case 'accepted':
          if (result.document) accepted.push(result.document);
          break;
        case 'reopened':
          reopened.push({ filename: result.filename, documentId: result.documentId });
          break;
        case 'duplicate':
          duplicates.push({ filename: result.filename, documentId: result.documentId });
          break;
      }
    }

    if (accepted.length === 0 && reopened.length === 0 && duplicates.length > 0) {
      throw conflict(
        duplicates.length === 1
          ? 'That document is already in the tracker.'
          : 'Every one of those documents is already in the tracker.',
        {
          remedy: { action: 'none', label: 'Open the existing record' },
          extra: { duplicates },
        },
      );
    }

    log.info('documents.uploaded', {
      accepted: accepted.length,
      duplicates: duplicates.length,
      reopened: reopened.length,
    });
    // `reopened` was collected but never returned, which made re-dropping a
    // rejected file look like a no-op in the UI. It is the same event the
    // Rejected tab's Reopen button raises, so it says so out loud now.
    return { accepted, duplicates, reopened };
  });
}
