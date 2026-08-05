#!/bin/sh
#
# Double-click this to put IBC Contracts on a Mac.
#
# It is safe to run more than once: every step either replaces what it made
# last time or notices that the work is already done. It never asks for an
# administrator password and it never touches anything outside the app itself,
# ~/Library/LaunchAgents, ~/Library/Caches, and one file inside the tracker's own
# data folder -- update/source.json, which says where new versions come from and
# is written only when it is not there already. Nothing in the repository itself
# is ever read or written by this script.
#
# The narration is deliberate. Someone is usually watching this run, and a wall
# of npm output with no headings looks like a failure even when it is fine.

set -u

PACKAGING_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$PACKAGING_DIR/.." && pwd)
TEMPLATE="$PACKAGING_DIR/app-template"
MANIFEST="$PACKAGING_DIR/manifest.json"

# shellcheck source=app-template/bin/common.sh
. "$TEMPLATE/bin/common.sh"

# TWO SHAPES, ONE SCRIPT.
#
#   "download"  what Bonnie gets: a folder holding this script, app-template/,
#               a manifest and payload/ -- a prebuilt .next plus production
#               node_modules, in exactly the tarball format the updater already
#               consumes. Nothing is compiled here, nothing is fetched from npm.
#   "source"    what Ayush has: this script sitting in packaging/ inside a full
#               checkout. Installs from the lockfile and builds, as before.
#
# One script rather than two because the eighteen steps AROUND the payload --
# the runtime, the bundle, the plists, the agents, the doctor -- are identical,
# and two copies of them is two things to keep in step. The distinguishing fact
# is a manifest next to a payload, not a flag anyone has to remember to pass.
if [ -f "$MANIFEST" ] && [ -d "$PACKAGING_DIR/payload" ]; then
  MODE="download"
  TOTAL_STEPS=6
elif [ -f "$REPO_ROOT/package.json" ]; then
  MODE="source"
  TOTAL_STEPS=8
else
  MODE="unknown"
  TOTAL_STEPS=1
fi
STEP_NO=0

# --- narration -------------------------------------------------------------

rule() { printf '\n------------------------------------------------------------\n'; }
say() { printf '   %s\n' "$*"; }
blank() { printf '\n'; }

step() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n[%d of %d]  %s\n' "$STEP_NO" "$TOTAL_STEPS" "$1"
}

# Every failure names what broke and what to do next. No stack traces, ever.
fail() {
  rule
  printf '\n   THIS DID NOT FINISH\n\n'
  printf '   What went wrong:  %s\n' "$1"
  printf '   What to do:       %s\n' "$2"
  blank
  printf '   Nothing has been damaged. Any contracts already in the tracker\n'
  printf '   are untouched at:\n   %s\n' "$IBC_DATA_DIR"
  blank
  printf '   Press return to close this window.\n'
  read -r _ignored 2>/dev/null || true
  exit 1
}

# --- reading the manifest --------------------------------------------------

# The manifest is written by packaging/make-distributable.sh, one key per line,
# flat, with plain strings and integers. Parsed with sed and not with jq
# because a stock Mac does not have jq -- and a dependency she would have to
# install is a dependency she cannot install.
manifest_str() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" 2>/dev/null | head -1
}

manifest_num() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$MANIFEST" 2>/dev/null | head -1
}

rule
printf '\n   IBC Contract Tracker -- installer\n\n'
if [ "$MODE" = "download" ]; then
  printf '   This puts the tracker on this Mac and sets it up to be ready\n'
  printf '   the moment you log in. Everything it needs is already in this\n'
  printf '   folder, so it takes about a minute.\n'
else
  printf '   This puts the tracker on this Mac and sets it up to be ready\n'
  printf '   the moment you log in. It takes a few minutes, mostly waiting\n'
  printf '   on downloads. You can watch, or go get a coffee.\n'
fi
rule

# Where new versions will come from. Filled in from the manifest in a download,
# or from the environment in a source install. Declared here so `set -u` holds on
# every path through the script, including the ones that never reach step 7.
UPDATE_REPO=""
UPDATE_URL=""

if [ "$MODE" = "unknown" ]; then
  fail "This installer is on its own, without the tracker it installs." \
    "Move install.command back into the folder it came in, with app-template and payload next to it, and open it from there."
fi

# --- 1. this Mac -----------------------------------------------------------

step "Checking this Mac"

if [ "$(uname -s)" != "Darwin" ]; then
  fail "This is not a Mac." "Run this on the Mac that will use the tracker."
fi

ARCH=$(ibc_node_arch) || fail \
  "This Mac's processor ($(uname -m)) is not one we have a runtime for." \
  "Send Ayush the line above."
if [ "$ARCH" = "arm64" ]; then
  say "Processor:      Apple silicon"
else
  say "Processor:      Intel"
fi

MACOS_VER=$(sw_vers -productVersion 2>/dev/null || printf 'unknown')
say "macOS:          $MACOS_VER"

MACOS_MAJOR=$(printf '%s' "$MACOS_VER" | cut -d. -f1)
case "$MACOS_MAJOR" in
  [0-9]*) [ "$MACOS_MAJOR" -lt 12 ] && fail \
    "This Mac runs macOS $MACOS_VER, and the tracker needs macOS 12 or newer." \
    "Update macOS from System Settings, then run this installer again." ;;
esac

command -v curl >/dev/null 2>&1 || fail \
  "The 'curl' download tool is missing, which should not be possible on macOS." \
  "Send Ayush this message."

# Source: ~120 MB runtime, ~1.2 GB of packages, ~600 MB of build output.
# Download: the same runtime, plus one unpack of a payload that is already
# reduced to what production needs. Measured, not guessed.
if [ "$MODE" = "download" ]; then
  NEEDED_GB=2
else
  NEEDED_GB=4
fi
FREE_KB=$(df -k / | tail -1 | awk '{print $4}')
FREE_GB=$((FREE_KB / 1024 / 1024))
say "Free space:     ${FREE_GB} GB"
if [ "$FREE_GB" -lt "$NEEDED_GB" ]; then
  fail "There is only ${FREE_GB} GB free and the tracker needs about ${NEEDED_GB} GB." \
    "Empty the Trash or move some files off this Mac, then run this again."
fi

if [ -w "/Applications" ]; then
  APPS_DIR="/Applications"
else
  # No sudo. A non-admin account gets its own Applications folder instead,
  # which Spotlight and the Dock treat identically.
  APPS_DIR="$HOME/Applications"
  mkdir -p "$APPS_DIR" || fail \
    "Could not create $APPS_DIR." \
    "Send Ayush this message."
fi
APP_PATH="$APPS_DIR/$IBC_APP_NAME.app"
say "Will install to: $APP_PATH"

[ -f "$TEMPLATE/bin/server.sh" ] || fail \
  "The installer cannot find the app-template folder next to it." \
  "Keep install.command in the folder it came in and open it from there."

if [ "$MODE" = "download" ]; then
  PAYLOAD_VERSION=$(manifest_str version)
  PAYLOAD_ARCH=$(manifest_str arch)
  PAYLOAD_REL=$(manifest_str url)
  PAYLOAD_SHA=$(manifest_str sha256)
  NODE_BUNDLED_REL=$(manifest_str nodeTarball)
  # Baked in by make-distributable.sh, which refuses to build a download with
  # neither. Exactly one of them is set.
  UPDATE_REPO=$(manifest_str updateGithubRepo)
  UPDATE_URL=$(manifest_str updateManifestUrl)

  printf '%s' "$PAYLOAD_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' || fail \
    "The download's description file does not say which version it is." \
    "Ask Ayush to send the file again."
  printf '%s' "$PAYLOAD_SHA" | grep -Eq '^[0-9a-fA-F]{64}$' || fail \
    "The download's description file has no usable fingerprint." \
    "Ask Ayush to send the file again."

  # An installer that half-understands a newer manifest is worse than one that
  # refuses it: every field it fails to read comes back as an empty string, and
  # an empty fingerprint is a check that passes over nothing.
  [ "$(manifest_num schemaVersion)" = "1" ] || fail \
    "This download was made by a newer version of the packaging tools than this installer understands." \
    "Use the install.command that came in the same folder, or ask Ayush to build the file again."

  # node_modules carries platform-gated packages: @next/swc-darwin-arm64 is not
  # the same file as the x64 one. An arm64 payload on an Intel Mac is a tracker
  # that will not start, and it would not fail until well after this window has
  # closed -- so it is refused here, by name, in words Ayush can act on.
  if [ "$PAYLOAD_ARCH" != "$ARCH" ]; then
    fail "This copy of the tracker was built for a different kind of Mac (it is for '$PAYLOAD_ARCH', this Mac is '$ARCH')." \
      "Ask Ayush for the $ARCH build."
  fi

  # The bundle's version is stamped from IBC_VERSION in app-template's
  # common.sh, and the Updates screen reads it back. If it disagreed with the
  # payload, the tracker would report a version it is not running and "is there
  # a newer one" would be wrong from then on. They are written together by
  # make-distributable.sh, so a disagreement means two folders got mixed up.
  if [ "$PAYLOAD_VERSION" != "$IBC_VERSION" ]; then
    fail "This folder has version $PAYLOAD_VERSION's program files next to version $IBC_VERSION's installer." \
      "Unzip the file Ayush sent into a new, empty folder and open install.command from there."
  fi

  PAYLOAD_FILE="$PACKAGING_DIR/$PAYLOAD_REL"
  [ -f "$PAYLOAD_FILE" ] || fail \
    "The tracker's program files are missing from this folder." \
    "Unzip the file Ayush sent again, without moving anything out of it, and open install.command from inside the new folder."

  say "Version:        $PAYLOAD_VERSION (nothing to download)"
fi

if [ "$MODE" = "source" ]; then
  # A checkout carries no manifest, so the environment is the only place this
  # can come from. Optional here on purpose: Ayush's own working install does
  # not need to update itself, and an empty value simply leaves source.json
  # unwritten rather than failing an install that is otherwise fine.
  UPDATE_REPO="${IBC_UPDATE_GITHUB_REPO:-}"
  UPDATE_URL="${IBC_UPDATE_MANIFEST_URL:-}"
fi

# --- 2. node runtime -------------------------------------------------------

step "Getting the Node runtime"
say "The tracker carries its own copy so nothing you install or update"
say "later on this Mac can break it."

NODE_TARBALL_NAME="node-$IBC_NODE_VERSION-darwin-$ARCH.tar.gz"
NODE_URL="https://nodejs.org/dist/$IBC_NODE_VERSION/$NODE_TARBALL_NAME"
NODE_EXPECTED=$(ibc_node_sha256 "$ARCH")
mkdir -p "$IBC_CACHE_DIR" || fail "Could not create $IBC_CACHE_DIR." "Send Ayush this message."
NODE_CACHED="$IBC_CACHE_DIR/$NODE_TARBALL_NAME"

checksum_ok() {
  [ -f "$1" ] || return 1
  _got=$(shasum -a 256 "$1" 2>/dev/null | awk '{print $1}')
  [ "$_got" = "$NODE_EXPECTED" ]
}

# The download she was sent carries the runtime, so a normal install needs
# nothing from the network. It is still checked against the fingerprint
# hard-coded in common.sh -- never one taken from the folder it arrived in, or a
# tampered copy could supply the answer that clears it.
if [ "$MODE" = "download" ] && [ -n "$NODE_BUNDLED_REL" ] && ! checksum_ok "$NODE_CACHED"; then
  if [ -f "$PACKAGING_DIR/$NODE_BUNDLED_REL" ]; then
    mkdir -p "$IBC_CACHE_DIR"
    cp "$PACKAGING_DIR/$NODE_BUNDLED_REL" "$NODE_CACHED.part" 2>/dev/null &&
      mv "$NODE_CACHED.part" "$NODE_CACHED" 2>/dev/null
    rm -f "$NODE_CACHED.part" 2>/dev/null
  fi
fi

if checksum_ok "$NODE_CACHED"; then
  say "Verified against the fingerprint published by nodejs.org."
else
  rm -f "$NODE_CACHED"
  say "Downloading $IBC_NODE_VERSION for $ARCH ..."
  if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -# \
    -o "$NODE_CACHED.part" "$NODE_URL"; then
    rm -f "$NODE_CACHED.part"
    fail "The download from nodejs.org did not finish." \
      "Check this Mac is on the internet, then run this installer again."
  fi
  mv "$NODE_CACHED.part" "$NODE_CACHED"
  # A silently corrupt runtime produces failures deep inside the app that
  # nobody can trace back to here, so it is checked before it is ever unpacked.
  if ! checksum_ok "$NODE_CACHED"; then
    rm -f "$NODE_CACHED"
    fail "The downloaded runtime does not match its published fingerprint." \
      "This usually means the download was interrupted. Run this installer again."
  fi
  say "Download verified against the fingerprint published by nodejs.org."
fi

# --- 3. assemble the bundle ------------------------------------------------

step "Building the app"
say "The app is assembled here, on this Mac. That is what lets it open"
say "with no security warning."

STAGE="$APP_PATH.building"
rm -rf "$STAGE" 2>/dev/null
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources/bin" || fail \
  "Could not create $STAGE." \
  "Make sure $APPS_DIR is not locked, then run this installer again."

say "Unpacking the runtime ..."
mkdir -p "$STAGE/Contents/Resources/node"
if ! tar -xzf "$NODE_CACHED" -C "$STAGE/Contents/Resources/node" --strip-components 1; then
  rm -rf "$STAGE"
  fail "The runtime could not be unpacked." \
    "Run this installer again. If it happens twice, send Ayush this message."
fi
NODE_BIN="$STAGE/Contents/Resources/node/bin/node"
[ -x "$NODE_BIN" ] || {
  rm -rf "$STAGE"
  fail "The unpacked runtime is missing its main program." "Send Ayush this message."
}
say "Runtime ready: $("$NODE_BIN" -v)"

APP_SRC="$STAGE/Contents/Resources/app"

if [ "$MODE" = "download" ]; then
  # The fingerprint is checked while the payload is still one inert file. A
  # corrupt archive that gets unpacked anyway is a tracker that half works, and
  # half working is the one outcome this product cannot have.
  say "Checking the program files against their fingerprint ..."
  GOT_SHA=$(shasum -a 256 "$PAYLOAD_FILE" 2>/dev/null | awk '{print $1}' | tr 'A-Z' 'a-z')
  WANT_SHA=$(printf '%s' "$PAYLOAD_SHA" | tr 'A-Z' 'a-z')
  if [ -z "$GOT_SHA" ] || [ "$GOT_SHA" != "$WANT_SHA" ]; then
    rm -rf "$STAGE"
    fail "The tracker's program files do not match their fingerprint, which means the download was damaged on the way here." \
      "Ask Ayush to send the file again, and unzip it before opening install.command."
  fi

  say "Unpacking the tracker ..."
  UNPACK="$STAGE/Contents/Resources/.payload"
  mkdir -p "$UNPACK"
  # --strip-components 1, the same way update.sh unpacks the same format.
  if ! tar -xzf "$PAYLOAD_FILE" -C "$UNPACK" --strip-components 1; then
    rm -rf "$STAGE"
    fail "The tracker's program files could not be unpacked." \
      "Ask Ayush to send the file again."
  fi
  [ -d "$UNPACK/app" ] || {
    rm -rf "$STAGE"
    fail "The tracker's program files are not in the shape the installer expects." \
      "Send Ayush this message."
  }
  # tar exiting 0 says the bytes came out. It says nothing about whether what
  # came out is an app. These are the same three files update.sh refuses a
  # payload without, asserted here for the same reason: finding out afterwards
  # means finding out from a tracker that will not start.
  for NEED in package.json node_modules/next/dist/bin/next .next/BUILD_ID; do
    [ -e "$UNPACK/app/$NEED" ] || {
      rm -rf "$STAGE"
      fail "The tracker's program files are incomplete (no $NEED)." \
        "Ask Ayush to send the file again."
    }
  done
  mv "$UNPACK/app" "$APP_SRC" || {
    rm -rf "$STAGE"
    fail "The tracker's program files could not be moved into place." \
      "Run this installer again. If it happens twice, send Ayush this message."
  }
  rm -rf "$UNPACK"
fi

if [ "$MODE" = "source" ]; then
  say "Copying the tracker's code ..."
  mkdir -p "$APP_SRC"
  # Excludes, and why:
  #   node_modules/.next   rebuilt below, and copying them risks stale artefacts
  #   .git/.gstack         history and tooling, not part of the product
  #   tests/evals          developer-only, and they would slow the build
  #   packaging            this installer; the app does not need it at runtime
  #   dist                 make-distributable.sh's own output. 208 MB of zip
  #                        that would otherwise be copied into her .app.
  #   data                 a local scratch database, if one was ever made
  #   .env*                may hold a developer's API key. Keys belong in the
  #                        Keychain, and one must never ride along in a copy.
  #                        A glob, not the two names: .env.example is at the
  #                        repo root and the two names let it straight through.
  if ! rsync -a \
    --exclude '.git' \
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
    "$REPO_ROOT/" "$APP_SRC/"; then
    rm -rf "$STAGE"
    fail "The tracker's code could not be copied." \
      "Run this installer again. If it happens twice, send Ayush this message."
  fi
fi

# The liveness marker. Next serves public/ straight off disk, so asking for
# this file costs the server nothing -- which is the whole point. Written
# before the build so it cannot depend on how Next treats public/ afterwards.
# See common.sh for why /api/health cannot do this job.
mkdir -p "$APP_SRC/public"
printf '%s %s\n' "$IBC_BUNDLE_ID" "$IBC_VERSION" >"$APP_SRC/public/ibc-ping.txt" || {
  rm -rf "$STAGE"
  fail "Could not write the app's startup marker." "Send Ayush this message."
}

PATH="$STAGE/Contents/Resources/node/bin:$PATH"
export PATH
NPM_BIN="$STAGE/Contents/Resources/node/lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_BIN" ] || {
  rm -rf "$STAGE"
  fail "The runtime did not come with npm." "Send Ayush this message."
}

NEXT_TELEMETRY_DISABLED=1
export NEXT_TELEMETRY_DISABLED

# --- 4 and 5. dependencies and build, from source only ---------------------
#
# Neither of these happens on her Mac. The download she is sent already carries
# node_modules reduced to production and a finished .next, which is the entire
# point of it: no npm registry, no build toolchain, no eight-minute wait, and
# none of the failures those bring with them. They are still here because Ayush
# installs from a checkout, where there is nothing prebuilt to use.
if [ "$MODE" = "source" ]; then
  step "Installing the tracker's parts (this is the slow one)"
  say "Downloading exactly the versions recorded in package-lock.json, so"
  say "this install matches every other install of the same version."

  if ! (cd "$APP_SRC" && "$NODE_BIN" "$NPM_BIN" ci --no-audit --no-fund); then
    rm -rf "$STAGE"
    fail "The tracker's parts could not be downloaded." \
      "Check this Mac is on the internet, then run this installer again."
  fi

  step "Preparing the screens"
  say "Compiling everything once now, so it opens instantly later."

  if ! (cd "$APP_SRC" && "$NODE_BIN" node_modules/next/dist/bin/next build); then
    rm -rf "$STAGE"
    fail "The tracker's screens could not be compiled." \
      "Send Ayush everything printed above this line."
  fi
fi

# --- 6. bundle plumbing ----------------------------------------------------

step "Wrapping it up as a Mac app"

# Taken from the copy that has just landed in the bundle rather than from the
# checkout, because in a download there is no checkout to take it from. Both
# modes put the same file in the same place, so this is one path, not two.
ICON_NAME="IBCContracts"
if ! "$NODE_BIN" "$APP_SRC/scripts/make-icon.mjs" \
  "$STAGE/Contents/Resources/$ICON_NAME.icns" >/dev/null 2>&1; then
  # An icon is cosmetic. Losing it is not worth failing an otherwise good
  # install over, so it degrades to the generic app icon.
  say "Note: the icon could not be drawn. The app will use a plain one."
  ICON_NAME=""
fi

sed \
  -e "s|@@NAME@@|$IBC_APP_NAME|g" \
  -e "s|@@BUNDLE_ID@@|$IBC_BUNDLE_ID|g" \
  -e "s|@@EXECUTABLE@@|$IBC_EXECUTABLE|g" \
  -e "s|@@ICON@@|$ICON_NAME|g" \
  -e "s|@@VERSION@@|$IBC_VERSION|g" \
  "$TEMPLATE/Info.plist.in" >"$STAGE/Contents/Info.plist" || {
  rm -rf "$STAGE"
  fail "Could not write the app's description file." "Send Ayush this message."
}

# Every script in the template's bin/, never a list of names. The list was the
# bug: update.sh and repair.sh had been written, were never added here, and so
# the whole update-rollback-repair mechanism was missing from the only Mac that
# matters -- the app looked for bin/update.sh, did not find it, and reported
# itself as unable to update at all. A directory cannot forget its own contents.
for SCRIPT in "$TEMPLATE"/bin/*.sh; do
  [ -f "$SCRIPT" ] || continue
  SCRIPT_NAME=$(basename "$SCRIPT")
  cp "$SCRIPT" "$STAGE/Contents/Resources/bin/$SCRIPT_NAME" || {
    rm -rf "$STAGE"
    fail "The app's $SCRIPT_NAME could not be copied into the bundle." \
      "Run this installer again. If it happens twice, send Ayush this message."
  }
  chmod 755 "$STAGE/Contents/Resources/bin/$SCRIPT_NAME"
done

cp "$TEMPLATE/launcher.sh" "$STAGE/Contents/MacOS/$IBC_EXECUTABLE"
chmod 755 "$STAGE/Contents/MacOS/$IBC_EXECUTABLE"

printf 'APPL????' >"$STAGE/Contents/PkgInfo"

# Strip com.apple.quarantine from the WHOLE bundle, not from the two places it
# was once assumed to be able to appear.
#
# Measured, not theorised. A download that arrived by AirDrop is quarantined,
# Archive Utility stamps every file it unzips out of it, and macOS tar then
# stamps every file it extracts out of a quarantined tarball -- so a real
# install put the flag on 263 files inside Contents/Resources, which the old
# two-line version did not look at. The bundle directory and the MacOS
# executable are what Gatekeeper checks first and they were clean, so it
# opened; but "it happened to be the files nobody checks" is not a property
# worth relying on when the failure mode is a security dialog she cannot
# answer and cannot describe.
#
# 1.8 seconds on the finished 799 MB bundle. Cheap enough to stop thinking
# about which files could have picked it up.
xattr -rd com.apple.quarantine "$STAGE" >/dev/null 2>&1

# Stop the old server before its files move out from under it.
launchctl bootout "gui/$(id -u)/$IBC_AGENT_LABEL" >/dev/null 2>&1
sleep 1

if [ -e "$APP_PATH" ]; then
  say "Replacing the previous version ..."
  rm -rf "$APP_PATH.old" 2>/dev/null
  mv "$APP_PATH" "$APP_PATH.old" || {
    rm -rf "$STAGE"
    fail "The previous version of the app could not be moved aside." \
      "Quit IBC Contracts if it is open, then run this installer again."
  }
fi

if ! mv "$STAGE" "$APP_PATH"; then
  mv "$APP_PATH.old" "$APP_PATH" 2>/dev/null
  rm -rf "$STAGE"
  fail "The app could not be moved into $APPS_DIR." \
    "Run this installer again. If it happens twice, send Ayush this message."
fi
rm -rf "$APP_PATH.old" 2>/dev/null
touch "$APP_PATH"
say "Installed: $APP_PATH"

# Everything from here on lives at the final path. The staging paths are gone,
# and a stale NODE_BIN pointing into them is exactly the kind of bug that only
# shows up on the one machine that matters.
NODE_BIN="$APP_PATH/Contents/Resources/node/bin/node"
NPM_BIN="$APP_PATH/Contents/Resources/node/lib/node_modules/npm/bin/npm-cli.js"
PATH="$APP_PATH/Contents/Resources/node/bin:$PATH"
export PATH

# --- 7. login item ---------------------------------------------------------

step "Making it start on its own when you log in"
say "So clicking the icon opens a window straight away instead of"
say "waiting for the tracker to wake up."

mkdir -p "$HOME/Library/LaunchAgents" "$IBC_LOG_DIR" "$IBC_RUNTIME_DIR"

AGENT_PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/bin:$APP_PATH/Contents/Resources/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

sed \
  -e "s|@@LABEL@@|$IBC_AGENT_LABEL|g" \
  -e "s|@@SERVER_SH@@|$APP_PATH/Contents/Resources/bin/server.sh|g" \
  -e "s|@@APP_DIR@@|$APP_PATH/Contents/Resources/app|g" \
  -e "s|@@STDOUT@@|$IBC_LOG_DIR/launchagent.out.log|g" \
  -e "s|@@STDERR@@|$IBC_LOG_DIR/launchagent.err.log|g" \
  -e "s|@@HOME@@|$HOME|g" \
  -e "s|@@PATH@@|$AGENT_PATH|g" \
  "$TEMPLATE/LaunchAgent.plist.in" >"$IBC_AGENT_PLIST" || fail \
  "Could not write the login item." "Send Ayush this message."

plutil -lint "$IBC_AGENT_PLIST" >/dev/null 2>&1 || fail \
  "The login item came out malformed." "Send Ayush this message."

launchctl bootout "gui/$(id -u)/$IBC_AGENT_LABEL" >/dev/null 2>&1
if launchctl bootstrap "gui/$(id -u)" "$IBC_AGENT_PLIST" >/dev/null 2>&1; then
  # RunAtLoad governs login. On macOS 26 it is NOT honoured by `bootstrap` --
  # measured here: a minimal agent with nothing but RunAtLoad reports runs=0
  # after being bootstrapped. So the first start is asked for explicitly rather
  # than assumed, otherwise the tracker is only running after her next login.
  launchctl kickstart "gui/$(id -u)/$IBC_AGENT_LABEL" >/dev/null 2>&1
  say "Login item installed and started."
else
  # Not fatal: the .app launcher starts a server itself when launchd has not.
  say "Note: the login item could not be started right now. The app will"
  say "still work; it just takes a few extra seconds to open the first time."
fi

# --- where updates come from -----------------------------------------------
#
# Written BEFORE the checking agent is bootstrapped, so its first fire has
# somewhere to ask. Without this file the updater, the rollback and the
# self-repair are all installed and all inert -- which is exactly what shipped:
# nothing in packaging wrote it, and the fortnightly agent woke up forever and
# found nowhere to look.
#
# It lives in her data folder rather than in the app bundle because it has to
# OUTLIVE the thing being updated, and it is not settable over HTTP because the
# app listens on localhost with no authentication: a route that could repoint
# the updater would turn any web page she has open into remote code execution.
# See src/lib/update/source.ts.
UPDATE_DIR="$IBC_DATA_DIR/update"
UPDATE_SOURCE="$UPDATE_DIR/source.json"

if [ -f "$UPDATE_SOURCE" ]; then
  # Never overwritten. A file already here was put here on purpose -- by hand,
  # or by an earlier install -- and it may carry a tokenFile for a private
  # repository that this installer knows nothing about.
  say "Update source: already set on this Mac, left as it is."
elif [ -n "$UPDATE_URL" ] || [ -n "$UPDATE_REPO" ]; then
  mkdir -p "$UPDATE_DIR" || fail \
    "Could not create $UPDATE_DIR." "Send Ayush this message."
  if [ -n "$UPDATE_URL" ]; then
    UPDATE_FIELD=$(printf '"manifestUrl": "%s"' "$UPDATE_URL")
  else
    UPDATE_FIELD=$(printf '"githubRepo": "%s"' "$UPDATE_REPO")
  fi
  # 336 hours is the fortnight, and it has to live here: StartCalendarInterval
  # cannot express "every two weeks", so the agent fires weekly and this is the
  # floor that turns that into a fortnight. `automatic` is false because a
  # system of record must not change under her without being asked.
  #
  # Written to a temp name and renamed, so a full disk or a machine that loses
  # power mid-write leaves either the old file or the new one, never half of a
  # JSON document the app would then refuse to read.
  {
    printf '{\n'
    printf '  %s,\n' "$UPDATE_FIELD"
    printf '  "automatic": false,\n'
    printf '  "checkIntervalHours": 336\n'
    printf '}\n'
  } >"$UPDATE_SOURCE.part" || fail \
    "Could not write $UPDATE_SOURCE." "Send Ayush this message."
  mv "$UPDATE_SOURCE.part" "$UPDATE_SOURCE" || fail \
    "Could not put $UPDATE_SOURCE in place." "Send Ayush this message."
  say "Updates will come from: ${UPDATE_URL:-$UPDATE_REPO}"
else
  # Only reachable from a source install with nothing in the environment. A
  # download cannot get here: make-distributable.sh refuses to build one.
  say "Note: this copy has nowhere to check for updates."
fi

# The fortnightly update check, as a second agent. Separate from the server's on
# purpose: it is allowed to fail, allowed to be throttled and must never be able
# to take the tracker down with it. It only ever sends a GET, so it can offer an
# update and can never install one. See app-template/UpdateCheck.plist.in.
#
# Without this the tracker only ever notices a new version when she happens to
# open Settings, which for a machine that pushes fixes to a CFO who will not
# open Terminal means it effectively never notices one.
UPDATECHECK_LABEL="$IBC_AGENT_LABEL.updatecheck"
UPDATECHECK_PLIST="$HOME/Library/LaunchAgents/$UPDATECHECK_LABEL.plist"

sed \
  -e "s|@@LABEL@@|$UPDATECHECK_LABEL|g" \
  -e "s|@@COMMON_SH@@|$APP_PATH/Contents/Resources/bin/common.sh|g" \
  -e "s|@@STDOUT@@|$IBC_LOG_DIR/updatecheck.out.log|g" \
  -e "s|@@STDERR@@|$IBC_LOG_DIR/updatecheck.err.log|g" \
  -e "s|@@HOME@@|$HOME|g" \
  -e "s|@@PATH@@|$AGENT_PATH|g" \
  "$TEMPLATE/UpdateCheck.plist.in" >"$UPDATECHECK_PLIST" || fail \
  "Could not write the update checker." "Send Ayush this message."

plutil -lint "$UPDATECHECK_PLIST" >/dev/null 2>&1 || fail \
  "The update checker came out malformed." "Send Ayush this message."

launchctl bootout "gui/$(id -u)/$UPDATECHECK_LABEL" >/dev/null 2>&1
if launchctl bootstrap "gui/$(id -u)" "$UPDATECHECK_PLIST" >/dev/null 2>&1; then
  # The same measured reason as the server agent above: `bootstrap` does not
  # honour RunAtLoad, so the first check is asked for rather than assumed.
  launchctl kickstart "gui/$(id -u)/$UPDATECHECK_LABEL" >/dev/null 2>&1
  say "Update checker installed and started."
else
  # Not fatal either: the Updates screen still checks and still installs on
  # demand. Only the unattended half is missing.
  say "Note: the update checker could not be started right now. Updates can"
  say "still be installed from the Updates screen inside the app."
fi

# --- 8. checkup ------------------------------------------------------------

step "Running the checkup"

DOCTOR_STATUS=0
(cd "$APP_PATH/Contents/Resources/app" && "$NODE_BIN" "$NPM_BIN" run --silent doctor) || DOCTOR_STATUS=$?

rule
if [ "$DOCTOR_STATUS" -eq 0 ]; then
  printf '\n   ALL SET\n\n'
  printf '   The checkup found nothing that stops the tracker working.\n'
else
  printf '\n   INSTALLED, WITH SOMETHING TO SORT OUT\n\n'
  printf '   The checkup above found something that needs attention. The app\n'
  printf '   is installed and will open -- go to Diagnostics inside it, which\n'
  printf '   explains each item and gives you a button to fix it.\n'
fi
blank
printf '   The app is here:  %s\n' "$APP_PATH"
printf '   Your contracts:   %s\n' "$IBC_DATA_DIR"
blank
printf '   Drag the app onto the Dock once, and from then on it is one click.\n'
rule
blank

say "Opening it now ..."
open "$APP_PATH"

blank
printf '   Press return to close this window.\n'
read -r _ignored 2>/dev/null || true
