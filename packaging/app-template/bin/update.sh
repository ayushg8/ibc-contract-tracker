#!/bin/sh
#
# Applies one update, from a published tarball to a health-checked server.
#
# Run detached by the app itself (POST /api/update). It CANNOT be part of the
# server it is updating: step five is "restart the server and check it came
# back", and a process cannot observe its own restart. So this script stops the
# server, swaps the code, starts it again and then asks the new server, over
# HTTP, which version it is -- and puts everything back if the answer is wrong.
#
# THE RULE THIS SCRIPT IS BUILT AROUND
#
#   An exit code is a claim, not evidence.
#
# The launcher learned this the hard way: `launchctl kickstart` returns 0 having
# merely ACCEPTED a request, and on this machine it has accepted and then never
# brought the service up. So nothing here concludes anything from an exit code.
# curl returning 0 does not mean the payload is the right payload -- the SHA256
# says that. tar returning 0 does not mean the payload is a whole app -- the
# file list says that. launchctl returning 0 does not mean the server is running
# -- the app answering with its own version number says that.
#
# WHAT IT WILL NOT DO
#
#   - It never touches the data directory. tracker.db, archive/, thumbnails/,
#     exports/ and the settings are hers and are not part of the app. The only
#     thing written under the data folder is this mechanism's own state in
#     update/, plus the log.
#   - It never unpacks a payload whose fingerprint does not match.
#   - It never deletes the version it came from until the new one has answered.
#
# Progress goes into $UPDATE_DIR/progress and the outcome into
# $UPDATE_DIR/result, both as `key value` lines -- value is everything after the
# first space, which is how paths with spaces survive. src/lib/update/runtime.ts
# reads them; tests/update.test.ts pins the format from both sides.

set -u

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
DEFAULT_RES_DIR=$(cd -- "$SELF_DIR/.." && pwd)

if [ ! -f "$SELF_DIR/common.sh" ]; then
  printf 'update.sh: cannot find common.sh next to it\n' >&2
  exit 1
fi

# shellcheck source=common.sh
. "$SELF_DIR/common.sh"

UPDATE_DIR="${IBC_UPDATE_DIR:-$IBC_DATA_DIR/update}"
LOCK_DIR="$UPDATE_DIR/apply.lock"
PLAN_FILE="$UPDATE_DIR/plan"
PROGRESS_FILE="$UPDATE_DIR/progress"
RESULT_FILE="$UPDATE_DIR/result"
DOWNLOAD_DIR="$UPDATE_DIR/downloads"

IBC_LOG_TARGET="$IBC_LOG_DIR/update.log"
UID_NUM=$(id -u)

# --- budgets ---------------------------------------------------------------
# Wall clock, never iteration counts: counting iterations makes the real timeout
# depend on how slow each probe was, i.e. longest exactly when things are worst.
#
# Overridable so the regression suite can drive a whole apply-and-roll-back cycle
# in seconds instead of minutes. The defaults are what ships, and the test file
# asserts these exact numbers so an override can never quietly become the norm.
DOWNLOAD_MAX_SECONDS=1800
STOP_TIMEOUT="${IBC_UPDATE_STOP_TIMEOUT:-45}"
LAUNCHD_GRACE="${IBC_UPDATE_LAUNCHD_GRACE:-20}"
HEALTH_TIMEOUT="${IBC_UPDATE_HEALTH_TIMEOUT:-180}"
ROLLBACK_HEALTH_TIMEOUT="${IBC_UPDATE_ROLLBACK_TIMEOUT:-240}"
# Below this much free space we do not start. Three times the payload covers the
# tarball plus the unpacked copy plus the version we are keeping for rollback.
MIN_FREE_KB=512000

# --- state used by the reporters -------------------------------------------
PHASE="idle"
MODE="apply"
NEW_VERSION=""
OLD_VERSION=""
STARTED_AT=""
STAGING=""
TARBALL=""
CURL_CONFIG=""
RESOURCES="$DEFAULT_RES_DIR"
APP_LINK=""
PREVIOUS_TARGET=""
ROLLED_BACK_TO=""
ROLLBACK_OK="0"
USED_LAUNCHD=""
LOCK_HELD=""

now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

# Values live on one line in a `key value` file, so anything that could break
# that is flattened here rather than at every call site.
one_line() {
  printf '%s' "$*" | tr '\n\r\t' '   ' | cut -c1-400
}

set_phase() {
  PHASE="$1"
  _note=$(one_line "$2")
  mkdir -p "$UPDATE_DIR" 2>/dev/null || true
  {
    printf 'phase %s\n' "$PHASE"
    printf 'version %s\n' "$NEW_VERSION"
    printf 'fromVersion %s\n' "$OLD_VERSION"
    printf 'startedAt %s\n' "$STARTED_AT"
    printf 'pid %s\n' "$$"
    printf 'note %s\n' "$_note"
  } >"$PROGRESS_FILE.tmp" 2>/dev/null
  mv -f "$PROGRESS_FILE.tmp" "$PROGRESS_FILE" 2>/dev/null || true
  ibc_log "[$PHASE] $_note"
}

write_result() {
  mkdir -p "$UPDATE_DIR" 2>/dev/null || true
  {
    printf 'ok %s\n' "$1"
    printf 'version %s\n' "$NEW_VERSION"
    printf 'fromVersion %s\n' "$OLD_VERSION"
    printf 'startedAt %s\n' "$STARTED_AT"
    printf 'finishedAt %s\n' "$(now_iso)"
    printf 'failCode %s\n' "$2"
    printf 'failPhase %s\n' "$3"
    printf 'detail %s\n' "$(one_line "$4")"
    printf 'rolledBackTo %s\n' "$ROLLED_BACK_TO"
    printf 'rollbackOk %s\n' "$ROLLBACK_OK"
  } >"$RESULT_FILE.tmp" 2>/dev/null
  mv -f "$RESULT_FILE.tmp" "$RESULT_FILE" 2>/dev/null || true
}

release_lock() {
  if [ -n "$LOCK_HELD" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    LOCK_HELD=""
  fi
}

cleanup() {
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
    rm -rf "$STAGING" 2>/dev/null || true
  fi
  if [ -n "$TARBALL" ]; then
    rm -f "$TARBALL" "$TARBALL.part" 2>/dev/null || true
  fi
  # The token file goes first and goes always. It is the only secret this
  # script ever holds and it must not outlive the download by a second.
  if [ -n "$CURL_CONFIG" ]; then
    rm -f "$CURL_CONFIG" 2>/dev/null || true
  fi
  rm -f "$PLAN_FILE" 2>/dev/null || true
  release_lock
}

fail() {
  _code="$1"
  _detail="$2"
  _at="$PHASE"
  ibc_log "FAILED $_code during $_at: $_detail"
  set_phase failed "$_code"
  write_result 0 "$_code" "$_at" "$_detail"
  cleanup
  exit 1
}

succeed() {
  set_phase done "Now running version $NEW_VERSION"
  write_result 1 "" "done" ""
  cleanup
  exit 0
}

# A stray TERM between the swap and the health check would abandon a half
# applied update with nothing recorded, so the critical section blocks it.
on_interrupt() {
  ibc_log "interrupted during $PHASE"
  write_result 0 "INTERRUPTED" "$PHASE" "the update was stopped during $PHASE"
  cleanup
  exit 1
}

# ---------------------------------------------------------------------------
# Reading the plan
# ---------------------------------------------------------------------------

# `key value`, where value is everything after the first space. The bundle path
# is "/Applications/IBC Contracts.app/...", which has a space in it -- that is
# precisely why the format is defined this way and not as whitespace fields.
plan_get() {
  [ -f "$PLAN_FILE" ] || return 1
  _want="$1"
  _val=""
  _found=""
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      "$_want "*)
        _val=${_line#* }
        _found=1
        break
        ;;
      "$_want")
        _val=""
        _found=1
        break
        ;;
    esac
  done <"$PLAN_FILE"
  [ -n "$_found" ] || return 1
  printf '%s' "$_val"
}

# A version string becomes a directory name, so this is a path safety check as
# much as a format check: no slashes, no dots that could walk upward.
version_ok() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

# ---------------------------------------------------------------------------
# Liveness: what version is actually serving
# ---------------------------------------------------------------------------

# The marker file this script writes into the new app's public/ folder after
# unpacking. Next serves public/ straight off disk, so reading it back costs the
# server nothing -- and because it carries the version, the answer is not merely
# "something is up" but "the code we just installed is up".
serving_version() {
  _p=$(ibc_running_port) || return 1
  _body=$(curl -s --max-time 5 "http://127.0.0.1:$_p$IBC_PING_PATH" 2>/dev/null) || return 1
  printf '%s' "$_body" | awk 'NR==1 {print $2}'
}

start_server_directly() {
  _sh="$RESOURCES/bin/server.sh"
  if [ ! -f "$_sh" ]; then
    ibc_log "there is no server.sh at $_sh"
    return 1
  fi
  ibc_log "starting server.sh directly"
  nohup /bin/sh "$_sh" >/dev/null 2>&1 &
  return 0
}

start_server() {
  USED_LAUNCHD=""
  if [ -f "$IBC_AGENT_PLIST" ] && command -v launchctl >/dev/null 2>&1; then
    if launchctl print "gui/$UID_NUM/$IBC_AGENT_LABEL" >/dev/null 2>&1; then
      launchctl kickstart "gui/$UID_NUM/$IBC_AGENT_LABEL" >/dev/null 2>&1
    else
      launchctl bootstrap "gui/$UID_NUM" "$IBC_AGENT_PLIST" >/dev/null 2>&1
    fi
    # Exit code deliberately discarded -- see the header. launchd is given a
    # grace period inside wait_for_serving to make good on its claim, and
    # nothing more.
    USED_LAUNCHD=1
    return 0
  fi
  start_server_directly
}

# $1: the version we want to see, or empty for "anything that is not the version
#     we were trying to install" (used by the rollback).
# $2: seconds.
# Prints the version that answered.
wait_for_serving() {
  _want="$1"
  _deadline=$(($(date +%s) + $2))
  _grace=$(($(date +%s) + LAUNCHD_GRACE))
  _fellback=""
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    _got=$(serving_version 2>/dev/null) || _got=""
    if [ -n "$_got" ]; then
      if [ -n "$_want" ]; then
        if [ "$_got" = "$_want" ]; then
          printf '%s' "$_got"
          return 0
        fi
      elif [ "$_got" != "$NEW_VERSION" ]; then
        printf '%s' "$_got"
        return 0
      fi
    fi
    # launchd said yes and produced nothing. Start one ourselves and keep
    # waiting; server.sh takes its own lock, so this cannot end in two servers.
    if [ -n "$USED_LAUNCHD" ] && [ -z "$_fellback" ] && [ "$(date +%s)" -ge "$_grace" ]; then
      ibc_log "launchd accepted the request but nothing is serving; starting server.sh directly"
      start_server_directly
      _fellback=1
    fi
    sleep 1
  done
  return 1
}

# Stop whatever is serving. The supervisor is asked first, because it is the one
# that would otherwise restart its child from underneath us. Its own exit is not
# taken as proof either: the port going quiet is the proof.
stop_server() {
  _pid=""
  if [ -f "$IBC_LOCK_DIR/pid" ]; then
    _pid=$(tr -dc '0-9' <"$IBC_LOCK_DIR/pid" 2>/dev/null)
  fi
  if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
    ibc_log "stopping the supervisor (pid $_pid)"
    kill "$_pid" 2>/dev/null || true
  fi

  _deadline=$(($(date +%s) + STOP_TIMEOUT))
  _hard_after=$(($(date +%s) + STOP_TIMEOUT / 2))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    _p=$(ibc_running_port 2>/dev/null) || return 0
    _sig="-TERM"
    if [ "$(date +%s)" -ge "$_hard_after" ]; then
      _sig="-KILL"
    fi
    # -sTCP:LISTEN is not optional. Without it lsof also lists every process
    # holding a CONNECTION to that port -- which is Bonnie's browser window, and
    # anything else with a keep-alive socket open. Killing "whatever is on the
    # port" would close the app she is looking at.
    if command -v lsof >/dev/null 2>&1; then
      for _lp in $(lsof -n -P -t -iTCP:"$_p" -sTCP:LISTEN 2>/dev/null); do
        kill "$_sig" "$_lp" 2>/dev/null || true
      done
    fi
    sleep 1
  done

  ibc_running_port >/dev/null 2>&1 || return 0
  return 1
}

# ---------------------------------------------------------------------------
# The swap
# ---------------------------------------------------------------------------

# `ln -sfn` unlinks and re-creates rather than renaming, so there is a moment
# where the link does not exist. That is acceptable here and only here: the
# server is already stopped when this runs, the result is verified with readlink
# immediately afterwards, and every failure path re-links before returning.
swap_to() {
  _target="$1"
  [ -d "$RESOURCES/$_target" ] || return 1
  if [ -e "$APP_LINK" ] && [ ! -L "$APP_LINK" ]; then
    # A real directory. The caller has to migrate it first; silently replacing a
    # directory with a symlink is how an install loses its only copy.
    return 1
  fi
  ln -sfn "$_target" "$APP_LINK" 2>/dev/null || return 1
  [ "$(readlink "$APP_LINK" 2>/dev/null)" = "$_target" ]
}

# The first update on an installation made before versioned directories existed:
# Contents/Resources/app is a real folder. It becomes app-<current version> and
# the name `app` becomes the symlink from then on.
migrate_to_versioned() {
  [ -L "$APP_LINK" ] && return 0
  [ -d "$APP_LINK" ] || return 1

  _mig="app-$OLD_VERSION"
  if [ "$_mig" = "app-$NEW_VERSION" ]; then
    ibc_log "refusing to migrate onto the incoming version directory"
    return 1
  fi
  if [ -e "$RESOURCES/$_mig" ]; then
    # Left over from an attempt that did not finish. The live folder is the one
    # under `app`, so this is safe to drop.
    rm -rf "$RESOURCES/$_mig" 2>/dev/null || true
  fi
  mv "$APP_LINK" "$RESOURCES/$_mig" 2>/dev/null || return 1
  if ! ln -s "$_mig" "$APP_LINK" 2>/dev/null; then
    mv "$RESOURCES/$_mig" "$APP_LINK" 2>/dev/null || true
    return 1
  fi
  ibc_log "converted the app folder to $_mig with a symlink"
  return 0
}

# Keep the running version and the one before it. Two is enough to roll back
# once; a third is disk space spent on a version nobody will ever go back to.
prune_versions() {
  for _d in "$RESOURCES"/app-*; do
    [ -d "$_d" ] || continue
    _n=$(basename "$_d")
    [ "$_n" = "app-$NEW_VERSION" ] && continue
    [ "$_n" = "$PREVIOUS_TARGET" ] && continue
    ibc_log "removing old version $_n"
    rm -rf "$_d" 2>/dev/null || true
  done
}

# The version that did not start, after the rollback has been health-checked.
#
# It is KEPT, not deleted, and this is the whole point: self-repair is handed
# this failure the moment the rollback lands, and the first thing it needs is
# the tree that would not start. Deleting it here -- which an earlier version of
# this function did, to reclaim the roughly one gigabyte a stranded version
# costs -- meant the handover fired correctly and then always refused, because
# the evidence had already been destroyed. Two individually reasonable fixes
# that cancel each other out.
#
# So the directory lives exactly as long as it is useful: recorded here, removed
# by discard_previous_failure at the start of the NEXT apply, by which time
# repair has either fixed it or spent its attempts.
#
# Guarded by the same readlink check swap_to uses, so whatever else went wrong
# above, the directory the app link points at is never the one recorded. Only in
# apply mode: in rollback mode app-$NEW_VERSION is a version she deliberately
# asked to go back to, and one that failed to start is still not ours to touch.
prune_failed_version() {
  [ "$MODE" = "apply" ] || return 0
  _dead="$RESOURCES/app-$NEW_VERSION"
  [ -d "$_dead" ] || return 0
  _linked=$(readlink "$APP_LINK" 2>/dev/null) || _linked=""
  if [ -z "$_linked" ] || [ "$_linked" = "app-$NEW_VERSION" ]; then
    ibc_log "keeping app-$NEW_VERSION: the app link points at it"
    return 0
  fi
  ibc_log "keeping app-$NEW_VERSION for repair to read; it will be removed at the next update"
  printf '%s\n' "app-$NEW_VERSION" > "$UPDATE_DIR/failed-version" 2>/dev/null || true
}

# Remove the tree a previous update left behind, once repair has had its turn.
# Called at the start of an apply rather than at the end of the failure, so the
# failed version outlives the repair that has to diagnose it.
discard_previous_failure() {
  [ -f "$UPDATE_DIR/failed-version" ] || return 0
  _stale=$(cat "$UPDATE_DIR/failed-version" 2>/dev/null) || _stale=""
  rm -f "$UPDATE_DIR/failed-version" 2>/dev/null || true
  case "$_stale" in
    app-*) ;;
    *) return 0 ;;
  esac
  [ -d "$RESOURCES/$_stale" ] || return 0
  _linked=$(readlink "$APP_LINK" 2>/dev/null) || _linked=""
  # She may have deliberately rolled back onto it in the meantime.
  [ "$_linked" = "$_stale" ] && return 0
  ibc_log "removing the version that failed last time: $_stale"
  rm -rf "$RESOURCES/$_stale" 2>/dev/null || true
}

# The payload may carry replacements for the scripts that live OUTSIDE app/ --
# which is the only way a bug in this file, in server.sh or in the launcher can
# ever be fixed without a reinstall. Applied only after the new version has
# proved it starts, and only if each one parses. Copied to a temp name and
# renamed, so replacing this very script leaves the copy being executed on its
# own untouched inode.
refresh_scripts() {
  [ -n "$STAGING" ] || return 0
  [ -d "$STAGING/bin" ] || return 0

  # Whatever the payload put in bin/, not a hand-maintained list of names. The
  # list was the bug: repair.sh joined the bundle, the list was never widened,
  # and so an update would have quietly deleted the self-repair mechanism from
  # her Mac. The payload's own directory is the only description of itself that
  # cannot go stale.
  for _src in "$STAGING"/bin/*.sh; do
    [ -f "$_src" ] || continue
    _f=$(basename "$_src")
    # launcher.sh is not a bin/ script. It is the bundle's executable and it is
    # installed under its own name into Contents/MacOS, just below.
    [ "$_f" = "launcher.sh" ] && continue
    if ! /bin/sh -n "$_src" 2>/dev/null; then
      ibc_log "refusing to install bin/$_f: it does not parse"
      continue
    fi
    _dst="$RESOURCES/bin/$_f"
    if cp "$_src" "$_dst.new" 2>/dev/null && chmod 755 "$_dst.new" 2>/dev/null; then
      mv -f "$_dst.new" "$_dst" 2>/dev/null || rm -f "$_dst.new" 2>/dev/null
      ibc_log "updated bin/$_f"
    fi
  done

  _launcher="$STAGING/bin/launcher.sh"
  _exe="$RESOURCES/../MacOS/$IBC_EXECUTABLE"
  if [ -f "$_launcher" ] && [ -f "$_exe" ] && /bin/sh -n "$_launcher" 2>/dev/null; then
    if cp "$_launcher" "$_exe.new" 2>/dev/null && chmod 755 "$_exe.new" 2>/dev/null; then
      mv -f "$_exe.new" "$_exe" 2>/dev/null || rm -f "$_exe.new" 2>/dev/null
      ibc_log "updated the launcher"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

mkdir -p "$UPDATE_DIR" "$IBC_LOG_DIR" 2>/dev/null || true

# mkdir is the mutex. It is atomic on every filesystem this runs on, unlike a
# test-then-write on a lock file, and it is the same shape server.sh uses. A
# manual Update and a scheduled check cannot both get past this line.
if mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_HELD=1
else
  STALE_PID=$(tr -dc '0-9' <"$LOCK_DIR/pid" 2>/dev/null)
  if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
    ibc_log "another update is already running (pid $STALE_PID); standing down"
    exit 0
  fi
  ibc_log "reclaiming a stale update lock (pid '${STALE_PID:-none}' is gone)"
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
  else
    ibc_log "could not take the update lock; standing down"
    exit 0
  fi
fi
printf '%s\n' "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
trap 'release_lock' EXIT
trap 'on_interrupt' TERM INT

STARTED_AT=$(now_iso)

MODE=$(plan_get mode) || MODE="apply"
NEW_VERSION=$(plan_get version) || NEW_VERSION=""
OLD_VERSION=$(plan_get fromVersion) || OLD_VERSION=""
RESOURCES=$(plan_get resources) || RESOURCES="$DEFAULT_RES_DIR"
SHA_EXPECTED=$(plan_get sha256) || SHA_EXPECTED=""
URL=$(plan_get url) || URL=""
SIZE_BYTES=$(plan_get sizeBytes) || SIZE_BYTES=0
CURL_CONFIG=$(plan_get curlConfig) || CURL_CONFIG=""

[ -n "$RESOURCES" ] || RESOURCES="$DEFAULT_RES_DIR"
APP_LINK="$RESOURCES/app"

case "$MODE" in
  apply | rollback) ;;
  *) MODE="apply" ;;
esac

ibc_log "----- update $MODE requested: $OLD_VERSION -> $NEW_VERSION -----"
set_phase starting "Getting ready"

# Reclaim the tree a previous failed update left for repair to read. Doing it
# here rather than at the moment of failure is what lets repair see it at all.
discard_previous_failure

version_ok "$NEW_VERSION" || fail UNKNOWN "the plan has no usable version number"
version_ok "$OLD_VERSION" || OLD_VERSION="0.0.0"
[ "$NEW_VERSION" != "$OLD_VERSION" ] || fail UNKNOWN "the new version is the one already installed"

[ -d "$RESOURCES" ] || fail NOT_SUPPORTED "there is no Resources folder at $RESOURCES"
[ -w "$RESOURCES" ] || fail NOT_WRITABLE "cannot write to $RESOURCES"

TARGET_NAME="app-$NEW_VERSION"

if [ "$MODE" = "rollback" ]; then
  [ -d "$RESOURCES/$TARGET_NAME" ] || fail SWAP_FAILED "version $NEW_VERSION is not on this Mac"
else
  # --- download ------------------------------------------------------------
  [ -n "$URL" ] || fail UNKNOWN "the plan has no download URL"
  printf '%s' "$SHA_EXPECTED" | grep -Eq '^[0-9a-fA-F]{64}$' ||
    fail UNKNOWN "the plan has no usable sha256"

  NEEDED_KB="$MIN_FREE_KB"
  case "$SIZE_BYTES" in
    '' | *[!0-9]*) SIZE_BYTES=0 ;;
  esac
  if [ "$SIZE_BYTES" -gt 0 ]; then
    NEEDED_KB=$((SIZE_BYTES * 3 / 1024))
    [ "$NEEDED_KB" -lt "$MIN_FREE_KB" ] && NEEDED_KB="$MIN_FREE_KB"
  fi
  FREE_KB=$(df -k "$RESOURCES" 2>/dev/null | tail -1 | awk '{print $4}')
  case "${FREE_KB:-}" in
    '' | *[!0-9]*) FREE_KB="" ;;
  esac
  if [ -n "$FREE_KB" ] && [ "$FREE_KB" -lt "$NEEDED_KB" ]; then
    fail DISK_FULL "needs ${NEEDED_KB}KB free, has ${FREE_KB}KB"
  fi

  set_phase downloading "Downloading version $NEW_VERSION"
  mkdir -p "$DOWNLOAD_DIR" 2>/dev/null || fail UNKNOWN "could not create $DOWNLOAD_DIR"
  TARBALL="$DOWNLOAD_DIR/ibc-$NEW_VERSION.tar.gz"
  rm -f "$TARBALL" "$TARBALL.part" 2>/dev/null || true

  # The token, when there is one, is in the curl config file -- never on the
  # command line, because arguments are visible to every process through `ps`.
  if [ -n "$CURL_CONFIG" ] && [ -f "$CURL_CONFIG" ]; then
    curl -fL --retry 3 --retry-delay 3 --connect-timeout 20 \
      --max-time "$DOWNLOAD_MAX_SECONDS" -H 'Accept: application/octet-stream' \
      -K "$CURL_CONFIG" -o "$TARBALL.part" "$URL" >/dev/null 2>&1
    DOWNLOAD_STATUS=$?
  else
    curl -fL --retry 3 --retry-delay 3 --connect-timeout 20 \
      --max-time "$DOWNLOAD_MAX_SECONDS" -o "$TARBALL.part" "$URL" >/dev/null 2>&1
    DOWNLOAD_STATUS=$?
  fi
  if [ -n "$CURL_CONFIG" ]; then
    rm -f "$CURL_CONFIG" 2>/dev/null || true
    CURL_CONFIG=""
  fi
  [ "$DOWNLOAD_STATUS" -eq 0 ] || fail DOWNLOAD_FAILED "curl exited $DOWNLOAD_STATUS"
  [ -s "$TARBALL.part" ] || fail DOWNLOAD_FAILED "the download is empty"

  # --- verify BEFORE unpacking --------------------------------------------
  # A corrupt payload that gets unpacked is a support call nobody can diagnose,
  # so the fingerprint is checked while the payload is still one inert file.
  set_phase verifying "Checking the download against its published fingerprint"
  GOT_SHA=$(shasum -a 256 "$TARBALL.part" 2>/dev/null | awk '{print $1}' | tr 'A-Z' 'a-z')
  WANT_SHA=$(printf '%s' "$SHA_EXPECTED" | tr 'A-Z' 'a-z')
  if [ -z "$GOT_SHA" ] || [ "$GOT_SHA" != "$WANT_SHA" ]; then
    rm -f "$TARBALL.part" 2>/dev/null || true
    fail CHECKSUM_MISMATCH "expected $WANT_SHA, got ${GOT_SHA:-nothing}"
  fi
  mv -f "$TARBALL.part" "$TARBALL" 2>/dev/null || fail UNKNOWN "could not stage the download"

  # --- unpack BESIDE the current install -----------------------------------
  set_phase unpacking "Unpacking version $NEW_VERSION"
  STAGING="$RESOURCES/.staging-$NEW_VERSION"
  rm -rf "$STAGING" 2>/dev/null || true
  mkdir -p "$STAGING" 2>/dev/null || fail UNKNOWN "could not create a staging folder"
  if ! tar -xzf "$TARBALL" -C "$STAGING" --strip-components 1 2>/dev/null; then
    fail UNPACK_FAILED "the archive could not be extracted"
  fi

  NEW_APP="$STAGING/app"
  [ -d "$NEW_APP" ] || fail PAYLOAD_INCOMPLETE "the archive has no app folder"
  # tar exiting 0 says the bytes came out. It says nothing about whether what
  # came out is an app, and finding that out AFTER the swap means finding it out
  # from a rollback.
  for _need in package.json node_modules/next/dist/bin/next .next/BUILD_ID; do
    [ -e "$NEW_APP/$_need" ] || fail PAYLOAD_INCOMPLETE "the payload has no $_need"
  done

  # The liveness marker is written here rather than trusted from the payload, so
  # the health check below cannot be satisfied by a stale version number that
  # happened to ship inside the tarball.
  mkdir -p "$NEW_APP/public" 2>/dev/null || true
  printf '%s %s\n' "$IBC_BUNDLE_ID" "$NEW_VERSION" >"$NEW_APP/public/ibc-ping.txt" ||
    fail UNPACK_FAILED "could not write the liveness marker"

  if [ "$(readlink "$APP_LINK" 2>/dev/null)" = "$TARGET_NAME" ]; then
    fail UNKNOWN "$TARGET_NAME is already the version in use"
  fi
  rm -rf "$RESOURCES/$TARGET_NAME.incoming" 2>/dev/null || true
  mv "$NEW_APP" "$RESOURCES/$TARGET_NAME.incoming" 2>/dev/null ||
    fail UNPACK_FAILED "could not move the new version into place"
  rm -rf "$RESOURCES/$TARGET_NAME" 2>/dev/null || true
  # A rename inside one directory, so app-<version> either exists whole or does
  # not exist. Nothing ever sees a half-written version folder.
  mv "$RESOURCES/$TARGET_NAME.incoming" "$RESOURCES/$TARGET_NAME" 2>/dev/null ||
    fail UNPACK_FAILED "could not name the new version folder"
fi

# ---------------------------------------------------------------------------
# Swap, restart, and prove it
# ---------------------------------------------------------------------------

# From here to the result being written, an interrupt would leave the install in
# a state nobody recorded. TERM is blocked for the duration.
#
# A no-op HANDLER, never `trap '' TERM INT`. The empty string sets SIG_IGN, and
# an ignored disposition is inherited across BOTH fork and exec -- and POSIX
# requires a shell to go on ignoring a signal that was already ignored when it
# was invoked. Every server started below this line is started by this process,
# so with SIG_IGN the child server.sh's own `trap 'on_term' TERM` would be a
# dead letter and stop_server could never stop it again: from the second update
# onward the old supervisor would keep the port with a stale working directory,
# the health check would fail, and every update after that would roll back.
# Handlers, unlike SIG_IGN, are reset to SIG_DFL on exec, so `:` protects this
# critical section exactly as well and leaves the children killable.
trap ':' TERM INT

set_phase swapping "Switching to version $NEW_VERSION"

if ! stop_server; then
  ibc_log "warning: something was still answering after the stop timeout"
fi

if [ -L "$APP_LINK" ]; then
  PREVIOUS_TARGET=$(basename "$(readlink "$APP_LINK")")
elif [ -d "$APP_LINK" ]; then
  migrate_to_versioned || {
    start_server
    wait_for_serving "" "$ROLLBACK_HEALTH_TIMEOUT" >/dev/null 2>&1 || true
    fail SWAP_FAILED "the app folder could not be converted to a versioned one"
  }
  PREVIOUS_TARGET="app-$OLD_VERSION"
else
  fail SWAP_FAILED "there is no app folder at $APP_LINK"
fi

if ! swap_to "$TARGET_NAME"; then
  # Nothing has been restarted yet, so putting the link back is the whole repair.
  swap_to "$PREVIOUS_TARGET" || true
  start_server
  wait_for_serving "" "$ROLLBACK_HEALTH_TIMEOUT" >/dev/null 2>&1 || true
  fail SWAP_FAILED "the app link could not be pointed at $TARGET_NAME"
fi

set_phase restarting "Restarting the tracker"
start_server

set_phase health-check "Waiting for version $NEW_VERSION to answer"
if wait_for_serving "$NEW_VERSION" "$HEALTH_TIMEOUT" >/dev/null; then
  ibc_log "version $NEW_VERSION answered on its own liveness endpoint"
  if [ "$MODE" = "apply" ]; then
    refresh_scripts
    prune_versions
  fi
  trap 'on_interrupt' TERM INT
  succeed
fi

# ---------------------------------------------------------------------------
# It did not come up. Go back.
# ---------------------------------------------------------------------------

set_phase rolling-back "Version $NEW_VERSION did not start; going back to $OLD_VERSION"
HEALTH_DETAIL="version $NEW_VERSION did not answer within ${HEALTH_TIMEOUT}s"

stop_server || true

if ! swap_to "$PREVIOUS_TARGET"; then
  ROLLBACK_OK="0"
  fail ROLLBACK_FAILED "$HEALTH_DETAIL, and the app link could not be pointed back at $PREVIOUS_TARGET"
fi

start_server

# Deliberately not "the old version number": what matters is that something
# other than the failed version is serving, and the honest thing to record is
# whatever actually answered.
BACK_ON=$(wait_for_serving "" "$ROLLBACK_HEALTH_TIMEOUT") || BACK_ON=""
if [ -n "$BACK_ON" ]; then
  ROLLED_BACK_TO="$BACK_ON"
  ROLLBACK_OK="1"
  ibc_log "rolled back; version $BACK_ON is serving again"
  # Only now: until something answered, the failed directory was still the best
  # thing left to try.
  prune_failed_version
  fail HEALTH_FAILED "$HEALTH_DETAIL"
fi

ROLLED_BACK_TO="$OLD_VERSION"
ROLLBACK_OK="0"
fail ROLLBACK_FAILED "$HEALTH_DETAIL, and nothing answered after going back to $PREVIOUS_TARGET"
