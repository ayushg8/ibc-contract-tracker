/**
 * The party-role invariant. This regressed once already: the logic lived only in the
 * pipeline, the eval suite never called it, and a run that scored 100% one day failed
 * six fields the next -- not because the code changed, but because the model ordered a
 * preamble differently. These cases are the thing that makes it a rule.
 */

import { describe, expect, it } from 'vitest';

import { enforcePartyRolesOnValues, partiesNeedSwap } from '../src/lib/parties';

describe('partiesNeedSwap', () => {
  it('swaps when IBC is in the B slot (counterparty template)', () => {
    // Acme's standard form: "(1) ACME CELLS GMBH ... and (2) INTERNATIONAL BATTERY..."
    expect(partiesNeedSwap('ACME CELLS GMBH', 'INTERNATIONAL BATTERY COMPANY, INC.')).toBe(true);
  });

  it('leaves an IBC-first preamble alone', () => {
    expect(partiesNeedSwap('International Battery Company, Inc.', 'Ntrium, Inc.')).toBe(false);
  });

  it('leaves an intra-group agreement alone', () => {
    expect(
      partiesNeedSwap('International Battery Company, Inc.', 'International Battery Company Ltd'),
    ).toBe(false);
  });

  it('does nothing when the counterparty slot is empty', () => {
    expect(partiesNeedSwap('Acme Cells GmbH', null)).toBe(false);
  });

  it('does nothing when neither side is IBC', () => {
    expect(partiesNeedSwap('Acme Cells GmbH', 'Ntrium, Inc.')).toBe(false);
  });
});

describe('enforcePartyRolesOnValues', () => {
  it('carries signer and address with the name, not just the name', () => {
    const values = {
      party_a: 'ACME CELLS GMBH',
      party_a_signer: 'Dr. Katharina Vogt',
      party_a_address: 'Landsberger Strasse 302, 80687 Munich, Germany',
      party_b: 'INTERNATIONAL BATTERY COMPANY, INC.',
      party_b_signer: 'Anand Krishnan',
      party_b_address: '1 Innovation Way, Fremont, California 94538',
    };
    expect(enforcePartyRolesOnValues(values)).toBe(true);
    expect(values.party_a).toBe('INTERNATIONAL BATTERY COMPANY, INC.');
    expect(values.party_a_signer).toBe('Anand Krishnan');
    expect(values.party_a_address).toBe('1 Innovation Way, Fremont, California 94538');
    expect(values.party_b).toBe('ACME CELLS GMBH');
    expect(values.party_b_signer).toBe('Dr. Katharina Vogt');
    expect(values.party_b_address).toBe('Landsberger Strasse 302, 80687 Munich, Germany');
  });

  it('is idempotent -- running it twice does not swap back', () => {
    const values = { party_a: 'Acme Cells GmbH', party_b: 'International Battery Company, Inc.' };
    expect(enforcePartyRolesOnValues(values)).toBe(true);
    expect(enforcePartyRolesOnValues(values)).toBe(false);
    expect(values.party_a).toBe('International Battery Company, Inc.');
  });

  it('moves a missing counterpart rather than duplicating a value', () => {
    const values: Record<string, string | null> = {
      party_a: 'Acme Cells GmbH',
      party_a_signer: 'Dr. Katharina Vogt',
      party_b: 'International Battery Company, Inc.',
      // no party_b_signer
    };
    enforcePartyRolesOnValues(values);
    expect(values.party_a_signer).toBeUndefined();
    expect(values.party_b_signer).toBe('Dr. Katharina Vogt');
  });
});
