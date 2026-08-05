#!/bin/sh
#
# Contents/MacOS/ibc-contracts -- what actually runs when the Dock icon is clicked.
#
# In the normal case the LaunchAgent already has a server up, so this is: one
# health probe, then open a window. Cold start only happens if the agent is
# missing or died.
#
# It must never hang silently and it must never show a stack trace. Every exit
# path is either a window or a dialog written in plain English.

set -u

# $0 is the full path to this file when LaunchServices starts it, but the
# bundle may be reached through a symlink (an alias in the Dock, a /Applications
# that is itself a link on some managed Macs), so resolve before deriving paths.
resolve_self() {
  _p="$1"
  _n=0
  while [ -L "$_p" ] && [ "$_n" -lt 32 ]; do
    _d=$(dirname -- "$_p")
    _l=$(readlink -- "$_p")
    case "$_l" in
      /*) _p="$_l" ;;
      *) _p="$_d/$_l" ;;
    esac
    _n=$((_n + 1))
  done
  printf '%s' "$_p"
}

SELF=$(resolve_self "$0")
MACOS_DIR=$(cd -- "$(dirname -- "$SELF")" && pwd)
RES_DIR=$(cd -- "$MACOS_DIR/../Resources" && pwd) || RES_DIR=""

if [ -z "$RES_DIR" ] || [ ! -f "$RES_DIR/bin/common.sh" ]; then
  /usr/bin/osascript - >/dev/null 2>&1 <<'IBC_APPLESCRIPT'
display dialog "IBC Contracts is damaged and cannot start.

Ask Ayush to run the installer again." with title "IBC Contracts" buttons {"OK"} default button "OK" with icon stop
IBC_APPLESCRIPT
  exit 1
fi

# shellcheck source=bin/common.sh
. "$RES_DIR/bin/common.sh"

IBC_LOG_TARGET="$IBC_LAUNCHER_LOG"
IBC_NODE="$RES_DIR/node/bin/node"
UID_NUM=$(id -u)

open_and_exit() {
  ibc_log "opening window on port $1"
  ibc_open_window "$1"
  exit 0
}

fail_and_exit() {
  ibc_log "FAILED $1"
  ibc_dialog "$1

Nothing has been lost -- every contract you have reviewed is still saved.

Try again in a minute. If it still will not open, send this line to Ayush:
$IBC_LOG_DIR"
  exit 1
}

# --- fast path: something is already serving -------------------------------
if PORT=$(ibc_running_port); then
  open_and_exit "$PORT"
fi

# --- cold start ------------------------------------------------------------
ibc_log "no server answering; starting one"
ibc_notify "Starting up. Your window will open in a few seconds."

started=""
if [ -f "$IBC_AGENT_PLIST" ]; then
  # Preferred: let launchd own the process, so there is exactly one supervisor
  # and it survives this script exiting.
  if launchctl print "gui/$UID_NUM/$IBC_AGENT_LABEL" >/dev/null 2>&1; then
    launchctl kickstart "gui/$UID_NUM/$IBC_AGENT_LABEL" >/dev/null 2>&1 && started=1
  else
    launchctl bootstrap "gui/$UID_NUM" "$IBC_AGENT_PLIST" >/dev/null 2>&1 && started=1
  fi
fi

fallback_started=""
start_directly() {
  # The same script launchd would have run. It takes the same lock, so this
  # cannot end up racing a launchd copy into two servers.
  ibc_log "$1"
  nohup /bin/sh "$RES_DIR/bin/server.sh" >/dev/null 2>&1 &
  fallback_started=1
}

if [ -z "$started" ]; then
  start_directly "launchd unavailable; running server.sh directly"
fi

# A wall-clock deadline. Counting iterations would make the real limit depend
# on how long each probe took, i.e. longest exactly when she is already waiting.
LIMIT=90
DEADLINE=$(($(date +%s) + LIMIT))

# launchd's exit code is a CLAIM, not evidence.
#
# `kickstart` and `bootstrap` both return 0 having merely accepted the request,
# and there are real states -- observed on this machine -- where the service is
# then never actually brought up. Trusting that zero used to set started=1, which
# suppressed the fallback below; the launcher then spent the full 90 seconds
# waiting on a server that was never coming and told her it had failed, when
# running server.sh directly would have answered in about two seconds.
#
# So launchd gets a grace period to make good on its claim, and nothing more. If
# the port is not answering by then we start one ourselves and keep waiting. The
# fallback exists for "launchd did not work", and it has to be reachable in the
# likelier shape of that -- launchd lying -- and not only in the tidy one where
# it refuses outright.
GRACE_UNTIL=$(($(date +%s) + 15))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if PORT=$(ibc_running_port); then
    open_and_exit "$PORT"
  fi
  if [ -z "$fallback_started" ] && [ "$(date +%s)" -ge "$GRACE_UNTIL" ]; then
    start_directly "launchd accepted the request but nothing is serving; starting server.sh directly"
  fi
  sleep 1
done

fail_and_exit "IBC Contracts could not start within a minute and a half."
