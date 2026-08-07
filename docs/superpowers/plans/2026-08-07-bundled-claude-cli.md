# Installing and authenticating Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The installer puts Claude Code on her Mac, and the app drives the sign-in and reports the account, plan and limit state, so that neither Terminal nor an API key is ever required of her.

**Architecture:** `install.command` gains a non-fatal step that installs Claude Code and records the absolute path it landed on. `cli.ts` consults that recorded path before its four existing probes, and replaces its credentials-file guess with a real `claude auth status --json` read that also yields account and plan. A `Sign in to Claude` action attaches to the `CLI_NOT_AUTHENTICATED` state wherever it surfaces.

**Tech Stack:** POSIX sh (installer), TypeScript strict with `noUncheckedIndexedAccess`, Next.js App Router, vitest.

## Global Constraints

- Runs from `app/`. All five gates plus doctor must pass before this is done: `npx tsc --noEmit`, `npx vitest run`, `npx next build`, `npm run eval`, `npm run eval -- --live`, `npm run doctor`.
- The live eval is 290/290 today and this work does not touch the AI path. If it drops, report the number; do not loosen anything.
- macOS only. Tests execute the packaging shell scripts rather than reading them.
- No automatic engine failover, ever. Nothing may auto-select an engine.
- Never run `claude auth logout` anywhere, in code or while testing. It would destroy the developer's own session.
- The installer step must never fail the install.
- Do not build a remaining-quota meter. Nothing reports consumption without spending a request.
- Assert against `SCHEMA_VERSION` from `@/lib/db/migrate`, never a literal schema number.
- Test migrations against a *copy* of the database; `IBC_DATA_DIR` overrides the location.

---

### Task 1: Parse `claude auth status --json`

**Files:**
- Modify: `src/lib/providers/cli.ts` (add near `parseCliVersion`, around line 366)
- Test: `tests/cli-auth-status.test.ts` (create)

**Interfaces:**
- Produces: `export type AuthStatus = { state: 'signed-in'; email: string | null; orgName: string | null; plan: string | null } | { state: 'signed-out' } | { state: 'unknown' }` and `export function parseAuthStatus(stdout: string): AuthStatus`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseAuthStatus } from '@/lib/providers/cli';

describe('parseAuthStatus', () => {
  it('reads a signed-in subscription account', () => {
    const out = JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: 'bonnie@ibcbatt.com', orgName: 'IBC', subscriptionType: 'pro',
    });
    expect(parseAuthStatus(out)).toEqual({
      state: 'signed-in', email: 'bonnie@ibcbatt.com', orgName: 'IBC', plan: 'pro',
    });
  });

  it('reads a signed-out account', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({ state: 'signed-out' });
  });

  it('tolerates a signed-in payload missing every optional field', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true }))).toEqual({
      state: 'signed-in', email: null, orgName: null, plan: null,
    });
  });

  it.each(['', 'not json', '{}', 'null', '[]', '{"loggedIn":"yes"}'])(
    'refuses to guess from %j', (out) => {
      expect(parseAuthStatus(out)).toEqual({ state: 'unknown' });
    },
  );

  it('ignores a banner printed before the JSON', () => {
    const out = `Welcome!\n${JSON.stringify({ loggedIn: true, subscriptionType: 'max' })}`;
    expect(parseAuthStatus(out)).toEqual({
      state: 'signed-in', email: null, orgName: null, plan: 'max',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-auth-status.test.ts`
Expected: FAIL, `parseAuthStatus` is not exported.

- [ ] **Step 3: Write minimal implementation**

The dotfile-banner problem is the same one `parseShellLookup` already solves: her shell prints its own noise and reading that as an answer is how someone with nothing installed gets told they are installed. Scan for the first balanced JSON object rather than trusting the whole of stdout.

```ts
/**
 * What `claude auth status --json` said, or `unknown`.
 *
 * `unknown` is a refusal, not a default. Anything this cannot positively account
 * for must never become "signed in" -- claiming an account exists when it does not
 * sends her to an engine that will fail on the first contract.
 */
export type AuthStatus =
  | { state: 'signed-in'; email: string | null; orgName: string | null; plan: string | null }
  | { state: 'signed-out' }
  | { state: 'unknown' };

function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseAuthStatus(stdout: string): AuthStatus {
  const parsed = firstJsonObject(stdout);
  if (!isRecord(parsed)) return { state: 'unknown' };
  const loggedIn = parsed['loggedIn'];
  if (loggedIn === false) return { state: 'signed-out' };
  if (loggedIn !== true) return { state: 'unknown' };
  return {
    state: 'signed-in',
    email: stringOrNull(parsed['email']),
    orgName: stringOrNull(parsed['orgName']),
    plan: stringOrNull(parsed['subscriptionType']),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli-auth-status.test.ts`
Expected: PASS, 10 assertions.

- [ ] **Step 5: Commit**

```bash
git add tests/cli-auth-status.test.ts src/lib/providers/cli.ts
git commit -m "Read the account out of auth status, and refuse anything else"
```

---

### Task 2: Classify the plan, without guessing

**Files:**
- Modify: `src/lib/providers/cli.ts`
- Test: `tests/cli-auth-status.test.ts`

**Interfaces:**
- Consumes: `AuthStatus` from Task 1
- Produces: `export function planSupportsCli(plan: string | null): 'yes' | 'no' | 'unknown'`

- [ ] **Step 1: Write the failing test**

An unrecognised plan string must be `unknown`, never `no`. Telling her a working plan will never work is the expensive mistake, and Anthropic can add a plan tier at any time.

```ts
import { planSupportsCli } from '@/lib/providers/cli';

describe('planSupportsCli', () => {
  it.each(['pro', 'Pro', 'max', 'MAX', 'team', 'enterprise'])('accepts %s', (p) => {
    expect(planSupportsCli(p)).toBe('yes');
  });
  it.each(['free', 'Free'])('rejects %s', (p) => {
    expect(planSupportsCli(p)).toBe('no');
  });
  it.each([null, '', 'ultra', 'something-new'])('will not guess about %j', (p) => {
    expect(planSupportsCli(p)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-auth-status.test.ts -t planSupportsCli`
Expected: FAIL, not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
const PLANS_WITH_CLI = new Set(['pro', 'max', 'team', 'enterprise']);
const PLANS_WITHOUT_CLI = new Set(['free']);

/**
 * Closed on both sides. A tier nobody here has heard of is `unknown`, so the
 * verdict falls through to what a real run says rather than telling her that a
 * plan she is paying for will never work.
 */
export function planSupportsCli(plan: string | null): 'yes' | 'no' | 'unknown' {
  if (plan === null) return 'unknown';
  const k = plan.trim().toLowerCase();
  if (PLANS_WITH_CLI.has(k)) return 'yes';
  if (PLANS_WITHOUT_CLI.has(k)) return 'no';
  return 'unknown';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli-auth-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Name the plans that drive the CLI, and refuse to guess at the rest"
```

---

### Task 3: Ask the binary instead of guessing from credential files

**Files:**
- Modify: `src/lib/providers/cli.ts` — replace `probeCliCredentials` (line 1019) and its use in `diagnoseCli` (line 1059)
- Modify: `src/lib/engine-diagnosis.ts` — `CliDiagnosis` gains account fields
- Test: `tests/engine-diagnosis.test.ts`

**Interfaces:**
- Consumes: `parseAuthStatus`, `planSupportsCli`
- Produces: `readAuthStatus(bin: string): Promise<AuthStatus>`; `CliDiagnosis` gains `account: { email: string | null; orgName: string | null; plan: string | null } | null`

- [ ] **Step 1: Write the failing test**

```ts
it('reports the account on the diagnosis when auth status answered', () => {
  const d = describeCli('working', {
    binPath: '/x/claude', foundVia: 'recorded',
    account: { email: 'bonnie@ibcbatt.com', orgName: 'IBC', plan: 'pro' },
  });
  expect(d.account?.plan).toBe('pro');
  expect(d.account?.email).toBe('bonnie@ibcbatt.com');
});

it('carries no account when auth status could not be read', () => {
  expect(describeCli('unverified', { binPath: '/x/claude' }).account).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-diagnosis.test.ts`
Expected: FAIL, `account` is not a property of `DiagnosisFacts`.

- [ ] **Step 3: Write minimal implementation**

Add to `engine-diagnosis.ts`:

```ts
export interface CliAccount {
  email: string | null;
  orgName: string | null;
  plan: string | null;
}
```

Add `account?: CliAccount | null` to `DiagnosisFacts`, `account: CliAccount | null` to `CliDiagnosis`, and `account: facts.account ?? null` inside `describeCli`.

In `cli.ts`, replace `probeCliCredentials` with:

```ts
/**
 * The authoritative answer, and it costs nothing.
 *
 * This used to look for a credentials file and infer a login from its existence,
 * which could not tell a stale file from a live session and knew nothing about the
 * plan. `auth status` answers both without spending a request.
 */
async function readAuthStatus(bin: string): Promise<AuthStatus> {
  const out = await runCapture(bin, ['auth', 'status', '--json'], 10_000);
  return out === null ? { state: 'unknown' } : parseAuthStatus(out);
}
```

In `diagnoseCli`, replace step 6 so that after the version and flag checks:

```ts
const auth = await readAuthStatus(bin);
const account =
  auth.state === 'signed-in'
    ? { email: auth.email, orgName: auth.orgName, plan: auth.plan }
    : null;

if (auth.state === 'signed-out') {
  return describeCli('not-signed-in', { binPath: bin, foundVia, version, account: null });
}
if (auth.state === 'signed-in' && planSupportsCli(auth.plan) === 'no') {
  return describeCli('plan-unsupported', { binPath: bin, foundVia, version, account });
}
return describeCli(auth.state === 'signed-in' ? 'working' : 'unverified', {
  binPath: bin, foundVia, version, account,
});
```

The replayed-failure check (step 4) must keep running *before* this, unchanged: a usage limit learned from a real run still outranks a healthy-looking `auth status`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. The existing test pinning that a real cap signal vetoes plan wording must still pass untouched.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Ask Claude Code whether it is signed in, rather than inferring it from a file"
```

---

### Task 4: Prefer the path the installer recorded

**Files:**
- Modify: `src/lib/paths.ts` — add `runtimeDir()` and `recordedClaudePath()`
- Modify: `src/lib/providers/cli.ts` — `resolveClaudeBinary` (line 312), `CliFoundVia`
- Modify: `src/lib/engine-diagnosis.ts` — `CliFoundVia`, `VIA_LABEL`, `neededDeepProbe`
- Test: `tests/cli-recorded-path.test.ts` (create)

**Interfaces:**
- Produces: `recordedClaudePath(): string | null` in `paths.ts`; `'recorded'` added to `CliFoundVia`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
const original = process.env['IBC_DATA_DIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ibc-claude-'));
  process.env['IBC_DATA_DIR'] = dir;
});
afterEach(() => {
  if (original === undefined) delete process.env['IBC_DATA_DIR'];
  else process.env['IBC_DATA_DIR'] = original;
  rmSync(dir, { recursive: true, force: true });
});

describe('recordedClaudePath', () => {
  it('is null when the installer never wrote one', async () => {
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBeNull();
  });

  it('is null when the recorded path is no longer executable', async () => {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'claude-path'), '/nowhere/claude\n');
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBeNull();
  });

  it('returns the trimmed path when it is executable', async () => {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, 'runtime', 'claude-path'), `${bin}\n`);
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBe(bin);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-recorded-path.test.ts`
Expected: FAIL, `recordedClaudePath` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `paths.ts`:

```ts
export function runtimeDir(): string {
  return join(dataDir(), 'runtime');
}

/**
 * The absolute path the installer put Claude Code at, when it still runs.
 *
 * An app launched from the Dock or by a LaunchAgent does not inherit her shell's
 * PATH, which is why "installed but unreachable" is the failure that actually
 * happens. The installer knows exactly where it wrote the binary, so it writes it
 * down and the probe never has to go looking. A recorded path that no longer runs
 * is discarded rather than trusted, and the four discovery probes still follow.
 */
export function recordedClaudePath(): string | null {
  try {
    const raw = readFileSync(join(runtimeDir(), 'claude-path'), 'utf8').trim();
    if (raw.length === 0) return null;
    accessSync(raw, constants.X_OK);
    return raw;
  } catch {
    return null;
  }
}
```

In `cli.ts`, at the top of `resolveClaudeBinary`, before `whichClaude()`:

```ts
const recorded = recordedClaudePath();
if (recorded !== null) {
  cachedBin = recorded;
  cachedFoundVia = 'recorded';
  return cachedBin;
}
```

Add `'recorded'` to `CliFoundVia` and to `VIA_LABEL` as `'where the installer put it'`. `neededDeepProbe` stays `foundVia === 'npm-prefix' || foundVia === 'login-shell'` — a recorded path is not a deep probe.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Write down where Claude Code was installed, and look there first"
```

---

### Task 5: The installer installs Claude Code

**Files:**
- Modify: `packaging/install.command` — new step after "Making it start on its own when you log in", before "Running the checkup"; `TOTAL_STEPS` 6 -> 7 and 8 -> 9 (lines 41, 44)
- Test: `tests/packaging-install.test.ts` (extend the existing packaging test file; find it with `ls tests | grep -i pack`)

**Interfaces:**
- Produces: `$IBC_RUNTIME_DIR/claude-path` containing one absolute path

- [ ] **Step 1: Write the failing test**

Follow the existing convention in this repo: run the script, do not read it. The test drives the step with a stub installer on PATH so no 265 MB download happens in CI.

```ts
it('records the claude path it installed, and survives a failed install', () => {
  // Both halves matter. The recorded path is the feature; not failing the
  // install is the constraint, because her Mac may have no network at that
  // moment and an installer that dies there leaves her with nothing.
});
```

Write two cases: one where the stub installer succeeds and `$IBC_RUNTIME_DIR/claude-path` ends up holding an executable path, and one where the stub exits non-zero and the script still exits 0 with the later steps having run.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/packaging-install.test.ts`
Expected: FAIL, no `claude-path` is written.

- [ ] **Step 3: Write minimal implementation**

```sh
step "Setting up Claude"
say "The tracker reads contracts through Claude Code. This installs it."
say "It does not sign you in -- the tracker asks for that when it opens."

CLAUDE_BIN=""
if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN=$(command -v claude)
  say "Already installed: $CLAUDE_BIN"
elif curl -fsSL https://claude.ai/install.sh 2>/dev/null | bash >/dev/null 2>&1; then
  [ -x "$HOME/.local/bin/claude" ] && CLAUDE_BIN="$HOME/.local/bin/claude"
fi

# Never fatal. No network, a refused download or a changed installer must not
# cost her the tracker: the app still opens, and its Engine screen offers this
# again with a button. An installer that dies here is the worse outcome.
if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
  mkdir -p "$IBC_RUNTIME_DIR"
  printf '%s\n' "$CLAUDE_BIN" >"$IBC_RUNTIME_DIR/claude-path"
  say "Claude Code is ready at $CLAUDE_BIN"
else
  rm -f "$IBC_RUNTIME_DIR/claude-path" 2>/dev/null
  say "Claude Code could not be installed right now."
  say "The tracker will still open, and its Engine screen can retry this."
fi
```

Bump `TOTAL_STEPS=6` to `7` and `TOTAL_STEPS=8` to `9`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. Any existing assertion on the `[n of 6]` / `[n of 8]` counts must be updated to 7 and 9.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Install Claude Code for her, and never let that step cost her the tracker"
```

---

### Task 6: Sign in from the app

**Files:**
- Create: `src/app/api/engine/signin/route.ts`
- Modify: `src/components/onboarding/Wizard.tsx` — the `login-cli` remedy branch (around line 405)
- Modify: `src/components/settings/EngineTab.tsx`
- Test: `tests/engine-signin.test.ts` (create)

**Interfaces:**
- Consumes: `resolveClaudeBinary`, `readAuthStatus`
- Produces: `POST /api/engine/signin` -> `{ started: true } | { started: false; reason: string }`

- [ ] **Step 1: Write the failing test**

The route opens an interactive login in a Terminal window and returns immediately; it must never block on the OAuth round-trip, and it must refuse cleanly when no binary is installed. Assert both, plus that the email argument is only passed when one is known.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-signin.test.ts`
Expected: FAIL, route does not exist.

- [ ] **Step 3: Write minimal implementation**

The route spawns Terminal running `<bin> auth login --claudeai [--email <addr>]` and returns at once. Recheck is the existing engine-health call, which now reads `auth status`, so no polling belongs here.

In the UI, the `login-cli` remedy becomes a real button rather than a copied command. It stays reachable from Settings -> Engine and Diagnostics, not only the wizard: tokens expire and she may sign out, so this is a permanent affordance.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Sign in from the Engine screen, wherever signed-out is discovered"
```

---

### Task 7: Show the account, the plan and the limit together

**Files:**
- Modify: `src/components/settings/EngineTab.tsx`, `src/components/onboarding/Wizard.tsx`
- Modify: `src/lib/support.ts` — include account and plan in the support bundle
- Test: `tests/support-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

Assert the support bundle names the signed-in account and plan, and — the point of the whole redaction rule — that it still contains no API key and no token.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/support-bundle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Render `Claude Pro, bonnie@ibcbatt.com` beside the engine state, and when `limitResetsAt` is set, the reset time next to it. Showing the account is the point: signing into a personal account rather than the IBC one is otherwise invisible.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Say which account is signed in, on the screen that reports the engine"
```

---

### Task 8: Correct the documents that now say something false

**Files:**
- Modify: `HANDOFF.md` — the five-failures table, the `not-on-path` row, and the claim that cases 4 and 5 cannot be detected from the machine
- Modify: `packaging/README.md` — step counts 6 -> 7 and 8 -> 9, and the new step
- Modify: `README.md` — the setup section, which implies Claude Code is a prerequisite she arranges

- [ ] **Step 1: Make the edits**

`HANDOFF.md` must no longer say plan and usage-limit "cannot be detected by looking at the machine": a plan now can, and is, at setup. The usage limit still cannot, and that distinction is the point.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "Correct the three documents that describe the old behaviour"
```

---

### Task 9: Verify, then rebuild the distributable

- [ ] **Step 1: Run every gate**

```bash
npx tsc --noEmit
npx vitest run
npx next build
npm run eval
npm run eval -- --live
npm run doctor
```

Expected: all pass; live eval still 290/290. Report the number either way.

- [ ] **Step 2: Cut the version**

Bump `IBC_VERSION` in `packaging/app-template/bin/common.sh` to `1.1.0`, commit, and tag with a message written for Bonnie rather than for a changelog.

- [ ] **Step 3: Rebuild**

```bash
sh packaging/make-distributable.sh
```

Expected: a fresh `dist/IBC-Contracts-1.1.0-macOS-arm64.zip`. The builder unpacks its own output, starts it and waits for a real 200 on `/ibc-ping.txt` before emitting anything.

- [ ] **Step 4: Adversarial review**

Re-read the citation guard rule before declaring done: anything a guard cannot positively account for is a rejection. Apply the same standard to `parseAuthStatus` and `planSupportsCli` — neither may return a confident answer for input it did not recognise.
