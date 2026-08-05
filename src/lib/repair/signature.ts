/**
 * The identity of a failure.
 *
 * The attempt cap is per distinct problem, which means two things have to be
 * true at once: the same failure seen twice must hash the same, and a genuinely
 * new failure must hash differently. Everything below exists to make the first
 * one true, because a signature that drifts is a cap that never bites -- and a
 * cap that never bites is an unattended agent spending her subscription forever
 * on a problem it cannot solve.
 *
 * So the text is normalised hard before it is hashed: timestamps, ids, ports,
 * temp paths, home directories, line and column numbers, durations and byte
 * counts all become placeholders. What is left is the shape of the failure.
 */

import { createHash } from 'node:crypto';

import type { FailureReport } from './types';

/** Substitutions applied in order. Each one removes a reason for the same failure to hash twice. */
const NOISE: readonly { re: RegExp; with: string }[] = [
  // ISO timestamps and clock times.
  { re: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, with: '<time>' },
  // A clock, and ONLY a clock. The lookbehind is the whole of it: without one,
  // `\d{1,2}:\d{2}` also matches the tail of `src/x.ts:84:12`, so a two-digit
  // line at a two-digit column normalises to `<time>` while a two-digit line at a
  // one-digit column falls through to the position rules and normalises to
  // `<pos>`. Same fault, two hashes, a fresh allowance of attempts every time an
  // edit above it moved the column -- which is the cap that stops an unfixable
  // problem looping forever on her subscription, defeated by an off-by-one digit.
  // A real clock is preceded by a space, a bracket or the start of a line; a
  // position is preceded by a path, a colon or another digit.
  // The space belongs to am/pm rather than to the clock: `\s*` on its own eats
  // the separator after every bare time, and a newline with it, gluing two lines
  // of a failure into one.
  { re: /(?<![\w./\\:])\d{1,2}:\d{2}(?::\d{2})?(?:[ \t]*(?:am|pm))?\b/gi, with: '<time>' },
  // Home directories and the temp dirs a workspace lives in.
  { re: /\/Users\/[^/\s:"']+/g, with: '<home>' },
  { re: /\/(?:private\/)?(?:var|tmp)\/[^\s:"']*/g, with: '<tmp>' },
  // uuids, then long hex (sha256, git oids), then any remaining hex-ish token.
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, with: '<id>' },
  { re: /\b[0-9a-f]{7,}\b/gi, with: '<hex>' },
  // Positions, which move every time a line is added above them. Both spellings:
  // `file:84:12` from a compiler, and `file(84,12)` from tsc.
  { re: /:(\d+):(\d+)\b/g, with: ':<pos>' },
  { re: /\((\d+),\s*(\d+)\)/g, with: '(<pos>)' },
  { re: /:(\d+)\b/g, with: ':<line>' },
  // Ports in the app's range, pids, durations, byte counts.
  { re: /\b4782\d\b/g, with: '<port>' },
  { re: /\bpid\s*[:=]?\s*\d+/gi, with: 'pid <n>' },
  { re: /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|minutes|mins)\b/gi, with: '<duration>' },
  { re: /\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|bytes)\b/gi, with: '<size>' },
  // Anything else numeric with three or more digits is a count, not a symptom.
  { re: /\b\d{3,}\b/g, with: '<n>' },
];

/**
 * Strip everything that can differ between two runs of the same fault.
 *
 * Exported because it is the whole of the cap's correctness, and a regression
 * here is invisible until the day it costs someone a hundred repair attempts.
 */
export function normaliseFailureText(input: string): string {
  // Substitute first, THEN lowercase. The other order silently breaks every
  // case-sensitive pattern here -- an ISO timestamp stops ending in Z and
  // /Users/ stops being /Users/ -- which leaves a signature that drifts with the
  // clock and the username, and a cap that never bites.
  let out = input;
  for (const rule of NOISE) out = out.replace(rule.re, rule.with);
  return out
    .toLowerCase()
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/**
 * The stable identity of a failure. 16 hex characters -- short enough to read
 * back over the phone, long enough that two real failures will not collide.
 *
 * The log excerpt is deliberately NOT hashed. It is the most useful thing to show
 * the model and the least stable thing on the machine: one changed line number in
 * a stack trace would mint a fresh signature and hand the agent three more
 * attempts at a problem it has already failed three times.
 */
export function failureSignature(failure: FailureReport): string {
  const material = [
    normaliseFailureText(failure.stage),
    normaliseFailureText(failure.code),
    normaliseFailureText(failure.message),
    normaliseFailureText(failure.detail ?? ''),
  ].join('\n--\n');
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

/** Attempts already spent against this signature. */
export function attemptsFor(attempts: Readonly<Record<string, number>>, signature: string): number {
  return attempts[signature] ?? 0;
}

/** Has this problem had its allowance? */
export function isExhausted(
  attempts: Readonly<Record<string, number>>,
  signature: string,
  cap: number,
): boolean {
  return attemptsFor(attempts, signature) >= cap;
}
