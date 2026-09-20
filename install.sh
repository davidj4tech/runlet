#!/usr/bin/env bash
#
# install.sh — make sure Node is here, then hand over to install.mjs, which is
# the installer on every platform.
#
#     ./install.sh                 # interactive: asks for the token if not in env
#     ./install.sh --no-service    # everything except starting the runner
#     ./install.sh --print-url     # print this machine's connector URL and exit
#
# Everything this script used to do itself -- the token, the database, the
# schema, the secrets, the deploy, the config, the service -- is in
# install.mjs now, shared with Windows. What is left is the one thing that
# cannot be written in Node: getting Node.
#
# Linux, or macOS with Homebrew. Windows has install.ps1.

set -euo pipefail
# Resolve links without GNU readlink -f (unavailable on stock macOS).
SOURCE=${BASH_SOURCE[0]}
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR=$(cd -P "$(dirname "$SOURCE")" && pwd)
  SOURCE=$(readlink "$SOURCE")
  [[ "$SOURCE" == /* ]] || SOURCE="$SOURCE_DIR/$SOURCE"
done
HERE=$(cd -P "$(dirname "$SOURCE")" && pwd)

die() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
note() { printf '    %s\n' "$*"; }

OS=$(uname -s)
case "$OS" in
  Darwin)
    # launchd and fresh Terminal sessions may not have Homebrew on PATH.
    if ! command -v brew >/dev/null 2>&1; then
      for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [[ -x "$brew_bin" ]]; then export PATH="$(dirname "$brew_bin"):$PATH"; break; fi
      done
    fi
    command -v brew >/dev/null 2>&1 || die "macOS requires Homebrew. Install it from https://brew.sh, then re-run ./install.sh"
    ;;
  Linux) ;;
  *) die "unsupported operating system: $OS (use Linux, macOS, or install.ps1 on Windows)" ;;
esac

# Node 20+ is the only dependency. install.mjs needs no curl, jq, openssl or
# coreutils: Node has fetch, JSON, crypto and a word picker of its own.
node_ok=0
if command -v node >/dev/null 2>&1; then
  v=$(node -v | sed 's/^v//' | cut -d. -f1); [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 20 )) && node_ok=1
fi
if (( ! node_ok )); then
  if [[ "$OS" == Darwin ]]; then
    note "installing Node 22 (Homebrew)"
    brew install node@22
    export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
  elif command -v apt-get >/dev/null 2>&1; then
    note "installing Node 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
    sudo apt-get install -y -qq nodejs
  else
    die "install Node 20+ with your package manager, then re-run ./install.sh"
  fi
fi
command -v node >/dev/null 2>&1 || die "Node is still not on PATH; open a new shell and re-run ./install.sh"

exec node "$HERE/install.mjs" "$@"
