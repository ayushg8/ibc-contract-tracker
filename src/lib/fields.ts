/**
 * THE single source of truth for the tracker schema.
 *
 * Derived directly from Bonnie's Tracker.xlsx (NDA sheet + Eval Agmt sheet).
 * Every screen, prompt, export column and eval case reads from this file.
 * If a field is not here, it does not exist in the product.
 */

export const FIELD_KEYS = [
  'party_a',
  'party_a_signer',
  'party_a_address',
  'party_b',
  'party_b_signer',
  'party_b_address',
  'party_c',
  'contract_name',
  'effective_date',
  'term',
  'termination_date',
  'confidentiality_term',
  'ibc_form',
  'notice_email',
  'notice_address',
  'governing_law',
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/** How a value got into the record. Drives the confidence dot in the UI. */
export type ExtractionMethod =
  | 'rule' // deterministic regex/parser matched — green
  | 'model' // model returned it with a verified citation — amber
  | 'computed' // derived in code from other fields — green, read-only
  | 'manual' // a human typed it — green
  | 'na' // human explicitly marked "not in document" — neutral
  | 'missing'; // nothing found — red

export type Confidence = 'high' | 'medium' | 'none';

export function confidenceOf(method: ExtractionMethod): Confidence {
  switch (method) {
    case 'rule':
    case 'computed':
    case 'manual':
      return 'high';
    case 'model':
      return 'medium';
    case 'na':
    case 'missing':
      return 'none';
  }
}

export type FieldGroup = 'parties' | 'dates' | 'signers' | 'notice' | 'legal';

export const FIELD_GROUPS: { id: FieldGroup; label: string }[] = [
  { id: 'parties', label: 'Parties' },
  { id: 'dates', label: 'Dates & Term' },
  { id: 'signers', label: 'Signers' },
  { id: 'notice', label: 'Notice' },
  { id: 'legal', label: 'Legal' },
];

export type FieldType = 'text' | 'longtext' | 'date' | 'duration' | 'email' | 'boolean';

export interface FieldDef {
  key: FieldKey;
  /** Label shown in the UI. */
  label: string;
  /** Exact column header in Bonnie's workbook. null = not exported. */
  excelHeader: string | null;
  group: FieldGroup;
  type: FieldType;
  /**
   * 'rules-then-model' — try deterministic extraction, ask the model only for what's left.
   * 'model'           — only the model can find this.
   * 'computed'        — never asked of the model; derived in code.
   */
  source: 'rules-then-model' | 'model' | 'computed';
  /** Approve is blocked until this is filled, manually entered, or marked N/A. */
  requiredToApprove: boolean;
  /** Guidance injected into the extraction prompt. Keep it factual and narrow. */
  prompt: string;
}

export const FIELDS: Record<FieldKey, FieldDef> = {
  party_a: {
    key: 'party_a',
    label: 'Party A',
    excelHeader: 'Party A',
    group: 'parties',
    type: 'text',
    source: 'rules-then-model',
    requiredToApprove: true,
    prompt:
      'The first contracting party as written in the preamble, including its legal suffix (Inc., LLC, GmbH, Ltd.). This is usually International Battery Company, Inc.',
  },
  party_a_signer: {
    key: 'party_a_signer',
    label: 'Party A signer',
    excelHeader: 'Party A signer',
    group: 'signers',
    type: 'text',
    source: 'model',
    requiredToApprove: false,
    prompt:
      'The natural person who signed on behalf of Party A, from the signature block. Name only — no title.',
  },
  party_a_address: {
    key: 'party_a_address',
    label: 'Party A address',
    excelHeader: 'Party A address',
    group: 'signers',
    type: 'longtext',
    source: 'model',
    requiredToApprove: false,
    prompt: "Party A's address as written in the preamble or notice clause.",
  },
  party_b: {
    key: 'party_b',
    label: 'Party B',
    excelHeader: 'Party B',
    group: 'parties',
    type: 'text',
    source: 'rules-then-model',
    requiredToApprove: true,
    prompt:
      'The counterparty as written in the preamble, including its legal suffix. This is the party that is NOT International Battery Company.',
  },
  party_b_signer: {
    key: 'party_b_signer',
    label: 'Party B signer',
    excelHeader: 'Party B signer',
    group: 'signers',
    type: 'text',
    source: 'model',
    requiredToApprove: false,
    prompt:
      'The natural person who signed on behalf of Party B, from the signature block. Name only — no title.',
  },
  party_b_address: {
    key: 'party_b_address',
    label: 'Party B address',
    excelHeader: 'Party B address',
    group: 'signers',
    type: 'longtext',
    source: 'model',
    requiredToApprove: false,
    prompt: "Party B's address as written in the preamble or notice clause.",
  },
  party_c: {
    key: 'party_c',
    label: 'Party C',
    excelHeader: null,
    group: 'parties',
    type: 'text',
    source: 'model',
    requiredToApprove: false,
    prompt:
      'A third contracting party, if and only if this agreement has more than two parties. Return null for ordinary two-party agreements.',
  },
  contract_name: {
    key: 'contract_name',
    label: 'Name of Contract',
    excelHeader: 'Name of Contract',
    group: 'parties',
    type: 'text',
    source: 'rules-then-model',
    requiredToApprove: true,
    prompt:
      'The document title as printed at the top of page 1, e.g. "Mutual Nondisclosure Agreement" or "Evaluation Agreement".',
  },
  effective_date: {
    key: 'effective_date',
    label: 'Effective Date',
    excelHeader: 'Effective Date',
    group: 'dates',
    type: 'date',
    source: 'rules-then-model',
    requiredToApprove: true,
    prompt:
      'The date the agreement takes effect. Prefer an explicit "Effective Date" or "effective as of" clause over the signature date. Return ISO format YYYY-MM-DD.',
  },
  term: {
    key: 'term',
    label: 'Term',
    excelHeader: 'Term',
    group: 'dates',
    type: 'duration',
    source: 'rules-then-model',
    requiredToApprove: true,
    prompt:
      'How long the agreement itself remains in force, verbatim as written, e.g. "5 years", "90 days", "2 years". This is the term of the AGREEMENT, not the confidentiality obligation.',
  },
  termination_date: {
    key: 'termination_date',
    label: 'Termination',
    excelHeader: 'Termination',
    group: 'dates',
    type: 'date',
    source: 'computed',
    requiredToApprove: false,
    prompt: '', // never sent to the model
  },
  confidentiality_term: {
    key: 'confidentiality_term',
    label: 'Confidentiality term',
    excelHeader: 'Confidentiality  term', // NOTE: two spaces — matches her workbook exactly
    group: 'dates',
    type: 'duration',
    source: 'rules-then-model',
    requiredToApprove: false,
    prompt:
      'How long the duty of confidentiality survives, verbatim, e.g. "5 years". This often OUTLASTS the term of the agreement and is a separate clause — do not confuse the two.',
  },
  ibc_form: {
    key: 'ibc_form',
    label: 'IBC Form',
    excelHeader: 'IBC Form',
    group: 'legal',
    type: 'boolean',
    source: 'model',
    requiredToApprove: false,
    prompt:
      'Whether this is on International Battery Company\'s own template rather than the counterparty\'s. Answer "Yes" or "No". Return null if there is no textual basis to decide.',
  },
  notice_email: {
    key: 'notice_email',
    label: 'Notice Email',
    excelHeader: 'Notice Email',
    group: 'notice',
    type: 'email',
    source: 'rules-then-model',
    requiredToApprove: false,
    prompt:
      'The email address designated for formal notices, from the notices clause. If several, return the counterparty\'s.',
  },
  notice_address: {
    key: 'notice_address',
    label: 'Notice Address',
    excelHeader: 'Notice Address',
    group: 'notice',
    type: 'longtext',
    source: 'model',
    requiredToApprove: false,
    prompt:
      'The postal address for formal notices to the counterparty. Return it as a single line, comma-separated, exactly as printed, including the company name and any "Attn:" or "marked for the attention of" line. Take it from the notices clause; if that clause instead points at an address stated elsewhere (for example "the principal office stated in the preamble"), return that address.',
  },
  governing_law: {
    key: 'governing_law',
    label: 'Governing Law',
    excelHeader: 'Governing Law',
    group: 'legal',
    type: 'text',
    source: 'rules-then-model',
    requiredToApprove: true,
    prompt:
      'The governing jurisdiction from the governing-law clause. Return the state or country name only, e.g. "Delaware", "California", "England and Wales".',
  },
};

export const FIELD_LIST: FieldDef[] = FIELD_KEYS.map((k) => FIELDS[k]);

/** Fields the model is ever allowed to answer. Excludes computed fields. */
export const MODEL_FIELD_KEYS: FieldKey[] = FIELD_LIST.filter(
  (f) => f.source !== 'computed',
).map((f) => f.key);

export function fieldsInGroup(group: FieldGroup): FieldDef[] {
  return FIELD_LIST.filter((f) => f.group === group);
}

/* ─────────────────────────── Document types ─────────────────────────── */

export const DOC_TYPES = ['nda', 'evaluation', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  nda: 'Mutual NDA',
  evaluation: 'Evaluation Agreement',
  other: 'Other',
};

/** Worksheet each doc type exports into. Matches her workbook's tab names. */
export const DOC_TYPE_SHEET: Record<DocType, string> = {
  nda: 'NDA',
  evaluation: 'Eval Agmt',
  other: 'Other',
};

/** Columns her workbook omits on the Eval Agmt sheet. */
export const SHEET_EXCLUDED_FIELDS: Record<DocType, FieldKey[]> = {
  nda: [],
  evaluation: ['ibc_form'],
  other: [],
};

/**
 * Column order for the Excel export, transcribed from Tracker.xlsx row 4.
 *
 * Deliberately NOT the same as FIELD_KEYS. FIELD_KEYS groups the party fields together
 * because that is how the review screen reads best; her workbook interleaves them
 * differently, putting the signers and addresses after the dates. She pastes our output
 * over her existing sheet, so the columns have to line up exactly -- a review-friendly
 * order would silently shift six columns.
 *
 * Verified against the file: NDA row 4 reads
 *   Party A | Party B | Name of Contract | Effective Date | Term | Termination |
 *   Confidentiality  term | IBC Form | Party A signer | Party A address |
 *   Party B signer | Party B address | Notice Email | Notice Address | Governing Law
 */
export const EXCEL_COLUMN_ORDER: FieldKey[] = [
  'party_a',
  'party_b',
  'contract_name',
  'effective_date',
  'term',
  'termination_date',
  'confidentiality_term',
  'ibc_form',
  'party_a_signer',
  'party_a_address',
  'party_b_signer',
  'party_b_address',
  'notice_email',
  'notice_address',
  'governing_law',
];

/** The exported columns for one sheet, in her order, minus that sheet's omissions. */
export function excelColumnsFor(docType: DocType): FieldDef[] {
  const excluded = new Set<FieldKey>(SHEET_EXCLUDED_FIELDS[docType]);
  return EXCEL_COLUMN_ORDER.filter((k) => !excluded.has(k))
    .map((k) => FIELDS[k])
    .filter((f) => f.excelHeader !== null);
}
