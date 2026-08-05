# Putting the tracker on Bonnie's Mac

This folder builds `IBC Contracts.app`. It is for Ayush, not for Bonnie. She
never opens Terminal, never types a command, and never sees this file.

## The handoff, in full

**What Ayush does. Once, on his Mac:**

```sh
sh packaging/make-distributable.sh
```

Two minutes later there is one file in `dist/`:

```
dist/IBC-Contracts-1.0.0-macOS-arm64.zip        209 MB
```

Send her that file. Drive, AirDrop, or an attachment if the mail server will
take 209 MB. Nothing else needs to reach her Mac -- no repository, no clone, no
Node, no npm.

**What she does. Three steps:**

1. Double-click the `.zip`. A folder appears next to it.
2. **Right-click `install.command` -> Open.** Then click Open in the box that
   appears. (Right-click, not double-click. See the rough edge below.)
3. Watch. It narrates every step, takes about a minute, and never asks for a
   password.

**What she sees when it works.** A Terminal window counting `[1 of 6]` through
`[6 of 6]`, then the checkup listing PASS lines, then:

```
   ALL SET

   The checkup found nothing that stops the tracker working.

   The app is here:  /Applications/IBC Contracts.app
   Your contracts:   /Users/<her>/Library/Application Support/IBC Contract Tracker
```

...and then the tracker opens by itself, in a window with no tabs and no
address bar. She drags the icon from the running section of the Dock into the
permanent part, and from then on it is one click.

Measured end to end on an M-series Mac: **45 seconds**, from the double-click
to the app on screen. Three runs, from a zip carrying a real
`com.apple.quarantine` flag: 42s, 43s, 45s.

Then sit with her once and walk the first-run setup: the folder she drops PDFs
into, where exports go, which engine.

That is the whole install. It is safe to run again at any time -- to reinstall,
or because something looks wrong. Re-running never touches her data.

## The one rough edge

macOS quarantines anything that arrives by AirDrop, email, Slack or a browser
download. A quarantined `.command` refuses to run on a double-click: it shows a
security warning with no obvious way past it, and there is no wording of that
dialog that helps her.

**Right-click -> Open, then Open in the dialog.** That is the whole difference,
it is only needed the first time, and it is step 2 of the note in the zip.

The app itself never has this problem, and that is on purpose.
`install.command` assembles the `.app` locally, on her Mac, and a bundle
created locally is not quarantined -- so it opens with no dialog at all. **This
is why there is no prebuilt `.app` in the download and why you must never ship
one.** A downloaded `.app` is refused outright, and getting past that needs a
paid Apple Developer signing certificate.

The quarantine flag does travel *into* the download -- Archive Utility stamps
every file it unzips, and macOS `tar` stamps every file it extracts from a
stamped tarball. On a real install that was 263 files inside
`Contents/Resources`. So the installer strips `com.apple.quarantine`
recursively from the whole staged bundle before it moves it into
`/Applications`, and it does that in 1.8 seconds. Do not narrow that back down
to "the executable and the bundle directory".

## What is in the download

```
IBC-Contracts-1.0.0/
  READ ME FIRST.txt    four steps, for her
  install.command      right-click -> Open
  uninstall.command    the same, later
  manifest.json        version, architecture, SHA256 of the payload
  app-template/        the plists, the launcher, bin/, all rendered on her Mac
  payload/
    ibc-contracts-1.0.0-darwin-arm64.tar.gz   153 MB, prebuilt
    node-v24.18.1-darwin-arm64.tar.gz          50 MB
```

The payload is `.next` already built and `node_modules` already reduced to
production, in **exactly the tarball format the updater consumes**. One format
for both paths -- see "One payload builder" below.

209 MB compressed, 203 MB of which is those two tarballs; a `.zip` of things
that are already gzipped barely shrinks. It lands as about **805 MB installed**:
574 MB of `node_modules`, 34 MB of `.next`, and 188 MB of Node runtime. If
209 MB is too big to move, `--no-bundled-node` drops the runtime and the
installer downloads it from nodejs.org instead -- 50 MB smaller, and one more
thing that has to work on her network.

## What the installer actually does

It detects which of two shapes it is running in. There is no flag to remember:

- **download** -- a `manifest.json` and a `payload/` sit next to it. Nothing is
  compiled and nothing is fetched from npm.
- **source** -- it is in `packaging/` inside a full checkout. `npm ci` and
  `next build`, as before. This is how Ayush installs.

| Step | Download (hers) | Source (Ayush's) |
| --- | --- | --- |
| 1 | macOS 12+, processor, free space, and the payload's architecture must match this Mac | the same, minus the payload check |
| 2 | Node `v24.18.1` out of the folder, **checked against the SHA256 hard-coded in `common.sh`** -- never one from the manifest | the same, downloaded from nodejs.org |
| 3 | Verifies the payload SHA256, **then** unpacks it into `Contents/Resources/app` | copies the source tree in |
| 4 | -- | `npm ci` from `package-lock.json` |
| 5 | -- | `next build` |
| 6 | Draws the icon, writes `Info.plist`, strips quarantine, moves the bundle into `/Applications` | the same |
| 7 | Writes and loads both LaunchAgents | the same |
| 8 | Runs `npm run doctor` and prints the result | the same |

So she sees `[1 of 6]`; Ayush sees `[1 of 8]`.

The fingerprint is checked before a single byte is unpacked, both for the Node
runtime and for the payload -- the same rule the updater follows. A payload
whose checksum does not match is refused with a sentence naming what to do; it
is never unpacked "to see if it works anyway".

Node lives inside the bundle. A Homebrew upgrade, an OS update, or her deleting
some folder cannot break her tracker later.

If `/Applications` is not writable (a non-admin account), it installs to
`~/Applications` instead. It never escalates to sudo.

## One payload builder

`packaging/make-distributable.sh` is the only thing in this repository that
assembles a payload. It serves both paths:

```sh
sh packaging/make-distributable.sh                                 # the .zip
sh packaging/make-distributable.sh --payload-only --out ibc.tar.gz # the release asset
```

`.github/workflows/release.yml` calls the second form. It used to keep its own
copy of the assembly steps, which is how the thing she installs from and the
thing she updates through could quietly stop being the same shape. **If you are
about to write payload assembly anywhere else, don't.**

It builds in a copy under `$TMPDIR`, never in the checkout -- `npm ci
--omit=dev` deletes and reinstalls `node_modules`, and doing that in the
repository would take a working tree apart. It refuses to run anywhere but
macOS, on the processor the artifact will claim: `node_modules` carries
platform-gated packages, so there is no cross-compiling an Intel build on an
Apple silicon Mac. **An Intel Mac needs an artifact made on an Intel Mac**, and
the installer refuses a payload for the wrong processor by name rather than
letting it fail somewhere unreadable later.

And it does not hand back a tarball it has not watched work: it unpacks the
finished archive into a clean directory, starts it, and waits for a real `200`
on `/ibc-ping.txt` before it will emit anything. An exit code is a claim.

## How it stays running

`~/Library/LaunchAgents/com.internationalbattery.contract-tracker.plist`

- `RunAtLoad` -- the server is up before she clicks anything
- `ProcessType: Interactive` -- see below, this one is not cosmetic
- `KeepAlive` / `SuccessfulExit: false` -- a backstop only
- Logs to `~/Library/Application Support/IBC Contract Tracker/logs/`

`server.sh` supervises its own child in a loop, and holds the lock directory
for its whole life rather than just during startup. So there is exactly one
supervisor and exactly one server, and a crashed server is back in about four
seconds without launchd being involved.

### Three things that only showed up by running it

All three are worked around; all three will look like gratuitous complexity if
you do not know why they are there.

1. **`ProcessType` must be `Interactive`, never `Background`.** This looks like
   a background job and is not one. macOS applies hard disk-I/O throttling to
   `Background` jobs: under it the server took **18.9s to boot instead of
   0.6s** and then failed to answer a single request in two minutes. It
   presents exactly as a hang, and the same build started by hand was fine --
   which is what makes it so expensive to debug.

2. **Liveness is `GET /ibc-ping.txt`, not `GET /api/health`.** `/api/health`
   spawns the Claude CLI to report engine health. Polling it once a second
   while waiting for startup piled up fifteen concurrent CLI processes and
   wedged the server. The installer writes a marker file into the bundle's
   `public/`; Next serves it off disk with no route handler, no database and no
   subprocess, and requiring exactly `200` on a path only this app has also
   proves the port belongs to us -- a foreign server squatting on 47821 returns
   404 and is correctly ignored. **Do not "simplify" this back to the health
   endpoint**, or waiting for the app to start becomes the thing that stops it
   starting.

3. **`launchctl bootstrap` ignores `RunAtLoad`, and `KeepAlive` did not fire.**
   A minimal agent declaring nothing but `RunAtLoad` reports `runs = 0` after
   bootstrap, so the installer follows `bootstrap` with an explicit
   `kickstart`. Separately, after the child was killed, `server.sh` exited 137
   and launchd parked the respawn on its "successful exit" semaphore and never
   fired it -- which is why `server.sh` restarts its own child rather than
   trusting `KeepAlive`. Login is a different code path and does honour
   `RunAtLoad`, so it stays in the plist; nothing depends on it, because the
   `.app` launcher starts a server itself whenever none is answering.

The `.app` launcher and the LaunchAgent run the same `server.sh`, which takes a
lock directory and checks the health endpoint before starting anything. Whoever
gets there first wins; the other one logs a line and exits. There is never more
than one server.

## Ports

`47821`, then `47822`... up to `47830`. Not 3000 -- this machine had three other
things on 3000 during development, and "port in use" is not an error she can do
anything with. `server.sh` walks the range until it finds one it can bind,
writes the number to
`~/Library/Application Support/IBC Contract Tracker/runtime/port`, and the
launcher opens whatever port is actually serving rather than a hardcoded one.

## Shipping her an update

She never reinstalls. Ayush pushes a tag, and the next time her tracker looks it
finds it and offers her a button. **Nothing installs itself.**

### Cutting a release

1. Bump `IBC_VERSION` in `app-template/bin/common.sh`. That string is the app's
   version everywhere: the bundle, the Settings screen, the manifest.
2. Commit it.
3. `git tag -a v1.1.0 -m "Expiry dates now read the notice period."` -- the tag
   message is what she reads under the Install button, so write it for her, not
   for a changelog. Then `git push --follow-tags`.
4. `.github/workflows/release.yml` does the rest and **refuses to publish unless
   every one of these passes**: `tsc --noEmit`, `vitest run`, `next build`, and
   the tag matching `IBC_VERSION`. It then builds each payload by calling
   `packaging/make-distributable.sh --payload-only` -- the same script and the
   same steps that produce the download she installs from -- which unpacks the
   finished tarball into a clean directory, starts it and waits for a real `200`
   on `/ibc-ping.txt` before handing it back. A build that exits 0 and then
   cannot serve is exactly what the rollback machinery would otherwise inherit.
5. It publishes two tarballs (`darwin-arm64`, `darwin-x64`), `manifest.json` and
   `manifest-darwin-x64.json`.

Two optional switches, both read at release time:

- A line reading exactly `CRITICAL` in the tag message sets `critical` on the
  manifest and is stripped out of the note she reads.
- `packaging/UPDATE_MINIMUM_VERSION`, if the file exists, becomes
  `minimumSupportedVersion`: any install older than that is told to reinstall
  rather than half-updated. That is the escape hatch for a change the updater
  cannot carry, such as a new Node floor.

### What is in the tarball

```
ibc-contracts-<version>/
  app/     the app tree, plus a built .next (no build cache) and node_modules
           from the lockfile with dev dropped
  bin/     every *.sh in app-template/bin, plus launcher.sh
```

This is the same file that sits in `payload/` in the download, byte for byte
the same shape. `update.sh` unpacks it with `--strip-components 1`, so the
single top directory is consumed and `app/` lands where it belongs; the
installer unpacks it exactly the same way. Both then refuse it unless
`package.json`, `node_modules/next/dist/bin/next` and `.next/BUILD_ID` are all
present, and the builder asserts the same three -- so that failure lands on a
red build rather than on a rollback on her Mac.

`bin/` is iterated, never listed by name. The list was the bug: `repair.sh`
joined the bundle, nobody widened the list, and because `update.sh` installs
exactly what the payload carries, an update would have deleted self-repair from
her Mac. Each script is only installed if it parses.

Because `.next` and `node_modules` are prebuilt, an update costs her a download
rather than a build -- which is the same reason the first install does too.

### One tarball per processor, one manifest each

`node_modules` carries platform-gated packages -- `@next/swc-darwin-arm64` is
not the same file as the x64 one -- so an arm64 payload on an Intel Mac is a
tracker that will not start. The manifest schema describes exactly one payload,
so there is one manifest per processor:

| Asset | For | Payload URL |
| --- | --- | --- |
| `manifest.json` | Apple silicon | `asset:ibc-contracts-<v>-darwin-arm64.tar.gz` |
| `manifest-darwin-x64.json` | Intel | the full https download URL |

`manifest.json` is the fixed name a `githubRepo` source looks for, and the
`asset:` form resolves through the Releases API, so it works for a private
repository too. **On an Intel Mac**, point `manifestUrl` at
`.../releases/latest/download/manifest-darwin-x64.json` instead; a plain URL
needs the release to be public.

```json
{ "schemaVersion": 1, "version": "1.1.0",
  "url": "asset:ibc-contracts-1.1.0-darwin-arm64.tar.gz",
  "sha256": "<64 hex>", "sizeBytes": 41234567,
  "publishedAt": "2026-08-03T11:04:22Z",
  "notes": "Expiry dates now read the notice period.", "critical": false }
```

The `sha256` is checked before a single byte is unpacked, the same rule the Node
download follows. The workflow validates both manifests against that shape
before publishing, then fetches the published one over the network and checks
the version it reports, because "published" is a claim.

The two runner labels (`macos-14` for arm64, `macos-13` for x64) are pinned, and
each job asserts `uname -m` matches the architecture it is labelling. If GitHub
retires a label the matrix fails loudly; it never quietly ships one processor's
tarball under the other's name.

### Pointing her copy at the releases

Not settable over HTTP, deliberately: the app listens on localhost with no
authentication, so a route that could repoint the updater would be remote code
execution. It is a file on her Mac.

`~/Library/Application Support/IBC Contract Tracker/update/source.json`:

```json
{ "githubRepo": "<owner>/<repo>",
  "checkIntervalHours": 336,
  "automatic": false }
```

- `336` hours is the fortnight. It is the floor the scheduled check obeys; the
  LaunchAgent below fires more often than that on purpose.
- `automatic` must stay `false`. True means this Mac installs an update without
  being asked, and silent auto-install on a system of record is how she finds
  out by the thing being different.
- A private repository also needs `tokenFile`, a path to a file holding a bearer
  token. The token is read at request time and never stored, logged, or returned
  by any route.

### Checking she got it

Ask her to open **Settings -> Updates** and read you the top line. "Up to date"
with the version underneath is the whole answer. If it says nothing new is
available and the version is old, the check is the thing that is broken, not the
release:

```sh
tail -20 "$HOME/Library/Application Support/IBC Contract Tracker/logs/update.log"
```

One line per scheduled check, with the HTTP status the server actually returned.

### Rolling one back

A failed update rolls itself back and she stays on the version she had; the
Updates tab says so in plain words and never as an alarm. To pull a bad release
that did *not* fail on her Mac:

```sh
gh release delete v1.1.0 --yes            # stop it reaching anyone else
git push --delete origin v1.1.0
```

Then cut a *new, higher* version containing the fix -- `v1.1.1`, never a re-cut
`v1.1.0`. Her tracker compares versions; a version number that changes meaning
is a version number she can no longer trust. If she is already on the bad one,
tag the fix and tell her to press **Check for updates**.

## The fortnightly check

`app-template/UpdateCheck.plist.in` is a second LaunchAgent, separate from the
server's on purpose: it is allowed to fail, it is `Background` (nobody is
waiting on it), and it can never take the tracker down.

`StartCalendarInterval` is a calendar matcher and **cannot express "every two
weeks"**. So it fires weekly at 12:20 on a Monday, plus `RunAtLoad`, and the
fortnight is enforced by `checkIntervalHours` in `source.json`: a `GET
/api/update` runs a check behind the answer only when one is due. The floor
lives in one place, next to the timestamp it compares against. Three
consequences worth knowing:

- A Mac asleep at the scheduled minute checks shortly after it wakes, because
  launchd re-fires a missed calendar interval. A Mac that was **switched off**
  is the case `RunAtLoad` covers, since that replay is not reliable.
- Midday rather than the small hours, because a laptop is awake then, and a fire
  that lands while the Mac is awake is a check that happens now.
- The extra fires are free: one loopback request that returns immediately
  because nothing is due.

It never installs anything, and it cannot: **the only verb it uses is GET.** A
`POST {"action":"check"}` would force a check on every fire, turning a weekly
wake-up into a weekly check, and would put a state-changing verb in a job that
has no business holding one. It checks the HTTP status rather than trusting
curl's exit code -- curl exits 0 having reached a 404 from something else
squatting on the port.

The installer wires it up the same way it wires the server agent:

```sh
sed \
  -e "s|@@LABEL@@|$IBC_AGENT_LABEL.updatecheck|g" \
  -e "s|@@COMMON_SH@@|$APP_PATH/Contents/Resources/bin/common.sh|g" \
  -e "s|@@STDOUT@@|$IBC_LOG_DIR/updatecheck.out.log|g" \
  -e "s|@@STDERR@@|$IBC_LOG_DIR/updatecheck.err.log|g" \
  -e "s|@@HOME@@|$HOME|g" \
  -e "s|@@PATH@@|$AGENT_PATH|g" \
  "$TEMPLATE/UpdateCheck.plist.in" >"$HOME/Library/LaunchAgents/$IBC_AGENT_LABEL.updatecheck.plist"
```

...followed by `bootout || true`, `bootstrap`, and **an explicit `kickstart`**,
for the reason in the list above: `bootstrap` does not honour `RunAtLoad`.

`uninstall.command` must remove that plist too, or an uninstalled tracker leaves
an agent behind poking a port nothing is listening on.

## Removing it

`uninstall.command` -- same right-click -> Open rule. It makes you type
`remove` to confirm.

It deletes the app, the LaunchAgent and the cached Node download. **It does not
touch `~/Library/Application Support/IBC Contract Tracker/`** and says so on
screen while it runs. That folder is every contract she has ever reviewed.
Deleting it is a deliberate act in Finder, not something a double-clicked
script can do by accident.

## When she says it will not open

Everything is in
`~/Library/Application Support/IBC Contract Tracker/logs/`:

| File | What it tells you |
| --- | --- |
| `launcher.log` | What happened when she clicked the icon |
| `server.log` | The server's own output, including which port it took |
| `launchagent.err.log` | Whatever launchd could not start |

Then, over a screen share:

```sh
cd "/Applications/IBC Contracts.app/Contents/Resources/app"
"/Applications/IBC Contracts.app/Contents/Resources/node/bin/node" \
  "/Applications/IBC Contracts.app/Contents/Resources/node/lib/node_modules/npm/bin/npm-cli.js" \
  run doctor
```

`doctor` ends with a plain-text block written to be pasted into an email.

Re-running `install.command` fixes most things and costs her nothing.
