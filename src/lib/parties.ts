/**
 * The party-role invariant: IBC is always Party A.
 *
 * Lives in its own module, generic over the record shape, because three callers need
 * it and the last time this logic lived in only one of them the eval suite silently
 * stopped testing it. It passed at 100% one run and regressed the next -- not because
 * the code changed, but because the model happened to order the preamble differently.
 * An invariant nothing exercises is a comment.
 */

import type { FieldKey } from './fields';
import { isIbcParty } from './util/normalize';

/** The three fields that travel together when a party changes slot. */
const A_KEYS = ['party_a', 'party_a_signer', 'party_a_address'] as const satisfies readonly FieldKey[];
const B_KEYS = ['party_b', 'party_b_signer', 'party_b_address'] as const satisfies readonly FieldKey[];

/**
 * Decide whether the two party slots are the wrong way round.
 *
 * Counterparty templates routinely list themselves first -- Acme's standard form opens
 * "(1) ACME CELLS GMBH ... and (2) INTERNATIONAL BATTERY COMPANY, INC." A model reading
 * that reports document order, which is the honest answer to the question it was asked,
 * and lands six fields in the wrong columns at once: both names, both signers and both
 * addresses.
 *
 * Asking the prompt to normalise it would work most of the time, which is the worst
 * possible property for the column that decides who the counterparty is.
 */
export function partiesNeedSwap(partyA: string | null, partyB: string | null): boolean {
  if (!partyB || !isIbcParty(partyB)) return false;
  // Both sides IBC means an intra-group agreement; leave it alone.
  if (partyA && isIbcParty(partyA)) return false;
  return true;
}

/**
 * Swap the two party slots in any keyed collection, carrying evidence with the value.
 * `get`/`set`/`del` keep this usable over a Map of field records and over a plain
 * object of bare values without either caller converting.
 */
export function swapPartyRoles<T>(access: {
  get: (key: FieldKey) => T | undefined;
  set: (key: FieldKey, value: T) => void;
  del: (key: FieldKey) => void;
}): void {
  for (let i = 0; i < A_KEYS.length; i++) {
    const aKey = A_KEYS[i];
    const bKey = B_KEYS[i];
    if (!aKey || !bKey) continue;
    const a = access.get(aKey);
    const b = access.get(bKey);
    if (b === undefined) access.del(aKey);
    else access.set(aKey, b);
    if (a === undefined) access.del(bKey);
    else access.set(bKey, a);
  }
}

/** Convenience for a plain `Partial<Record<FieldKey, string | null>>` of values. */
export function enforcePartyRolesOnValues(
  values: Partial<Record<FieldKey, string | null>>,
): boolean {
  if (!partiesNeedSwap(values.party_a ?? null, values.party_b ?? null)) return false;
  swapPartyRoles<string | null>({
    get: (k) => (k in values ? values[k] : undefined),
    set: (k, v) => {
      values[k] = v;
    },
    del: (k) => {
      delete values[k];
    },
  });
  return true;
}
