/**
 * The fixtures that exist because a wrong answer here is invisible.
 *
 * northwind asserts a null. sequoia has no duration at all. voltaic hides two decoy dates
 * above the real one. kestrel is genuinely ambiguous and the only correct behaviour is to
 * abstain. stonecrest is not American.
 */

import type { Fixture } from './types';

/** Fixture 9 - the notice email is absent. Asserting null is the whole point. */
export const northwind: Fixture = {
  id: 'northwind',
  label: 'Northwind Energy NDA (no notice email)',
  filename: 'Northwind_NDA.pdf',
  docType: 'nda',
  proves:
    'The notices clause specifies courier delivery only. The correct notice_email is null, and the general enquiries address in the footer is a decoy that must not be used.',
  pages: [
    `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement is made effective as of Jan. 9, 2023, between International Battery Company, Inc., a Delaware corporation having its principal office at 1 Innovation Way, Fremont, California 94538, and Northwind Energy Storage, Inc., a Washington corporation having its principal office at 720 Olive Way, Suite 1400, Seattle, Washington 98101.

1. Confidential Information. Any information disclosed by one party to the other that is designated as confidential or that a reasonable person would understand to be confidential, including without limitation cell test data, cost models and supplier identities.

2. Obligations. Each party shall maintain the other party's Confidential Information in confidence, restrict access to it, and use it only to evaluate a potential joint development programme.

3. Term. This Agreement remains in effect for four (4) years from the effective date first written above.

4. Survival. The obligations of confidentiality survive for four (4) years from the effective date first written above.

5. Governing Law. This Agreement is governed by the laws of the State of Delaware.

6. Notices. All notices under this Agreement must be in writing and delivered by hand or by nationally recognised overnight courier to the receiving party at the principal office stated in the preamble, marked for the attention of the Legal Department. Notice by electronic mail is not effective under this Agreement.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

NORTHWIND ENERGY STORAGE, INC.

By: /s/ Alice Fenwick
Name: Alice Fenwick
Title: General Counsel

General enquiries: info@northwindenergy.com | www.northwindenergy.com
IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Northwind Energy Storage, Inc.',
    party_b_signer: 'Alice Fenwick',
    party_b_address: '720 Olive Way, Suite 1400, Seattle, Washington 98101',
    party_c: null,
    contract_name: 'Mutual Nondisclosure Agreement',
    effective_date: '2023-01-09',
    term: '4 years',
    termination_date: '2027-01-09',
    confidentiality_term: '4 years',
    ibc_form: 'Yes',
    notice_email: null,
    notice_address:
      'Northwind Energy Storage, Inc., Attn: Legal Department, 720 Olive Way, Suite 1400, Seattle, Washington 98101',
    governing_law: 'Delaware',
  },
  acceptable: {
    term: ['four (4) years', 'four years'],
    confidentiality_term: ['four (4) years', 'four years'],
    governing_law: ['State of Delaware'],
    notice_address: ['720 Olive Way, Suite 1400, Seattle, Washington 98101'],
  },
  quotes: {
    effective_date: 'made effective as of Jan. 9, 2023',
    term: 'remains in effect for four (4) years',
    confidentiality_term: 'survive for four (4) years',
    governing_law: 'governed by the laws of the State of Delaware',
    party_b: 'Northwind Energy Storage, Inc., a Washington corporation',
  },
  pageOf: { effective_date: 1 },
  computed: {
    terminationDate: '2027-01-09',
    confidentialityEnd: '2027-01-09',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['notice_email', 'party_c'],
};

/** Fixture 10 - a term expressed only as an end date. There is no duration to parse. */
export const sequoia: Fixture = {
  id: 'sequoia',
  label: 'Sequoia Grid NDA (end date, no duration)',
  filename: 'SequoiaGrid_NDA.pdf',
  docType: 'nda',
  proves:
    'The agreement states an end date and never states a duration. term is null and the termination date comes from the document, not from arithmetic.',
  pages: [
    `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement is effective as of September 15, 2025 by and between International Battery Company, Inc., a Delaware corporation of 1 Innovation Way, Fremont, California 94538, and Sequoia Grid Storage, LLC, a California limited liability company of 900 Middlefield Road, Redwood City, California 94063.

1. Confidential Information. Information of either party that is not generally known and that is disclosed in connection with a potential grid storage supply relationship.

2. Obligations. Each party shall keep the other party's Confidential Information confidential and shall use it only for the purpose stated in Section 1.

3. Term. This Agreement commences on the Effective Date and shall continue until December 31, 2027, unless earlier terminated by mutual written agreement of the parties.

4. Survival. The obligations of confidentiality shall survive for five (5) years from the Effective Date.

5. Governing Law. This Agreement is governed by the laws of the State of California.

6. Notices. Notices shall be delivered in writing to legal@sequoiagrid.com and to Sequoia Grid Storage, LLC, Attn: Legal, 900 Middlefield Road, Redwood City, California 94063.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

SEQUOIA GRID STORAGE, LLC

By: /s/ Miriam Osei
Name: Miriam Osei
Title: Chief Executive Officer

IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Sequoia Grid Storage, LLC',
    party_b_signer: 'Miriam Osei',
    party_b_address: '900 Middlefield Road, Redwood City, California 94063',
    party_c: null,
    contract_name: 'Mutual Nondisclosure Agreement',
    effective_date: '2025-09-15',
    term: null,
    termination_date: '2027-12-31',
    confidentiality_term: '5 years',
    ibc_form: 'Yes',
    notice_email: 'legal@sequoiagrid.com',
    notice_address:
      'Sequoia Grid Storage, LLC, Attn: Legal, 900 Middlefield Road, Redwood City, California 94063',
    governing_law: 'California',
  },
  acceptable: {
    term: ['until December 31, 2027'],
    confidentiality_term: ['five (5) years', 'five years'],
    governing_law: ['State of California'],
  },
  quotes: {
    effective_date: 'effective as of September 15, 2025',
    termination_date: 'shall continue until December 31, 2027',
    confidentiality_term: 'survive for five (5) years from the Effective Date',
    governing_law: 'governed by the laws of the State of California',
    notice_email: 'legal@sequoiagrid.com',
    party_b: 'Sequoia Grid Storage, LLC, a California limited liability company',
  },
  pageOf: { effective_date: 1, termination_date: 1 },
  computed: {
    terminationDate: '2027-12-31',
    confidentialityEnd: '2030-09-15',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['term', 'party_c'],
};

/** Fixture 11 - two decoy dates sit above the real effective date. */
export const voltaic: Fixture = {
  id: 'voltaic',
  label: 'Voltaic Materials NDA (decoy dates in the recitals)',
  filename: 'Voltaic_NDA_executed.pdf',
  docType: 'nda',
  proves:
    'The first two dates in the document are a conference meeting and a letter of intent. A rule that takes the first date it sees returns 2021-03-01 and is wrong.',
  pages: [
    `NON-DISCLOSURE AGREEMENT

RECITALS

A. WHEREAS, representatives of the parties first met at the Advanced Automotive Battery Conference on March 1, 2021 and have since held preliminary discussions concerning cathode active material supply;

B. WHEREAS, the parties executed a non-binding Letter of Intent dated June 15, 2021 which did not address the treatment of confidential information;

C. WHEREAS, the parties now wish to record their obligations with respect to confidential information disclosed in the course of those discussions;

NOW, THEREFORE, this Non-Disclosure Agreement (this "Agreement") is entered into and shall be effective as of September 8, 2021 (the "Effective Date") by and between International Battery Company, Inc., a Delaware corporation with its principal place of business at 1 Innovation Way, Fremont, California 94538, and Voltaic Materials Corporation, a Nevada corporation with its principal place of business at 6795 Edmond Street, Las Vegas, Nevada 89118.

1. Confidential Information. All non-public information disclosed by either party, whether before or after the Effective Date, relating to the subject matter of the discussions described in the Recitals.`,
    `2. Obligations. The receiving party shall not disclose the disclosing party's Confidential Information to any third party and shall not use it other than for the purpose of evaluating the potential relationship.

3. Term. The term of this Agreement is three (3) years from the Effective Date.

4. Survival. The obligations of confidentiality shall survive for five (5) years from the Effective Date, notwithstanding any earlier expiration of this Agreement.

5. Governing Law. This Agreement shall be governed by the laws of the State of Delaware without regard to conflicts of law principles.

6. Notices. Notices shall be sent to contracts@voltaicmaterials.com and to Voltaic Materials Corporation, Attn: Contracts, 6795 Edmond Street, Las Vegas, Nevada 89118.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

VOLTAIC MATERIALS CORPORATION

By: /s/ Simon Adeyemi
Name: Simon Adeyemi
Title: Senior Vice President

IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Voltaic Materials Corporation',
    party_b_signer: 'Simon Adeyemi',
    party_b_address: '6795 Edmond Street, Las Vegas, Nevada 89118',
    party_c: null,
    contract_name: 'Non-Disclosure Agreement',
    effective_date: '2021-09-08',
    term: '3 years',
    termination_date: '2024-09-08',
    confidentiality_term: '5 years',
    ibc_form: 'Yes',
    notice_email: 'contracts@voltaicmaterials.com',
    notice_address:
      'Voltaic Materials Corporation, Attn: Contracts, 6795 Edmond Street, Las Vegas, Nevada 89118',
    governing_law: 'Delaware',
  },
  acceptable: {
    contract_name: ['Nondisclosure Agreement'],
    term: ['three (3) years', 'three years'],
    confidentiality_term: ['five (5) years', 'five years'],
    governing_law: ['State of Delaware'],
  },
  quotes: {
    effective_date: 'shall be effective as of September 8, 2021',
    term: 'The term of this Agreement is three (3) years from the Effective Date',
    confidentiality_term: 'shall survive for five (5) years from the Effective Date',
    governing_law: 'governed by the laws of the State of Delaware',
    notice_email: 'contracts@voltaicmaterials.com',
    party_b: 'Voltaic Materials Corporation, a Nevada corporation',
  },
  pageOf: { effective_date: 1, term: 2, governing_law: 2 },
  computed: {
    terminationDate: '2024-09-08',
    confidentialityEnd: '2026-09-08',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

/**
 * Fixture 12 - 03/04/2024 with a US governing law and a British counterparty. Nothing in
 * the document decides between 3 April and 4 March, so the deterministic pass must abstain
 * and leave the field for a human. Abstaining is the pass condition.
 */
export const kestrel: Fixture = {
  id: 'kestrel',
  label: 'Kestrel Power NDA (ambiguous 03/04/2024)',
  filename: 'Kestrel_NDA_scan.pdf',
  docType: 'nda',
  proves:
    'An ambiguous numeric date. The rules pass must not guess, so the field arrives at review empty rather than confidently wrong.',
  pages: [
    `MUTUAL NONDISCLOSURE AGREEMENT

Dated: 03/04/2024

Between: International Battery Company, Inc., a Delaware corporation of 1 Innovation Way, Fremont, California 94538

And: Kestrel Power Systems Limited, a company registered in England and Wales of 12 Deansgate, Manchester M3 1BQ, United Kingdom

1. Confidential Information. Information disclosed by either party in connection with a potential cell supply arrangement that is marked confidential or that would reasonably be understood to be confidential.

2. Obligations. Each party shall keep the other party's Confidential Information secret and shall use it only for the purpose described in Section 1.

3. Term. The term of this Agreement is two (2) years from the date stated above.

4. Survival. The obligations of confidentiality shall survive for five (5) years from the date stated above.

5. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware.

6. Notices. Notices shall be sent to legal@kestrelpower.co.uk and to Kestrel Power Systems Limited, Attn: Company Secretary, 12 Deansgate, Manchester M3 1BQ, United Kingdom.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

KESTREL POWER SYSTEMS LIMITED

By: /s/ Owen Bramley
Name: Owen Bramley
Title: Director

IBC Form NDA-2022 Rev. 3`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Kestrel Power Systems Limited',
    party_b_signer: 'Owen Bramley',
    party_b_address: '12 Deansgate, Manchester M3 1BQ, United Kingdom',
    party_c: null,
    contract_name: 'Mutual Nondisclosure Agreement',
    effective_date: null,
    term: '2 years',
    termination_date: null,
    confidentiality_term: '5 years',
    ibc_form: 'Yes',
    notice_email: 'legal@kestrelpower.co.uk',
    notice_address:
      'Kestrel Power Systems Limited, Attn: Company Secretary, 12 Deansgate, Manchester M3 1BQ, United Kingdom',
    governing_law: 'Delaware',
  },
  acceptable: {
    effective_date: ['2024-03-04', '2024-04-03'],
    term: ['two (2) years', 'two years'],
    confidentiality_term: ['five (5) years', 'five years'],
    governing_law: ['State of Delaware'],
  },
  quotes: {
    term: 'The term of this Agreement is two (2) years',
    confidentiality_term: 'shall survive for five (5) years',
    governing_law: 'the laws of the State of Delaware',
    notice_email: 'legal@kestrelpower.co.uk',
    party_b: 'Kestrel Power Systems Limited, a company registered in England and Wales',
  },
  computed: {
    terminationDate: null,
    confidentialityEnd: null,
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['governing_law'],
  rulesMustNotFind: ['effective_date', 'termination_date', 'party_c'],
};

/** Fixture 13 - non-US governing law and a non-US notice address. */
export const stonecrest: Fixture = {
  id: 'stonecrest',
  label: 'Stonecrest Cathode NDA (England and Wales)',
  filename: 'Stonecrest_NDA.pdf',
  docType: 'nda',
  proves:
    'Governing law is a country pair, not a US state, and the notice address is British. A rule keyed to "State of X" must not fire here.',
  pages: [
    `MUTUAL CONFIDENTIALITY AGREEMENT

THIS AGREEMENT is dated 1st April 2025

PARTIES

(1) INTERNATIONAL BATTERY COMPANY, INC., a Delaware corporation whose principal place of business is 1 Innovation Way, Fremont, California 94538 ("IBC")

(2) STONECREST CATHODE LIMITED, a company registered in England and Wales with company number 09912345 whose registered office is at 30 Finsbury Square, London EC2A 1AG, United Kingdom ("Stonecrest")

1. Purpose. The parties wish to discuss the potential supply of cathode active material by Stonecrest to IBC and will exchange Confidential Information for that purpose.

2. Confidentiality. Each party shall keep confidential all Confidential Information of the other party and shall not disclose it to any person except as permitted by this Agreement.

3. Term. This Agreement shall commence on the date of this Agreement and shall continue for three (3) years.

4. Duration of Confidentiality Obligations. The obligations in clause 2 shall continue for seven (7) years from the date of this Agreement, notwithstanding the expiry of this Agreement.

5. Governing Law. This Agreement and any dispute or claim arising out of or in connection with it shall be governed by and construed in accordance with the law of England and Wales, and the parties irrevocably submit to the exclusive jurisdiction of the courts of England and Wales.

6. Notices. Any notice given under this Agreement shall be sent by email to legal@stonecrest.co.uk and by post to Stonecrest Cathode Limited, 30 Finsbury Square, London EC2A 1AG, United Kingdom, marked for the attention of the Company Secretary.

Signed for and on behalf of INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

Signed for and on behalf of STONECREST CATHODE LIMITED

By: /s/ Fiona Whitmore
Name: Fiona Whitmore
Title: Company Secretary`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Stonecrest Cathode Limited',
    party_b_signer: 'Fiona Whitmore',
    party_b_address: '30 Finsbury Square, London EC2A 1AG, United Kingdom',
    party_c: null,
    contract_name: 'Mutual Confidentiality Agreement',
    effective_date: '2025-04-01',
    term: '3 years',
    termination_date: '2028-04-01',
    confidentiality_term: '7 years',
    ibc_form: 'No',
    notice_email: 'legal@stonecrest.co.uk',
    notice_address:
      'Stonecrest Cathode Limited, 30 Finsbury Square, London EC2A 1AG, United Kingdom',
    governing_law: 'England and Wales',
  },
  acceptable: {
    term: ['three (3) years', 'three years'],
    confidentiality_term: ['seven (7) years', 'seven years'],
    ibc_form: [null],
    contract_name: ['Mutual Confidentiality Agreement'],
  },
  quotes: {
    effective_date: 'THIS AGREEMENT is dated 1st April 2025',
    term: 'shall continue for three (3) years',
    confidentiality_term: 'shall continue for seven (7) years from the date of this Agreement',
    governing_law: 'the law of England and Wales',
    notice_email: 'legal@stonecrest.co.uk',
    party_b: 'STONECREST CATHODE LIMITED, a company registered in England and Wales',
  },
  pageOf: { effective_date: 1, governing_law: 1 },
  computed: {
    terminationDate: '2028-04-01',
    confidentialityEnd: '2032-04-01',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

export const EDGE_FIXTURES: Fixture[] = [northwind, sequoia, voltaic, kestrel, stonecrest];
