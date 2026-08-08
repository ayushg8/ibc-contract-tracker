/**
 * Show a contract's folder, or the folder holding all of them, in Finder.
 *
 * THE CALLER NAMES A DOCUMENT, NEVER A PATH. This server listens on localhost
 * with no authentication of any kind, so a route that opens whatever path it is
 * handed is a route that opens anything on the disk -- and `open` on a file is not
 * an inert act. The document id is looked up here, the path comes off the row, and
 * it is checked against the contracts root before Finder is asked for anything.
 *
 * The same reasoning is why the updater's source cannot be set over HTTP.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { NextResponse } from 'next/server';

import { contractsRoot, isInside } from '@/lib/contracts-folder';
import { getDocument, getSettings } from '@/lib/db/queries';
import { archiveDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  documentId?: unknown;
  path?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const root = contractsRoot(getSettings());

  let documentId: string | null = null;
  let wanted: string | null = null;
  try {
    const body: unknown = await request.json();
    if (body !== null && typeof body === 'object') {
      const raw = (body as Body).documentId;
      if (typeof raw === 'string' && raw.trim() !== '') documentId = raw.trim();
      const p = (body as Body).path;
      if (typeof p === 'string' && p.trim() !== '') wanted = p.trim();
    }
  } catch {
    // No body means "show me the folder with everything in it".
  }

  let target = root;

  /*
   * A path is accepted, but only one already inside the contracts folder.
   *
   * The Files screen needs to open a folder she is looking at, and it knows that
   * folder by path rather than by document. Allowing it is safe only because the
   * containment check below is the same one every move goes through: outside the
   * root is refused outright, so this cannot become a way to open the disk.
   */
  if (wanted !== null) {
    if (!isInside(root, wanted)) {
      return NextResponse.json(
        { ok: false, reason: 'That is outside the contracts folder.' },
        { status: 409 },
      );
    }
    target = wanted;
  }

  if (documentId !== null) {
    const doc = getDocument(documentId);
    if (doc === null) {
      return NextResponse.json({ ok: false, reason: 'No such contract.' }, { status: 404 });
    }
    const archived = doc.archivePath;
    if (typeof archived !== 'string' || archived === '') {
      return NextResponse.json(
        { ok: false, reason: 'This contract has no archived copy yet.' },
        { status: 409 },
      );
    }
    // The folder, not the file: she asked where it lives, and a Finder window
    // showing the folder also shows the text and the record beside it.
    const folder = dirname(archived);
    /*
     * Accept it only if it is under the contracts root OR under the old flat
     * archive. Both are ours; anything else on the row is either stale from a
     * moved folder or something that should never be opened, and the answer to
     * both is the same refusal.
     */
    if (!isInside(root, folder) && !isInside(archiveDir(), folder)) {
      return NextResponse.json(
        { ok: false, reason: 'That contract is stored outside the contracts folder.' },
        { status: 409 },
      );
    }
    target = folder;
  }

  if (!existsSync(target)) {
    return NextResponse.json(
      { ok: false, reason: `That folder is not there any more: ${target}` },
      { status: 404 },
    );
  }

  spawn('/usr/bin/open', [target], { stdio: 'ignore', detached: true }).unref();
  return NextResponse.json({ ok: true, path: target });
}
