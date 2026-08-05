/**
 * The deterministic pass. Pure functions over page text, no model, no I/O.
 *
 * The standing bias here is precision over recall: a wrong rule is worse than no
 * rule, because a green dot tells the reviewer not to look. Every extractor below
 * either matches an unambiguous pattern or emits nothing and lets the model — whose
 * answers arrive amber and get citation-checked — have the field.
 *
 * Every hit carries the exact substring it matched and the page it was on.
 */

import type { FieldKey } from '@/lib/fields';
import { parseDate, parseDateIso } from '@/lib/util/dates';
import { isIbcParty } from '@/lib/util/normalize';
import { DATE_RE, DURATION_RE, collapse, parseDurationParts } from './verify';

export interface RuleHit {
  value: string;
  /** Verbatim substring of the page it was found on. */
  quote: string;
  /** 1-indexed. */
  page: number;
  method: 'rule';
}

export type RuleHits = Partial<Record<FieldKey, RuleHit>>;

/* ─────────────────────────────── helpers ─────────────────────────────── */

function hit(value: string, quote: string, page: number): RuleHit {
  return { value: collapse(value), quote, page, method: 'rule' };
}

/**
 * The sentence a match sits in.
 *
 * A single newline is NOT a boundary: PDF text breaks every printed line, and cutting
 * there would strip the very wording that says which clock a duration belongs to.
 * Blank lines and numbered headings are boundaries, because those are clause breaks.
 */
function sentenceAround(text: string, index: number, length: number, span = 260): string {
  const from = Math.max(0, index - span);
  const to = Math.min(text.length, index + length + span);

  const before = text.slice(from, index);
  const boundary = /[.;:](?=\s)|\n\s*\n|\n(?=\s*\d+[.)]\s)/g;
  let start = from;
  let b: RegExpExecArray | null = boundary.exec(before);
  while (b !== null) {
    start = from + b.index + b[0].length;
    b = boundary.exec(before);
  }

  const after = text.slice(index + length, to);
  const endMatch = /[.;](?=\s|$)|\n\s*\n/.exec(after);
  const end = endMatch ? index + length + endMatch.index + 1 : to;
  return text.slice(start, end).trim();
}

/**
 * Legal suffixes, split by whether the trailing period belongs to the name.
 * "Acme Ltd." keeps its period; "Northwind Cells GmbH." borrowed the sentence's, and
 * storing that period would put a different name in the repository than the one on
 * the page.
 */
const COMPANY_SUFFIX =
  /\b(?:(?:Inc|Ltd|Corp|Co|LP|LLP|Pte|Pty|L\.L\.C|B\.V|N\.V|K\.K|S\.A|S\.p\.A|Sdn)\b\.?|(?:Incorporated|Limited|LLC|PLC|GmbH|AG|SAS|SARL|BV|NV|AB|AS|Oy|Corporation|Company|KK|SpA|ApS|SA)\b)/;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Domains that belong to IBC. Used only to *prefer* the counterparty's notice
 * address; if this list is incomplete the rule still emits a real email.
 */
const IBC_DOMAIN_RE = /@(?:[A-Za-z0-9-]+\.)*(?:internationalbattery|intlbattery|ibcbattery)\./i;

/* ──────────────────────────── contract_name ──────────────────────────── */

const TITLE_KEYWORD = /NON-?DISCLOSURE|NONDISCLOSURE|CONFIDENTIALITY|EVALUATION|MUTUAL/i;
/** Without this a clause heading such as "2. Confidentiality" wins over the title. */
const TITLE_NOUN = /\b(?:AGREEMENT|NDA)\b/i;
const NUMBERED_HEADING = /^\s*(?:\d+[.)]|[IVXLC]+\.|ARTICLE\b|SECTION\b|EXHIBIT\b|SCHEDULE\b)/i;
/** Titles live at the very top of page 1. */
const TITLE_SCAN_LINES = 25;

function ruleContractName(pagesText: string[]): RuleHit | null {
  const page1 = pagesText[0];
  if (!page1) return null;
  const lines = page1.split('\n');
  let seen = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (++seen > TITLE_SCAN_LINES) break;
    if (trimmed.length > 80) continue;
    if (trimmed.endsWith('.') || trimmed.endsWith(',')) continue;
    if (NUMBERED_HEADING.test(trimmed)) continue;
    if (!TITLE_KEYWORD.test(trimmed) || !TITLE_NOUN.test(trimmed)) continue;
    const isAllCaps = trimmed === trimmed.toUpperCase();
    const isTitleCase = /^(?:[A-Z][A-Za-z-]*)(?:\s+(?:of|and|the|for|[A-Z][A-Za-z-]*))*$/.test(
      trimmed,
    );
    if (!isAllCaps && !isTitleCase) continue;
    return hit(trimmed, trimmed, 1);
  }
  return null;
}

/* ──────────────────────────── effective_date ─────────────────────────── */

const EFFECTIVE_TRIGGER =
  /(?:effective\s+(?:as\s+of|on|from)|dated\s+as\s+of|made\s+(?:and\s+entered\s+into\s+)?as\s+of|entered\s+into\s+as\s+of|Effective\s+Date\s*[:\u2013\u2014-]?)\s*(?:this\s+)?/gi;

/** How far into page 1 a bare date is still the agreement's own date. */
const PREAMBLE_CHARS = 800;

function ruleEffectiveDate(pagesText: string[]): RuleHit | null {
  for (let i = 0; i < pagesText.length; i++) {
    const text = pagesText[i];
    if (!text) continue;
    const trigger = new RegExp(EFFECTIVE_TRIGGER.source, 'gi');
    let m: RegExpExecArray | null = trigger.exec(text);
    while (m !== null) {
      const after = collapse(text.slice(m.index + m[0].length, m.index + m[0].length + 60));
      const dateMatch = new RegExp(DATE_RE.source, 'i').exec(after);
      // The date must sit right after the trigger, not two clauses later.
      if (dateMatch && dateMatch.index <= 12) {
        const parsed = parseDate(dateMatch[0]);
        // An ambiguous numeric form (03/04/2024) is a coin flip. Emit nothing and let
        // the model answer, so the field lands amber and a human actually looks at it.
        if (parsed && parsed.iso && !parsed.ambiguous) {
          const dated = after.slice(0, dateMatch.index + dateMatch[0].length);
          const quote = `${collapse(m[0])} ${dated}`;
          return hit(parsed.iso, exactSpan(text, quote) ?? quote, i + 1);
        }
      }
      m = trigger.exec(text);
    }
  }

  const page1 = pagesText[0];
  if (page1) {
    const head = page1.slice(0, PREAMBLE_CHARS);
    const first = new RegExp(DATE_RE.source, 'i').exec(collapse(head));
    if (first) {
      const parsed = parseDate(first[0]);
      if (parsed && parsed.iso && !parsed.ambiguous) {
        return hit(parsed.iso, exactSpan(page1, first[0]) ?? first[0], 1);
      }
    }
  }
  return null;
}

/**
 * Recover the verbatim span for a whitespace-collapsed match, because the quote we
 * store has to exist in the page byte-for-byte.
 */
function exactSpan(text: string, collapsed: string): string | null {
  const direct = text.indexOf(collapsed);
  if (direct !== -1) return collapsed;
  // \s* rather than \s+: a trigger such as "Effective Date:March 1, 2024" has no
  // space where the collapsed form implies one.
  const pattern = collapsed
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  const m = new RegExp(pattern).exec(text);
  return m ? m[0] : null;
}

/* ─────────────────────── term / confidentiality_term ─────────────────── */

/** Wording that can only be describing the life of the agreement itself. */
const TERM_CONTEXT =
  /\bterm\s+of\s+this\s+agreement\b|\bthe\s+term\s+hereof\b|\bthis\s+agreement\s+(?:shall|will|is|does)\s+(?:remain|continue|be)\s+(?:in\s+)?(?:full\s+)?(?:force|effect|effective)\b|\bshall\s+(?:remain|continue)\s+in\s+(?:full\s+)?force\s+and\s+effect\s+for\b|\bthis\s+agreement\s+(?:shall|will)\s+(?:expire|terminate)\s+(?:on|after|upon\s+the\s+expiration)\b/i;

/** Wording that can only be describing the confidentiality clock. */
const CONF_CONTEXT =
  /\bsurviv(?:e|es|al|ing)\b|\bconfidentiality\s+obligations?\b|\bobligations?\s+of\s+confidentiality\b|\bheld?\s+in\s+confidence\s+for\b|\bkeep\s+[^.;]{0,60}confidential\s+for\b|\bduty\s+of\s+confidentiality\b/i;

interface DurationCandidate {
  value: string;
  quote: string;
  page: number;
}

function collectDurations(pagesText: string[]): {
  term: DurationCandidate[];
  conf: DurationCandidate[];
} {
  const term: DurationCandidate[] = [];
  const conf: DurationCandidate[] = [];

  for (let i = 0; i < pagesText.length; i++) {
    const text = pagesText[i];
    if (!text) continue;
    const re = new RegExp(DURATION_RE.source, 'gi');
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      const parts = parseDurationParts(m[0]);
      if (parts && !isNoticePeriod(text, m.index, m[0].length)) {
        const sentence = sentenceAround(text, m.index, m[0].length);
        const isTerm = TERM_CONTEXT.test(sentence);
        const isConf = CONF_CONTEXT.test(sentence);
        // Both or neither means the sentence does not say which clock this is.
        if (isTerm !== isConf) {
          const candidate = {
            value: `${parts.n} ${parts.unit}${parts.n === 1 ? '' : 's'}`,
            quote: sentence,
            page: i + 1,
          };
          (isTerm ? term : conf).push(candidate);
        }
      }
      m = re.exec(text);
    }
  }
  return { term, conf };
}

/**
 * A termination-notice period is not a term.
 *
 * "The term of this Agreement is twenty-four (24) months from the Effective Date,
 * unless terminated earlier by either party on thirty (30) days written notice" puts
 * two durations in one sentence under term-of-agreement wording. Both used to become
 * term candidates, they disagreed, and the rule abstained on a document that states
 * its term perfectly clearly. The notice period is identifiable from the words
 * immediately after it, so exclude it and the remaining candidate stands alone.
 */
const NOTICE_PERIOD_AFTER_RE =
  /^\s*(?:'|’)?\s*(?:written|prior|advance|calendar|business)?\s*(?:written\s+)?notice\b|^\s*(?:notice|notification)\b/i;
const NOTICE_PERIOD_BEFORE_RE = /\b(?:on|upon|with|giving|give|provide|providing)\s*$/i;

function isNoticePeriod(text: string, index: number, length: number): boolean {
  const after = text.slice(index + length, index + length + 40);
  const before = collapse(text.slice(Math.max(0, index - 30), index));
  return NOTICE_PERIOD_AFTER_RE.test(after) && NOTICE_PERIOD_BEFORE_RE.test(before);
}

/** One agreed answer, or nothing. Two different durations for one clock is a conflict. */
function soleCandidate(candidates: DurationCandidate[]): RuleHit | null {
  if (candidates.length === 0) return null;
  const first = candidates[0];
  if (!first) return null;
  if (candidates.some((c) => c.value !== first.value)) return null;
  return hit(first.value, first.quote, first.page);
}

/* ─────────────────────────── governing_law ───────────────────────────── */

const GOVERNING_LAW_RE =
  /(?:governed\s+by(?:\s+and\s+construed\s+in\s+accordance\s+with)?|construed\s+in\s+accordance\s+with|subject\s+to)\s+the\s+laws?\s+of\s+(?:the\s+)?(?:State\s+of\s+|Commonwealth\s+of\s+|Province\s+of\s+|Republic\s+of\s+)?([A-Z][A-Za-z]+(?:\s+(?:and\s+|of\s+)?[A-Z][A-Za-z]+){0,3})/;

function ruleGoverningLaw(pagesText: string[]): RuleHit | null {
  for (let i = 0; i < pagesText.length; i++) {
    const text = pagesText[i];
    if (!text) continue;
    const flat = collapse(text);
    const m = GOVERNING_LAW_RE.exec(flat);
    const jurisdiction = m?.[1]?.trim();
    if (!m || !jurisdiction || jurisdiction.length > 40) continue;
    return hit(jurisdiction, exactSpan(text, m[0]) ?? m[0], i + 1);
  }
  return null;
}

/* ──────────────────────────── notice_email ───────────────────────────── */

const NOTICES_HEADING = /\bnotices?\b/gi;
/** A notices clause and its addresses are close together. */
const NOTICE_WINDOW = 1500;

/**
 * Language that DESIGNATES an address for notice, as opposed to an address that merely
 * appears nearby. Without this the rule picks up letterhead and footers.
 */
const DESIGNATING_RE =
  /\b(?:to|at|sent\s+to|delivered\s+to|addressed\s+to|by\s+e-?mail\s+to|via\s+e-?mail\s+to|email(?:ed)?\s+to)\s*:?\s*$/i;

/**
 * A notices clause that rules email OUT. Northwind says "Notice by electronic mail is
 * not effective under this Agreement" and then prints a general enquiries address in
 * the footer -- the rule used to answer with the footer, which is a confidently wrong
 * value in the reviewer's face. The correct answer is null.
 */
const EMAIL_DISCLAIMED_RE =
  /\b(?:notice|notices)\b[^.]{0,120}?\b(?:e-?mail|electronic\s+mail)\b[^.]{0,60}?\b(?:not|shall\s+not|is\s+not|are\s+not)\b|\b(?:not|no)\s+(?:be\s+)?(?:effective|valid|permitted|accepted)\b[^.]{0,40}?\be-?mail\b/i;

/** Addresses that are structurally not notice addresses, whatever their position. */
const NON_NOTICE_CONTEXT_RE =
  /\b(?:general\s+enquir|general\s+inquir|www\.|website|support|sales|info@|careers|press|media|unsubscribe)/i;

function ruleNoticeEmail(pagesText: string[]): RuleHit | null {
  const candidates: { email: string; quote: string; page: number; isIbc: boolean }[] = [];

  for (let i = 0; i < pagesText.length; i++) {
    const text = pagesText[i];
    if (!text) continue;
    const headings = new RegExp(NOTICES_HEADING.source, 'gi');
    let h: RegExpExecArray | null = headings.exec(text);
    while (h !== null) {
      const from = h.index;
      const window = text.slice(from, from + NOTICE_WINDOW);

      // If this clause disclaims email entirely, no address in it is designated.
      if (EMAIL_DISCLAIMED_RE.test(collapse(window))) {
        h = headings.exec(text);
        continue;
      }

      const emails = new RegExp(EMAIL_RE.source, 'g');
      let e: RegExpExecArray | null = emails.exec(window);
      while (e !== null) {
        const email = e[0];
        const lead = collapse(window.slice(Math.max(0, e.index - 40), e.index));
        const around = collapse(
          window.slice(Math.max(0, e.index - 80), e.index + email.length + 40),
        );
        // Require designating language immediately before the address, and reject
        // anything sitting in obvious letterhead or footer context.
        if (DESIGNATING_RE.test(lead) && !NON_NOTICE_CONTEXT_RE.test(around)) {
          candidates.push({
            email,
            quote: sentenceAround(text, from + e.index, email.length),
            page: i + 1,
            isIbc: IBC_DOMAIN_RE.test(email),
          });
        }
        e = emails.exec(window);
      }
      h = headings.exec(text);
    }
  }

  const preferred = candidates.find((c) => !c.isIbc) ?? candidates[0];
  if (!preferred) return null;
  return hit(preferred.email, preferred.quote, preferred.page);
}

/* ───────────────────────── party_a / party_b ─────────────────────────── */

/** The preamble is the first thing on page 1; anything later is a cross-reference. */
const PREAMBLE_SCAN_CHARS = 2500;
const PARTY_WINDOW = 400;
const SECOND_PARTY_WINDOW = 220;
const MAX_PARTY_NAME = 90;

interface PartyPair {
  first: string;
  second: string;
  quote: string;
  page: number;
}

function findPartyPair(pagesText: string[]): PartyPair | null {
  const page1 = pagesText[0];
  if (!page1) return null;
  const flat = collapse(page1.slice(0, PREAMBLE_SCAN_CHARS));
  const between = /\bbetween\b/i.exec(flat);
  if (!between) return null;

  const start = between.index + between[0].length;
  const window = flat.slice(start, start + PARTY_WINDOW);

  const endA = nameEnd(window);
  if (endA === null) return null;
  const rawA = window.slice(0, endA);
  const nameA = cleanPartyName(rawA);
  if (!nameA) return null;

  const rest = window.slice(rawA.length);
  const conjunction = /\band\b/i.exec(rest);
  if (!conjunction) return null;

  const secondWindow = rest.slice(
    conjunction.index + conjunction[0].length,
    conjunction.index + conjunction[0].length + SECOND_PARTY_WINDOW,
  );
  const endB = nameEnd(secondWindow);
  // A suffix a long way into the second window belongs to an address, not a name.
  if (endB === null || endB > 120) return null;
  const rawB = secondWindow.slice(0, endB);
  const nameB = cleanPartyName(rawB);
  if (!nameB) return null;

  const spanEnd = rawA.length + conjunction.index + conjunction[0].length + rawB.length;
  const collapsedQuote = `${between[0]}${window.slice(0, spanEnd)}`;
  return {
    first: nameA,
    second: nameB,
    quote: exactSpan(page1, collapsedQuote) ?? collapsedQuote,
    page: 1,
  };
}

/** Chained suffixes: "Company, Inc." and "Co., Ltd." are one name, not two. */
const CHAINED_SUFFIX = new RegExp(`^\\s*,?\\s*${COMPANY_SUFFIX.source}`, 'i');

/**
 * Where a party name ends: at its last consecutive legal suffix. Stopping at the
 * first one would file "International Battery Company, Inc." as "...Company".
 */
function nameEnd(text: string): number | null {
  const first = COMPANY_SUFFIX.exec(text);
  if (!first) return null;
  let end = first.index + first[0].length;
  for (;;) {
    const more = CHAINED_SUFFIX.exec(text.slice(end));
    if (!more || more[0].length === 0) return end;
    end += more[0].length;
  }
}

/**
 * A name that swallowed an "and" is two names, and a name longer than a line is a
 * sentence. Both mean the preamble is not the shape this rule understands.
 */
function cleanPartyName(raw: string): string | null {
  const name = collapse(raw)
    // A leading ':' or '-' survives the "between" match when the preamble is laid out
    // as "Between: X" / "And: Y" rather than as prose.
    .replace(/^[\s:;,\-\u2013\u2014]+/, '')
    .replace(/^(?:the\s+)?["'\u201C\u2018(]*/i, '')
    .replace(/^(?:among|between|and)\s+/i, '')
    .replace(/^[\s:;,\-\u2013\u2014]+/, '')
    .trim();
  if (name.length < 3 || name.length > MAX_PARTY_NAME) return null;
  if (/\band\b/i.test(name.replace(COMPANY_SUFFIX, ''))) return null;
  if (!/[A-Za-z]{2}/.test(name)) return null;
  return name;
}

/**
 * IBC is always Party A. When neither side matches IBC we emit nothing: the pattern
 * may have found two counterparties, or an IBC entity name we do not recognise, and
 * guessing the roles would put the wrong company in the wrong column.
 */
function ruleParties(pagesText: string[]): RuleHits {
  const pair = findPartyPair(pagesText);
  if (!pair) return {};
  const firstIsIbc = isIbcParty(pair.first);
  const secondIsIbc = isIbcParty(pair.second);
  if (firstIsIbc === secondIsIbc) return {};
  const a = firstIsIbc ? pair.first : pair.second;
  const b = firstIsIbc ? pair.second : pair.first;
  return {
    party_a: hit(a, pair.quote, pair.page),
    party_b: hit(b, pair.quote, pair.page),
  };
}

/* ──────────────────────────────── entry ──────────────────────────────── */

/**
 * `pagesText[0]` is page 1. Pass the same array the model will be shown, so a rule
 * hit and a model citation always refer to identical text.
 */
export function runRules(pagesText: string[]): RuleHits {
  const hits: RuleHits = { ...ruleParties(pagesText) };

  const name = ruleContractName(pagesText);
  if (name) hits.contract_name = name;

  const effective = ruleEffectiveDate(pagesText);
  if (effective) hits.effective_date = effective;

  const { term, conf } = collectDurations(pagesText);
  const termHit = soleCandidate(term);
  if (termHit) hits.term = termHit;
  const confHit = soleCandidate(conf);
  if (confHit) hits.confidentiality_term = confHit;

  const law = ruleGoverningLaw(pagesText);
  if (law) hits.governing_law = law;

  const email = ruleNoticeEmail(pagesText);
  if (email) hits.notice_email = email;

  return hits;
}
