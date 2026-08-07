#!/bin/sh
#
# Put Claude Code on this Mac, and write down where it landed.
#
#   claude-setup.sh          install if needed, then record the path
#   claude-setup.sh --check  record the path only, install nothing
#
# WHY this exists as its own script rather than a block inside install.command:
# it has to run again after the install. She may sign out, a token may expire, or
# the install may have happened on a Mac with no network that morning, and the
# Engine screen offers this again with a button. A block inside a one-shot
# installer could not be that button. It lives in bin/ so it is staged, shipped
# and updated by exactly the machinery that already carries the other scripts --
# bin/ is iterated, never listed, which is the bug that once shipped an update
# that deleted self-repair.
#
# WHAT IT DELIBERATELY DOES NOT DO: sign in. The login is an interactive prompt
# plus a browser round-trip, and driving that from an installer means she is
# looking at a Terminal with no app around it when it goes wrong. The app asks
# for the login, where Recheck and the whole error taxonomy already live.
#
# NOTHING HERE IS ALLOWED TO BE FATAL. Its caller runs with `set -e` and treats a
# non-zero exit as a failed install, so every path below ends in `exit 0`. Her Mac
# may have no network at this moment; that must cost her a sentence on screen, not
# the tracker. The app opens either way and says the engine is not ready yet.
#
# POSIX sh: no arrays, no double-bracket tests, no function-scoped variables.

set -u

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=/dev/null
. "$SELF_DIR/common.sh"

MODE="${1:-install}"

say_() { printf '   %s\n' "$*"; }

# Every place Claude Code actually installs itself. `command -v` alone is not
# enough: this may run from a LaunchAgent or from an app bundle, neither of which
# inherits her shell's PATH, so the same lookup that works in Terminal finds
# nothing here.
find_claude() {
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  for candidate in \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    /opt/homebrew/bin/claude \
    /usr/local/bin/claude \
    "$HOME/bin/claude"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Written only when the binary actually runs. A path recorded for something that
# does not execute is worse than no path at all: the app trusts this ahead of its
# own four probes, so a bad line here would take a working install offline.
record() {
  if [ ! -x "$1" ]; then
    return 1
  fi
  if ! "$1" --version >/dev/null 2>&1; then
    return 1
  fi
  mkdir -p "$IBC_RUNTIME_DIR" 2>/dev/null || return 1
  printf '%s\n' "$1" >"$IBC_RUNTIME_DIR/claude-path" || return 1
  return 0
}

FOUND=$(find_claude 2>/dev/null) || FOUND=""

if [ -z "$FOUND" ] && [ "$MODE" != "--check" ]; then
  say_ "Installing Claude Code ..."
  # The official installer, so what lands here is what Anthropic ships and it
  # keeps itself current afterwards. Piped to sh in a subshell whose failure
  # cannot escape: a 404, a proxy that returns an HTML error page, or no network
  # at all must all end up in the same place as "it did not install".
  if curl -fsSL https://claude.ai/install.sh 2>/dev/null | sh >/dev/null 2>&1; then
    FOUND=$(find_claude 2>/dev/null) || FOUND=""
  fi
fi

if [ -n "$FOUND" ] && record "$FOUND"; then
  say_ "Claude Code is ready: $FOUND"
  say_ "You will be asked to sign in when the tracker opens."
  exit 0
fi

# The stale line has to go. If this ran because something broke, leaving the old
# path behind means the app keeps preferring a binary that no longer runs instead
# of falling through to the probes that might still find one.
rm -f "$IBC_RUNTIME_DIR/claude-path" 2>/dev/null

say_ "Claude Code could not be set up right now."
say_ "This is not fatal. The tracker still opens, and its Engine screen"
say_ "can try again once you have a connection."
exit 0
