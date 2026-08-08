/**
 * Propose an arrangement, and — separately — carry one out.
 *
 * Two verbs, and the split between them is the whole safety story:
 *
 *   POST { scheme }         -> a plan. Nothing on disk is touched.
 *   POST { apply: [moves] } -> those moves, each re-validated here first.
 *
 * She sees the plan before anything happens, which is the same rule the rest of
 * the product runs on: the tracker proposes, a human agrees, and only then is
 * something recorded. A single endpoint that planned and moved in one step would
 * make a preview impossible and put a model's output directly onto her disk.
 *
 * The free-text scheme is the one that involves Claude, and it is the reason
 * `applyMoves` distrusts its input. Claude only ever chooses GROUP NAMES for
 * contracts it was given; it never sees a path, never proposes one, and cannot
 * name a destination. The paths are computed here from those names.
 */

import { basename, join } from 'node:path';

import { NextResponse } from 'next/server';

import { contractsRoot } from '@/lib/contracts-folder';
import { getSettings, listContracts, setDocumentFileMeta } from '@/lib/db/queries';
import { getDocument } from '@/lib/db/queries';
import { log } from '@/lib/logger';
import {
  applyMoves,
  planMoves,
  type Filable,
  type PlannedMove,
  type Scheme,
} from '@/lib/organize';
import { askText } from '@/lib/providers/cli';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every approved contract, with the bit of its document row filing needs. */
function filables(): Filable[] {
  const out: Filable[] = [];
  for (const c of listContracts({ limit: 1000 }).rows) {
    const doc = getDocument(c.documentId);
    const archivePath = doc?.archivePath;
    if (typeof archivePath !== 'string' || archivePath === '') continue;
    out.push({
      documentId: c.documentId,
      archivePath,
      counterparty: c.counterparty,
      effectiveDate: c.effectiveDate,
      agreementStatus: c.agreementStatus,
    });
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Turn her sentence into a group name per contract, using the engine already set up.
 *
 * Deliberately the narrowest possible question to ask a model: given this list of
 * contracts and this instruction, what folder name does each one go in. It cannot
 * answer with a path, cannot answer with a move, and anything it returns for an
 * id we did not send is discarded. A name it invents is still only ever a folder
 * name, flattened by `groupFor` before it reaches the filesystem.
 */
async function groupsFromInstruction(
  instruction: string,
  contracts: readonly Filable[],
): Promise<Record<string, string | null>> {
  const list = contracts.map((c) => ({
    id: c.documentId,
    counterparty: c.counterparty ?? '',
    signed: c.effectiveDate ?? '',
    status: c.agreementStatus ?? '',
  }));

  const prompt = [
    'You are filing contracts into folders for a finance team.',
    '',
    'INSTRUCTION FROM THE USER:',
    instruction,
    '',
    'CONTRACTS:',
    JSON.stringify(list, null, 2),
    '',
    'Reply with ONLY a JSON object mapping each contract id to a folder name.',
    'Use null for a contract that should sit at the top level with no folder.',
    'A folder name is a plain name, never a path: no slashes and no "..".',
    'Keep the number of folders small and the names short and human.',
    'Every id above must appear exactly once. Add nothing else to your reply.',
  ].join('\n');

  const text = (await askText(prompt).catch(() => null)) ?? '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  // Only ids we sent, only string-or-null values. Anything else is dropped
  // rather than interpreted.
  const known = new Set(contracts.map((c) => c.documentId));
  const out: Record<string, string | null> = {};
  for (const [id, v] of Object.entries(parsed)) {
    if (!known.has(id)) continue;
    if (v === null) out[id] = null;
    else if (typeof v === 'string') out[id] = v;
  }
  return out;
}

export async function POST(request: Request): Promise<NextResponse> {
  const root = contractsRoot(getSettings());

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (isRecord(parsed)) body = parsed;
  } catch {
    return NextResponse.json({ ok: false, reason: 'Nothing to do.' }, { status: 400 });
  }

  /* ------------------------------- apply ------------------------------- */
  if (Array.isArray(body['apply'])) {
    const moves: PlannedMove[] = [];
    for (const m of body['apply']) {
      if (!isRecord(m)) continue;
      const documentId = m['documentId'];
      const from = m['from'];
      const to = m['to'];
      if (typeof documentId !== 'string' || typeof from !== 'string' || typeof to !== 'string') continue;
      moves.push({
        documentId,
        from,
        to,
        group: typeof m['group'] === 'string' ? m['group'] : null,
      });
    }

    /*
     * The folder moved; the file inside it kept its name. So the new stored path
     * is the new folder plus the old basename -- computed per document rather
     * than assumed, because two contracts can hold differently named PDFs.
     */
    const results = applyMoves(moves, root, (documentId, folder) => {
      const doc = getDocument(documentId);
      const previous = doc?.archivePath;
      if (typeof previous !== 'string' || previous === '') return;
      const filename = basename(previous);
      if (filename === '') return;
      setDocumentFileMeta(documentId, { archivePath: join(folder, filename) });
    });

    const moved = results.filter((r) => r.ok).length;
    log.info('files.organized', { moved, refused: results.length - moved });
    return NextResponse.json({ ok: true, results, moved, refused: results.length - moved });
  }

  /* -------------------------------- plan -------------------------------- */
  const contracts = filables();
  const kind = body['scheme'];
  let scheme: Scheme;

  if (kind === 'year' || kind === 'counterparty' || kind === 'flat') {
    scheme = { kind };
  } else if (kind === 'instruction') {
    const instruction = typeof body['instruction'] === 'string' ? body['instruction'].trim() : '';
    if (instruction === '') {
      return NextResponse.json(
        { ok: false, reason: 'Say how you would like them arranged.' },
        { status: 400 },
      );
    }
    const groups = await groupsFromInstruction(instruction, contracts);
    if (Object.keys(groups).length === 0) {
      return NextResponse.json(
        { ok: false, reason: 'That could not be turned into an arrangement. Try saying it another way.' },
        { status: 422 },
      );
    }
    scheme = { kind: 'explicit', groupFor: groups };
  } else {
    return NextResponse.json({ ok: false, reason: 'Unknown arrangement.' }, { status: 400 });
  }

  return NextResponse.json({ ok: true, root, moves: planMoves(contracts, scheme, root) });
}
