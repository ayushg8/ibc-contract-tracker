#!/bin/sh
#
# Build the one file Ayush sends Bonnie.
#
# This runs on AYUSH's Mac, never on hers. It ends with a single .zip he can put
# in Drive, AirDrop, or attach to an email. Everything slow, everything that
# needs the npm registry and everything that needs a build toolchain happens
# here, once, so that her side is: unzip, right-click Open, wait, done.
#
# WHY THIS EXISTS
#
# install.command used to need the whole source tree -- 644 MB of dev
# node_modules and a 721 MB .next -- and then ran `npm ci` and `next build` on
# her Mac. That is minutes of waiting, a toolchain she does not have, a registry
# she may not reach, and a class of failure ("Module not found in
# @tailwindcss/postcss") that she cannot read, cannot describe and cannot fix.
# None of it belongs on the machine of someone who will not open Terminal.
#
# ONE PAYLOAD FORMAT, NOT TWO
#
# The updater already consumes a tarball of prebuilt `.next` + production
# `node_modules` (see app-template/bin/update.sh). This script builds exactly
# that tarball and the installer consumes exactly that tarball, so the format
# she installs from is the format she updates through -- one shape, exercised by
# both paths, with no chance of drifting apart.
#
# That is also why `--payload-only` exists: .github/workflows/release.yml calls
# this same script to build its release asset. There is one payload builder in
# this repository and this is it. If you are about to write payload assembly
# anywhere else, don't.
#
# USAGE
#
#   sh packaging/make-distributable.sh                 # the .zip for Bonnie
#   sh packaging/make-distributable.sh --payload-only --out ibc.tar.gz
#
#   --out PATH          where to write. A directory for the default mode
#                       (default: <repo>/dist), a file for --payload-only.
#   --payload-only      emit just the update payload tarball, nothing else.
#   --update-repo O/N   where her copy will look for new versions, as a GitHub
#                       owner/name. Defaults to $IBC_UPDATE_GITHUB_REPO, then to
#                       this checkout's `origin` remote.
#   --update-url URL    the same thing as a plain manifest URL, for a build that
#                       does not use GitHub. Defaults to
#                       $IBC_UPDATE_MANIFEST_URL. https, file, or http to
#                       loopback -- the same rule src/lib/update/source.ts
#                       enforces at read time.
#   --no-bundled-node   leave the Node runtime out of the .zip; the installer
#                       downloads it instead. About 60 MB smaller, and one more
#                       thing that has to work on her network.
#   --skip-smoke        do not start the packaged server to prove it serves.
#                       For iterating on this script. Never for a real build.
#
# WHERE UPDATES COME FROM IS PART OF THE BUILD
#
# It has to be, and this is the second time that has been learned the hard way.
# The updater, the rollback and the guardrailed self-repair were all written and
# all tested, and nothing anywhere wrote update/source.json -- so on the only Mac
# that matters the whole mechanism was inert, while a fortnightly LaunchAgent
# fired forever and did nothing. The same shape as update.sh and repair.sh never
# being staged by the installer.
#
# So the value is resolved here, before anything is built, and a distributable
# that cannot ever update itself is REFUSED rather than produced. install.command
# reads it back out of the manifest and writes source.json on her Mac.

set -u

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$SELF_DIR/.." && pwd)
TEMPLATE="$SELF_DIR/app-template"

# shellcheck source=app-template/bin/common.sh
. "$TEMPLATE/bin/common.sh"

OUT=""
PAYLOAD_ONLY=0
BUNDLE_NODE=1
SMOKE=1
WORK=""
# Declared before the argument loop so `set -u` holds even when neither the flag
# nor the environment variable is given.
UPDATE_REPO="${IBC_UPDATE_GITHUB_REPO:-}"
UPDATE_URL="${IBC_UPDATE_MANIFEST_URL:-}"
UPDATE_REPO_EXPLICIT=0
UPDATE_URL_EXPLICIT=0

say() { printf '   %s\n' "$*"; }
note() { printf '\n==> %s\n' "$*"; }

die() {
  printf '\nmake-distributable: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  [ -n "$WORK" ] && [ -d "$WORK" ] && rm -rf "$WORK"
}
trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT TERM

# --- arguments -------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || die "--out needs a path"
      OUT="$2"
      shift 2
      ;;
    --payload-only)
      PAYLOAD_ONLY=1
      shift
      ;;
    --update-repo)
      [ $# -ge 2 ] || die "--update-repo needs an owner/name"
      UPDATE_REPO="$2"
      UPDATE_REPO_EXPLICIT=1
      shift 2
      ;;
    --update-url)
      [ $# -ge 2 ] || die "--update-url needs a URL"
      UPDATE_URL="$2"
      UPDATE_URL_EXPLICIT=1
      shift 2
      ;;
    --no-bundled-node)
      BUNDLE_NODE=0
      shift
      ;;
    --skip-smoke)
      SMOKE=0
      shift
      ;;
    -h | --help)
      cat <<'USAGE'
sh packaging/make-distributable.sh [options]

  --out PATH          where to write. A directory for the default mode
                      (default: <repo>/dist), a file for --payload-only.
  --payload-only      emit just the update payload tarball, nothing else.
  --update-repo O/N   where her copy looks for new versions (GitHub owner/name).
  --update-url URL    the same, as a plain manifest URL.
  --no-bundled-node   leave the Node runtime out of the .zip.
  --skip-smoke        do not start the packaged server to prove it serves.
USAGE
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

VERSION="$IBC_VERSION"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' ||
  die "IBC_VERSION in app-template/bin/common.sh is not a version: '$VERSION'"

# --- where her copy will look for new versions -----------------------------

# owner/name out of this checkout's `origin`, which is the repository the
# release workflow publishes to. Derived rather than typed, because a value
# somebody has to remember to pass is a value that is one day not passed.
git_origin_repo() {
  _url=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null) || return 1
  [ -n "$_url" ] || return 1
  _url=${_url%.git}
  case "$_url" in
    git@github.com:*) _repo=${_url#git@github.com:} ;;
    ssh://git@github.com/*) _repo=${_url#ssh://git@github.com/} ;;
    https://github.com/*) _repo=${_url#https://github.com/} ;;
    http://github.com/*) _repo=${_url#http://github.com/} ;;
    *) return 1 ;;
  esac
  printf '%s' "$_repo"
}

[ "$UPDATE_REPO_EXPLICIT" -eq 1 ] && [ "$UPDATE_URL_EXPLICIT" -eq 1 ] &&
  die "pass --update-repo or --update-url, not both: one build has one place it updates from"

if [ -z "$UPDATE_REPO" ] && [ -z "$UPDATE_URL" ]; then
  UPDATE_REPO=$(git_origin_repo) || UPDATE_REPO=""
fi

# The same two rules src/lib/update/source.ts applies when it reads the file, so
# a value that would be silently rejected on her Mac is refused here instead.
if [ -n "$UPDATE_URL" ]; then
  case "$UPDATE_URL" in
    https://* | file://* | http://127.0.0.1[:/]* | http://localhost[:/]*) ;;
    *) die "--update-url must be https, file, or http to loopback: '$UPDATE_URL'" ;;
  esac
elif [ -n "$UPDATE_REPO" ]; then
  printf '%s' "$UPDATE_REPO" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' ||
    die "--update-repo must be owner/name: '$UPDATE_REPO'"
fi

# One field, one answer. manifestUrl wins in source.ts, so it wins here and the
# other is cleared rather than left for two readers to resolve differently.
if [ -n "$UPDATE_URL" ]; then
  UPDATE_REPO=""
fi

# THE REFUSAL. A .zip with nothing in this field installs an app that can never
# update itself, while its fortnightly LaunchAgent wakes up forever and finds
# nowhere to ask. That is what shipped last time, and it is not shippable.
#
# Not enforced for --payload-only: that mode emits the update payload itself,
# which carries no source configuration and never has -- the manifest the
# installer reads is only written below.
if [ "$PAYLOAD_ONLY" -eq 0 ] && [ -z "$UPDATE_REPO" ] && [ -z "$UPDATE_URL" ]; then
  die "no update source: pass --update-repo owner/name (or --update-url), or set IBC_UPDATE_GITHUB_REPO. A download that cannot ever update itself is not built."
fi

# --- the machine this runs on ----------------------------------------------

# It has to be macOS, and it has to be the SAME processor the artifact claims.
# node_modules carries platform-gated packages -- @next/swc-darwin-arm64 is a
# different file from the x64 one, and @img/sharp-* likewise -- so a tree built
# on Linux, or on Intel for Apple silicon, is a tracker that will not start.
# There is no cross-compiling this; an Intel build needs an Intel Mac.
[ "$(uname -s)" = "Darwin" ] || die "this must run on a Mac: node_modules is platform-gated"
ARCH=$(ibc_node_arch) || die "unsupported processor $(uname -m)"

command -v npm >/dev/null 2>&1 || die "npm is not on PATH"
command -v node >/dev/null 2>&1 || die "node is not on PATH"
command -v rsync >/dev/null 2>&1 || die "rsync is not on PATH"

# The runtime that will ship inside the .app is pinned in common.sh. Building
# against a different MAJOR is how you get a native binding compiled for a
# module ABI the shipped runtime does not have. A different patch is fine and
# routine, so it is said out loud rather than refused.
BUILD_NODE=$(node -v)
PIN_MAJOR=$(printf '%s' "$IBC_NODE_VERSION" | sed -e 's/^v//' -e 's/\..*//')
BUILD_MAJOR=$(printf '%s' "$BUILD_NODE" | sed -e 's/^v//' -e 's/\..*//')
[ "$BUILD_MAJOR" = "$PIN_MAJOR" ] ||
  die "this Mac has Node $BUILD_NODE but the app ships $IBC_NODE_VERSION; build with the pinned major"

if [ -z "$OUT" ]; then
  if [ "$PAYLOAD_ONLY" -eq 1 ]; then
    OUT="$REPO_ROOT/dist/ibc-contracts-$VERSION-darwin-$ARCH.tar.gz"
  else
    OUT="$REPO_ROOT/dist"
  fi
fi

STARTED=$(date +%s)
note "IBC Contract Tracker $VERSION -- building for darwin-$ARCH with Node $BUILD_NODE"

# --- a clean tree to build in ----------------------------------------------

# Built in a copy, never in the checkout. `npm ci --omit=dev` deletes and
# reinstalls node_modules, and doing that in $REPO_ROOT would take Ayush's
# working tree apart underneath whatever else he has open in it.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ibc-dist.XXXXXX") || die "could not create a working directory"
TOP="$WORK/stage/ibc-contracts-$VERSION"
APP="$TOP/app"
mkdir -p "$APP" "$TOP/bin" || die "could not create the staging tree"

note "[1/6] Copying the source into a clean tree"

# The exclusion list, and why each one is here. This is the ONLY copy of this
# list: the release workflow calls this script rather than keeping its own.
#   node_modules/.next  built below, in place. Copying them in would be minutes
#                       spent moving 1.3 GB that is about to be replaced.
#   .git/.github/.gstack  history and tooling, not the product
#   tests/evals         developer-only, and evals carries fixture PDFs
#   packaging           the installer; the app does not need it at runtime
#   dist                previous artifacts, i.e. this script's own output
#   data                a local scratch database, if one was ever made
#   .env*               may hold a developer's API key. Keys live in the
#                       Keychain, and one must never ride along in a copy.
#                       A GLOB, not the two names. The two names is what this
#                       was, and .env.example sailed straight past it into the
#                       payload -- caught only because the assertion below
#                       looks for the same glob. .env.production and a stray
#                       .env.local.bak are the next two that would have.
rsync -a \
  --exclude '.git' \
  --exclude '.github' \
  --exclude '.gstack' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'tests' \
  --exclude 'evals' \
  --exclude 'packaging' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude '*.tsbuildinfo' \
  --exclude '.env*' \
  "$REPO_ROOT/" "$APP/" || die "could not stage the source"

[ -f "$APP/package.json" ] || die "the staged tree has no package.json"

# The liveness marker, written BEFORE the build for the same reason
# install.command writes it before the build: Next serves public/ straight off
# disk, so probing it costs the server nothing. It carries the version, so the
# answer is not "something is up" but "the code we installed is up".
mkdir -p "$APP/public"
printf '%s %s\n' "$IBC_BUNDLE_ID" "$VERSION" >"$APP/public/ibc-ping.txt" ||
  die "could not write the liveness marker"

# Without this the first OCR on her Mac reaches for a CDN. She may be on a plane
# or behind a proxy, and "the first scanned PDF failed and the next one worked"
# is not a thing anyone can debug later. Only a warning: a missing 5 MB file is
# not worth refusing a release over.
[ -f "$APP/eng.traineddata" ] ||
  say "WARNING: eng.traineddata is not in the tree; OCR will need the internet the first time"

# --- build ------------------------------------------------------------------

NEXT_TELEMETRY_DISABLED=1
export NEXT_TELEMETRY_DISABLED

note "[2/6] Installing dev dependencies and building"
say "This is the part she never has to run."
(cd "$APP" && npm ci --no-audit --no-fund) || die "npm ci failed"
# The same entry point the .app runs, not `npx`: one fewer resolver between the
# build that is tested and the build that ships.
(cd "$APP" && node node_modules/next/dist/bin/next build) || die "next build failed"
[ -f "$APP/.next/BUILD_ID" ] || die "next build exited 0 without producing .next/BUILD_ID"

note "[3/6] Reducing node_modules to what production needs"
# A fresh install rather than `npm prune`: prune leaves behind whatever a dev
# dependency dropped in place, and this tree is unpacked verbatim onto her Mac.
rm -rf "$APP/node_modules"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund) || die "npm ci --omit=dev failed"

# The build cache is not the build. It is scratch space Next recreates on
# demand, it is the single biggest thing in a .next, and shipping it would mean
# sending her hundreds of megabytes of incremental-compile state.
rm -rf "$APP/.next/cache" "$APP/.next/dev" "$APP/.next/trace"

# --- assemble the payload ---------------------------------------------------

note "[4/6] Assembling the update payload"

# The scripts that live OUTSIDE app/, so a bug in the supervisor, the launcher
# or the updater itself can be fixed by an update instead of a reinstall.
#
# Iterated, never listed by name. The list was the bug: repair.sh joined the
# bundle, nobody widened the list, and because update.sh installs exactly what
# the payload carries, an update would have silently deleted self-repair from
# her Mac. A directory cannot forget its own contents.
for f in "$TEMPLATE"/bin/*.sh; do
  [ -f "$f" ] || continue
  cp "$f" "$TOP/bin/$(basename "$f")" || die "could not copy $(basename "$f") into the payload"
done
cp "$TEMPLATE/launcher.sh" "$TOP/bin/launcher.sh" || die "could not copy launcher.sh into the payload"

# A failed cp is a script silently missing from the payload, which is a script
# silently removed from her install on the next update. Checked, not assumed.
for f in "$TEMPLATE"/bin/*.sh; do
  [ -f "$f" ] || continue
  [ -f "$TOP/bin/$(basename "$f")" ] || die "bin/$(basename "$f") did not reach the payload"
done
[ -f "$TOP/bin/launcher.sh" ] || die "bin/launcher.sh did not reach the payload"

# Exactly the three files update.sh refuses a payload without, plus the marker
# the health check reads. Failing here costs a rebuild; failing there costs a
# rollback on her Mac.
for need in package.json node_modules/next/dist/bin/next .next/BUILD_ID public/ibc-ping.txt; do
  [ -e "$APP/$need" ] || die "the payload has no $need"
done

# No key may ever ride along in a payload.
if find "$APP" -maxdepth 2 -name '.env*' | grep -q .; then
  die "an env file reached the payload"
fi

TARBALL_NAME="ibc-contracts-$VERSION-darwin-$ARCH.tar.gz"
TARBALL="$WORK/$TARBALL_NAME"
# One top directory, because update.sh unpacks with --strip-components 1.
tar -czf "$TARBALL" -C "$WORK/stage" "ibc-contracts-$VERSION" || die "could not create the payload tarball"

PAYLOAD_SHA=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
PAYLOAD_BYTES=$(wc -c <"$TARBALL" | tr -d ' ')
[ "${#PAYLOAD_SHA}" -eq 64 ] || die "could not checksum the payload"

# --- prove it serves --------------------------------------------------------

# An exit code is a claim. `next build` exiting 0 is a claim that a build
# happened, not evidence that what came out can answer a request -- and a
# payload that cannot start is exactly what the rollback machinery inherits.
if [ "$SMOKE" -eq 1 ]; then
  note "[5/6] Watching the finished tarball serve a request"
  SMOKE_DIR="$WORK/smoke"
  mkdir -p "$SMOKE_DIR"
  # Unpacked into a clean directory, the same way update.sh unpacks it, so the
  # thing under test is the artifact and not the tree it came from.
  tar -xzf "$TARBALL" -C "$SMOKE_DIR" --strip-components 1 || die "the payload will not unpack"
  [ -d "$SMOKE_DIR/app" ] || die "the payload has no app folder"

  SMOKE_PORT=""
  for p in 47891 47892 47893 47894 47895; do
    if node -e 'const s=require("node:net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$p"; then
      SMOKE_PORT="$p"
      break
    fi
  done
  [ -n "$SMOKE_PORT" ] || die "no free port to smoke test on"

  # Its own data directory. A smoke test must never touch a real tracker.db.
  IBC_DATA_DIR="$WORK/smoke-data"
  export IBC_DATA_DIR
  mkdir -p "$IBC_DATA_DIR"

  (
    cd "$SMOKE_DIR/app" || exit 1
    NODE_ENV=production exec node node_modules/next/dist/bin/next start \
      -H 127.0.0.1 -p "$SMOKE_PORT"
  ) >"$WORK/smoke.log" 2>&1 &
  SMOKE_PID=$!

  # Bounded by wall clock, never by iteration count: with a timeout on each
  # probe, "60 tries" is an unbounded amount of time.
  DEADLINE=$(($(date +%s) + 120))
  CODE=000
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
      break
    fi
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:$SMOKE_PORT/ibc-ping.txt" 2>/dev/null) || CODE=000
    [ "$CODE" = "200" ] && break
    sleep 2
  done
  kill "$SMOKE_PID" 2>/dev/null
  wait "$SMOKE_PID" 2>/dev/null
  if [ "$CODE" != "200" ]; then
    sed -n '1,40p' "$WORK/smoke.log" >&2 2>/dev/null
    die "the packaged tracker did not serve /ibc-ping.txt (last status $CODE)"
  fi
  say "Served /ibc-ping.txt with 200 out of the finished tarball."
else
  note "[5/6] Smoke test skipped (--skip-smoke)"
fi

# --- payload-only: this is what the release workflow wants ------------------

if [ "$PAYLOAD_ONLY" -eq 1 ]; then
  OUT_DIR=$(dirname -- "$OUT")
  mkdir -p "$OUT_DIR" || die "could not create $OUT_DIR"
  cp "$TARBALL" "$OUT" || die "could not write $OUT"
  printf '%s\n' "$PAYLOAD_SHA" >"$OUT.sha256"
  printf '%s\n' "$PAYLOAD_BYTES" >"$OUT.size"
  note "[6/6] Done"
  say "Payload:   $OUT"
  say "SHA256:    $PAYLOAD_SHA"
  say "Bytes:     $PAYLOAD_BYTES"
  exit 0
fi

# --- assemble what she downloads -------------------------------------------

note "[6/6] Assembling the download"

DIST_NAME="IBC-Contracts-$VERSION"
DIST="$WORK/$DIST_NAME"
mkdir -p "$DIST/payload" || die "could not create the distributable folder"

cp "$SELF_DIR/install.command" "$DIST/install.command" || die "could not copy install.command"
cp "$SELF_DIR/uninstall.command" "$DIST/uninstall.command" || die "could not copy uninstall.command"
chmod 755 "$DIST/install.command" "$DIST/uninstall.command"

# The templates the installer renders on her Mac: the plists, the launcher and
# the bin/ scripts. Copied whole rather than by name, for the same reason the
# payload's bin/ is.
rsync -a "$TEMPLATE/" "$DIST/app-template/" || die "could not copy app-template"

cp "$TARBALL" "$DIST/payload/$TARBALL_NAME" || die "could not copy the payload"

# The Node runtime, so the install needs nothing from the network at all. The
# installer still checks it against the SHA256 hard-coded in common.sh -- the
# fingerprint is never taken from the artifact, so a tampered .zip cannot also
# supply the answer that clears it.
NODE_TARBALL_NAME="node-$IBC_NODE_VERSION-darwin-$ARCH.tar.gz"
NODE_SHA=$(ibc_node_sha256 "$ARCH")
NODE_INCLUDED=0
if [ "$BUNDLE_NODE" -eq 1 ]; then
  NODE_CACHED="$IBC_CACHE_DIR/$NODE_TARBALL_NAME"
  if [ ! -f "$NODE_CACHED" ] ||
    [ "$(shasum -a 256 "$NODE_CACHED" 2>/dev/null | awk '{print $1}')" != "$NODE_SHA" ]; then
    say "Fetching $IBC_NODE_VERSION for $ARCH to bundle ..."
    mkdir -p "$IBC_CACHE_DIR"
    rm -f "$NODE_CACHED"
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -# \
      -o "$NODE_CACHED.part" \
      "https://nodejs.org/dist/$IBC_NODE_VERSION/$NODE_TARBALL_NAME" ||
      die "could not download the Node runtime"
    mv "$NODE_CACHED.part" "$NODE_CACHED"
  fi
  [ "$(shasum -a 256 "$NODE_CACHED" | awk '{print $1}')" = "$NODE_SHA" ] ||
    die "the Node runtime does not match the fingerprint pinned in common.sh"
  cp "$NODE_CACHED" "$DIST/payload/$NODE_TARBALL_NAME" || die "could not copy the Node runtime"
  NODE_INCLUDED=1
fi

# --- the manifest -----------------------------------------------------------

# One key per line, plain strings and integers, because the reader on the other
# end is install.command running under /bin/sh on a stock Mac -- and a stock Mac
# has no jq. Keep the shape flat; see manifest_get() in install.command.
PUBLISHED=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
{
  printf '{\n'
  printf '  "schemaVersion": 1,\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "arch": "%s",\n' "$ARCH"
  printf '  "url": "payload/%s",\n' "$TARBALL_NAME"
  printf '  "sha256": "%s",\n' "$PAYLOAD_SHA"
  printf '  "sizeBytes": %s,\n' "$PAYLOAD_BYTES"
  printf '  "nodeVersion": "%s",\n' "$IBC_NODE_VERSION"
  printf '  "nodeTarball": "%s",\n' "$([ "$NODE_INCLUDED" -eq 1 ] && printf 'payload/%s' "$NODE_TARBALL_NAME")"
  # Where her copy will look for new versions. install.command turns exactly one
  # of these into update/source.json on her Mac; without them the updater is
  # installed and inert. Exactly one is non-empty -- the refusal above is what
  # guarantees at least one, and the resolution above is what guarantees not two.
  printf '  "updateGithubRepo": "%s",\n' "$UPDATE_REPO"
  printf '  "updateManifestUrl": "%s",\n' "$UPDATE_URL"
  printf '  "publishedAt": "%s",\n' "$PUBLISHED"
  printf '  "builtOn": "darwin-%s node %s"\n' "$ARCH" "$BUILD_NODE"
  printf '}\n'
} >"$DIST/manifest.json" || die "could not write the manifest"

# --- the note she reads -----------------------------------------------------

# Deliberately short. A page of instructions is a page nobody reads; four lines
# and one warning is what actually gets followed.
cat >"$DIST/READ ME FIRST.txt" <<TXT
IBC Contract Tracker $VERSION
=================================

To install:

  1. Right-click "install.command" and choose Open.
     (Right-click, not double-click. macOS blocks a double-click on anything
     that arrived from the internet. Choosing Open is the way past it, and you
     only have to do it this once.)

  2. Click "Open" in the box that appears.

  3. A black Terminal window opens and narrates what it is doing. It takes
     about a minute. It never asks for a password.

  4. It finishes with "ALL SET" and opens the tracker for you. Drag the icon
     from the bottom of the Dock into the permanent part of the Dock, and from
     then on it is one click.

If anything goes wrong it stops and tells you what happened in plain words,
and nothing is damaged. Send that text to Ayush.

You can run install.command again at any time. It never touches your contracts.

To remove it later: uninstall.command, the same right-click -> Open.
Your contracts are NOT deleted by it -- they live in
~/Library/Application Support/IBC Contract Tracker.
TXT

# --- zip --------------------------------------------------------------------

mkdir -p "$OUT" || die "could not create $OUT"
# The output directory disowns itself. A 208 MB zip committed by accident is a
# repository nobody can clone again, and the alternative -- remembering to add a
# line to .gitignore -- is the kind of thing that gets remembered once.
printf '*\n' >"$OUT/.gitignore" 2>/dev/null || true
ZIP="$OUT/$DIST_NAME-macOS-$ARCH.zip"
rm -f "$ZIP"
# ditto rather than zip: it is what Finder's own Compress uses, it preserves the
# executable bit on install.command, and the .zip it makes is the one macOS
# expands most predictably on the other end.
ditto -c -k --sequesterRsrc --keepParent "$DIST" "$ZIP" || die "could not create $ZIP"

# --- the report -------------------------------------------------------------

ELAPSED=$(($(date +%s) - STARTED))
UNCOMPRESSED_KB=$(du -sk "$DIST" | awk '{print $1}')
ZIP_KB=$(du -k "$ZIP" | awk '{print $1}')
APP_KB=$(du -sk "$APP" | awk '{print $1}')
MODULES_KB=$(du -sk "$APP/node_modules" | awk '{print $1}')
NEXT_KB=$(du -sk "$APP/.next" | awk '{print $1}')
NODE_KB=0
NODE_UNPACKED_KB=0
if [ "$NODE_INCLUDED" -eq 1 ]; then
  NODE_KB=$(du -k "$DIST/payload/$NODE_TARBALL_NAME" | awk '{print $1}')
  # gzip records the uncompressed length in the trailer, so this is measured
  # rather than a multiple somebody guessed at.
  NODE_UNPACKED_KB=$(($(gzip -l "$DIST/payload/$NODE_TARBALL_NAME" | awk 'NR==2 {print $2}') / 1024))
fi

mb() { printf '%s MB' "$((($1 + 512) / 1024))"; }

printf '\n'
printf '   Send this file:  %s\n' "$ZIP"
printf '\n'
# Two numbers, kept apart on purpose. What Ayush has to move across a network
# is not what she ends up with on disk, and quoting one when someone meant the
# other is how "it is only 200 MB" becomes a full disk.
printf '   To send:         %s\n' "$(mb "$ZIP_KB")"
printf '     program files  %s\n' "$(mb $((PAYLOAD_BYTES / 1024)))"
if [ "$NODE_INCLUDED" -eq 1 ]; then
  printf '     Node runtime   %s   (drop it with --no-bundled-node)\n' "$(mb "$NODE_KB")"
fi
printf '     unzipped       %s   (it is a zip of two tarballs, so it barely shrinks)\n' \
  "$(mb "$UNCOMPRESSED_KB")"
printf '\n'
printf '   On her Mac:      about %s installed\n' "$(mb $((APP_KB + NODE_UNPACKED_KB)))"
printf '     node_modules   %s\n' "$(mb "$MODULES_KB")"
printf '     .next          %s\n' "$(mb "$NEXT_KB")"
printf '     app, total     %s\n' "$(mb "$APP_KB")"
if [ "$NODE_INCLUDED" -eq 1 ]; then
  printf '     Node runtime   %s\n' "$(mb "$NODE_UNPACKED_KB")"
fi
printf '\n'
# Said out loud in the report, because it is the one property of this build that
# cannot be checked by opening the .zip: it decides whether she ever gets a fix.
printf '   Updates from:    %s\n' "${UPDATE_URL:-$UPDATE_REPO}"
printf '     written to update/source.json by install.command, on her Mac,\n'
printf '     only if she has no source of her own already. Never automatic.\n'
printf '\n'
printf '   Built in:        %sm %ss\n' "$((ELAPSED / 60))" "$((ELAPSED % 60))"
printf '   For darwin-%s only. An Intel Mac needs a build made on an Intel Mac.\n' "$ARCH"
printf '\n'
