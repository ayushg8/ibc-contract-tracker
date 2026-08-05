# IBC Contract Tracker

Reads signed NDAs and evaluation agreements, pulls out the sixteen tracker fields with a
human approving every record, and keeps them searchable. Exports to the exact Excel
workbook already in use.

Runs on one machine. Nothing leaves it except the contract text sent to Claude for
reading, and only when a document is being extracted.

---

## Setup

Needs **Node 22.5 or newer** (`node -v`). Nothing else — no database to install, no
compiler, no native modules.

```sh
npm install
npm run dev
```

Then open <http://localhost:3000>. First run walks through a five-step setup and finishes
by extracting a bundled sample agreement, so you can see it work before trusting it with
anything real.

For day-to-day use:

```sh
npm run build && npm start
```

### If something is wrong

```sh
npm run doctor
```

Checks Node, the database, the Claude CLI, the API key, disk space, the PDF reader and
the Excel writer, and prints a one-line fix for anything failing. It ends with a block
you can paste into an email. The same checks are in the app under
**Settings → Diagnostics**, each with a Fix button.

---

## The two engines

Reading a contract needs a language model. There are two ways to provide one, switchable
in **Settings → Engine** with no restart.

**Claude subscription** — shells out to the `claude` CLI you are already signed in to. No
API key, no per-document charge. Requires Claude Code installed and logged in. Reads scans
too: they go through local OCR first, so the model receives text either way.

**API key** — calls the Anthropic API directly. Faster, no usage cap, and the JSON shape is
guaranteed by the API rather than repaired by us. Also the fallback for a scan too poor to
OCR, which it can read as page images. Costs roughly 1–3¢ per
contract. The key is stored in the macOS keychain, never in the database, the logs, or any
HTTP response.

There is **no automatic failover between them**. If the selected engine fails you get a
plain-English message and a one-click switch. Silent failover would mean the same document
could produce different output on different days, which is the one thing this tool must not
do.

---

## Why you can trust the output

**Everything deterministic is done in code.** Dates, term arithmetic, expiry status,
search, duplicate detection and the Excel export never touch a model. Termination and
confidentiality end dates are computed here, from the term the model quoted.

**The model must cite everything.** For each field it returns the value, a verbatim quote,
and a page number — or null. A null is a useful answer; a guess is a defect.

**Citations are verified against the document.** Every quote is searched for in the
extracted text. If it is not there, the field is dropped and marked missing. The matcher
tolerates the mangling real PDFs produce — curly quotes, soft hyphens, ligatures,
mid-word line wraps — but **any difference in a number or a modal verb is a rejection**,
because "November 7" against a document that says November 5 is exactly the failure that
would otherwise reach the repository unnoticed.

**The same PDF always gives the same answer**, cached by file hash plus model plus prompt
version. Changing the prompt is a visible version bump, recorded on every record.

**Nothing enters the repository without a human clicking Approve**, and Approve stays
disabled until every required field is filled or explicitly marked not-applicable. The
server enforces that itself rather than trusting the screen, so a document that was set
aside or failed to read cannot be approved by any route.

**Nothing is a one-way door.** A record can be sent back to the Inbox, re-read with a newer
prompt, or removed and restored. Removing is a soft delete; the audit trail survives all of
it, including the approval and every later correction.

---

## Two clocks, not one

An agreement and its confidentiality obligation expire on different dates, and a
confidentiality period often runs from **termination** rather than from signing. A 2-year
evaluation agreement with "7 years after termination" is dead in 2026 but binding until
2033. Every record shows both, computed separately. A flat spreadsheet cannot express
this, and getting it wrong is invisible.

---

## Tests and evals

```sh
npm run typecheck      # no errors
npm test               # 342 unit tests
npm run eval           # offline: rules, dates, citation guard, status, determinism
npm run eval -- --live # scores the real engine on all 10 fixtures, prints accuracy + cost
```

The live run is the honest number. Current: **290/290 fields (100%)** against the Claude
subscription engine at $0.

`evals/` has the detail. The most important file is `evals/cases/verify.ts` — it feeds
deliberately fabricated quotes and asserts every one is rejected, and feeds quotes mangled
the way real extraction mangles them and asserts every one is accepted.

---

## Where things are

```
src/lib/fields.ts              the 16 tracker fields. the source of truth
src/lib/providers/errors.ts    every failure mode, with its plain-English text and remedy
src/lib/providers/{cli,api}.ts the two engines
src/lib/extraction/verify.ts   the citation guard
src/lib/extraction/pipeline.ts the orchestrator
src/lib/util/dates.ts          all date arithmetic, including both clocks
src/lib/db/schema.sql          the schema (schema.ts is the generated copy that runs)
src/app/api/                   the HTTP surface
src/components/ui/             the design-system primitives
evals/                         fixtures and cases
```

Data lives in `~/Library/Application Support/IBC Contract Tracker/` — database, PDF
archive, thumbnails, logs, exports. Override with `IBC_DATA_DIR`.

---

## Scans

A PDF with no text layer is rasterised and read locally by OCR (~1.5s a page, no network,
no API key). The point is not only that scans work -- it is that OCR produces **text**, so
every quote can be checked against it. The alternative path, sending page images straight
to the model, has nothing to check a quote against, and fields read that way are stored
`citation_verified = NULL` rather than a faked true.

Three things follow, and the app says all three out loud on the record rather than in a
log:

- A scan read by OCR is marked as such, because a digit OCR gets wrong appears identically
  in the quote and in the text the quote is checked against, so it passes verification. The
  guard cannot catch that; disclosure is the honest answer.
- A document read as page images carries a warning that nothing was checked at all.
- A document longer than the page cap names **which** pages were read. The reader takes the
  head and the tail, not the first N -- signatures, notices and governing law live at the
  end -- so "not found" never quietly means "not present".

## Known limits

- **Documents over 120 pages** are rejected rather than truncated.
- **Ambiguous numeric dates** (`03/04/2024`) are deliberately left empty for a human,
  and no end date is derived from one.
- **Notice addresses vary between runs** on the subscription engine, which has no
  structured-output guarantee. The API engine is stable here.
- **Every eval fixture is synthetic.** Accuracy against real IBC contracts is unmeasured
  until real files are available; the number above is against documents we wrote.
