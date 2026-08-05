import { describe, expect, it } from 'vitest';
import {
  countVerifiableQuotes,
  extractDocType,
  extractJson,
  hasAnswerKeys,
  validateAnswer,
} from '../src/lib/providers/parse';
import type { FieldKey } from '../src/lib/fields';

const FIELDS: FieldKey[] = ['party_a', 'party_b', 'effective_date', 'governing_law'];

const CLEAN = JSON.stringify({
  doc_type: 'nda',
  fields: {
    party_a: { value: 'International Battery Company, Inc.', quote: 'IBC', page: 1 },
  },
});

describe('extractJson', () => {
  it('parses clean JSON', () => {
    const out = extractJson(CLEAN);
    expect(out).not.toBeNull();
    expect(out?.['doc_type']).toBe('nda');
  });

  it('parses a ```json fenced block', () => {
    const out = extractJson('Sure.\n\n```json\n' + CLEAN + '\n```\n');
    expect(out?.['doc_type']).toBe('nda');
  });

  it('parses an unlabelled fenced block', () => {
    const out = extractJson('```\n' + CLEAN + '\n```');
    expect(out?.['doc_type']).toBe('nda');
  });

  it('parses prose-prefixed output', () => {
    const out = extractJson('Here is the extraction:\n' + CLEAN);
    expect(out?.['doc_type']).toBe('nda');
  });

  it('parses prose-suffixed output', () => {
    const out = extractJson(CLEAN + '\n\nLet me know if you need anything else.');
    expect(out?.['doc_type']).toBe('nda');
  });

  it('survives a closing brace inside a string value', () => {
    const text =
      'Result:\n{"party_a": {"value": "Acme } Corp", "quote": "Acme } Corp {see Ex. A}", "page": 2}}';
    const out = extractJson(text);
    const partyA = out?.['party_a'];
    expect(partyA).toEqual({ value: 'Acme } Corp', quote: 'Acme } Corp {see Ex. A}', page: 2 });
  });

  it('survives an escaped quote inside a string value', () => {
    const text = '{"party_b": {"value": "The \\"Company\\"", "quote": "the \\"Company\\"", "page": 1}}';
    expect(extractJson(text)?.['party_b']).toEqual({
      value: 'The "Company"',
      quote: 'the "Company"',
      page: 1,
    });
  });

  it('repairs smart quotes', () => {
    const text =
      '{\u201Cparty_a\u201D: {\u201Cvalue\u201D: \u201CIBC\u201D, \u201Cquote\u201D: \u201CIBC\u201D, \u201Cpage\u201D: 1}}';
    expect(extractJson(text)?.['party_a']).toEqual({ value: 'IBC', quote: 'IBC', page: 1 });
  });

  it('repairs trailing commas', () => {
    const text = '{"fields": {"party_a": {"value": "IBC", "quote": "IBC", "page": 1,},},}';
    const out = extractJson(text);
    expect(hasAnswerKeys(out ?? {})).toBe(true);
  });

  it('strips // comments', () => {
    const text = '{\n  // the first party\n  "party_a": {"value": "IBC", "quote": "IBC", "page": 1}\n}';
    expect(extractJson(text)?.['party_a']).toBeTruthy();
  });

  it('returns null on truncated output rather than inventing the tail', () => {
    const text = '{"fields": {"party_a": {"value": "International Battery Comp';
    expect(extractJson(text)).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJson('I could not read this document.')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('digs the answer out of a CLI envelope', () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 4210,
      session_id: 'abc',
      result: '```json\n' + CLEAN + '\n```',
    });
    const out = extractJson(envelope);
    expect(out?.['doc_type']).toBe('nda');
  });

  it('ignores ANSI escapes and npm notices', () => {
    const text =
      'npm notice New major version of npm available!\n\u001B[32m' + CLEAN + '\u001B[0m';
    expect(extractJson(text)?.['doc_type']).toBe('nda');
  });

  it('prefers the object that looks like an answer over an earlier example object', () => {
    const text = 'For example {"foo": 1} is not the answer. The answer is ' + CLEAN;
    expect(extractJson(text)?.['doc_type']).toBe('nda');
  });
});

describe('validateAnswer', () => {
  it('coerces the null vocabulary to null', () => {
    const res = validateAnswer(
      {
        party_a: { value: '', quote: '', page: null },
        party_b: { value: 'N/A', quote: 'unknown', page: null },
        effective_date: { value: 'not found', quote: null, page: null },
        governing_law: { value: 'Unknown', quote: 'null', page: 3 },
      },
      FIELDS,
    );
    expect(res.ok).toBe(true);
    for (const key of FIELDS) {
      expect(res.data[key]).toEqual({ value: null, quote: null, page: null });
    }
  });

  it('keeps a value whose quote is missing, and nulls the quote', () => {
    const res = validateAnswer({ party_a: { value: 'IBC, Inc.', quote: null, page: 2 } }, FIELDS);
    expect(res.data.party_a).toEqual({ value: 'IBC, Inc.', quote: null, page: null });
    expect(res.issues.join(' ')).toContain('no verbatim quote');
    expect(res.ok).toBe(true);
  });

  it('coerces numbers and booleans to strings', () => {
    const res = validateAnswer(
      {
        party_a: { value: 2024, quote: 'the year 2024', page: '3' },
        party_b: { value: true, quote: 'IBC form', page: 1 },
      },
      ['party_a', 'party_b'],
    );
    expect(res.data.party_a?.value).toBe('2024');
    expect(res.data.party_a?.page).toBe(3);
    expect(res.data.party_b?.value).toBe('Yes');
  });

  it('accepts a bare string in place of the answer object', () => {
    const res = validateAnswer({ party_a: 'Acme Corp' }, FIELDS);
    expect(res.data.party_a).toEqual({ value: 'Acme Corp', quote: null, page: null });
  });

  it('drops unknown keys silently', () => {
    const res = validateAnswer(
      { party_a: { value: 'IBC', quote: 'IBC', page: 1 }, invented_field: { value: 'x' } },
      ['party_a'],
    );
    expect(Object.keys(res.data)).toEqual(['party_a']);
  });

  it('reads a nested fields wrapper', () => {
    const res = validateAnswer(
      { doc_type: 'nda', fields: { party_a: { value: 'IBC', quote: 'IBC', page: 1 } } },
      ['party_a'],
    );
    expect(res.data.party_a?.value).toBe('IBC');
  });

  it('fails when no requested key is present', () => {
    const res = validateAnswer({ something_else: 1 }, FIELDS);
    expect(res.ok).toBe(false);
    expect(res.data).toEqual({});
  });

  it('never throws on hostile input', () => {
    for (const input of [null, undefined, 42, 'nope', [], { party_a: [] }]) {
      expect(() => validateAnswer(input, FIELDS)).not.toThrow();
    }
  });

  it('tolerates alternate key spellings for quote and page', () => {
    const res = validateAnswer(
      { party_a: { value: 'IBC', evidence: 'IBC, Inc.', page_number: 'page 4' } },
      ['party_a'],
    );
    expect(res.data.party_a).toEqual({ value: 'IBC', quote: 'IBC, Inc.', page: 4 });
  });
});

describe('extractDocType', () => {
  it('reads the exact values', () => {
    expect(extractDocType({ doc_type: 'nda' })).toBe('nda');
    expect(extractDocType({ docType: 'evaluation' })).toBe('evaluation');
    expect(extractDocType({ document_type: 'other' })).toBe('other');
  });

  it('maps common phrasings', () => {
    expect(extractDocType({ doc_type: 'Mutual Non-Disclosure Agreement' })).toBe('nda');
    expect(extractDocType({ doc_type: 'Evaluation Agmt' })).toBe('evaluation');
  });

  it('returns null when it cannot tell', () => {
    expect(extractDocType({ doc_type: 'purchase order' })).toBeNull();
    expect(extractDocType({})).toBeNull();
    expect(extractDocType('nda')).toBeNull();
  });
});

describe('countVerifiableQuotes', () => {
  const text = 'This Agreement is effective as of March 14, 2024 between IBC and Northwind.';

  it('counts only quotes that appear in the source', () => {
    const found = countVerifiableQuotes(text, {
      party_a: { value: 'IBC', quote: 'effective as of March 14, 2024', page: 1 },
      party_b: { value: 'Northwind', quote: 'a clause that is not in the document', page: 1 },
    });
    expect(found).toBe(1);
  });

  it('ignores answers with no value or no quote', () => {
    expect(
      countVerifiableQuotes(text, {
        party_a: { value: null, quote: 'effective as of March 14, 2024', page: 1 },
        party_b: { value: 'Northwind', quote: null, page: null },
      }),
    ).toBe(0);
  });
});
