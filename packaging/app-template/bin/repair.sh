#!/bin/sh
#
# Self-repair's two jobs that cannot be done from inside the app.
#
#   repair.sh resume <no args>   run by the RepairAgent when the Claude
#                                subscription limit resets, to pick a repair
#                                back up where it left off
#   repair.sh apply  <env file>  put a fix that has passed every gate live,
#                                verify it, and undo it if it does not answer
#
# WHY a shell script at all, when the rest of self-repair is TypeScript inside
# the app: both of these outlive the server. `apply` restarts the very process
# that would otherwise be doing the verifying -- a promotion cannot be checked by
# the thing it kills -- and `resume` has to run at a calendar time when the app
# may not be running at all.
#
# The lesson this file is built on is the launcher's: an exit code is a claim,
# not evidence. `launchctl bootout` returning 0 means launchd accepted the
# request, and `launchctl kickstart` returning 0 means it accepted that one too.
# Neither proves a server stopped or started. Every state change below is
# confirmed by asking the port, with a deadline, and the fix is put back only
# when the app actually answers.
#
# POSIX sh: no arrays, no double-bracket tests, no function-scoped variables.
# It runs under /bin/sh from launchd, where a bash-ism is a silent no-op.

set -u

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

REPAIR_AGENT_LABEL="com.internationalbattery.contract-tracker.repair"

# common.sh is copied next to this script when it is materialised, but this must
# still work without it: it is the one script that runs when the install is in
# the middle of being changed underneath it.
if [ -f "$SELF_DIR/common.sh" ]; then
  # shellcheck source=common.sh
  . "$SELF_DIR/common.sh"
else
  IBC_AGENT_LABEL="com.internationalbattery.contract-tracker"
  IBC_PORTS="47821 47822 47823 47824 47825 47826 47827 47828 47829 47830"
  IBC_DATA_DIR_DEFAULT="$HOME/Library/Application Support/IBC Contract Tracker"
  IBC_DATA_DIR="${IBC_DATA_DIR:-$IBC_DATA_DIR_DEFAULT}"
  IBC_LOG_DIR="$IBC_DATA_DIR/logs"
  IBC_PORT_FILE="$IBC_DATA_DIR/runtime/port"
  IBC_PING_PATH="/ibc-ping.txt"

  ibc_http_code() {
    _code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-20}" "$1" 2>/dev/null)
    case "$_code" in
      '' | 000) printf '000' ;;
      *) printf '%s' "$_code" ;;
    esac
  }

  ibc_probe_port() {
    [ -n "$1" ] || return 1
    [ "$(ibc_http_code "http://127.0.0.1:$1$IBC_PING_PATH" "${2:-5}")" = "200" ]
  }

  ibc_read_port_file() {
    [ -f "$IBC_PORT_FILE" ] || return 1
    _p=$(tr -dc '0-9' <"$IBC_PORT_FILE" 2>/dev/null)
    [ -n "$_p" ] || return 1
    printf '%s' "$_p"
  }

  ibc_running_port() {
    _recorded=$(ibc_read_port_file) || _recorded=''
    if [ -n "$_recorded" ] && ibc_probe_port "$_recorded" 5; then
      printf '%s' "$_recorded"
      return 0
    fi
    for _p in $IBC_PORTS; do
      [ "$_p" = "$_recorded" ] && continue
      if ibc_probe_port "$_p" 3; then
        printf '%s' "$_p"
        return 0
      fi
    done
    return 1
  }

  ibc_log() {
    mkdir -p "$IBC_LOG_DIR" 2>/dev/null || true
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$IBC_LOG_DIR/repair.log" 2>/dev/null || true
  }

  ibc_notify() {
    /usr/bin/osascript - "$1" >/dev/null 2>&1 <<'IBC_APPLESCRIPT' || true
on run argv
  display notification (item 1 of argv) with title "IBC Contracts"
end run
IBC_APPLESCRIPT
  }

  ibc_dialog() {
    /usr/bin/osascript - "$1" >/dev/null 2>&1 <<'IBC_APPLESCRIPT' || true
on run argv
  display dialog (item 1 of argv) with title "IBC Contracts" buttons {"OK"} default button "OK" with icon caution
end run
IBC_APPLESCRIPT
  }
fi

IBC_LOG_TARGET="$IBC_LOG_DIR/repair.log"
export IBC_LOG_TARGET

UID_NUM=$(id -u)
SERVER_DOMAIN="gui/$UID_NUM/$IBC_AGENT_LABEL"
REPAIR_DOMAIN="gui/$UID_NUM/$REPAIR_AGENT_LABEL"

# ---------------------------------------------------------------------------
# Waiting for the thing you actually want
# ---------------------------------------------------------------------------

# Wall clock, not an iteration count: with slow probes a count of iterations
# makes the real timeout (iterations x probe timeout), which is dishonest at
# exactly the moment honesty is useful.
rp_wait_up() {
  _deadline=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    if PORT=$(ibc_running_port); then
      printf '%s' "$PORT"
      return 0
    fi
    sleep 1
  done
  return 1
}

rp_wait_down() {
  _deadline=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    if ! ibc_running_port >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Start the server and PROVE it started.
#
# launchd is asked first because it owns the service, then given a grace period,
# and then bypassed. This is the launcher's bug, generalised: on this machine
# launchctl accepted a kickstart, returned 0, and never brought the service up.
rp_start_server() {
  launchctl kickstart -k "$SERVER_DOMAIN" >/dev/null 2>&1
  if PORT=$(rp_wait_up 20); then
    printf '%s' "$PORT"
    return 0
  fi

  if [ -n "${SERVER_SH:-}" ] && [ -f "$SERVER_SH" ]; then
    ibc_log "launchd did not bring the server up; starting it directly"
    /bin/sh "$SERVER_SH" >/dev/null 2>&1 &
    if PORT=$(rp_wait_up 90); then
      printf '%s' "$PORT"
      return 0
    fi
  fi
  return 1
}

rp_stop_server() {
  launchctl bootout "$SERVER_DOMAIN" >/dev/null 2>&1
  # bootout returning 0 says the request was accepted. The port says the truth.
  if rp_wait_down 30; then
    return 0
  fi
  ibc_log "the server is still answering after bootout; killing the supervisor"
  pkill -f "$IBC_AGENT_LABEL" >/dev/null 2>&1
  rp_wait_down 15
}

# ---------------------------------------------------------------------------
# resume
# ---------------------------------------------------------------------------

rp_unschedule_self() {
  launchctl bootout "$REPAIR_DOMAIN" >/dev/null 2>&1
  rm -f "$HOME/Library/LaunchAgents/$REPAIR_AGENT_LABEL.plist" 2>/dev/null || true
  ibc_log "repair agent removed; nothing further is owed"
}

rp_resume() {
  ibc_log "resume: the Claude limit should have reset by now"

  if ! PORT=$(ibc_running_port); then
    if ! PORT=$(rp_start_server); then
      # Leaving the agent in place is deliberate: the state file still says a
      # repair is owed, and the app picks it up itself the next time it is asked.
      ibc_log "resume: the app is not running and could not be started; leaving it to the app"
      return 1
    fi
  fi

  RESPONSE=$(curl -s --max-time 60 -X POST \
    -H 'Content-Type: application/json' \
    -d '{"action":"resume"}' \
    "http://127.0.0.1:$PORT/api/repair" 2>/dev/null)

  if [ -z "$RESPONSE" ]; then
    ibc_log "resume: no answer from the app on port $PORT"
    return 1
  fi
  ibc_log "resume: $(printf '%s' "$RESPONSE" | cut -c1-400)"

  # The app is the authority on what happens next; this only decides whether the
  # calendar entry still has a job to do.
  case "$RESPONSE" in
    *'"phase":"waiting-limit"'*)
      ibc_log "resume: still capped; the app has rescheduled"
      ;;
    *'"phase":"emergency"'*)
      ibc_dialog "IBC Contracts could not repair itself and needs Ayush to look at it. Your contracts are safe and the tracker is running the last version that worked."
      rp_unschedule_self
      ;;
    *'"phase":"succeeded"'* | *'"phase":"exhausted"'* | *'"phase":"refused"'*)
      rp_unschedule_self
      ;;
    *) ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------

rp_result() {
  [ -n "${PLAN_RESULT:-}" ] || return 0
  mkdir -p "$(dirname "$PLAN_RESULT")" 2>/dev/null || true
  printf 'status=%s\ndetail=%s\nat=%s\n' \
    "$1" "$2" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$PLAN_RESULT" 2>/dev/null || true
  ibc_log "apply: $1 -- $2"
}

# The protected prefixes, again, in the language of the thing that does the
# copying.
#
# WHY a second copy of a list that already exists in TypeScript: the Node process
# that checked the diff has exited by the time this script runs, so the only
# guard left on the plan is the plan itself -- and the plan is a newline-
# delimited file. A filename containing a newline splits into two lines, the
# second of which no check ever saw. Duplication is the point: two independent
# checks, in two languages, on a list whose second reader is what actually writes
# into her install. If they ever disagree, the answer is no.
#
# Kept as one expression rather than a loop over patterns because POSIX sh has no
# arrays, and a word-split string is exactly the kind of quoting bug that would
# make this pass everything.
RP_PROTECTED_RE='^(src/lib/extraction/|src/lib/util/dates\.ts$|src/lib/fields\.ts$|src/lib/db/schema\.sql$|src/lib/db/migrate\.ts$|src/lib/providers/errors\.ts$|src/lib/repair/|evals/|tests/|packaging/|node_modules/|\.next/|package\.json$|package-lock\.json$|tsconfig\.json$|tsconfig\..*\.json$|next\.config\.ts$|vitest\.config\.ts$)'

# Is this a path the promoter is allowed to touch? Silence means yes.
rp_path_ok() {
  case "$1" in
    '' | /*) return 1 ;;
    '..' | '../'* | *'/../'* | *'/..') return 1 ;;
  esac

  # A control character cannot occur in a filename this app ships. It can occur
  # in one crafted to split a line of the plan in two, and a tab or a carriage
  # return would also make the path this script builds differ from the path that
  # was checked. Deleting them and comparing rather than matching a character
  # class: the class would have to be spelled with a doubled bracket, and this
  # file is checked for bash-isms by looking for exactly that.
  if [ "$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\037\177')" != "$1" ]; then
    return 1
  fi

  # Case-insensitively, because the disk this runs on is case-insensitive:
  # SRC/LIB/FIELDS.TS and src/lib/fields.ts are one file.
  if printf '%s' "$1" | grep -qiE "$RP_PROTECTED_RE"; then
    return 1
  fi

  return 0
}

# Copy the files named in the plan from the workspace into the live install,
# keeping whatever they displaced.
rp_copy_in() {
  _ok=1
  while IFS= read -r REL; do
    [ -n "$REL" ] || continue
    if ! rp_path_ok "$REL"; then
      ibc_log "apply: refusing to copy $REL -- the plan names a path the promoter must never write"
      _ok=0
      continue
    fi
    _src="$PLAN_WORKSPACE/$REL"
    _dst="$PLAN_LIVE/$REL"
    if [ -f "$_src" ]; then
      mkdir -p "$(dirname "$_dst")" 2>/dev/null || true
      if ! cp -p "$_src" "$_dst" 2>/dev/null; then
        ibc_log "apply: could not copy $REL"
        _ok=0
      fi
    elif [ -f "$_dst" ]; then
      # The fix deleted this file. Leaving it behind would mean the live tree
      # stops matching the tree the gates passed, and the next update would diff
      # against something that was never shipped. The backup holds a copy.
      rm -f "$_dst" 2>/dev/null || _ok=0
    fi
  done <"$PLAN_FILES"
  [ "$_ok" = "1" ]
}

rp_backup() {
  mkdir -p "$PLAN_BACKUP" 2>/dev/null || true
  : >"$PLAN_BACKUP/.created"
  while IFS= read -r REL; do
    [ -n "$REL" ] || continue
    # Refused here rather than skipped: backup runs before anything is copied, so
    # failing it is how a bad plan is rejected with the install still untouched.
    if ! rp_path_ok "$REL"; then
      ibc_log "apply: refusing the whole plan -- it names $REL, which the promoter must never write"
      return 1
    fi
    _live="$PLAN_LIVE/$REL"
    if [ -f "$_live" ]; then
      mkdir -p "$(dirname "$PLAN_BACKUP/$REL")" 2>/dev/null || true
      cp -p "$_live" "$PLAN_BACKUP/$REL" 2>/dev/null || return 1
    else
      # New file: the undo is to delete it, which needs its own list.
      printf '%s\n' "$REL" >>"$PLAN_BACKUP/.created"
    fi
  done <"$PLAN_FILES"

  # The build output is moved rather than copied: it is large, a move is atomic
  # on one volume, and having it out of the way makes a partial copy impossible
  # to mistake for a finished one.
  if [ -d "$PLAN_LIVE/.next" ]; then
    rm -rf "$PLAN_BACKUP/.next" 2>/dev/null || true
    mv "$PLAN_LIVE/.next" "$PLAN_BACKUP/.next" 2>/dev/null || return 1
  fi
  return 0
}

rp_restore() {
  while IFS= read -r REL; do
    [ -n "$REL" ] || continue
    # Skipped rather than fatal: restore is the safety net, and it has to put back
    # everything it legitimately can even when one line of the plan is rubbish.
    rp_path_ok "$REL" || continue
    if [ -f "$PLAN_BACKUP/$REL" ]; then
      mkdir -p "$(dirname "$PLAN_LIVE/$REL")" 2>/dev/null || true
      cp -p "$PLAN_BACKUP/$REL" "$PLAN_LIVE/$REL" 2>/dev/null || true
    fi
  done <"$PLAN_FILES"

  if [ -f "$PLAN_BACKUP/.created" ]; then
    while IFS= read -r REL; do
      [ -n "$REL" ] || continue
      rp_path_ok "$REL" || continue
      rm -f "$PLAN_LIVE/$REL" 2>/dev/null || true
    done <"$PLAN_BACKUP/.created"
  fi

  if [ -d "$PLAN_BACKUP/.next" ]; then
    rm -rf "$PLAN_LIVE/.next" 2>/dev/null || true
    mv "$PLAN_BACKUP/.next" "$PLAN_LIVE/.next" 2>/dev/null || true
  fi
}

rp_apply() {
  ENV_FILE="${1:-}"
  if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    ibc_log "apply: no plan file"
    return 1
  fi

  PLAN_ATTEMPT_ID=''
  PLAN_SIGNATURE=''
  PLAN_WORKSPACE=''
  PLAN_LIVE=''
  PLAN_BACKUP=''
  PLAN_FILES=''
  PLAN_RESULT=''
  PLAN_SERVER_SH=''
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  SERVER_SH="$PLAN_SERVER_SH"

  if [ ! -d "$PLAN_WORKSPACE" ] || [ ! -d "$PLAN_LIVE" ] || [ ! -f "$PLAN_FILES" ]; then
    rp_result failed "the promotion plan points at something that is not there"
    return 1
  fi

  ibc_log "apply: promoting attempt $PLAN_ATTEMPT_ID into $PLAN_LIVE"

  # The workspace must have been built, or there is nothing to serve. Checked
  # here as well as in the gates because this script is what actually copies it.
  if [ ! -f "$PLAN_WORKSPACE/.next/BUILD_ID" ]; then
    rp_result failed "the candidate has no build output; nothing was changed"
    return 1
  fi

  rp_stop_server

  if ! rp_backup; then
    rp_result failed "the current version could not be backed up; nothing was changed"
    rp_start_server >/dev/null 2>&1
    return 1
  fi

  COPIED=1
  rp_copy_in || COPIED=0
  if [ "$COPIED" = "1" ]; then
    if ! cp -Rc "$PLAN_WORKSPACE/.next" "$PLAN_LIVE/.next" 2>/dev/null; then
      cp -R "$PLAN_WORKSPACE/.next" "$PLAN_LIVE/.next" 2>/dev/null || COPIED=0
    fi
  fi

  if [ "$COPIED" = "0" ]; then
    ibc_log "apply: the copy failed part way; putting the previous version back"
    rp_restore
    if PORT=$(rp_start_server); then
      rp_result reverted "the fix could not be copied in; the previous version is back and answering on port $PORT"
    else
      rp_result failed "the copy failed and the previous version did not come back up"
      ibc_dialog "IBC Contracts could not finish an automatic repair and needs Ayush. Your contracts are safe."
    fi
    return 1
  fi

  # The whole point of this script: the fix is only applied if the app it
  # produces actually answers.
  if PORT=$(rp_start_server); then
    rp_result applied "the repaired version is live and answering on port $PORT"
    return 0
  fi

  ibc_log "apply: the repaired version did not answer; putting the previous version back"
  rp_stop_server
  rp_restore
  if PORT=$(rp_start_server); then
    rp_result reverted "the repaired version did not start; the previous version is back and answering on port $PORT"
    return 1
  fi

  rp_result failed "neither the repaired version nor the previous one would start"
  ibc_dialog "IBC Contracts stopped after an automatic repair and needs Ayush to look at it. Your contracts and PDFs have not been touched."
  return 1
}

# ---------------------------------------------------------------------------
# entry
# ---------------------------------------------------------------------------

mkdir -p "$IBC_LOG_DIR" 2>/dev/null || true

case "${1:-resume}" in
  resume)
    rp_resume
    ;;
  apply)
    rp_apply "${2:-}"
    ;;
  status)
    if PORT=$(ibc_running_port); then
      curl -s --max-time 20 "http://127.0.0.1:$PORT/api/repair"
      printf '\n'
    else
      printf 'IBC Contracts is not running.\n'
    fi
    ;;
  *)
    printf 'usage: repair.sh [resume|apply <plan>|status]\n' >&2
    exit 2
    ;;
esac
