# Installing and authenticating Claude Code for her

Date: 2026-08-07
Status: approved, ready for implementation planning

## Why

Bonnie will not use an API key. She has Claude Pro on her IBC account. Today the
tracker only *detects* Claude Code and, when it is missing, hands her a Terminal
command with a copy button and a note to send it to Ayush. On her Mac that path
does not work at all:

- macOS does not ship Node, and the Node this project bundles lives inside the app
  bundle rather than on her PATH, so `npm install -g @anthropic-ai/claude-code`
  fails at `command not found: npm` before it starts.
- `~/.local/bin` and friends are invisible to an app launched from the Dock or by a
  LaunchAgent, which is why `not-on-path` is documented as the case that actually
  happens.
- The login is an interactive prompt plus a browser round-trip, which nothing in the
  product currently drives.

So the installer must install Claude Code, and the app must drive the sign-in.

## What changed underneath

`claude auth status --json` reports, without spending a request:

```json
{ "loggedIn": true, "authMethod": "claude.ai", "email": "...",
  "orgName": "...", "subscriptionType": "max" }
```

and `claude auth login [--claudeai] [--email <addr>]` starts the sign-in.

Two claims currently written into the code and into HANDOFF.md are therefore now
false and must be corrected as part of this work:

- `engine-diagnosis.ts` says sign-in "cannot be checked without asking it to read
  something, and that would spend a request."
- HANDOFF.md says the plan and usage-limit cases "cannot be detected by looking at
  the machine."

A signed-out state and an unsupported plan can both now be detected at setup,
before any contract is read.

## Scope

### 1. Installer: a new step that installs Claude Code

`packaging/install.command` gains a step. Her flow becomes `[1 of 7]` … `[7 of 7]`;
the source flow becomes 9.

It installs Claude Code with the official native installer, the same shape already
present on Ayush's Mac (`~/.local/bin/claude` symlinking into
`~/.local/share/claude/versions/<version>`). It requests `stable` rather than pinning
a version, because a pinned CLI is how an install drifts into
`CLI_VERSION_UNSUPPORTED` months later.

Rejected alternatives:

- *Bundled npm.* The app already ships `npm`, but the npm package is a 166 KB
  launcher that fetches the same ~265 MB native build on first use. That download
  would then happen during her first extraction and present as a hang.
- *Bundling the native binary in the payload.* Fully offline and checksummable the
  way Node already is, but it takes the download from 203 MB to roughly 470 MB and
  requires re-bundling on every Claude Code release.

**This step must never fail the install.** No network, a failed download, or any
other error prints a plain sentence and continues. The app still opens, the wizard
still runs, and the sign-in step can retry. This follows the existing rule that no
step in this product is a wall.

It records the absolute path it installed to. It never attempts a login.

### 2. The app trusts the recorded path first

`src/lib/providers/cli.ts` currently probes in four steps: augmented-PATH `which`,
known install locations, `npm config get prefix`, then the login shell. A step is
added ahead of all four: the path recorded by the installer, used when it exists and
is executable.

This removes the `not-on-path` case for a machine installed this way. The four
existing probes stay, unchanged, for every other machine and for an install that has
moved.

### 3. Real authentication detection

The `unknown` / "sign-in is unconfirmed" case is replaced by a real reading of
`claude auth status --json`.

New states that become detectable at setup rather than after a failed extraction:

- signed out -> `CLI_NOT_AUTHENTICATED`
- a plan that cannot drive Claude Code -> `CLI_PLAN_UNSUPPORTED`

Diagnostics and the engine screens additionally show which account is signed in
(email, org, plan). Showing the account is deliberate: signing into a personal
account instead of the IBC one is otherwise invisible and produces a support call
that nothing on the screen explains.

Parsing must be defensive. Unrecognised or malformed output is `unknown`, never a
guess, and never a claim that she is signed in.

### 4. Sign-in as a permanent, repeatable action

Not an onboarding step. Tokens expire and she may sign out, so the action lives
wherever `CLI_NOT_AUTHENTICATED` surfaces: the wizard's engine step,
Settings -> Engine, Diagnostics, and the banner on a failed extraction.

It runs `claude auth login --claudeai --email <her address, when known>` so her email
is pre-filled, and Recheck confirms the result through `auth status` rather than
through a real extraction.

### 5. Usage limit

`CLI_USAGE_LIMIT` already exists, already parses "usage limit" / "resets at" /
"weekly limit" out of the CLI's own failure output, already remembers a reset time,
and the queue already resumes where it stopped.

What this work adds is the account and plan shown beside that state, so the screen
reads "Claude Pro, bonnie@ibcbatt.com, limit reached, resets 3:00pm" rather than a
bare error.

**Explicitly not built: a live remaining-quota meter.** No CLI command reports
consumption, and `auth status` reports the plan only. The only honest source of
usage information is a run that actually hit the cap. A meter would have to either
spend requests to populate itself or invent a number.

## Testing

Following this repository's convention that packaging scripts are executed by tests
rather than read:

- the new installer step installs Claude Code and records a usable path
- a failed CLI install does not fail the install, and the app still starts
- `auth status` parsing across logged-out, free, pro, max, and malformed output
- the recorded path takes precedence over PATH discovery, and a stale recorded path
  falls through to the existing four probes
- the plan-versus-usage-limit distinction continues to hold; `tests/engine-diagnosis.test.ts`
  already pins that a real cap signal vetoes plan wording, and that must not regress

The step count assertions in the packaging tests change with the new step, and the
`TOTAL_STEPS` values must be asserted rather than hardcoded in two places.

## Verification

All five gates plus doctor, from `app/`:

```
npx tsc --noEmit
npx vitest run
npx next build
npm run eval
npm run eval -- --live
npm run doctor
```

The live eval is the honest number and is 290/290 today. It exercises the AI path,
which this work does not touch, so it must still read 290/290 afterwards. A drop is
reported, not explained away.

Then the distributable is rebuilt and a new version cut, because the current
`v1.0.0` release predates even the third-engine commit.

## Documentation that must change with the code

- `HANDOFF.md` — the "five ways Claude Code fails" table, the claim that cases 4 and
  5 cannot be detected from the machine, and the `not-on-path` guidance
- `packaging/README.md` — the step counts and what the installer now does
- `README.md` — the setup section, which currently implies Claude Code is a
  prerequisite the user arranges

## Risks

- Her install gains a network dependency and roughly 265 MB of download. On a poor
  connection this is the slowest step, which is exactly why it cannot be fatal.
- She must still complete an OAuth round-trip in a browser once. Nothing removes
  that; the button only puts it in front of her instead of inside a Terminal she
  would have to be talked into opening.
- `claude auth status` behaviour when signed out is assumed to exit cleanly with
  `loggedIn: false`. This must be verified against a signed-out state during
  implementation rather than assumed.
