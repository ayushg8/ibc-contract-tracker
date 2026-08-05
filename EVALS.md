# Evals

Bonnie's objection to AI is that it is not repeatable. This suite is the answer to that
objection, and it has to be an answer she can check herself: one command, one number.

```
npm run eval
```

```
CASE                CHECKS     FIELDS  COST   TIME
fixtures     PASS  430/430    -       -      13ms
dates        PASS  89/89      -       -      16ms
rules        FAIL  515/522    83/86   -      54ms
verify       FAIL  1119/1158  -       -      199ms
status       PASS  62/62      -       -      10ms
determinism  PASS  30/30      -       -      2.1s
extraction   SKIP  -          -       -      0ms   needs --live

field-level accuracy: 83/86 (96.5%)
checks: 2245/2291 passed  |  cases: 4 passed, 2 failed, 1 skipped
offline run - no engine was called, nothing was spent
```

No network, no engine, no cost, about three seconds. Exit code 1 if any offline case
regressed, which makes it usable as a commit gate.

## The commands

| Command | What it does |
| --- | --- |
| `npm run eval` | Every offline case. No engine, no spend. |
| `npm run eval -- --list` | What each case proves, in one line each. |
| `npm run eval -- --case=verify` | One case. |
| `npm run eval -- --json` | The whole report as JSON, for CI. |
| `npm run eval -- --live` | Adds the extraction case: a real engine on every fixture. |
| `npm run eval -- --live --fixture=octillion` | One document against the engine. |
| `npm run eval -- --today=2027-01-01` | Moves the frozen "today" the status case uses. |
| `npm run eval -- --keep-data` | Leaves the throwaway database behind for inspection. |
| `npm run doctor` | Not an eval. The command to run when the app will not start. |
| `npm test` | The vitest suites, including the pipeline and the workbook. |

Two things are true of every run:

- **It cannot touch the real database.** `IBC_DATA_DIR` is pointed at a fresh temp directory
  before a single application module is imported, and the directory is deleted at the end.
- **It cannot depend on the date.** "Today" is a parameter (`--today`, default `2026-07-29`),
  never `Date.now()`, so a status assertion that passes in July still passes in October.

## The cases

Run `npm run eval -- --list` for this in the terminal.

### `fixtures` - the suite checking itself

Every fixture's quotes really are in its own text, on the page it claims; every computed
termination and confidentiality-end date follows from that fixture's own effective date and
term; every field has an expected value. The arithmetic here uses a second, deliberately
dumb date implementation in `evals/fixtures/types.ts` rather than `src/lib/util/dates.ts`,
because an oracle that shares code with the thing it grades is not an oracle.

A fixture whose expected quote had a typo would silently turn the hallucination guard's
positive cases into false failures. This case is what stops that.

### `dates` - the arithmetic

Every date form in the corpus (`November 5, 2022`, `the 29th day of February, 2024`,
`14 January 2024`, `Jan. 9, 2023`, `1st April 2025`, `2025-06-30`, `03/04/2024`), every
duration form (`five (5) years`, `ninety (90) days`, `twenty-four (24) months`,
`in perpetuity`), and the arithmetic between them.

Includes what must be **refused**: `February 30, 2024`, `2023-02-29`, `until December 31,
2027` as a duration, and anything unquantifiable. A date parser that guesses is worse than
one that returns null, because null is visible in the review pane and a guess is not.

Conventions this case pins down:

- Month and year addition is calendar addition, not 365 days. `2024-02-29 + 1 year` is
  `2025-02-28` - clamped to the month end, never rolled into March.
- An ambiguous numeric date (`03/04/2024`) parses with `ambiguous: true`. It is resolved
  US month-first, and the flag is what the UI uses to keep it out of the green tier.
- `in perpetuity` has no end date. `addDuration` returns null rather than a distant year.

### `rules` - the deterministic pass, precision first

Every rule hit is checked three ways: the value is right, the quote it cites is really on
the page it cites, and the value is clean enough to store (no leading colon, no trailing
comma). A rule hit shows up in the UI as a green dot, and a green dot tells the reviewer
not to look, so the standard is asymmetric on purpose:

- **A rule that fires with a wrong value is a failure.** Every fixture's
  `rulesMustNotFind` list is a place where guessing is worse than silence.
- **A rule that stays silent is only a failure where the document is unambiguous.** Recall
  is asserted for `effective_date` and `governing_law` (the two fields PLAN.md section 13
  puts in the rules pass), plus both clocks on the Octillion fixture, where confusing them
  is the whole risk.

This case also produces the headline field-level accuracy number on an offline run: the
denominator is every field the deterministic pass either answered or owed an answer for.

### `verify` - the hallucination guard

The most important file in the suite, because it is the only thing standing between "the
model quoted a clause" and "the model made up a clause". Two directions, both asserted for
every fixture:

**Mangled real quotes must be accepted.** `evals/fixtures/mangle.ts` reproduces what a real
PDF text layer does to a sentence: curly apostrophes, non-breaking spaces, soft hyphens at
every legal break point, a word split across a line wrap, `fi` and `fl` ligatures,
zero-width joiners, en dashes for hyphens, collapsed whitespace, and all of it at once. A
false rejection puts "not found in document" next to a clause that is plainly in the
document, and Bonnie stops believing the tool.

**Fabricated quotes must be refused.** The same file produces the fabrications a model
actually makes: the right clause with the wrong number, a paraphrase that changes the
meaning (`shall` to `may`), an invented renewal clause, generic boilerplate, a real quote
that keeps going into something invented, the words reordered, a party name swapped in.
Each fabrication is checked for genuine absence first, using the local oracle, so the case
can never assert against something the document happens to say.

Then `applyVerification` is exercised the way the pipeline uses it: a value with no quote is
dropped, a value with an unfindable quote is dropped, the page number comes from where the
quote actually is rather than from what the model claimed, and a run where every citation
failed raises `ALL_CITATIONS_FAILED` instead of saving a record full of holes.

### `status` - both clocks at the boundaries

Day 400, 92, 91, 90, 89, 1, 0, -1 and -400 from the end date, for the agreement clock and
the confidentiality clock independently, plus every fixture's two clocks against a local
oracle. Day 90 is amber, day 91 is not; the termination date itself is not yet expired; one
day past it is.

Also asserted: no end date reads as `unknown`, not `active` (a lapsed agreement must never
hide in the Active filter); a record dated in the future reads as `active` with a real day
count; and the case the product exists for - the Octillion row, where the agreement is
expired while the duty of confidence still runs.

A perpetual confidentiality obligation has no end date, so it reads as `unknown` and the
verbatim term (`in perpetuity`) is what the UI shows. That is a deliberate reading of a
four-state enum with no `perpetual` member, and it is asserted so nobody changes it by
accident.

### `determinism` - the repeatability claim

The cache key is checked for the four things it has to separate (file, model, prompt
version, field list) and the one thing it must not (field order). Then the real pipeline
runs the same document twice through a stub engine and the case asserts: the engine was
called once, the second run was served from the cache, the second run cost nothing, and the
two outputs are byte-identical. Dropping the same bytes again opens the same record rather
than creating a second one.

The engine here is a stub on purpose. What is under test is the pipeline's determinism, not
the model's - which is exactly why the cache exists.

### `extraction` - a real engine, opt-in

```
npm run eval -- --live
```

Runs the rules pass, asks the configured engine for what is left, applies the citation guard
exactly as the pipeline does, computes both dates in code, and scores all sixteen fields of
every fixture. Reports per-field accuracy and the real cost. Skips with a legible message
when no engine is available, and **never** sets the exit code: a model having a bad day is a
judgement call for a human, and the offline cases are what gate a commit.

A field only counts as correct if the value is right *and* the quote behind it was found in
the document. There is no credit for a lucky guess.

## The fixtures

Thirteen synthetic agreements in `evals/fixtures/`, each with a hand-written record of all
sixteen fields. They are TypeScript string constants, not PDFs, so they are reviewable and
diffable; `evals/fixtures/pdf.ts` turns them into real PDF bytes at test time when a case
needs to exercise the actual reader.

| Fixture | What it exists to prove |
| --- | --- |
| `ntrium` | The clean two-party mutual NDA. Nothing ambiguous, so nothing excuses a wrong answer. |
| `octillion` | **The two clocks.** A 90-day evaluation agreement with a 5-year confidentiality tail: expires 2026-09-30, confidential until 2031-07-02. A 60-day termination notice in the same document must not be mistaken for the term. |
| `trisolar` | Three parties. Party C populated. |
| `helios` | `the 29th day of February, 2024` plus a one-year term: the month-end clamp to `2025-02-28`. |
| `acme` | `14 January 2024`, a German address, and the counterparty's own template (IBC Form = No). |
| `daybreak` | An ISO date, durations in months, and a text layer full of curly quotes, NBSPs, a soft hyphen and a mid-word line wrap. |
| `stonecrest` | Governing law `England and Wales` and a London notice address. A rule keyed to "State of X" must not fire. |
| `northwind` | **The notice email is absent.** The correct answer is null, and the general-enquiries address in the footer is a decoy. |
| `hall_keegan` | A counterparty called `Hall and Keegan Materials, Inc.` Splitting the preamble on " and " gives "Hall" and is wrong. |
| `sequoia` | A term stated only as an end date. `term` is null; the termination date comes from the document, not from arithmetic. |
| `voltaic` | Two decoy dates above the real one: a conference meeting and a letter of intent. |
| `kestrel` | An ambiguous `03/04/2024` with a US governing law and a British counterparty. The only correct deterministic behaviour is to abstain. |
| `legacy` | Confidentiality `in perpetuity` on an agreement that expired in 2024. |

Between them the fixtures carry six date forms, both a US and a non-US jurisdiction, a
perpetual obligation, a null that must stay null, and three documents where the first date
or the first "and" in the preamble is a trap.

## Adding a fixture

1. Write it in `evals/fixtures/nda.ts`, `evaluation.ts` or `edge.ts`. Pages are an array of
   strings, one per printed page. Keep the source ASCII: write a curly quote as
   `\u2019` and a non-breaking space as `\u00a0` rather than pasting the characters in.
2. Fill in all sixteen `expected` values. `null` means "correctly absent from this
   document" - a fixture that asserts a null is worth as much as one that asserts a value.
3. Add a verbatim `quotes` entry for every field the document evidences. These become the
   hallucination guard's positive cases, so they must be exact substrings of one page.
4. Fill in `computed`: the termination date, the confidentiality end date, and whether the
   confidentiality obligation is perpetual.
5. Set `rulesMustFind` (fields where silence would be inexcusable) and `rulesMustNotFind`
   (fields where a deterministic answer would be a guess). Both default to conservative.
6. Write one line of `proves`. If you cannot say what a fixture proves that the other
   thirteen do not, it is not worth its maintenance.
7. Export it from `evals/fixtures/index.ts` and run `npm run eval -- --case=fixtures`. That
   case will tell you if a quote is not in the text or the arithmetic does not agree, before
   any extraction code is allowed near it.

`acceptable` is optional: alternative answers a careful human would also accept
(`five (5) years` for `5 years`, `State of Delaware` for `Delaware`). It widens the answer
set for the live model scoring only; the deterministic cases always compare against
`expected`.

## Adding a case

Write `evals/cases/<name>.ts` exporting
`runCase(ctx: CaseContext): Promise<CaseResult>`, build the result with `CaseRun` from
`evals/report.ts`, and register it in the `CASES` array in `evals/run.ts`.

Three rules the report depends on:

- Reach into `src/lib` only through `evals/cases/_modules.ts`. It wraps every import in a
  try/catch so a module that does not exist yet becomes one legible SKIP line instead of a
  stack trace that hides every case behind it.
- Use `run.skipAssertion()` for a check that could not run. A skipped assertion counts as
  neither a pass nor a failure, which is the only way the headline number stays honest.
- Mark an assertion `{ field: true }` when it is about one of the sixteen tracker fields.
  That is what the field-level accuracy number counts.

## Why the runner re-executes itself

`npm run eval` invokes `node --experimental-strip-types`. That mode erases types but refuses
TypeScript that needs real code generation - a parameter property, an enum, a namespace -
and it does not read `tsconfig` paths or infer file extensions. So `evals/run.ts` and
`scripts/doctor.ts` each do two things before importing anything:

1. Re-execute themselves under `--experimental-transform-types` if they are not already
   there, so the suite does not care which legal TypeScript features `src/lib` uses.
2. Register a module resolve hook that supplies the `@/` alias and appends `.ts` /
   `/index.ts`, so application code can be written the way the bundler expects.

The cost is one extra process spawn. The benefit is that `npm run eval` and `npm run doctor`
work with plain node, no build step, and no test-runner configuration.

## doctor

```
npm run doctor
```

Twelve checks with a PASS/WARN/FAIL and, whenever something is not right, one line of what
to do about it: Node version, `node:sqlite`, SQLite FTS5, the data folder, the database and
its schema version, the Claude Code CLI (resolved path, version, signed in), the API key,
whether *any* engine is usable, port 3000, disk space, the PDF reader (it reads a real test
page), and the Excel writer (it writes a real test workbook).

Exits non-zero when a hard check fails, and finishes with a plain-text block designed to be
copied into an email - no colour, no ANSI, key redacted.
