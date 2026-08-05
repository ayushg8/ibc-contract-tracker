/**
 * The JSON contract shared by both engines.
 *
 * The prompt builder and the parser live in the same file on purpose: they describe
 * the same object from opposite ends, and splitting them across modules is exactly
 * how the two drift apart. Change the shape here and both halves move together.
 *
 * Nothing in this file talks to a network, a process, or the filesystem, so it is
 * cheap to unit-test every hostile string a model can produce.
 */

import { z } from 'zod';
import { DOC_TYPES, FIELDS, type DocType, type FieldKey } from '../fields';
import type { ExtractionRequest, RawFieldAnswer } from './types';

/* ────────────────────────── small guards ────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ──────────────────────── output sanitising ─────────────────────── */

/**
 * ANSI colour/cursor sequences, OSC hyperlinks, and the C1 CSI form. A CLI that
 * thinks it owns a terminal will happily wrap our JSON in escape codes.
 */
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|[\dA-Za-z])/g;

/** Lines a package manager or updater injects into stdout, never part of the answer. */
const NOISE_LINE_RE =
  /^\s*(?:npm\s+(?:notice|warn|WARN|ERR!)|yarn\s+warning|\(node:\d+\)|Update available|A new (?:version|release) of|Please (?:update|upgrade) to|Run `?npm i -g)\b.*$/gm;

/** Zero-width and BOM characters that survive copy-paste and break JSON.parse. */
const INVISIBLE_RE = /[\uFEFF\u200B-\u200D\u2060]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Everything we do before we even look for JSON. Deliberately conservative: it
 * only removes bytes that cannot be part of a JSON document.
 */
export function sanitiseModelOutput(text: string): string {
  return stripAnsi(text)
    .replace(INVISIBLE_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(NOISE_LINE_RE, '');
}

/* ───────────────────────── JSON extraction ─────────────────────── */

/** Fields a CLI wrapper commonly nests the model's actual text inside. */
const ENVELOPE_TEXT_KEYS = ['result', 'text', 'content', 'response', 'output', 'stdout', 'message'];

function tryParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Walk from `start` (which must be a `{`) to its matching `}`, honouring string
 * literals and backslash escapes. A naive depth counter breaks the moment a
 * contract clause contains a brace or a quote, which they do.
 *
 * Returns the index of the closing brace, or -1 if the object never closes
 * (truncated output — we refuse to guess at the missing tail).
 */
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const end = scanBalanced(text, i);
    if (end === -1) continue;
    out.push(text.slice(i, end + 1));
    i = end;
  }
  return out;
}

/** Fenced code blocks, ```json first then any fence. */
function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const lang = (m[1] ?? '').toLowerCase();
    const body = m[2] ?? '';
    if (lang === 'json' || lang === '') out.unshift(body);
    else out.push(body);
    m = re.exec(text);
  }
  return out;
}

function isSmartDouble(ch: string): boolean {
  return ch === '\u201C' || ch === '\u201D' || ch === '\u201E' || ch === '\u2033';
}

/**
 * Last-resort repair. Runs only after the honest strategies fail, because each
 * substitution can corrupt a legitimate value (a smart quote inside a quoted
 * clause, for instance) and a corrupted value is worse than no value.
 */
export function repairJsonish(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  // Which delimiter opened the current string. A string opened with a curly quote
  // must be closed by one, or the whole document runs on to the end of the buffer.
  let openedWithSmart = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (openedWithSmart) {
        if (isSmartDouble(ch)) {
          out += '"';
          inString = false;
          continue;
        }
        // A straight quote inside a curly-quoted string would end it early.
        out += ch === '"' ? '\\"' : ch;
        continue;
      }
      out += ch;
      if (ch === '"') inString = false;
      continue;
    }

    // Outside a string: normalise typographic quotes into real delimiters.
    if (isSmartDouble(ch)) {
      out += '"';
      inString = true;
      openedWithSmart = true;
      continue;
    }
    if (ch === '\u2018' || ch === '\u2019') {
      out += "'";
      continue;
    }
    if (ch === '\u00A0') {
      out += ' ';
      continue;
    }
    // Line comment.
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    // Block comment.
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = true;
      openedWithSmart = false;
      continue;
    }
    out += ch;
  }

  // Trailing commas, now that comments and fancy quotes are gone. Safe to do with
  // a regex because a real comma inside a string is still inside a string, and the
  // pass above preserved those byte-for-byte.
  return stripTrailingCommas(out);
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let pendingComma = -1; // index in `out` of a comma we may still drop

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      pendingComma = -1;
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      pendingComma = out.length;
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (pendingComma >= 0) {
        out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
        pendingComma = -1;
      }
      out += ch;
      continue;
    }
    if (!/\s/.test(ch)) pendingComma = -1;
    out += ch;
  }
  return out;
}

/**
 * A wrapper object is not the answer. If the parsed object has no field-shaped
 * keys but does carry a string payload, dig into the payload.
 */
function unwrapEnvelope(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (depth > 4) return null;

  if (looksLikeAnswer(value)) return value;

  for (const key of ENVELOPE_TEXT_KEYS) {
    const inner = value[key];
    if (typeof inner === 'string' && inner.trim() !== '') {
      const found = extractJson(inner);
      if (found) return found;
    } else if (isRecord(inner)) {
      const found = unwrapEnvelope(inner, depth + 1);
      if (found) return found;
    }
  }
  // No payload to dig into — the object itself is the best we have.
  return value;
}

const ANSWER_HINT_KEYS = new Set<string>([
  ...Object.keys(FIELDS),
  'fields',
  'doc_type',
  'docType',
  'document_type',
]);

function looksLikeAnswer(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((k) => ANSWER_HINT_KEYS.has(k));
}

/**
 * True when the object carries at least one tracker field key (or a `fields`
 * wrapper). The engines use this to tell an answer from a status envelope before
 * they decide whether a run succeeded.
 */
export function hasAnswerKeys(value: Record<string, unknown>): boolean {
  return looksLikeAnswer(value);
}

/**
 * Pull the answer object out of whatever the engine actually said.
 *
 * Strategy, in order: parse the whole thing; parse each fenced block; parse each
 * balanced-brace run; then repeat all three on a repaired copy. Returns null when
 * every strategy fails — including truncated output, where salvaging a partial
 * object would mean inventing the tail.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.trim() === '') return null;

  const clean = sanitiseModelOutput(text);
  const direct = attemptAll(clean);
  if (direct) return direct;

  const repaired = repairJsonish(clean);
  if (repaired !== clean) {
    const salvaged = attemptAll(repaired);
    if (salvaged) return salvaged;
  }
  return null;
}

function attemptAll(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  const whole = tryParse(trimmed);
  if (whole !== undefined) {
    const unwrapped = unwrapEnvelope(whole);
    if (unwrapped) return unwrapped;
  }

  for (const block of fencedBlocks(text)) {
    const parsed = tryParse(block.trim());
    if (parsed === undefined) continue;
    const unwrapped = unwrapEnvelope(parsed);
    if (unwrapped) return unwrapped;
  }

  // Prefer the object that actually looks like an answer over the first one found:
  // prose sometimes contains a small illustrative object before the real payload.
  const candidates = balancedObjects(text);
  let fallback: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (!isRecord(parsed)) continue;
    if (looksLikeAnswer(parsed)) return parsed;
    const unwrapped = unwrapEnvelope(parsed);
    if (unwrapped && looksLikeAnswer(unwrapped)) return unwrapped;
    fallback ??= unwrapped ?? parsed;
  }
  return fallback;
}

/* ─────────────────────────── validation ────────────────────────── */

/** Strings that mean "nothing here", however the model chose to phrase it. */
const NULLISH_TOKENS = new Set<string>([
  '',
  '-',
  '--',
  'n/a',
  'n.a.',
  'na',
  'nil',
  'none',
  'null',
  'not applicable',
  'not available',
  'not found',
  'not in document',
  'not mentioned',
  'not present',
  'not provided',
  'not specified',
  'not stated',
  'tbd',
  'unavailable',
  'undefined',
  'unknown',
  'unspecified',
]);

const VALUE_KEYS = ['value', 'text', 'answer'];
const QUOTE_KEYS = ['quote', 'evidence', 'source', 'snippet', 'excerpt'];
const PAGE_KEYS = ['page', 'page_number', 'pageNumber', 'pageNo', 'page_no'];

function firstPresent(rec: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in rec) return rec[key];
  }
  return undefined;
}

function coerceText(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'boolean') return input ? 'Yes' : 'No';
  if (typeof input === 'number') return Number.isFinite(input) ? String(input) : null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (NULLISH_TOKENS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function coercePage(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 1 ? Math.floor(input) : null;
  }
  if (typeof input === 'string') {
    const m = /\d+/.exec(input);
    if (!m) return null;
    const n = Number.parseInt(m[0], 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const page = coercePage(item);
      if (page !== null) return page;
    }
  }
  return null;
}

const EMPTY_ANSWER = { value: null, quote: null, page: null } as const;

/**
 * Normalise anything the model put under a field key into `{value, quote, page}`.
 * A bare string is treated as a value with no citation — the verify step will
 * demote it, which is the correct outcome, not a parse failure.
 */
function coerceAnswerShape(input: unknown): unknown {
  if (input === null || input === undefined) return { ...EMPTY_ANSWER };

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return { value: coerceText(input), quote: null, page: null };
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (item === null || item === undefined) continue;
      return coerceAnswerShape(item);
    }
    return { ...EMPTY_ANSWER };
  }

  if (!isRecord(input)) return { ...EMPTY_ANSWER };

  const value = coerceText(firstPresent(input, VALUE_KEYS));
  const quote = coerceText(firstPresent(input, QUOTE_KEYS));
  const page = coercePage(firstPresent(input, PAGE_KEYS));

  // Value present, citation missing: keep the value and null the quote. The verify
  // step demotes an uncited value; silently dropping it would hide a real answer.
  if (value === null) return { value: null, quote: null, page: null };
  // A page number with no quote cites nothing, so it goes with the quote.
  return { value, quote, page: quote === null ? null : page };
}

const answerSchema = z.preprocess(
  coerceAnswerShape,
  z.object({
    value: z.string().nullable(),
    quote: z.string().nullable(),
    page: z.number().int().nullable(),
  }),
);

export interface ValidationResult {
  /** False when the object is unusable and a repair round is warranted. */
  ok: boolean;
  data: Partial<Record<FieldKey, RawFieldAnswer>>;
  /** Human-readable, safe to append to a repair prompt. Never contains a key. */
  issues: string[];
}

/**
 * Coerce and validate the model's answer. Never throws; unknown keys are dropped
 * silently because a model inventing a field is not the reviewer's problem.
 */
export function validateAnswer(
  obj: unknown,
  fieldsToFill: readonly FieldKey[],
): ValidationResult {
  const issues: string[] = [];
  const data: Partial<Record<FieldKey, RawFieldAnswer>> = {};

  if (!isRecord(obj)) {
    return { ok: false, data, issues: ['Response was not a JSON object.'] };
  }

  // Accept both `{party_a: ...}` and `{fields: {party_a: ...}}`.
  const nested = obj['fields'];
  const source: Record<string, unknown> = isRecord(nested) ? { ...nested } : obj;

  let matched = 0;
  for (const key of fieldsToFill) {
    if (!(key in source)) continue;
    matched += 1;
    const parsed = answerSchema.safeParse(source[key]);
    if (!parsed.success) {
      issues.push(`Field "${key}" could not be read as {value, quote, page}.`);
      continue;
    }
    const answer: RawFieldAnswer = parsed.data;
    if (answer.value !== null && answer.quote === null) {
      issues.push(`Field "${key}" has a value but no verbatim quote.`);
    }
    data[key] = answer;
  }

  if (matched === 0) {
    issues.push(
      `None of the ${fieldsToFill.length} requested field keys were present in the response.`,
    );
  } else {
    const missing = fieldsToFill.filter((k) => !(k in source));
    if (missing.length > 0) {
      issues.push(`Missing keys: ${missing.join(', ')}.`);
    }
  }

  return { ok: matched > 0, data, issues };
}

const DOC_TYPE_KEYS = ['doc_type', 'docType', 'document_type', 'documentType', 'type'];

/** The model's read on the document type. Rules may override it later. */
export function extractDocType(obj: unknown): DocType | null {
  if (!isRecord(obj)) return null;
  const raw = firstPresent(obj, DOC_TYPE_KEYS);
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');

  for (const candidate of DOC_TYPES) {
    if (norm === candidate) return candidate;
  }
  if (norm.includes('nda') || norm.includes('nondisclosure') || norm.includes('confidentiality')) {
    return 'nda';
  }
  if (norm.includes('eval')) return 'evaluation';
  if (norm === 'other') return 'other';
  return null;
}

/* ──────────────────────── schema for the API ───────────────────── */

/**
 * JSON Schema for the API engine's structured outputs. Every property is required
 * and `additionalProperties` is false, which is what makes the shape a guarantee
 * rather than a request.
 */
export function buildAnswerJsonSchema(
  fieldsToFill: readonly FieldKey[],
): Record<string, unknown> {
  const nullableString = {
    anyOf: [{ type: 'string' }, { type: 'null' }],
  };
  const nullableInt = {
    anyOf: [{ type: 'integer' }, { type: 'null' }],
  };

  const properties: Record<string, unknown> = {};
  for (const key of fieldsToFill) {
    properties[key] = {
      type: 'object',
      description: FIELDS[key].prompt,
      properties: {
        value: nullableString,
        quote: nullableString,
        page: nullableInt,
      },
      required: ['value', 'quote', 'page'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {
      doc_type: {
        anyOf: [{ type: 'string', enum: [...DOC_TYPES] }, { type: 'null' }],
        description: 'Your read on the document type.',
      },
      fields: {
        type: 'object',
        properties,
        required: [...fieldsToFill],
        additionalProperties: false,
      },
    },
    required: ['doc_type', 'fields'],
    additionalProperties: false,
  };
}

/* ──────────────────────────── the prompt ───────────────────────── */

const SYSTEM_RULES = [
  'You are reading a signed commercial agreement and filling a contract tracker.',
  'You have exactly one job: report what the document says, with the verbatim text you read it from.',
  '',
  'Rules, in order of importance:',
  '1. Every non-null value MUST be accompanied by a "quote" copied character-for-character',
  '   from the document. Not paraphrased, not tidied, not re-punctuated.',
  '2. If a field is not stated in the document, return null for value, quote and page.',
  '   A null is expected and useful. A guess is a defect.',
  '3. Never infer, calculate, or combine. Do not compute dates. Do not translate.',
  '4. "page" is the 1-indexed page the quote appears on, read from the page markers',
  '   in the text. If you cannot tell, return null for page but keep the quote.',
  '5. Reply with a single JSON object and nothing else. No prose, no code fence,',
  '   no commentary before or after.',
].join('\n');

function fieldSpecLines(fieldsToFill: readonly FieldKey[]): string {
  return fieldsToFill
    .map((key) => `- "${key}" (${FIELDS[key].label}): ${FIELDS[key].prompt}`)
    .join('\n');
}

function shapeExample(fieldsToFill: readonly FieldKey[]): string {
  const sample = fieldsToFill[0] ?? 'party_a';
  return [
    '{',
    '  "doc_type": "nda" | "evaluation" | "other" | null,',
    '  "fields": {',
    `    "${sample}": { "value": "...", "quote": "...", "page": 1 },`,
    '    ...one entry for every requested key...',
    '  }',
    '}',
  ].join('\n');
}

/**
 * The full prompt, identical on both engines so a document read on the API and on
 * the CLI differs only by the model's own judgement, never by the instructions.
 */
export function buildExtractionPrompt(req: ExtractionRequest): string {
  const parts: string[] = [
    SYSTEM_RULES,
    '',
    `Prompt version: ${req.promptVersion}`,
    `Pages in document: ${req.pageCount}`,
    '',
    'Fields to fill:',
    fieldSpecLines(req.fieldsToFill),
    '',
    'Reply with exactly this shape:',
    shapeExample(req.fieldsToFill),
    '',
  ];

  if (req.text !== null) {
    parts.push('--- BEGIN DOCUMENT ---', req.text, '--- END DOCUMENT ---');
  } else {
    parts.push(
      'The document is supplied as page images. Read them in order; page 1 is the first image.',
    );
  }

  return parts.join('\n');
}

/** Appended verbatim on a repair round. Kept short so it cannot drown the rules. */
export function buildRepairInstruction(issues: readonly string[]): string {
  const detail = issues.length > 0 ? issues.slice(0, 6).join(' ') : 'It was not valid JSON.';
  return [
    '',
    'IMPORTANT: your previous reply could not be used.',
    detail,
    'Reply again with a single JSON object matching the shape above exactly.',
    'No prose, no code fence, no trailing commas. Use null where the document is silent.',
  ].join('\n');
}

/* ───────────────────────────── self test ───────────────────────── */

/**
 * A synthetic agreement, inline on purpose: a self test that reads a file can fail
 * for reasons that have nothing to do with the engine.
 */
export const SELF_TEST_TEXT = [
  '[page 1]',
  'MUTUAL NONDISCLOSURE AGREEMENT',
  '',
  'This Mutual Nondisclosure Agreement (this "Agreement") is entered into and effective',
  'as of March 14, 2024 (the "Effective Date") by and between International Battery',
  'Company, Inc., a Delaware corporation ("IBC"), and Northwind Cell Systems GmbH, a',
  'German limited liability company ("Counterparty").',
  '',
  '1. Term. This Agreement shall remain in force for a period of three (3) years from the',
  'Effective Date unless earlier terminated in accordance with Section 6.',
  '',
  '[page 2]',
  '7. Governing Law. This Agreement shall be governed by and construed in accordance with',
  'the laws of the State of Delaware, without regard to its conflict of laws principles.',
].join('\n');

export const SELF_TEST_FIELDS: FieldKey[] = [
  'party_a',
  'party_b',
  'effective_date',
  'governing_law',
];

function normaliseForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * How many answers carry a quote we can actually find in the source text. This is
 * the only self-test metric worth reporting: it proves the citation contract holds
 * end to end, not merely that the engine replied.
 */
export function countVerifiableQuotes(
  text: string,
  data: Partial<Record<FieldKey, RawFieldAnswer>>,
): number {
  const haystack = normaliseForMatch(text);
  let found = 0;
  for (const answer of Object.values(data)) {
    if (!answer || answer.value === null || answer.quote === null) continue;
    const needle = normaliseForMatch(answer.quote);
    if (needle.length >= 8 && haystack.includes(needle)) found += 1;
  }
  return found;
}

/** The request used by both engines' selfTest(). */
export function buildSelfTestRequest(req: {
  promptVersion: string;
  tier: ExtractionRequest['tier'];
}): ExtractionRequest {
  return {
    text: SELF_TEST_TEXT,
    images: null,
    pageCount: 2,
    fieldsToFill: [...SELF_TEST_FIELDS],
    promptVersion: req.promptVersion,
    tier: req.tier,
  };
}
