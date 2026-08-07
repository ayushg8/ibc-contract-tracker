# HANDOFF

For Ayush. Bonnie will never read this file.

She is not technical. She will not open Terminal, will not read a README, and does not
know what a port is. Everything below assumes the call starts with "it stopped working"
and nothing more precise than that.

---

## First move, every time

Ask her to open **Settings -> Diagnostics** and press **Copy support bundle**, then paste
it into a message. That one screen carries the engine verdict, the folder checks, the last
ten failures and the last 200 log lines, all redacted. It is the same probe the setup
wizard runs, rendered the same way, so the sentence she reads to you over the phone is the
sentence you need.

The bundle never contains the API key. It reports only that one exists and where it came
from. That is deliberate - a bundle can be forwarded, saved to a drive, or pasted into a
thread without leaking anything that can spend money.

If the app will not start at all, on her Mac:

```sh
npm run doctor
```

Same checks, one line of fix per failure, and a paste-able block at the end.

---

## The five ways Claude Code fails, and how to tell them apart

The app reads contracts through either the `claude` CLI (her Claude subscription) or an
Anthropic API key. On her Mac it is the CLI, and it can be wrong in five distinct ways
that used to look identical. Each one now has its own sentence, its own error code and its
own next action, in the wizard and in Diagnostics.

| What she sees | Code | What is true | What fixes it |
| --- | --- | --- | --- |
| "Claude Code isn't installed on this Mac." | `CLI_NOT_FOUND` | Nothing runnable anywhere, and her login shell does not know the name either. | The installer normally handles this. Re-run `install.command`, or `claude-setup.sh` inside the bundle |
| "Claude Code is installed, but this app cannot run it." | `CLI_NOT_FOUND` | Her shell resolves `claude`; this process cannot. **Now rare:** the installer records the absolute path and the app reads that first. Means the recorded path went stale *and* discovery failed. | Re-run `install.command`, or send you the output of `command -v claude && claude --version` |
| "Claude Code is installed but not signed in." | `CLI_NOT_AUTHENTICATED` | Runs, but no account attached. Detected directly now, not guessed from a credentials file. | **She presses "Sign in to Claude"** in the wizard, Settings → Engine or Diagnostics. No Terminal command to dictate |
| "This Claude plan doesn't include what the tracker needs." | `CLI_PLAN_UNSUPPORTED` | Signed in, plan lacks the access. Waiting will not help. | Upgrade the plan, or switch to an API key |
| "You've hit your Claude subscription limit." | `CLI_USAGE_LIMIT` | Working, currently capped. Resets on its own. | Wait, or switch to an API key. The queue resumes where it stopped |

### Why the second row is the one to expect

An app launched from the Dock or by a LaunchAgent does **not** inherit the PATH from her
shell profile. `~/.local/bin`, Homebrew's `/opt/homebrew/bin`, nvm shims, volta, fnm and
asdf are all invisible to it. `which claude` succeeding in her Terminal proves nothing
about the app.

`src/lib/providers/cli.ts` therefore probes, in order:

0. **the path the installer wrote down**, at
   `~/Library/Application Support/IBC Contract Tracker/runtime/claude-path`,
1. `/usr/bin/which` against an augmented PATH,
2. every known install location, including nvm/fnm/asdf version directories listed at
   runtime because the node version is in the path,
3. `npm config get prefix`,
4. her actual login shell (`$SHELL -lic`), which is the only probe that sees what she
   sees.

Step 0 is what makes this mostly a solved problem now. `claude-setup.sh` installs the
CLI during the install and records the absolute path it landed on, so the app is told
where the binary is rather than going looking. A path we were handed beats one we
searched for. It is trusted only while it still answers `--version`; a stale one is
discarded and the four discovery probes still run, so an install that moved degrades
to the old behaviour rather than to a dead engine. That script also never writes a
path for a binary that does not execute, because the app prefers it over everything
else and a bad line there would take a working install offline.

If step 4 finds the name but nothing executable, that is the "installed but unreachable"
row above. The shell probe uses a sentinel marker (`IBC-CLAUDE-PATH:`) rather than reading
stdout, because her dotfiles print their own banner and reading that as an answer would
tell someone with nothing installed that it is installed. If you change this code, keep
that test.

Case 4 **can** now be detected from the machine, and is. `claude auth status --json`
reports `subscriptionType` without spending a request, so a plan that cannot drive
Claude Code is caught at setup rather than by the first contract failing. The same
call reports `loggedIn` and the account address, which is why Diagnostics can now
name *which* account she is signed in as - signing into a personal account instead
of the IBC one was previously invisible and produced a support call nothing on the
screen explained.

Only a plan positively recognised as lacking access is a verdict. An unfamiliar
tier stays quiet and lets a real run decide, because the plan names are Anthropic's
to change and telling her a working plan will never work is the expensive mistake.

Case 5 still cannot be detected from the machine. Nothing on the Mac knows how much
of a subscription window is spent, and no CLI command reports it. It is learned only
from a run that hit the cap, so it is remembered for 30 minutes after a failed run,
replayed into Diagnostics, and cleared the moment a run succeeds. **There is
deliberately no remaining-quota meter anywhere in the app**: populating one would
mean either spending requests to ask or inventing the number.

### Do not let these two collapse into each other

A usage limit resets. A plan does not. Telling someone whose limit resets at 3pm that
their plan will never work is the worse of the two mistakes, so the classifier checks for
plan wording first but lets any real cap signal ("usage limit", "resets at", "weekly
limit") veto it. `tests/engine-diagnosis.test.ts` pins this.

---

## Switching engines

Settings -> Engine, no restart. An API key costs roughly 1-3 cents a contract, has no
usage cap, and is the only engine that can read a page image.

**There is no automatic failover between them, and there must never be.** A failed engine
raises its error and stops. Silent failover would mean the same contract produces
different output on different days, which is the objection this whole product answers.
If you are tempted to add a retry-on-the-other-engine, don't.

---

## Where the data lives

Everything is under one folder:

```
~/Library/Application Support/IBC Contract Tracker/
├── tracker.db        SQLite. Contracts, documents, fields, audit, settings
├── archive/          The tracker's own copy of every PDF
├── thumbnails/       First-page renders
├── exports/          Generated workbooks
└── logs/             Rolling log, redacted
```

Overridable with `IBC_DATA_DIR` for a test profile or a second machine.

The **API key is not in there**. It lives in the macOS keychain and never touches the
database, the logs, or any HTTP response.

---

## Backup and restore

**Take one:** Settings -> Data -> Back up. One zip: the database, the archive, the
thumbnails, a manifest, a copy of settings, and a plain-text restore guide inside the zip
itself. PDFs are stored, not deflated - they are already compressed and are streamed
rather than buffered, so a large archive does not blow memory.

**Restore:** the exact steps are in the zip, and in `describeRestore()` in
`src/lib/backup.ts`. Short version: quit the app, unzip, Finder Command-Shift-G to the
data folder above, move the current contents to the Desktop, copy `tracker.db`, `archive/`
and `thumbnails/` in, reopen. Then re-enter the API key if one is in use - it is
deliberately absent from the backup, so a zip on a drive or in an email cannot spend
money.

---

## Reading the audit trail

The `audit` table is append-only. The application never updates a row and never deletes
one. Actions: `extracted`, `approved`, `edited`, `rejected`, `unapproved`, `archived`,
`exported`, `reextracted`, `reopened`, `unarchived`, `restored`.

In the app: open a contract, the timeline is on the record.

Two things worth knowing before you read SQL against it:

- `contract_id` is `ON DELETE SET NULL`, not cascade. Unapproving or re-reading a document
  used to destroy the history that proves what happened; now the row survives and still
  resolves through `document_id`.
- Every row also carries `document_id`, so a contract that has been unapproved and
  re-approved still shows one continuous history under its document.

The raw prompt and raw model response for every extraction are kept verbatim on the
document row. That is the audit of the exchange itself, and it is what to look at when a
field came out wrong.

---

## What is deliberately not built

Say these plainly if she asks; none of them is a bug.

- **No reminders, no notifications, no email.** The app tells you what is expiring when
  you open it. It will not chase you.
- **No multi-user, no accounts, no permissions.** Every audit row is `actor = 'local'`.
- **Single machine.** No sync, no server, no shared database. Two Macs would be two
  separate sets of contracts.
- **No automatic engine failover.** Covered above. This is a feature.
- **No automatic approval.** Nothing enters the repository without a human pressing
  Approve, including bulk approve, which approves only records that already pass every
  check.
- **Folder watching is optional, not required.** Drag-and-drop onto the Inbox is a
  complete way to use the app and always will be. The wizard's folder step can be skipped,
  the app never blocks on it, and the setup screen only claims a folder is being watched
  when `GET /api/watch` says the loop is actually running against a folder it can read.

---

## The honest caveat on accuracy

Every accuracy number quoted so far - the eval pass rate, the field yield, the citation
verification rate - is measured against **synthetic fixtures written alongside the code**.
They exercise the pipeline, the citation matcher and the date arithmetic properly, and
they are a real guard against regression. They are not evidence about IBC's contracts.

Nothing is known about how this performs on IBC's actual drafting until real signed NDAs
have gone through it. Before quoting a number to anyone at IBC, run a batch of real
contracts, review every field by hand, and count. Expect the first real batch to surface
drafting patterns no fixture anticipated - that is the point of running it.

The guarantees that *are* real regardless of the corpus, because they are enforced in code
rather than measured: no value is stored without a verbatim quote found in the document,
every date is computed rather than read from the model, and nothing reaches the repository
without a human approving it.
