#!/bin/sh
#
# Double-click this to take IBC Contracts off a Mac.
#
# It removes the app and the login item. It does NOT remove the contracts.
# That is not an oversight and it is not configurable here: the database is
# every record she has ever reviewed and approved, and a double-clicked script
# is the wrong place to be able to destroy it. Deleting it is a deliberate act
# done in Finder, by hand, by someone who means it.

set -u

PACKAGING_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

# shellcheck source=app-template/bin/common.sh
. "$PACKAGING_DIR/app-template/bin/common.sh"

rule() { printf '\n------------------------------------------------------------\n'; }
say() { printf '   %s\n' "$*"; }
blank() { printf '\n'; }

rule
printf '\n   IBC Contract Tracker -- remove\n\n'
printf '   This removes the app and stops it starting when you log in.\n'
blank
printf '   YOUR CONTRACTS ARE KEPT. Every document, every approved record\n'
printf '   and every export stays exactly where it is:\n\n'
printf '     %s\n\n' "$IBC_DATA_DIR"
printf '   Nothing in this script touches that folder. Reinstalling later\n'
printf '   picks up right where you left off.\n'
rule
blank

printf '   Type  remove  and press return to continue, or just press return\n'
printf '   to cancel: '
read -r ANSWER 2>/dev/null || ANSWER=""
if [ "$ANSWER" != "remove" ]; then
  blank
  say "Cancelled. Nothing was changed."
  blank
  printf '   Press return to close this window.\n'
  read -r _ignored 2>/dev/null || true
  exit 0
fi

blank

# --- login item ------------------------------------------------------------

say "Stopping the tracker and removing the login items ..."

# The server agent first and unconditionally, because a job stays loaded even
# when its plist file has already gone, and this is the one whose files are
# about to be deleted out from under it.
launchctl bootout "gui/$(id -u)/$IBC_AGENT_LABEL" >/dev/null 2>&1

# Every agent this product installs, matched by the label it is named after --
# not just the server's. There are three: the server, the fortnightly update
# check written by the installer, and the repair agent, which is created at
# RUNTIME whenever a repair has to defer until a usage limit resets. Booting out
# one by name left the other two behind, poking a port nothing was listening on
# after the app was gone. The glob is anchored on $IBC_AGENT_LABEL, so it can
# only ever match this product's own plists -- and the next sibling agent is
# caught without anyone remembering to come back here.
AGENTS_REMOVED=0
for AGENT_PLIST in "$HOME/Library/LaunchAgents/$IBC_AGENT_LABEL"*.plist; do
  [ -f "$AGENT_PLIST" ] || continue
  AGENT_LABEL=$(basename "$AGENT_PLIST" .plist)
  launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1
  if rm -f "$AGENT_PLIST"; then
    say "Removed: $AGENT_PLIST"
    AGENTS_REMOVED=$((AGENTS_REMOVED + 1))
  else
    say "Could not remove $AGENT_PLIST -- delete it by hand."
  fi
done
[ "$AGENTS_REMOVED" -eq 0 ] && say "No login items were installed."

# A server started by the .app launcher rather than by launchd is not launchd's
# to stop, so it is stopped by the port it recorded.
if PORT=$(ibc_running_port); then
  PIDS=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
  for pid in $PIDS; do
    kill "$pid" >/dev/null 2>&1
  done
  [ -n "$PIDS" ] && say "Stopped the server that was still running on port $PORT."
fi
rm -rf "$IBC_LOCK_DIR" 2>/dev/null

# --- the app ---------------------------------------------------------------

REMOVED=0
for dir in "/Applications" "$HOME/Applications"; do
  target="$dir/$IBC_APP_NAME.app"
  if [ -e "$target" ]; then
    if rm -rf "$target"; then
      say "Removed: $target"
      REMOVED=$((REMOVED + 1))
    else
      say "Could not remove $target -- drag it to the Trash by hand."
    fi
  fi
  rm -rf "$dir/$IBC_APP_NAME.app.old" "$dir/$IBC_APP_NAME.app.building" 2>/dev/null
done
[ "$REMOVED" -eq 0 ] && say "The app was not in Applications. Nothing to remove."

# --- downloaded runtime cache ----------------------------------------------

if [ -d "$IBC_CACHE_DIR" ]; then
  rm -rf "$IBC_CACHE_DIR" && say "Removed the cached download: $IBC_CACHE_DIR"
fi

rule
printf '\n   DONE\n\n'
printf '   The app and the login item are gone.\n\n'
printf '   Your contracts are still here, untouched:\n\n'
printf '     %s\n' "$IBC_DATA_DIR"
rule
blank
printf '   Press return to close this window.\n'
read -r _ignored 2>/dev/null || true
