/**
 * Presentation helpers shared by the repository table, the expiring list and the
 * detail sheet. Every function here is display-only: nothing it returns is ever
 * written back to a record.
 */

import type { ContractDetail } from '@/lib/db/types';

/** Em dash, escaped so the source stays ASCII. Stands in for an absent value. */
export const MISSING = '\u2014';

/**
 * "State of Delaware" and "Delaware" are the same jurisdiction, and a column
 * holding both looks like nobody read it. Normalised for the eye only -- the
 * stored value stays exactly as the document worded it, because the export has
 * to match the contract.
 */
export function displayGoverningLaw(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed.replace(/^(?:the\s+)?(?:state|commonwealth)\s+of\s+/i, '');
  return stripped.length > 0 ? stripped : trimmed;
}

/**
 * approvedAt and editedAt are UTC instants, not calendar dates: slicing the ISO
 * string would print tomorrow's date all evening and disagree with the history
 * rows further down the sheet.
 */
export function localDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ms));
}

export function localStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

/**
 * "2 years ago" / "in 63 days" / "today".
 *
 * The unit coarsens with distance on purpose: "in 2419 days" is a number nobody
 * can picture, and precision to the day only carries meaning while the date is
 * close enough to act on.
 */
export function relativeDays(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'today';

  const n = Math.abs(days);
  const [count, unit] =
    n < 45
      ? [n, 'day']
      : n < 730
        ? [Math.round(n / 30.44), 'month']
        : [Math.round(n / 365.25), 'year'];
  const phrase = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return days < 0 ? `${phrase} ago` : `in ${phrase}`;
}

/**
 * "in perpetuity" reads as a headline once it starts with a capital. Only the
 * first character moves, so "5 years" and an all-caps quotation survive intact.
 */
export function sentenceCase(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Kept upright when a shouting title is folded back to title case. */
const ACRONYMS = new Set(['NDA', 'MNDA', 'CDA', 'IBC', 'LLC', 'LLP', 'INC', 'LP', 'USA']);

/** Never capitalised inside a title, only at the front of one. */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
]);

/**
 * Contract titles are printed in caps on the page and extracted verbatim, so the
 * stored value is usually MUTUAL NONDISCLOSURE AGREEMENT. Set at 22px on white
 * that is a headline shouting at the reader. Folded to title case for display
 * only, and only when the stored value is entirely uppercase -- a drafter who
 * cased their own title keeps it.
 */
export function displayTitle(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  if (trimmed !== trimmed.toUpperCase()) return trimmed;

  return trimmed
    .toLowerCase()
    .replace(/[a-z']+/g, (word, offset: number) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      if (offset > 0 && MINOR_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
}

export type PartyRoleTag = 'IBC' | 'Counterparty' | 'Third party';

export function partyTag(party: ContractDetail['parties'][number]): PartyRoleTag {
  if (party.isIbc) return 'IBC';
  return party.role === 'c' ? 'Third party' : 'Counterparty';
}
