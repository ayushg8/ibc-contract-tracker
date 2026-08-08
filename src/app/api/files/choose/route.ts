/**
 * Open the macOS folder chooser, and make a folder.
 *
 * Until now, changing where contracts are kept meant pasting a path she had to
 * get out of Finder with a right-click, Option held, "Copy as Pathname". That is
 * a genuinely obscure thing to ask of anyone. A browser cannot hand a page an
 * absolute directory path, but this server is running on her own Mac, so it can
 * ask the operating system to put up the ordinary folder dialog and read back
 * what she picked.
 *
 * The AppleScript is a fixed program with no interpolation of any kind. Nothing
 * from the request reaches osascript.
 */

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { contractsRoot, isInside, safeFolder } from '@/lib/contracts-folder';
import { getSettings } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

/**
 * Ask Finder for a folder. Returns null when she cancels, which is not an error.
 *
 * `-e` arguments are literal program text and carry nothing from the caller. The
 * POSIX path conversion happens inside the script so what comes back is already
 * a plain path rather than an AppleScript alias.
 */
async function chooseFolder(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      [
        '-e',
        'tell application "System Events" to activate',
        '-e',
        'set f to choose folder with prompt "Where should the tracker keep your contracts?"',
        '-e',
        'POSIX path of f',
      ],
      { timeout: 5 * 60_000 },
    );
    const picked = stdout.trim();
    if (picked === '') return null;
    // AppleScript hands back a trailing separator on a directory.
    return picked.endsWith(path.sep) && picked.length > 1 ? picked.slice(0, -1) : picked;
  } catch {
    // A cancel exits non-zero. So does a timeout. Neither is worth an error page:
    // she simply does not have a new folder, and the old one still stands.
    return null;
  }
}

interface Body {
  action?: unknown;
  name?: unknown;
  parent?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    // An empty body means "open the chooser".
  }

  if (body.action === 'create') {
    const root = contractsRoot(getSettings());
    const rawName = typeof body.name === 'string' ? body.name : '';
    const name = safeFolder(rawName);
    if (rawName.trim() === '') {
      return NextResponse.json({ ok: false, reason: 'Give the folder a name.' }, { status: 400 });
    }

    // A parent may be supplied to nest a group, but only ever inside the
    // contracts folder. The name itself is flattened to a single folder name, so
    // neither half can be used to climb out.
    const parent = typeof body.parent === 'string' && body.parent !== '' ? body.parent : root;
    if (!isInside(root, parent)) {
      return NextResponse.json(
        { ok: false, reason: 'That is outside the contracts folder.' },
        { status: 409 },
      );
    }

    const target = path.join(parent, name);
    if (!isInside(root, target)) {
      return NextResponse.json({ ok: false, reason: 'That name is not usable.' }, { status: 409 });
    }
    try {
      mkdirSync(target, { recursive: true });
      return NextResponse.json({ ok: true, path: target, name });
    } catch (e) {
      return NextResponse.json(
        { ok: false, reason: e instanceof Error ? e.message : 'The folder could not be made.' },
        { status: 500 },
      );
    }
  }

  const picked = await chooseFolder();
  if (picked === null) return NextResponse.json({ ok: false, cancelled: true });
  return NextResponse.json({ ok: true, path: picked });
}
