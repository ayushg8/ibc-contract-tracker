#!/bin/sh
#
# Shared constants and helpers for IBC Contracts on macOS.
#
# Sourced by three different callers -- the installer, the .app launcher and the
# server runner -- so it must not assume a shell beyond POSIX and must not
# assume a working directory. Everything is derived from $HOME or from a path
# the caller passes in.
#
# WHY a shared file at all: the port range, the data directory and the health
# probe have to agree between the LaunchAgent and the .app. When they disagreed
# during testing the icon opened a browser at a port nothing was listening on,
# which is exactly the failure a non-technical user cannot diagnose.

IBC_APP_NAME="IBC Contracts"
IBC_EXECUTABLE="ibc-contracts"
IBC_BUNDLE_ID="com.internationalbattery.contract-tracker"
IBC_AGENT_LABEL="com.internationalbattery.contract-tracker"
IBC_VERSION="1.3.0"

# Pinned so an install today and an install in six months produce the same
# runtime. 24.x is well past the node:sqlite floor (22.5) the app requires.
IBC_NODE_VERSION="v24.18.1"
# Published on nodejs.org in SHASUMS256.txt for this exact version. Hard-coded
# rather than fetched so a compromised or truncated download cannot also supply
# its own checksum.
IBC_NODE_SHA256_ARM64="eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941"
IBC_NODE_SHA256_X64="6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec"

# Deliberately not 3000, 3001, 5173, 8000 or 8080. This machine had three other
# things on 3000 while the app was being built. These sit in the registered
# range but are unassigned, and below the macOS ephemeral floor (49152) so the
# OS will never hand one out to something else mid-session.
IBC_PORTS="47821 47822 47823 47824 47825 47826 47827 47828 47829 47830"

# Must match src/lib/paths.ts. Not exported: the app computes the same default
# on its own, and an exported override here would silently win over a real one.
IBC_DATA_DIR_DEFAULT="$HOME/Library/Application Support/IBC Contract Tracker"
IBC_DATA_DIR="${IBC_DATA_DIR:-$IBC_DATA_DIR_DEFAULT}"
IBC_RUNTIME_DIR="$IBC_DATA_DIR/runtime"
IBC_LOG_DIR="$IBC_DATA_DIR/logs"
IBC_PORT_FILE="$IBC_RUNTIME_DIR/port"
IBC_LOCK_DIR="$IBC_RUNTIME_DIR/start.lock"
IBC_SERVER_LOG="$IBC_LOG_DIR/server.log"
IBC_LAUNCHER_LOG="$IBC_LOG_DIR/launcher.log"

# Set by whichever caller knows where the bundle is. Declared here so `set -u`
# does not trip over it in a caller that never needs a runtime.
IBC_NODE="${IBC_NODE:-}"

IBC_CACHE_DIR="$HOME/Library/Caches/com.internationalbattery.contract-tracker"
IBC_AGENT_PLIST="$HOME/Library/LaunchAgents/$IBC_AGENT_LABEL.plist"

# ---------------------------------------------------------------------------
# Arch
# ---------------------------------------------------------------------------

# Node's own naming, not uname's. Detected, never guessed: an x64 tarball on
# Apple silicon runs under Rosetta if it runs at all, and node:sqlite is a
# native binding, so a wrong guess fails deep inside the app rather than here.
ibc_node_arch() {
  case "$(uname -m)" in
    arm64) printf 'arm64' ;;
    x86_64) printf 'x64' ;;
    *) return 1 ;;
  esac
}

ibc_node_sha256() {
  case "$1" in
    arm64) printf '%s' "$IBC_NODE_SHA256_ARM64" ;;
    x64) printf '%s' "$IBC_NODE_SHA256_X64" ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Liveness probe
# ---------------------------------------------------------------------------

# A marker file the installer writes into the app's public/ folder. Next serves
# public/ straight off disk: no route handler, no render, no database, no
# subprocess. Requiring exactly 200 on a path only this app has also answers
# "is this our server" better than a status code from a shared endpoint would.
IBC_PING_PATH="/ibc-ping.txt"

# WHY NOT /api/health, which is the obvious choice: it is the right endpoint
# for a person and the wrong one for a poll loop. Every call spawns the Claude
# CLI to report engine health. Polling it once a second while waiting for
# startup piled up fifteen concurrent CLI processes and wedged the server for
# ten minutes -- measured on this machine, not theorised. Liveness has to be
# free, or waiting for the app to start is what stops it starting.

# curl prints 000 when it could not connect at all.
ibc_http_code() {
  _code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-20}" "$1" 2>/dev/null)
  case "$_code" in
    '' | 000) printf '000' ;;
    *) printf '%s' "$_code" ;;
  esac
}

# Is anything listening at all? A pure TCP connect, so it costs nothing on the
# nine ports of the range that are closed. Without this pre-filter, one
# unrelated slow server parked on a candidate port makes the sweep take as long
# as its HTTP timeout, and the icon appears to do nothing.
ibc_tcp_open() {
  if [ -x /usr/bin/nc ]; then
    /usr/bin/nc -z -G 1 -w 1 127.0.0.1 "$1" >/dev/null 2>&1
  else
    # No nc: cannot pre-filter, so let the HTTP probe be the whole answer.
    return 0
  fi
}

ibc_probe_port() {
  [ -n "$1" ] || return 1
  ibc_tcp_open "$1" || return 1
  [ "$(ibc_http_code "http://127.0.0.1:$1$IBC_PING_PATH" "${2:-5}")" = "200" ]
}

ibc_read_port_file() {
  [ -f "$IBC_PORT_FILE" ] || return 1
  _p=$(tr -dc '0-9' <"$IBC_PORT_FILE" 2>/dev/null)
  [ -n "$_p" ] || return 1
  printf '%s' "$_p"
}

# The port the server is ACTUALLY on, which is not necessarily the one we last
# wrote down. Checks the recorded port first (the common case, one probe), then
# sweeps the range. A refused connection returns instantly, so the sweep costs
# nothing when nothing is running.
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

# Can we bind it? Asked through node rather than lsof because lsof only sees
# sockets it has permission to see, and a port held by another user's process
# would look free.
ibc_port_free() {
  [ -x "$IBC_NODE" ] || return 1
  "$IBC_NODE" -e '
const net = require("node:net");
const s = net.createServer();
s.once("error", () => process.exit(1));
s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close(() => process.exit(0)));
' "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

ibc_log() {
  mkdir -p "$IBC_LOG_DIR" 2>/dev/null || true
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"${IBC_LOG_TARGET:-$IBC_LAUNCHER_LOG}" 2>/dev/null || true
}

# Message goes in as an argument, so nothing in it needs escaping. Building the
# AppleScript string by hand broke the first time a path contained a quote.
ibc_dialog() {
  /usr/bin/osascript - "$1" >/dev/null 2>&1 <<'IBC_APPLESCRIPT' || true
on run argv
  display dialog (item 1 of argv) with title "IBC Contracts" buttons {"OK"} default button "OK" with icon caution
end run
IBC_APPLESCRIPT
}

ibc_notify() {
  /usr/bin/osascript - "$1" >/dev/null 2>&1 <<'IBC_APPLESCRIPT' || true
on run argv
  display notification (item 1 of argv) with title "IBC Contracts"
end run
IBC_APPLESCRIPT
}

# Chrome's --app mode drops the tab strip and the address bar, so the window
# reads as an application rather than as a web page. Detected by asking
# LaunchServices, not by testing one hard-coded path, because Chrome is often
# in ~/Applications instead.
ibc_open_window() {
  _url="http://127.0.0.1:$1/"
  if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
    if open -na "Google Chrome" --args --app="$_url" >/dev/null 2>&1; then
      return 0
    fi
  fi
  open "$_url" >/dev/null 2>&1
}
