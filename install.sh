#!/usr/bin/env bash
#
# install.sh — runlet, from a Cloudflare API token to a running runner.
#
#     ./install.sh                 # interactive: asks for the token if not in env
#     CLOUDFLARE_API_TOKEN=... ./install.sh
#     ./install.sh --no-service    # everything except starting the runner
#     ./install.sh --print-url     # print this machine's connector URL and exit
#
# The ONE manual step is the token. Create it at
#   https://dash.cloudflare.com/profile/api-tokens  ->  Create Token  ->  Custom
# with these permissions, all at Account scope:
#   Workers Scripts : Edit
#   D1              : Edit
#   Account Settings: Read
# (No zone permissions: the Worker lives on workers.dev.)
#
# From that token this script: finds the account, creates the D1 database,
# applies the schema, registers a workers.dev subdomain if the account has
# none, generates the HMAC key and the URL secret, sets both as Worker
# secrets, deploys the Worker, writes ~/.config/runlet/{env,relay.key},
# and starts the runner as a systemd user service or macOS LaunchAgent.
# Re-running is safe: every step checks before it creates.
#
# Linux, macOS (Homebrew), or WSL2. On WSL2 the runner needs systemd
# (wsl.conf [boot] systemd=true);
# if it is off this script turns it on and tells you to `wsl --shutdown` and
# re-run.

set -euo pipefail
# Resolve links without GNU readlink -f (unavailable on stock macOS).
SOURCE=${BASH_SOURCE[0]}
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR=$(cd -P "$(dirname "$SOURCE")" && pwd)
  SOURCE=$(readlink "$SOURCE")
  [[ "$SOURCE" == /* ]] || SOURCE="$SOURCE_DIR/$SOURCE"
done
HERE=$(cd -P "$(dirname "$SOURCE")" && pwd)
CONF="$HOME/.config/runlet"
NO_SERVICE=0
[[ "${1:-}" == "--no-service" ]] && NO_SERVICE=1

# --print-url: rebuild the connector URL from the env file an earlier run
# wrote, and nothing else -- no token, no network, no redeploy. The bare URL
# on stdout, so it can be piped (e.g. into wl-copy).
if [[ "${1:-}" == "--print-url" ]]; then
  [[ -r "$CONF/env" ]] || { echo "no $CONF/env: run ./install.sh first" >&2; exit 1; }
  url=$(sed -n 's/^RUNLET_WORKER_URL=//p' "$CONF/env" | tail -1)
  sec=$(sed -n 's/^RUNLET_URL_SECRET=//p' "$CONF/env" | tail -1)
  [[ -n "$url" && -n "$sec" ]] || { echo "$CONF/env lacks RUNLET_WORKER_URL or RUNLET_URL_SECRET: re-run ./install.sh" >&2; exit 1; }
  printf '%s/%s/mcp\n' "$url" "$sec"
  exit 0
fi

# install.conf beside this script, if present, answers the questions in
# advance so the person running it types nothing: CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID (optional), RUNLET_SITE. Copy install.conf.example.
if [[ -r "$HERE/install.conf" ]]; then set -a; . "$HERE/install.conf"; set +a; fi

# One account can hold several of these (one per machine). RUNLET_SITE names
# this one; it goes into the Worker and database names so they never
# collide. Default: this machine's hostname.
RUNLET_SITE="${RUNLET_SITE:-$(hostname -s 2>/dev/null || hostname)}"
RUNLET_SITE=$(printf '%s' "$RUNLET_SITE" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-\n' '-' | sed 's/^-*//; s/-*$//' | cut -c1-30)
[[ -n "$RUNLET_SITE" ]] || RUNLET_SITE=site
# A re-run must find the stack it made, even if the hostname changed or the
# names were edited by hand: the names written to the env file last time
# win over the site default. An explicit RUNLET_WORKER_NAME / RUNLET_DB_NAME
# in the environment or install.conf still wins over both.
if [[ -r "$CONF/env" ]]; then
  : "${RUNLET_WORKER_NAME:=$(sed -n 's/^RUNLET_WORKER_NAME=//p' "$CONF/env" | tail -1)}"
  : "${RUNLET_DB_NAME:=$(sed -n 's/^RUNLET_DB_NAME=//p' "$CONF/env" | tail -1)}"
fi
WORKER_NAME="${RUNLET_WORKER_NAME:-runlet-$RUNLET_SITE}"
DB_NAME="${RUNLET_DB_NAME:-runlet-$RUNLET_SITE}"
API=https://api.cloudflare.com/client/v4

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
cf()   { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }

# --- 1. dependencies -------------------------------------------------------
say "Checking dependencies"
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
    RUNLET_BREW_PREFIX=$(brew --prefix)
    brew install jq coreutils openssl@3 python
    export PATH="$RUNLET_BREW_PREFIX/opt/coreutils/libexec/gnubin:$RUNLET_BREW_PREFIX/opt/openssl@3/bin:$RUNLET_BREW_PREFIX/bin:$PATH"
    ;;
  Linux) ;;
  *) die "unsupported operating system: $OS (use Linux, macOS, or WSL2)" ;;
esac
need_apt=()
if [[ "$OS" == Linux ]]; then
  for d in curl jq openssl; do command -v "$d" >/dev/null 2>&1 || need_apt+=("$d"); done
  if ! command -v timeout >/dev/null 2>&1 || ! command -v shuf >/dev/null 2>&1; then need_apt+=(coreutils); fi
  command -v setsid >/dev/null 2>&1 || need_apt+=(util-linux)
fi
if [[ -n "${need_apt[*]:-}" ]]; then
  command -v apt-get >/dev/null 2>&1 || die "install the missing packages with your package manager: ${need_apt[*]}"
  note "installing: ${need_apt[*]}"
  sudo apt-get update -qq && sudo apt-get install -y -qq "${need_apt[@]}"
fi
node_ok=0
if command -v node >/dev/null 2>&1; then
  v=$(node -v | sed 's/^v//' | cut -d. -f1); (( v >= 20 )) && node_ok=1
fi
if (( ! node_ok )) && [[ "$OS" == Darwin ]]; then
  note "installing Node 22 (Homebrew)"
  brew install node@22
  export PATH="$RUNLET_BREW_PREFIX/opt/node@22/bin:$PATH"
  node_ok=1
fi
if (( ! node_ok )); then
  command -v apt-get >/dev/null 2>&1 || die "install Node 22 and npm with your package manager, then re-run ./install.sh"
  note "installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
NODE_BIN=$(dirname "$(command -v node)")
note "node $(node -v), npm $(npm -v)"
( cd "$HERE/worker" && npm install --silent --no-audit --no-fund ) || die "npm install failed in worker/"
WRANGLER="$HERE/worker/node_modules/.bin/wrangler"
note "wrangler $("$WRANGLER" --version 2>/dev/null | tail -1)"

# --- 2. the token ----------------------------------------------------------
say "Cloudflare API token (site: $RUNLET_SITE -> Worker $WORKER_NAME, database $DB_NAME)"
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -r "$CONF/env" ]]; then
  CLOUDFLARE_API_TOKEN=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$CONF/env" | tail -1)
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cat <<'EOF'
    The installer needs a Cloudflare API token. Full steps are in SETUP.md;
    the short version:
      1. Sign in at https://dash.cloudflare.com (a free account is enough).
      2. Open https://dash.cloudflare.com/profile/api-tokens
         -> Create Token -> Create Custom Token (Get started).
      3. Name it runlet and add three permissions, all "Account":
            Workers Scripts   Edit
            D1                Edit
            Account Settings  Read
      4. Continue to summary -> Create Token -> copy it (shown once).
EOF
  read -rsp "    Paste the token here and press Enter: " CLOUDFLARE_API_TOKEN; echo
fi
export CLOUDFLARE_API_TOKEN
cf "$API/user/tokens/verify" | jq -e '.success and .result.status == "active"' >/dev/null || die "the token did not verify"
accounts=$(cf "$API/accounts?per_page=50")
n=$(jq '.result | length' <<<"$accounts")
(( n >= 1 )) || die "the token can see no accounts; it needs Account Settings: Read"
if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
elif (( n == 1 )); then ACCOUNT_ID=$(jq -r '.result[0].id' <<<"$accounts")
else
  note "The token can see several accounts:"
  jq -r '.result[] | "      \(.id)  \(.name)"' <<<"$accounts"
  read -rp "    Account id to use: " ACCOUNT_ID
fi
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
note "account $ACCOUNT_ID ($(jq -r --arg a "$ACCOUNT_ID" '.result[] | select(.id==$a) | .name' <<<"$accounts"))"

# --- 3. D1 -----------------------------------------------------------------
say "D1 database '$DB_NAME'"
DB_ID=$(cf "$API/accounts/$ACCOUNT_ID/d1/database?name=$DB_NAME&per_page=100" | jq -r --arg n "$DB_NAME" '.result[] | select(.name==$n) | .uuid' | head -1)
if [[ -z "$DB_ID" ]]; then
  DB_ID=$(cf -X POST "$API/accounts/$ACCOUNT_ID/d1/database" --data "{\"name\":\"$DB_NAME\"}" | jq -r '.result.uuid')
  note "created $DB_ID"
else
  note "exists: $DB_ID"
fi
[[ "$DB_ID" =~ ^[0-9a-f-]{36}$ ]] || die "could not get a database id"

# --- 4. wrangler config ----------------------------------------------------
say "Writing worker/wrangler.jsonc"
sed -e "s/__WORKER_NAME__/$WORKER_NAME/" -e "s/__ACCOUNT_ID__/$ACCOUNT_ID/" \
    -e "s/__DB_NAME__/$DB_NAME/" -e "s/__DB_ID__/$DB_ID/" \
    "$HERE/worker/wrangler.jsonc.template" > "$HERE/worker/wrangler.jsonc"
( cd "$HERE/worker" && "$WRANGLER" d1 execute "$DB_NAME" --remote --file "$HERE/schema.sql" >/dev/null ) || die "applying schema.sql failed"
# Columns added after the first release, for a database created before
# them. ALTER TABLE is not idempotent in SQLite, so look first.
cols=$( cd "$HERE/worker" && "$WRANGLER" d1 execute "$DB_NAME" --remote --json --command "PRAGMA table_info(commands);" 2>/dev/null | jq -r '.[0].results[].name' )
for spec in "background INTEGER NOT NULL DEFAULT 0" "cancel INTEGER NOT NULL DEFAULT 0" "runner TEXT"; do
  col="${spec%% *}"
  if ! grep -qx "$col" <<<"$cols"; then
    ( cd "$HERE/worker" && "$WRANGLER" d1 execute "$DB_NAME" --remote --command "ALTER TABLE commands ADD COLUMN $spec;" >/dev/null ) \
      || die "adding the $col column failed"
    note "added the $col column"
  fi
done
note "schema applied"

# --- 5. secrets --------------------------------------------------------------
say "Keys"
mkdir -p "$CONF"; chmod 700 "$CONF"
if [[ ! -s "$CONF/relay.key" ]]; then
  openssl rand -hex 32 > "$CONF/relay.key"; chmod 600 "$CONF/relay.key"; note "generated relay.key"
else note "relay.key exists, keeping it"; fi
if [[ -r "$CONF/env" ]] && URL_SECRET=$(sed -n 's/^RUNLET_URL_SECRET=//p' "$CONF/env" | tail -1) && [[ -n "$URL_SECRET" ]]; then
  note "URL secret exists, keeping it"
else
  # Random words from the EFF short list (1295 words), RUNLET_SECRET_WORDS of
  # them (default 5: about 52 bits, ~1,100 years at 100k guesses/s with no
  # rate limit anywhere -- the floor for a secret that is a shell on the
  # machine; 6 is ~1.5M years). A URL a person can read back over the phone.
  # Hex if the list is missing, so a stripped-down copy still installs.
  nwords="${RUNLET_SECRET_WORDS:-5}"
  [[ "$nwords" =~ ^[0-9]+$ ]] && (( nwords >= 4 )) || { note "RUNLET_SECRET_WORDS=$nwords is too few; using 5"; nwords=5; }
  if [[ -r "$HERE/words.txt" ]] && (( $(wc -l < "$HERE/words.txt") > 1000 )); then
    URL_SECRET=$(shuf -n "$nwords" --random-source=/dev/urandom "$HERE/words.txt" | paste -sd- -)
    note "generated the URL secret ($nwords words)"
  else
    URL_SECRET=$(openssl rand -hex 24); note "generated the URL secret (hex; words.txt not found)"
  fi
fi
( cd "$HERE/worker" \
  && tr -d '[:space:]' < "$CONF/relay.key" | "$WRANGLER" secret put RUNLET_HMAC_KEY >/dev/null \
  && printf '%s' "$URL_SECRET" | "$WRANGLER" secret put RUNLET_URL_SECRET >/dev/null ) || die "setting Worker secrets failed"
note "Worker secrets set"

# --- 6. workers.dev subdomain, then deploy ----------------------------------
say "Deploying the Worker"
sub=$(cf "$API/accounts/$ACCOUNT_ID/workers/subdomain" | jq -r '.result.subdomain // empty')
if [[ -z "$sub" ]]; then
  want="relay-$(openssl rand -hex 3)"
  cf -X PUT "$API/accounts/$ACCOUNT_ID/workers/subdomain" --data "{\"subdomain\":\"$want\"}" >/dev/null \
    || die "the account has no workers.dev subdomain and registering '$want' failed"
  sub="$want"; note "registered workers.dev subdomain: $sub"
fi
( cd "$HERE/worker" && "$WRANGLER" deploy 2>&1 | tail -3 | sed 's/^/    /' ) || die "wrangler deploy failed"
WORKER_URL="https://$WORKER_NAME.$sub.workers.dev"

# --- 7. local config ---------------------------------------------------------
say "Writing $CONF/env"
cat > "$CONF/env" <<EOF
# runlet — written by install.sh $(date +%F). The token here is what the
# runner uses to read and write the queue; keep this file private.
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
RUNLET_SITE=$RUNLET_SITE
RUNLET_WORKER_NAME=$WORKER_NAME
RUNLET_DB_NAME=$DB_NAME
RUNLET_DB_ID=$DB_ID
RUNLET_URL_SECRET=$URL_SECRET
RUNLET_WORKER_URL=$WORKER_URL
RUNLET_POLL=5
RUNLET_CMD_TIMEOUT=600
EOF
# Shell quoting also supports home directories with spaces.
printf 'RUNLET_KEY_FILE=%q\n' "$CONF/relay.key" >> "$CONF/env"
if [[ "$OS" == Darwin ]]; then
  printf 'RUNLET_BREW_PREFIX=%q\n' "$RUNLET_BREW_PREFIX" >> "$CONF/env"
fi
chmod 600 "$CONF/env"
chmod +x "$HERE/runlet.sh"
# `runlet` on PATH, so `runlet --help` is there to find: ~/.local/bin is on
# the login-shell PATH of most distros, and commands run under bash -lc.
mkdir -p "$HOME/.local/bin" "$CONF/skills"
ln -sfn "$HERE/runlet.sh" "$HOME/.local/bin/runlet"

# --- 8. smoke test: queue a row the way the Worker does, run it once ---------
say "Smoke test"
# A fresh deploy takes a few seconds to reach every edge; the first probe
# after it answered 404 on 2026-09-17. Retry for up to a minute.
resp=""
for i in $(seq 1 12); do
  resp=$(curl -fsS -X POST "$WORKER_URL/$URL_SECRET/mcp" -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"echo runlet-ok","wait":0}}}' 2>/dev/null) && break
  note "waiting for the deploy to propagate ($((i*5))s)"; sleep 5
done
[[ -n "$resp" ]] || die "the Worker did not answer at $WORKER_URL/<secret>/mcp after a minute"
rid=$(jq -r '.result.content[0].text' <<<"$resp" | grep -oE '^#[0-9]+' | tr -d '#')
[[ -n "$rid" ]] || die "unexpected Worker reply: $resp"
"$HERE/runlet.sh" --once 2>&1 | sed 's/^/    /'
# get_result with a wait: if a service is already running it may have taken
# the row before the one-shot poll above, and still be on it.
got=$(curl -fsS -X POST "$WORKER_URL/$URL_SECRET/mcp" -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_result\",\"arguments\":{\"id\":$rid,\"wait\":30}}}" \
  | jq -r '.result.content[0].text')
grep -q 'runlet-ok' <<<"$got" || die "smoke test failed; the runner did not produce the result: $got"
note "queued #$rid, ran it, read the output back: OK"

# --- 9. the service ----------------------------------------------------------
if (( NO_SERVICE )); then
  say "Not starting the service (--no-service). Run it with: $HERE/runlet.sh"
elif [[ "$OS" == Darwin ]]; then
  say "Starting the runner as a macOS LaunchAgent"
  AGENT_LABEL=org.runlet.runner
  AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
  LOG_DIR="$HOME/Library/Logs/runlet"
  mkdir -p "$(dirname "$AGENT_PLIST")" "$LOG_DIR"
  # plistlib escapes XML metacharacters and spaces in paths correctly.
  python3 - "$AGENT_PLIST" "$HERE" "$HOME" "$PATH" "$LOG_DIR" <<'PYPLIST'
import plistlib
import sys
plist, repo, home, path, logs = sys.argv[1:]
with open(plist, "wb") as stream:
    plistlib.dump({
        "Label": "org.runlet.runner",
        "ProgramArguments": ["/bin/bash", repo + "/runlet.sh"],
        "WorkingDirectory": home,
        "EnvironmentVariables": {"HOME": home, "PATH": home + "/.local/bin:" + path},
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": logs + "/runner.log",
        "StandardErrorPath": logs + "/runner.log",
    }, stream)
PYPLIST
  plutil -lint "$AGENT_PLIST" >/dev/null
  launch_domain="gui/$(id -u)"
  if launchctl print "$launch_domain" >/dev/null 2>&1; then
    # Re-running replaces a loaded definition, and re-enables a disabled one.
    if launchctl print "$launch_domain/$AGENT_LABEL" >/dev/null 2>&1; then
      launchctl bootout "$launch_domain/$AGENT_LABEL"
    fi
    launchctl enable "$launch_domain/$AGENT_LABEL"
    launchctl bootstrap "$launch_domain" "$AGENT_PLIST"
    note "$AGENT_LABEL installed; starts now and at login"
  else
    note "LaunchAgent installed; it will start at your next desktop login."
    note "To run now in this session: $HERE/runlet.sh"
  fi
else
  say "Starting the runner as a systemd user service"
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    if grep -qi microsoft /proc/version 2>/dev/null; then
      note "systemd is not running in this WSL distro. Enabling it in /etc/wsl.conf."
      printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
      note "From PowerShell run:  wsl --shutdown   then open the distro again and re-run ./install.sh"
      note "Until then, run the runner by hand: $HERE/runlet.sh"
    else
      note "systemd user session not available; run the runner by hand: $HERE/runlet.sh"
    fi
  else
    mkdir -p "$HOME/.config/systemd/user"
    sed -e "s|__LITE_DIR__|$HERE|g" -e "s|__NODE_BIN__|$NODE_BIN|g" "$HERE/runlet.service" \
      > "$HOME/.config/systemd/user/runlet.service"
    systemctl --user daemon-reload
    systemctl --user enable --now runlet >/dev/null
    sudo loginctl enable-linger "$USER" 2>/dev/null || true
    sleep 2
    note "runlet.service: $(systemctl --user is-active runlet)"
  fi
fi

# --- 10. hand the URL to the person -------------------------------------------
# The last manual step is pasting the URL into Claude's connector form, and
# there is no way to prefill that form. So: put the URL on the clipboard
# and open the page. Both are best-effort -- over ssh or in a container
# there is no clipboard and no browser -- and the URL is printed regardless.
# If they are not signed in, claude.ai shows the login and returns them to
# the page afterwards; nothing for us to do about that.
CONNECT_URL="$WORKER_URL/$URL_SECRET/mcp"
CONNECTORS_PAGE="https://claude.ai/settings/connectors"
clip=0; opened=0
if grep -qi microsoft /proc/version 2>/dev/null && command -v clip.exe >/dev/null 2>&1; then
  printf '%s' "$CONNECT_URL" | clip.exe 2>/dev/null && clip=1              # WSL -> Windows clipboard
elif command -v wl-copy >/dev/null 2>&1 && [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  printf '%s' "$CONNECT_URL" | wl-copy 2>/dev/null && clip=1
elif command -v xclip >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
  printf '%s' "$CONNECT_URL" | xclip -selection clipboard 2>/dev/null && clip=1
elif command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$CONNECT_URL" | pbcopy 2>/dev/null && clip=1
fi
if [[ -z "${SSH_CONNECTION:-}" ]]; then
  if grep -qi microsoft /proc/version 2>/dev/null && command -v cmd.exe >/dev/null 2>&1; then
    ( cd /mnt/c 2>/dev/null && cmd.exe /c start "" "$CONNECTORS_PAGE" >/dev/null 2>&1 ) && opened=1   # Windows default browser
  elif command -v xdg-open >/dev/null 2>&1 && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    ( xdg-open "$CONNECTORS_PAGE" >/dev/null 2>&1 & ) && opened=1
  elif command -v open >/dev/null 2>&1 && [[ "$(uname)" == Darwin ]]; then
    open "$CONNECTORS_PAGE" >/dev/null 2>&1 && opened=1
  fi
fi

say "Done"
cat <<EOF
    Connector URL (treat it as a password; it is the only credential):

        $CONNECT_URL

EOF
(( clip ))   && note "It is on your clipboard." \
             || note "Copy it from above."
(( opened )) && note "Claude's connectors page is opening in your browser (sign in if it asks)." \
             || note "Open $CONNECTORS_PAGE in a browser (sign in if it asks)."
cat <<EOF
    There: Add custom connector -> paste the URL -> no authentication -> save.
    Then ask Claude to run a command, e.g. "run uname -a on my machine".

    Status:      runlet status        (runlet --help for the rest)
    Skills:      link SKILL.md files into $CONF/skills/ for assistants to find
    Config:      $CONF/env   (token, secret, URL)   $CONF/relay.key
    Re-run this script any time; it keeps existing keys and ids.
EOF
if [[ "$OS" == Darwin ]]; then
  note "Runner log: tail -f \"$HOME/Library/Logs/runlet/runner.log\""
  note 'If runlet is not on your Terminal PATH, add export PATH="$HOME/.local/bin:$PATH" to ~/.zprofile (zsh) or ~/.bash_profile (bash).'
else
  note "Runner log: journalctl --user -u runlet -f"
fi
