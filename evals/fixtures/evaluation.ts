/**
 * Evaluation agreement fixtures.
 *
 * `octillion` is the highest-value fixture in the suite: a 90-day agreement carrying a
 * 5-year confidentiality obligation. A flat spreadsheet cannot express that, and getting
 * it wrong is the failure mode that would cost IBC real money.
 */

import type { Fixture } from './types';

/** Fixture 6 - the two-clocks case. Short term, long confidentiality tail. */
export const octillion: Fixture = {
  id: 'octillion',
  label: 'Octillion evaluation agreement (90-day term, 5-year confidentiality)',
  filename: 'Octillion_Evaluation_Agreement.pdf',
  docType: 'evaluation',
  proves:
    'The two clocks. The agreement expires 2026-09-30; the duty of confidence runs to 2031-07-02. A 60-day termination notice in the same document must not be mistaken for the term.',
  pages: [
    `EVALUATION AGREEMENT

This Evaluation Agreement (this "Agreement") is made effective as of July 2, 2026 (the "Effective Date") by and between International Battery Company, Inc., a Delaware corporation with its principal place of business at 1 Innovation Way, Fremont, California 94538 ("IBC"), and Octillion Power Supply, Inc., a California corporation with its principal place of business at 3120 Diablo Avenue, Hayward, California 94545 ("Octillion").

1. Purpose. IBC will supply a limited quantity of prototype cells to Octillion, and Octillion will evaluate those cells for possible use in its energy storage products. This Agreement governs that evaluation and the exchange of information relating to it.

2. Evaluation Samples. Cells supplied under this Agreement are supplied for evaluation only, remain the property of IBC, and shall be returned or destroyed at IBC's direction at the conclusion of the evaluation.

3. Confidential Information. Each party may disclose to the other information that is confidential or proprietary, including cell specifications, test data, manufacturing processes, pricing, and product roadmaps. Such information is "Confidential Information" whether or not it is marked as such.

4. Obligations. The receiving party shall use Confidential Information solely for the purposes of the evaluation, shall not disclose it to any third party without prior written consent, and shall protect it with at least reasonable care.`,
    `5. Term. The term of this Agreement is ninety (90) days from the Effective Date. The parties may extend the term only by a written amendment signed by both parties.

6. Termination for Convenience. Either party may terminate this Agreement before the end of the term upon sixty (60) days prior written notice to the other party. Termination does not relieve either party of its obligations under Section 7.

7. Confidentiality Period. The obligations of confidentiality and non-use set forth in Section 4 shall remain in effect for five (5) years from the Effective Date, and shall survive the expiration or earlier termination of this Agreement.

8. No Warranty. The evaluation cells are provided "AS IS" without warranty of any kind, express or implied, including any warranty of merchantability or fitness for a particular purpose.

9. Ownership. Each party retains all right, title and interest in its own intellectual property. No licence is granted except the limited right to conduct the evaluation described in Section 1.

10. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of California, without regard to its conflict of laws provisions.`,
    `11. Notices. All notices under this Agreement shall be in writing and delivered by courier or electronic mail as follows:

If to IBC:
International Battery Company, Inc., Attn: General Counsel, 1 Innovation Way, Fremont, California 94538
legal@internationalbattery.com

If to Octillion:
Octillion Power Supply, Inc., Attn: Director of Engineering, 3120 Diablo Avenue, Hayward, California 94545
contracts@octillionpower.com

12. Entire Agreement. This Agreement is the complete and exclusive statement of the parties' agreement regarding the evaluation and supersedes all prior proposals and understandings.

IN WITNESS WHEREOF, the parties have caused this Agreement to be executed by their duly authorised representatives.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

OCTILLION POWER SUPPLY, INC.

By: /s/ Lena Ortiz
Name: Lena Ortiz
Title: Director of Engineering

IBC Form EVAL-2024 Rev. 1`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Octillion Power Supply, Inc.',
    party_b_signer: 'Lena Ortiz',
    party_b_address: '3120 Diablo Avenue, Hayward, California 94545',
    party_c: null,
    contract_name: 'Evaluation Agreement',
    effective_date: '2026-07-02',
    term: '90 days',
    termination_date: '2026-09-30',
    confidentiality_term: '5 years',
    ibc_form: 'Yes',
    notice_email: 'contracts@octillionpower.com',
    notice_address:
      'Octillion Power Supply, Inc., Attn: Director of Engineering, 3120 Diablo Avenue, Hayward, California 94545',
    governing_law: 'California',
  },
  acceptable: {
    term: ['ninety (90) days', 'ninety days'],
    confidentiality_term: ['five (5) years', 'five years'],
    governing_law: ['State of California'],
  },
  quotes: {
    party_b: 'Octillion Power Supply, Inc., a California corporation',
    contract_name: 'EVALUATION AGREEMENT',
    effective_date: 'made effective as of July 2, 2026',
    term: 'The term of this Agreement is ninety (90) days from the Effective Date',
    confidentiality_term: 'shall remain in effect for five (5) years from the Effective Date',
    governing_law: 'the laws of the State of California',
    notice_email: 'contracts@octillionpower.com',
    party_b_signer: 'Name: Lena Ortiz',
  },
  pageOf: { effective_date: 1, term: 2, confidentiality_term: 2, governing_law: 2, notice_email: 3 },
  computed: {
    terminationDate: '2026-09-30',
    confidentialityEnd: '2031-07-02',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'term', 'confidentiality_term', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

/** Fixture 7 - three parties. Party C is data, not a schema migration. */
export const trisolar: Fixture = {
  id: 'trisolar',
  label: 'Trisolar / Meridian three-party evaluation agreement',
  filename: 'Trisolar_Meridian_Evaluation.pdf',
  docType: 'evaluation',
  proves:
    'Three contracting parties. Party C must be populated, and the counterparty for the card title is the second party named in the preamble.',
  pages: [
    `THREE-PARTY EVALUATION AGREEMENT

This Three-Party Evaluation Agreement (this "Agreement") is entered into and effective as of March 12, 2025 (the "Effective Date") among International Battery Company, Inc., a Delaware corporation with offices at 1 Innovation Way, Fremont, California 94538 ("IBC"), Trisolar Cells, Ltd., a company incorporated in Singapore with offices at 8 Marina Boulevard, Level 11, Singapore 018981 ("Trisolar"), and Meridian Pack Systems, LLC, a Michigan limited liability company with offices at 2100 Cass Avenue, Detroit, Michigan 48201 ("Meridian"). IBC, Trisolar and Meridian are each a "Party" and together the "Parties".

1. Purpose. The Parties will jointly evaluate the integration of IBC cells and Trisolar cell hardware into Meridian battery pack assemblies for a commercial vehicle programme.

2. Confidential Information. Information disclosed by any Party to any other Party in connection with the evaluation, in any form, that is marked confidential or that a reasonable person would understand to be confidential.

3. Obligations. Each Party shall use the Confidential Information of each other Party solely for the purpose described in Section 1 and shall not disclose it to anyone outside the Parties without the prior written consent of the disclosing Party.`,
    `4. Term. This Agreement commences on the Effective Date and continues for two (2) years unless the Parties agree in writing to extend it.

5. Survival of Confidentiality. The confidentiality obligations in Section 3 continue for three (3) years from the Effective Date with respect to all Confidential Information disclosed during the term.

6. Governing Law. This Agreement is governed by the laws of the State of California, excluding its conflict of laws rules.

7. Notices. Notices to Trisolar shall be sent to legal@trisolarcells.com and to Trisolar Cells, Ltd., Attn: Company Secretary, 8 Marina Boulevard, Level 11, Singapore 018981. Notices to Meridian shall be sent to contracts@meridianpack.com. Notices to IBC shall be sent to legal@internationalbattery.com.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

TRISOLAR CELLS, LTD.

By: /s/ Wei Lin Tan
Name: Wei Lin Tan
Title: Director

MERIDIAN PACK SYSTEMS, LLC

By: /s/ Gregory Poole
Name: Gregory Poole
Title: Managing Member

IBC Form EVAL-2024 Rev. 1`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Trisolar Cells, Ltd.',
    party_b_signer: 'Wei Lin Tan',
    party_b_address: '8 Marina Boulevard, Level 11, Singapore 018981',
    party_c: 'Meridian Pack Systems, LLC',
    contract_name: 'Three-Party Evaluation Agreement',
    effective_date: '2025-03-12',
    term: '2 years',
    termination_date: '2027-03-12',
    confidentiality_term: '3 years',
    ibc_form: 'Yes',
    notice_email: 'legal@trisolarcells.com',
    notice_address:
      'Trisolar Cells, Ltd., Attn: Company Secretary, 8 Marina Boulevard, Level 11, Singapore 018981',
    governing_law: 'California',
  },
  acceptable: {
    contract_name: ['Evaluation Agreement'],
    term: ['two (2) years', 'two years'],
    confidentiality_term: ['three (3) years', 'three years'],
    governing_law: ['State of California'],
  },
  quotes: {
    party_b: 'Trisolar Cells, Ltd., a company incorporated in Singapore',
    party_c: 'and Meridian Pack Systems, LLC, a Michigan limited liability company',
    contract_name: 'THREE-PARTY EVALUATION AGREEMENT',
    effective_date: 'effective as of March 12, 2025',
    term: 'continues for two (2) years',
    confidentiality_term: 'continue for three (3) years from the Effective Date',
    governing_law: 'governed by the laws of the State of California',
    notice_email: 'legal@trisolarcells.com',
  },
  pageOf: { party_c: 1, effective_date: 1, term: 2 },
  computed: {
    terminationDate: '2027-03-12',
    confidentialityEnd: '2028-03-12',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'governing_law'],
  rulesMustNotFind: [],
};

/**
 * Fixture 8 - an ISO date in the document, durations in months, and text mangled the way a
 * real PDF text layer mangles it: curly apostrophes, an NBSP, a soft hyphen, an en dash,
 * and one word broken across a line wrap. The rules pass must survive all of it.
 */
export const daybreak: Fixture = {
  id: 'daybreak',
  label: 'Daybreak Grid evaluation agreement (dirty text layer, month durations)',
  filename: 'Daybreak_Grid_Eval.pdf',
  docType: 'evaluation',
  proves:
    'An ISO date form, durations expressed in months, and a text layer full of curly quotes, NBSPs, soft hyphens and a mid-word line wrap. Rules must normalise before matching.',
  pages: [
    `EVALUATION AGREEMENT

This Evaluation Agreement is effective as of 2025-06-30 (the \u201cEffective Date\u201d) between International Battery Company, Inc., a Delaware corporation of 1 Innovation Way, Fremont, California 94538, and Daybreak Grid Storage, Inc., a Colorado corporation of 1515 Wynkoop Street, Suite 600, Denver, Colorado 80202.

1. Purpose. The parties will evaluate the use of IBC\u2019s prismatic cells in Daybreak\u2019s utility-scale storage cabinets.

2. Confiden\u00adtial Information. All information disclosed by either party in connection with the evaluation \u2013 including test data, drawings and pricing \u2013 that is marked confidential or that a reasonable person would treat as confidential.

3. Obligations. Neither party shall disclose the other party\u2019s Confidential Information to any third party, nor use it for any purpose other than the evaluation, without the disclosing party\u2019s prior written consent.`,
    `4. Term. The term of this Agreement is twenty-four (24) months from the Effective Date, unless terminated earlier by either party on thirty\u00a0(30) days written notice.

5. Confiden-
tiality Period. The obligations set out in Section 3 continue for 36 months from the Effective Date and survive expiration or termination of this Agreement.

6. Governing Law. This Agreement is governed by the laws of the State of Ohio.

7. Notices. Notices shall be sent to notices@daybreakgrid.com and to Daybreak Grid Storage, Inc., Attn: General Counsel, 1515 Wynkoop Street, Suite 600, Denver, Colorado 80202.

INTERNATIONAL BATTERY COMPANY, INC.

By: /s/ Anand Krishnan
Name: Anand Krishnan
Title: Chief Financial Officer

DAYBREAK GRID STORAGE, INC.

By: /s/ Tomas Ruiz
Name: Tomas Ruiz
Title: Chief Operating Officer

IBC Form EVAL-2024 Rev. 1`,
  ],
  expected: {
    party_a: 'International Battery Company, Inc.',
    party_a_signer: 'Anand Krishnan',
    party_a_address: '1 Innovation Way, Fremont, California 94538',
    party_b: 'Daybreak Grid Storage, Inc.',
    party_b_signer: 'Tomas Ruiz',
    party_b_address: '1515 Wynkoop Street, Suite 600, Denver, Colorado 80202',
    party_c: null,
    contract_name: 'Evaluation Agreement',
    effective_date: '2025-06-30',
    term: '24 months',
    termination_date: '2027-06-30',
    confidentiality_term: '36 months',
    ibc_form: 'Yes',
    notice_email: 'notices@daybreakgrid.com',
    notice_address:
      'Daybreak Grid Storage, Inc., Attn: General Counsel, 1515 Wynkoop Street, Suite 600, Denver, Colorado 80202',
    governing_law: 'Ohio',
  },
  acceptable: {
    term: ['twenty-four (24) months', '2 years'],
    confidentiality_term: ['3 years'],
    governing_law: ['State of Ohio'],
  },
  quotes: {
    effective_date: 'effective as of 2025-06-30',
    term: 'The term of this Agreement is twenty-four (24) months from the Effective Date',
    confidentiality_term: 'continue for 36 months from the Effective Date',
    governing_law: 'governed by the laws of the State of Ohio',
    notice_email: 'notices@daybreakgrid.com',
    party_b: 'Daybreak Grid Storage, Inc., a Colorado corporation',
  },
  pageOf: { effective_date: 1, term: 2, confidentiality_term: 2 },
  computed: {
    terminationDate: '2027-06-30',
    confidentialityEnd: '2028-06-30',
    confidentialityPerpetual: false,
  },
  rulesMustFind: ['effective_date', 'term', 'confidentiality_term', 'governing_law'],
  rulesMustNotFind: ['party_c'],
};

export const EVALUATION_FIXTURES: Fixture[] = [octillion, trisolar, daybreak];
