/**
 * The contracts folder as it actually is on disk.
 *
 * Read from the filesystem rather than composed from the database, deliberately.
 * This screen exists so she can see the truth about her own folder -- including
 * anything she moved in Finder without telling the app. A tree assembled from
 * stored paths would show her what the app believes instead, which is precisely
 * the thing she would open this screen to check.
 */

import { NextResponse } from 'next/server';

import { contractsRoot } from '@/lib/contracts-folder';
import { getSettings } from '@/lib/db/queries';
import { readTree } from '@/lib/organize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const root = contractsRoot(getSettings());
  return NextResponse.json({ root, tree: readTree(root) });
}
