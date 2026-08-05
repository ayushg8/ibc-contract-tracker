#!/bin/sh
#
# Starts and supervises the one Next server.
#
# Run by two callers that must never produce two servers:
#   1. the LaunchAgent at login (the normal path -- the server is up before she
#      ever clicks anything, so the icon opens instantly)
#   2. the .app launcher, only as a fallback when the agent is missing or dead
#
# Coordination is a lock directory held for the whole life of the supervisor,
# plus the fact that the OS itself will only let one process bind a port. A
# second copy sees a live pid in the lock and stands down; a copy whose owner
# was killed leaves a stale pid, and the next one reclaims it.
#
# The supervisor restarts its own child. launchd's KeepAlive is only a backstop
# for this script itself dying -- see the loop below for why it cannot be the
# primary mechanism.

set -u

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
RES_DIR=$(cd -- "$SELF_DIR/.." && pwd)

# shellcheck source=common.sh
. "$SELF_DIR/common.sh"

IBC_LOG_TARGET="$IBC_SERVER_LOG"
IBC_NODE="$RES_DIR/node/bin/node"
APP_DIR="$RES_DIR/app"
NEXT_BIN="$APP_DIR/node_modules/next/dist/bin/next"

HEALTH_TIMEOUT=120
CHILD=""

cleanup_lock() {
  [ -n "${LOCK_HELD:-}" ] && rm -rf "$IBC_LOCK_DIR" 2>/dev/null
  LOCK_HELD=""
}

# launchd sends TERM on `launchctl bootout` and at logout. Exiting 0 here is
# deliberate: it means "we were asked to stop", not "we crashed", so KeepAlive
# leaves us stopped.
on_term() {
  ibc_log "stop requested"
  [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null
  cleanup_lock
  exit 0
}

mkdir -p "$IBC_RUNTIME_DIR" "$IBC_LOG_DIR" 2>/dev/null || true

if [ ! -x "$IBC_NODE" ]; then
  ibc_log "FATAL bundled node runtime missing at $IBC_NODE -- reinstall required"
  exit 1
fi
if [ ! -f "$NEXT_BIN" ]; then
  ibc_log "FATAL app payload missing at $APP_DIR -- reinstall required"
  exit 1
fi

# --- lock ------------------------------------------------------------------
# mkdir is atomic on every filesystem we care about, unlike a test-then-write
# on a lock file. A lock left behind by a killed process is reclaimed by
# checking whether its pid is still alive.
LOCK_HELD=""
if mkdir "$IBC_LOCK_DIR" 2>/dev/null; then
  LOCK_HELD=1
else
  STALE_PID=$(cat "$IBC_LOCK_DIR/pid" 2>/dev/null | tr -dc '0-9')
  if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
    ibc_log "another supervisor is running (pid $STALE_PID); standing down"
    exit 0
  fi
  ibc_log "reclaiming stale lock (pid '${STALE_PID:-none}' is gone)"
  rm -rf "$IBC_LOCK_DIR" 2>/dev/null
  if mkdir "$IBC_LOCK_DIR" 2>/dev/null; then
    LOCK_HELD=1
  else
    ibc_log "could not take the start lock; standing down"
    exit 0
  fi
fi
printf '%s\n' "$$" >"$IBC_LOCK_DIR/pid" 2>/dev/null || true
trap 'on_term' TERM INT
trap 'cleanup_lock' EXIT

cd "$APP_DIR" || {
  ibc_log "FATAL cannot enter $APP_DIR"
  exit 1
}

# --- supervise -------------------------------------------------------------
# This script restarts its own child rather than leaning on launchd's KeepAlive.
# Measured on macOS 26: after the child was killed, server.sh exited 137 and
# launchd parked the respawn on its "successful exit" semaphore and never fired
# it. KeepAlive stays in the plist as a backstop for this script itself being
# killed, but a crashed server must heal whether or not launchd cooperates --
# and healing here is immediate instead of waiting out ThrottleInterval.
#
# The lock is held for the whole life of the supervisor, not just startup, so
# it is a real mutex: a second copy sees a live pid and stands down. A
# supervisor that is SIGKILLed leaves a lock whose pid is gone, and the next
# copy reclaims it.
FAILURES=0
MAX_FAILURES=5

while true; do
  # Someone else's server is serving. Idle rather than exit: exiting 0 would
  # make a KeepAlive respawn loop, and idling means we take over if they stop.
  if RUNNING=$(ibc_running_port); then
    printf '%s\n' "$RUNNING" >"$IBC_PORT_FILE" 2>/dev/null || true
    sleep 5
    continue
  fi

  # Failing with "port in use" is not an outcome she can act on, so we walk the
  # range and only give up once every candidate is taken.
  PORT=""
  for p in $IBC_PORTS; do
    if ibc_port_free "$p"; then
      PORT="$p"
      break
    fi
    ibc_log "port $p is in use, trying the next one"
  done

  if [ -z "$PORT" ]; then
    ibc_log "FATAL every candidate port is in use: $IBC_PORTS"
    exit 1
  fi

  # Written before the server binds so the .app launcher, which may be racing
  # us, looks in the right place. A port file pointing at a not-yet-open port
  # is harmless: the launcher probes before it opens a window.
  printf '%s\n' "$PORT" >"$IBC_PORT_FILE"
  ibc_log "starting server on port $PORT"

  NODE_ENV=production "$IBC_NODE" "$NEXT_BIN" start -H 127.0.0.1 -p "$PORT" >>"$IBC_SERVER_LOG" 2>&1 &
  CHILD=$!

  # A wall-clock deadline, not a count of iterations. Counting iterations makes
  # the real timeout (iterations x probe timeout) whenever probes are slow,
  # which is exactly when you want the timeout to be honest.
  DEADLINE=$(($(date +%s) + HEALTH_TIMEOUT))
  up=""
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if ! kill -0 "$CHILD" 2>/dev/null; then
      ibc_log "server process exited during startup; see $IBC_SERVER_LOG"
      break
    fi
    if ibc_probe_port "$PORT" 3; then
      up=1
      break
    fi
    sleep 1
  done

  if [ -z "$up" ]; then
    ibc_log "server did not answer within ${HEALTH_TIMEOUT}s on port $PORT"
    kill "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
    CHILD=""
    FAILURES=$((FAILURES + 1))
    if [ "$FAILURES" -ge "$MAX_FAILURES" ]; then
      ibc_log "FATAL gave up after $FAILURES attempts; see $IBC_SERVER_LOG"
      exit 1
    fi
    sleep 5
    continue
  fi

  ibc_log "server is up on port $PORT (pid $CHILD)"
  FAILURES=0

  wait "$CHILD"
  STATUS=$?
  CHILD=""
  ibc_log "server exited with status $STATUS; restarting"
  sleep 2
done
