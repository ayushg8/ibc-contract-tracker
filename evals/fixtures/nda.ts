/**
 * Mutual NDA fixtures.
 *
 * Each document is synthetic but drafted the way the real ones read, including the traps:
 * a notice-period duration sitting in the same sentence as the term, a title spelled three
 * different ways, and a counterparty whose legal name contains the word "and".
 */

import type { Fixture } from './types';

/** Fixture 1 — the clean case. Modelled on the Ntrium row in ../../PLAN.md. */
export const ntrium: Fixture = {
  id: 'ntrium',
  label: 'Ntrium mutual NDA (clean)',
  filename: 'Ntrium_NDA.pdf',
  docType: 'nda',
  proves:
    'A well-drafted two-party mutual NDA. Nothing here is ambiguous, so nothing here excuses a wrong answer.',
  pages: [
    `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement (this "Agreement") is entered into and effective as of November 5, 2022 (the "Effective Date"), by and between International Battery Company, Inc., a Delaware corporation with its principal place of business at 1 Innovation Way, Fremont, California 94538 ("IBC"), and Ntrium, Inc., a Delaware corporation with its principal place of business at 2200 Sand Hill Road, Menlo Park, California 94025 ("Ntrium"). IBC and Ntrium are each referred to herein as a "Party" and collectively as the "Parties".

RECITALS

The Parties wish to evaluate a potential commercial relationship concerning lithium-ion cell manufacturing and, in connection with those discussions, each Party expects to disclose to the other certain confidential and proprietary information.

1. Confidential Information. "Confidential Information" means any non-public information disclosed by one Party (the "Disclosing Party") to the other Party (the "Receiving Party"), whether orally, in writing, or in any other form, that is designated as confidential or that reasonably should be understood to be confidential given the nature of the information and the circumstances of disclosure.

2. Obligations. The Receiving Party shall (a) hold the Confidential Information in strict confidence, (b) use it solely to evaluate the potential relationship described above, and (c) disclose it only to those of its employees, officers and professional advisers who have a need to know it and who are bound by obligations of confidentiality no less protective than those set out here.

IBC Form NDA-2022 Rev. 3`,
    `3. Term. This Agreement shall commence on the Effective Date and shall remain in force for five (5) years, unless earlier terminated by either Party upon thirty (30) days prior written notice to the other Party.

4. Survival of Confidentiality. Notwithstanding any expiration or termination of this Agreement, the obligations of confidentiality and non-use set out in Section 2 shall survive for five (5) years from the Effective Date.

5. Return of Materials. Upon the Disclosing Party's written request, the Receiving Party shall promptly return or destroy all materials containing Confidential Information and shall certify such destruction in writing.

6. No License. Nothing in this Agreement grants either Party any right, title, interest or license, express or implied, in the Confidential Information or in any patent, copyright, trademark or trade secret of the other Party.

7. No Obligation to Proceed. Neither Party is obligated to enter into any further agreement or transaction. Each Party may terminate the discussions at any time.

8. Remedies. The Parties agree that money damages may be an inadequate remedy for a breach of this Agreement and that the non-breaching Party is entitled to seek equitable relief without the necessity of posting a bond.

9. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles.

IBC Form NDA-2022 Rev. 3`,
    `10. Notices. All notices required or permitted under this Agreement shall be in writing and shall be deemed given when delivered by hand, by nationally recognised overnight courier, or by electronic mail to the addresses set out below.

If to IBC:
International Battery Company, Inc., Attn: General Counsel, 1 Innovation Way, Fremont, California 94538
legal@internationalbattery.com

If to Ntrium:
Ntrium, Inc., Attn: Legal Department, 2200 Sand Hill Road, Menlo Park, California 94025
legal@ntrium.com

11. Entire Agreement. This Agreement constitutes the entire understanding of the Parties with respect to the subject matter hereof and supersedes all prior discussions.

IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

NTRIUM, INC.

By: /s/ Marcus Feld
Name: Marcus Feld
Title: Chief Executive Officer

IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Ntrium, Inc.',
    party_b_signer: 'Marcus Feld',
    party_b_address: '2200 Sand Hill Road, Menlo Park, California 94025',
    party_c: null,
    contract_name: 'Mutual Nondisclosure Agreement',
    effective_date: '2022-11-05',
    term: '5 years',
    termination_date: '2027-11-05',
    confidentiality_term: '5 years',
    ibc_form: 'Yes',
    notice_email: 'legal@ntrium.com',
    notice_address:
      'Ntrium, Inc., Attn: Legal Department, 2200 Sand Hill Road, Menlo Park, California 94025',
    governing_law: 'Delaware',
  },
  acceptable: {
    term: ['five (5) years', 'five years'],
    confidentiality_term: ['five (5) years', 'five years'],
    governing_law: ['State of Delaware'],
  },
  quotes: {
    party_a: 'between International Battery Company, Inc., a Delaware corporation',
    party_b: 'and Ntrium, Inc., a Delaware corporation',
    contract_name: 'MUTUAL NONDISCLOSURE AGREEMENT',
    effective_date: 'effective as of November 5, 2022',
    term: 'shall remain in force for five (5) years',
    confidentiality_term: 'shall survive for five (5) years from the Effective Date',
    governing_law: 'the laws of the State of Delaware',
    notice_email: 'legal@ntrium.com',
    party_a_signer: 'Name: Anand Krishnan',
    party_b_signer: 'Name: Marcus Feld',
    ibc_form: 'IBC Form NDA-2022 Rev. 3',
  },
  pageOf: { effective_date: 1, term: 2, confidentiality_term: 2, governing_law: 2, notice_email: 3 },
  computed: {
    terminationDate: '2027-11-05',
    confidentialityEnd: '2027-11-05',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

/** Fixture 2 — non-US counterparty address, day-first date, counterparty's own template. */
export const acme: Fixture = {
  id: 'acme',
  label: 'Acme Cells GmbH NDA (day-first date, German address)',
  filename: 'AcmeCells_NDA_signed.pdf',
  docType: 'nda',
  proves: 'A "14 January 2024" date form, a non-US address, and IBC Form = No.',
  pages: [
    `MUTUAL NON-DISCLOSURE AGREEMENT

THIS AGREEMENT is made on 14 January 2024 between:

(1) ACME CELLS GMBH, a company incorporated in Germany whose registered office is at Landsberger Strasse 302, 80687 Munich, Germany ("Acme"); and

(2) INTERNATIONAL BATTERY COMPANY, INC., a Delaware corporation whose principal place of business is at 1 Innovation Way, Fremont, California 94538 ("IBC").

BACKGROUND

The parties intend to discuss the qualification of Acme cathode active material for use in IBC cells. In the course of those discussions each party may disclose Confidential Information to the other.

1. Definitions. "Confidential Information" means all information of a confidential nature disclosed by or on behalf of one party to the other, in any form, whether or not marked as confidential.

2. Undertakings. Each party undertakes to keep the other party's Confidential Information confidential, to use it only for the Purpose, and not to disclose it to any third party without prior written consent.

Acme Cells GmbH Standard Form NDA (Rev. 2023-09)`,
    `3. Duration. This Agreement takes effect on the date first written above and continues for three (3) years, after which it terminates automatically without notice.

4. Confidentiality Period. Each party's obligations in respect of Confidential Information disclosed under this Agreement continue for five (5) years from the date first written above, notwithstanding the earlier termination of this Agreement.

5. Return. On written demand each party shall return or irretrievably delete the other party's Confidential Information.

6. No Warranty. Confidential Information is provided "as is" without warranty of any kind.

7. Governing Law and Jurisdiction. This Agreement and any dispute arising out of it are governed by the laws of the State of New York, and the parties submit to the exclusive jurisdiction of the state and federal courts sitting in New York County.

8. Notices. Notices under this Agreement shall be sent to Acme Cells GmbH, Attn: Legal, Landsberger Strasse 302, 80687 Munich, Germany, marked for the attention of the Managing Director, with a copy by email to k.vogt@acmecells.de.

SIGNED for and on behalf of ACME CELLS GMBH

By: /s/ Dr. Katharina Vogt
Name: Dr. Katharina Vogt
Title: Managing Director

SIGNED for and on behalf of INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

Acme Cells GmbH Standard Form NDA (Rev. 2023-09)`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Acme Cells GmbH',
    party_b_signer: 'Katharina Vogt',
    party_b_address: 'Landsberger Strasse 302, 80687 Munich, Germany',
    party_c: null,
    contract_name: 'Mutual Non-Disclosure Agreement',
    effective_date: '2024-01-14',
    term: '3 years',
    termination_date: '2027-01-14',
    confidentiality_term: '5 years',
    ibc_form: 'No',
    notice_email: 'k.vogt@acmecells.de',
    notice_address: 'Acme Cells GmbH, Attn: Legal, Landsberger Strasse 302, 80687 Munich, Germany',
    governing_law: 'New York',
  },
  acceptable: {
    party_b_signer: ['Dr. Katharina Vogt'],
    term: ['three (3) years', 'three years'],
    confidentiality_term: ['five (5) years', 'five years'],
    governing_law: ['State of New York'],
    contract_name: ['Mutual Nondisclosure Agreement'],
  },
  quotes: {
    party_b: 'ACME CELLS GMBH, a company incorporated in Germany',
    contract_name: 'MUTUAL NON-DISCLOSURE AGREEMENT',
    effective_date: 'made on 14 January 2024 between',
    term: 'continues for three (3) years',
    confidentiality_term: 'continue for five (5) years from the date first written above',
    governing_law: 'governed by the laws of the State of New York',
    notice_email: 'k.vogt@acmecells.de',
    ibc_form: 'Acme Cells GmbH Standard Form NDA (Rev. 2023-09)',
  },
  pageOf: { effective_date: 1, term: 2, governing_law: 2 },
  computed: {
    terminationDate: '2027-01-14',
    confidentialityEnd: '2029-01-14',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

/** Fixture 3 — the leap-day case. "the 29th day of February, 2024" + 1 year clamps to Feb 28. */
export const helios: Fixture = {
  id: 'helios',
  label: 'Helios Anode NDA (word-ordinal leap-day date)',
  filename: 'Helios_Anode_NDA.pdf',
  docType: 'nda',
  proves:
    'A "the 29th day of February, 2024" date form, and month-end clamping: +1 year is 2025-02-28.',
  pages: [
    `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement is made and entered into as of the 29th day of February, 2024, by and between International Battery Company, Inc., a Delaware corporation located at 1 Innovation Way, Fremont, California 94538, and Helios Anode Systems, Inc., a Texas corporation located at 4400 Post Oak Parkway, Suite 1200, Houston, Texas 77027.

1. Purpose. The parties wish to exchange technical information relating to silicon-dominant anode materials for the purpose of assessing a potential supply arrangement.

2. Confidentiality. Each party shall protect the other party's Confidential Information using at least the same degree of care it uses to protect its own confidential information of like importance, and in no event less than a reasonable degree of care.

3. Term. The term of this Agreement is one (1) year from the date first set forth above. Either party may terminate this Agreement earlier upon fifteen (15) days written notice.

4. Survival. The confidentiality obligations of Section 2 shall continue for three (3) years from the date first set forth above.

IBC Form NDA-2022 Rev. 3`,
    `5. Governing Law. This Agreement is governed by the laws of the State of Texas, excluding its choice of law rules.

6. Notices. Any notice must be delivered in writing to the receiving party at the address set forth in the preamble, with a copy to contracts@heliosanode.com in the case of Helios and to legal@internationalbattery.com in the case of IBC.

7. Counterparts. This Agreement may be executed in counterparts, each of which is deemed an original.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

HELIOS ANODE SYSTEMS, INC.

By: /s/ Rebecca Sandoval
Name: Rebecca Sandoval
Title: President

IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Helios Anode Systems, Inc.',
    party_b_signer: 'Rebecca Sandoval',
    party_b_address: '4400 Post Oak Parkway, Suite 1200, Houston, Texas 77027',
    party_c: null,
    contract_name: 'Mutual Nondisclosure Agreement',
    effective_date: '2024-02-29',
    term: '1 year',
    termination_date: '2025-02-28',
    confidentiality_term: '3 years',
    ibc_form: 'Yes',
    notice_email: 'contracts@heliosanode.com',
    notice_address: '4400 Post Oak Parkway, Suite 1200, Houston, Texas 77027',
    governing_law: 'Texas',
  },
  acceptable: {
    term: ['one (1) year', 'one year'],
    confidentiality_term: ['three (3) years', 'three years'],
    governing_law: ['State of Texas'],
  },
  quotes: {
    effective_date: 'as of the 29th day of February, 2024',
    term: 'The term of this Agreement is one (1) year',
    confidentiality_term: 'shall continue for three (3) years',
    governing_law: 'governed by the laws of the State of Texas',
    notice_email: 'contracts@heliosanode.com',
    party_b: 'Helios Anode Systems, Inc., a Texas corporation',
  },
  pageOf: { effective_date: 1, term: 1, governing_law: 2 },
  computed: {
    terminationDate: '2025-02-28',
    confidentialityEnd: '2027-02-28',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

/** Fixture 4 — the preamble-parsing trap: the counterparty's legal name contains "and". */
export const hallKeegan: Fixture = {
  id: 'hall_keegan',
  label: 'Hall and Keegan Materials NDA ("and" in the party name)',
  filename: 'HallandKeegan_NDA.pdf',
  docType: 'nda',
  proves:
    'A counterparty called "Hall and Keegan Materials, Inc." Splitting the preamble on " and " gives "Hall" and is wrong.',
  pages: [
    `MUTUAL NON-DISCLOSURE AGREEMENT

This Mutual Non-Disclosure Agreement is effective as of March 3, 2025 by and between International Battery Company, Inc., a Delaware corporation with offices at 1 Innovation Way, Fremont, California 94538, and Hall and Keegan Materials, Inc., a Massachusetts corporation with offices at 61 Bent Street, Cambridge, Massachusetts 02141.

1. Purpose. The parties wish to discuss the supply of separator films and, for that purpose, to exchange Confidential Information.

2. Confidential Information. All technical, business and financial information disclosed by either party, in any medium, that is marked confidential or that a reasonable person would understand to be confidential.

3. Obligations. Each party shall use the other's Confidential Information only for the Purpose and shall not disclose it to any third party except to its own personnel and advisers on a need-to-know basis.

4. Term. This Agreement remains in effect for two (2) years from the effective date stated above.

5. Survival. The obligations of confidentiality survive for five (5) years from the effective date stated above.

6. Governing Law. This Agreement is governed by the laws of the Commonwealth of Massachusetts.

7. Notices. Written notice shall be given to notices@hallandkeegan.com and to Hall and Keegan Materials, Inc., Attn: Contracts Administrator, 61 Bent Street, Cambridge, Massachusetts 02141.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

HALL AND KEEGAN MATERIALS, INC.

By: /s/ Dana Keegan
Name: Dana Keegan
Title: Vice President, Commercial

IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Hall and Keegan Materials, Inc.',
    party_b_signer: 'Dana Keegan',
    party_b_address: '61 Bent Street, Cambridge, Massachusetts 02141',
    party_c: null,
    contract_name: 'Mutual Non-Disclosure Agreement',
    effective_date: '2025-03-03',
    term: '2 years',
    termination_date: '2027-03-03',
    confidentiality_term: '5 years',
    ibc_form: 'Yes',
    notice_email: 'notices@hallandkeegan.com',
    notice_address:
      'Hall and Keegan Materials, Inc., Attn: Contracts Administrator, 61 Bent Street, Cambridge, Massachusetts 02141',
    governing_law: 'Massachusetts',
  },
  acceptable: {
    term: ['two (2) years', 'two years'],
    confidentiality_term: ['five (5) years', 'five years'],
    governing_law: ['Commonwealth of Massachusetts'],
  },
  quotes: {
    party_b: 'and Hall and Keegan Materials, Inc., a Massachusetts corporation',
    effective_date: 'effective as of March 3, 2025',
    term: 'remains in effect for two (2) years',
    confidentiality_term: 'survive for five (5) years from the effective date',
    governing_law: 'governed by the laws of the Commonwealth of Massachusetts',
    notice_email: 'notices@hallandkeegan.com',
  },
  pageOf: { party_b: 1, effective_date: 1 },
  computed: {
    terminationDate: '2027-03-03',
    confidentialityEnd: '2030-03-03',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

/** Fixture 5 — perpetual confidentiality on an agreement that has already expired. */
export const legacy: Fixture = {
  id: 'legacy',
  label: 'Legacy Materials NDA (perpetual confidentiality, expired agreement)',
  filename: 'LegacyMaterials_NDA_2019.pdf',
  docType: 'nda',
  proves:
    'Confidentiality "in perpetuity" has no end date, while the agreement itself expired in 2024. Two clocks, one of which never stops.',
  pages: [
    `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement is entered into as of the 1st day of March, 2019, between International Battery Company, Inc., a Delaware corporation, of 1 Innovation Way, Fremont, California 94538, and Legacy Materials, Inc., a New Jersey corporation, of 88 Raritan Center Parkway, Edison, New Jersey 08837.

1. Confidential Information. Information disclosed by either party that is designated as confidential at the time of disclosure or reduced to writing and marked confidential within thirty (30) days thereafter.

2. Obligations. Each party shall hold the other's Confidential Information in confidence and shall not use it for any purpose other than evaluating a potential cathode powder supply relationship.

3. Term. The term of this Agreement is five (5) years from the date first written above.

4. Survival. The obligations of confidentiality set forth in Section 2 shall survive in perpetuity with respect to any trade secret and shall not expire upon termination of this Agreement.

5. Governing Law. This Agreement shall be governed by the laws of the State of Delaware.

6. Notices. Notices shall be sent to legal@legacymaterials.com and to Legacy Materials, Inc., Attn: President, 88 Raritan Center Parkway, Edison, New Jersey 08837.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

LEGACY MATERIALS, INC.

By: /s/ Howard Bell
Name: Howard Bell
Title: President

IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Legacy Materials, Inc.',
    party_b_signer: 'Howard Bell',
    party_b_address: '88 Raritan Center Parkway, Edison, New Jersey 08837',
    party_c: null,
    contract_name: 'Mutual Nondisclosure Agreement',
    effective_date: '2019-03-01',
    term: '5 years',
    termination_date: '2024-03-01',
    confidentiality_term: 'in perpetuity',
    ibc_form: 'Yes',
    notice_email: 'legal@legacymaterials.com',
    notice_address:
      'Legacy Materials, Inc., Attn: President, 88 Raritan Center Parkway, Edison, New Jersey 08837',
    governing_law: 'Delaware',
  },
  acceptable: {
    term: ['five (5) years', 'five years'],
    confidentiality_term: ['perpetual', 'perpetuity', 'in perpetuity with respect to trade secrets'],
    governing_law: ['State of Delaware'],
  },
  quotes: {
    effective_date: 'as of the 1st day of March, 2019',
    term: 'The term of this Agreement is five (5) years',
    confidentiality_term: 'shall survive in perpetuity',
    governing_law: 'governed by the laws of the State of Delaware',
    notice_email: 'legal@legacymaterials.com',
    party_b: 'Legacy Materials, Inc., a New Jersey corporation',
  },
  pageOf: { effective_date: 1, confidentiality_term: 1 },
  computed: {
    terminationDate: '2024-03-01',
    confidentialityEnd: null,
    confidentialityPerpetual: true,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

export const NDA_FIXTURES: Fixture[] = [ntrium, acme, helios, hallKeegan, legacy];
