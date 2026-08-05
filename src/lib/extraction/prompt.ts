/**
 * The prompt. Pinned, versioned and byte-identical for identical inputs.
 *
 * Two properties matter more than the wording:
 *
 *  1. Determinism. No timestamps, no Object.keys ordering, no locale formatting.
 *     The same document and the same field list must produce the same bytes forever,
 *     because PROMPT_VERSION plus this text is half of the cache key.
 *  2. Guessing has to be structurally impossible, not discouraged. Every field
 *     requires a verbatim quote, and verify.ts checks every quote against the text,
 *     so an invented answer is deleted rather than shown. The prompt says so.
 *
 * Bump PROMPT_VERSION on any change to this file. That invalidates the cache on
 * purpose and is a visible event in the UI, not a silent drift.
 */

import { FIELDS, FIELD_KEYS, type FieldKey } from '@/lib/fields';
import type { ExtractionRequest } from '@/lib/providers/types';

export const PROMPT_VERSION = '1.1.0';

/** Marker the document text is wrapped in, so the model can never confuse the two. */
const DOC_OPEN = '<document>';
const DOC_CLOSE = '</document>';

/** FIELD_KEYS order, never the caller's order — the cache key depends on it. */
function orderedFields(fieldsToFill: readonly FieldKey[]): FieldKey[] {
  const wanted = new Set(fieldsToFill);
  return FIELD_KEYS.filter((k) => wanted.has(k));
}

function fieldLines(keys: readonly FieldKey[]): string {
  return keys
    .map((key) => {
      const def = FIELDS[key];
      return `- ${key} (${def.type}) - ${def.label}: ${def.prompt}`;
    })
    .join('\n');
}

function shapeExample(keys: readonly FieldKey[]): string {
  const fields = keys
    .map((key) => `    "${key}": { "value": null, "quote": null, "page": null }`)
    .join(',\n');
  return ['{', '  "docType": null,', '  "fields": {', fields, '  }', '}'].join('\n');
}

export function buildPrompt(req: ExtractionRequest): string {
  const keys = orderedFields(req.fieldsToFill);
  const scanned = req.text === null;

  const parts: string[] = [
    'You are reading one signed commercial agreement and recording facts from it into a register.',
    'You are not advising, summarising or interpreting. You are copying facts and citing where each one came from.',
    '',
    scanned
      ? `The document has ${req.pageCount} page(s), supplied as images in page order. Page 1 is the first image.`
      : `The document has ${req.pageCount} page(s). Its text follows, split by lines of the form "===== PAGE 3 =====".`,
    '',
    'FIELDS TO EXTRACT',
    fieldLines(keys),
    '',
    'RULES',
    '1. For every field, return the value, a quote, and the page number the quote is on.',
    '2. The quote must be copied VERBATIM from the document, character for character, including its punctuation and capitalisation. Do not tidy it, shorten it with an ellipsis, or re-type it from memory.',
    '3. If you cannot find a verbatim quote that supports a value, return null for that field. A null is correct and useful. A guess is a defect: every quote is checked against the document, and a value whose quote is not found is deleted.',
    '4. Never infer, never calculate, never use anything you know about these companies from outside this document.',
    '5. Do not compute any date. Report only dates that are printed in the document, exactly as printed, formatted as YYYY-MM-DD.',
    '6. Do not compute the end of a term. Report durations as the document words them.',
    '7. The term of the agreement and the confidentiality period are different clocks and usually different clauses. If only one is stated, fill only that one.',
    '8. page is 1-indexed and must be the page the quote appears on.',
    '9. docType is "nda" for a confidentiality or non-disclosure agreement, "evaluation" for an evaluation or sample-testing agreement, "other" for anything else, and null if you cannot tell.',
    '10. Return only the JSON object. No prose, no explanation, no markdown fences.',
    '',
    'OUTPUT SHAPE (exactly these keys, in this order)',
    shapeExample(keys),
  ];

  if (!scanned && req.text !== null) {
    parts.push('', DOC_OPEN, req.text, DOC_CLOSE);
  }

  return parts.join('\n');
}

/**
 * The retry path: the model returned something unusable. Show it what it sent and
 * what was wrong, and demand the same shape. Never restate the document — the
 * original prompt carries it, and repeating it doubles the bill.
 */
export function buildRepairPrompt(original: string, badOutput: string, issues: string[]): string {
  const numbered = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
  return [
    'Your previous reply could not be read as the required JSON object.',
    '',
    'WHAT WAS WRONG',
    numbered.length > 0 ? numbered : '1. The reply was not a single valid JSON object.',
    '',
    'WHAT YOU SENT',
    badOutput,
    '',
    'Send the corrected JSON object only: no prose, no explanation, no markdown fences.',
    'Do not change any value or quote that was already correct. Do not invent a value to fill a field - null is the correct answer when there is no verbatim quote.',
    '',
    'THE ORIGINAL INSTRUCTIONS AND DOCUMENT FOLLOW UNCHANGED.',
    '',
    original,
  ].join('\n');
}
