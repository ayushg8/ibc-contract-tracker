/**
 * Version comparison, written out rather than pulled in.
 *
 * WHY hand-rolled: this comparison is the gate that decides whether a different
 * build of this app starts running on the CFO's Mac. A dependency that resolves
 * "1.0.0" and "1.0.0-rc.1" differently after a minor bump would change that
 * decision silently, which is the one thing an update mechanism must never do.
 * Sixty lines with a test file next to them is cheaper than that risk.
 *
 * Semantics are semver 2.0.0, restricted to what we actually publish:
 * major.minor.patch with an optional prerelease and an ignored build metadata
 * suffix. A leading "v" is accepted because tags carry one.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Empty for a normal release. Dot-separated identifiers otherwise. */
  readonly prerelease: readonly string[];
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Guard against a manifest that tries to be clever with a 400-digit major. */
const MAX_COMPONENT = 1_000_000;

export function parseVersion(input: string): SemVer | null {
  const m = PATTERN.exec(input.trim());
  if (!m) return null;

  const [major, minor, patch] = [m[1], m[2], m[3]].map((s) => Number(s ?? Number.NaN));
  if (major === undefined || minor === undefined || patch === undefined) return null;
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  if (major > MAX_COMPONENT || minor > MAX_COMPONENT || patch > MAX_COMPONENT) return null;

  const tail = m[4];
  const prerelease = tail === undefined || tail === '' ? [] : tail.split('.');
  // "1.0.0-" and "1.0.0-a..b" are not versions, and an empty identifier would
  // otherwise sort in a way nobody can predict.
  if (prerelease.some((id) => id.length === 0)) return null;

  return { major, minor, patch, prerelease };
}

export function isVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

/** Canonical spelling. The directory name on disk is derived from this. */
export function formatVersion(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${base}-${v.prerelease.join('.')}` : base;
}

const NUMERIC = /^\d+$/;

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A release outranks any prerelease of the same numbers. 1.2.0 > 1.2.0-rc.1.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    // Fewer identifiers sorts lower: rc.1 < rc.1.2.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;

    const xNum = NUMERIC.test(x);
    const yNum = NUMERIC.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always sort below alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Compare two version strings. Returns null when either side is not a version,
 * because "unknown" is not "older" -- treating it as older is how an installation
 * whose version we failed to read ends up accepting every payload offered to it.
 * Every caller has to say out loud what it does with null.
 */
export function compareStrings(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  return compare(pa, pb);
}

/** Strictly newer. Unknown on either side is not newer. */
export function isNewer(candidate: string, current: string): boolean {
  const d = compareStrings(candidate, current);
  return d !== null && d > 0;
}

/** At least as new. Unknown on either side is not satisfied. */
export function isAtLeast(candidate: string, floor: string): boolean {
  const d = compareStrings(candidate, floor);
  return d !== null && d >= 0;
}

/** Newest first. Anything unparseable sinks to the end rather than disappearing. */
export function sortVersionsDescending(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => {
    const d = compareStrings(a, b);
    if (d !== null) return -d;
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (pa === null && pb === null) return a < b ? 1 : a > b ? -1 : 0;
    return pa === null ? 1 : -1;
  });
}
