/**
 * The fixture registry. 13 synthetic agreements, each with a hand-written expected record.
 *
 * Adding one: write it in nda.ts / evaluation.ts / edge.ts, export it, add it here, then run
 * `npm run eval -- --case=fixtures`. That case checks the fixture against itself (every
 * quote present, every computed date consistent with its own arithmetic) before any
 * extraction code is allowed near it.
 */

import type { Fixture } from './types';
import { NDA_FIXTURES } from './nda';
import { EVALUATION_FIXTURES } from './evaluation';
import { EDGE_FIXTURES } from './edge';

export * from './types';
export * from './mangle';
export * from './nda';
export * from './evaluation';
export * from './edge';

export const ALL_FIXTURES: Fixture[] = [...NDA_FIXTURES, ...EVALUATION_FIXTURES, ...EDGE_FIXTURES];

export function fixtureById(id: string): Fixture | null {
  return ALL_FIXTURES.find((f) => f.id === id) ?? null;
}

/** The one fixture used wherever a single representative document is needed. */
export const PRIMARY_FIXTURE_ID = 'ntrium';
