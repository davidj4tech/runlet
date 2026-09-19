#!/usr/bin/env bash
#
# runlet.sh — poll the queue, run what is signed, write the result back.
#
# ############################################################################
# ##  THIS SCRIPT EXECUTES SHELL COMMANDS READ FROM A DATABASE, as you.     ##
# ##  Whoever holds the Worker URL can run anything here. The HMAC check   ##
# ##  below is what stops a row that merely got INTO the database from     ##
# ##  running: only a row signed with relay.key is executed.               ##
# ############################################################################
#
#     runlet.sh            # poll forever (the service form)
#     runlet.sh --once     # one poll, for testing
#     runlet.sh status [n] # the last n rows (default 10), newest first
#     runlet.sh sign <nonce> <command>   # the signature this runner expects
#     runlet.sh skills     # the skills listed in RUNLET_SKILLS_DIR
#     runlet.sh --help     # the above, for a person or an assistant
#
# Config: ~/.config/runlet/env (written by install.sh):
#     CLOUDFLARE_API_TOKEN   token for reading and writing D1 (over its HTTP API)
#     CLOUDFLARE_ACCOUNT_ID  account holding the database (default: from wrangler.jsonc)
#     RUNLET_DB_NAME          D1 database (default runlet)
#     RUNLET_DB_ID            its id (default: looked up by name in wrangler.jsonc)
#     RUNLET_KEY_FILE         hex key shared with the Worker (default relay.key beside env)
#     RUNLET_POLL             seconds between polls (default 5)
#     RUNLET_CMD_TIMEOUT      seconds a command may run (default 600)
#     RUNLET_MAX_OUTPUT       bytes of output kept (default 60000)
#     RUNLET_PARALLEL         commands run at once (default 1: strictly in order)
#     RUNLET_BACKGROUND_MAX   rows sent with background=true running at once (default 4)
#     RUNLET_DETACH_CHECK     seconds between looks for a detach or cancel on a running row (default 3)
#     RUNLET_KEEP_DAYS        finished rows older than this are deleted daily (default 30)
#     RUNLET_PROGRESS_EVERY   seconds between copies of a running job's output onto its row (default 10; 0 = off)
#     RUNLET_LOAD_MAX         hold new commands while the 1-min load average is above this (default 0 = off)
#     RUNLET_RUNNER_ID        this runner's name on the rows it claims (default: hostname)
#     RUNLET_SKILLS_DIR       SKILL.md files (or links) that `skills` lists (default skills/ beside env)
#
# Every tunable above (not the token, key or database) is re-read from the env
# file every poll: edit the file and the change is live within one interval.
#
# This is github.com/davidj4tech/tmux-relay's d1-runner with everything that is not "run a command
# and write the result" removed: no kinds, no panes, no Claude, no mailbox.
# The signature it checks is the same v1 scheme, so the two can share a key
# if you ever want them to.

set -uo pipefail

# Commands inherit this, so `"$RUNLET" skills` works from any of them. A
# login shell (bash -lc) may reset PATH, but it leaves this alone. Already
# set means this copy was started BY a command the runner is running.
IN_JOB=0; [[ -n "${RUNLET:-}" ]] && IN_JOB=1
# Resolve links without GNU readlink -f (unavailable on stock macOS).
SOURCE=${BASH_SOURCE[0]}
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR=$(cd -P "$(dirname "$SOURCE")" && pwd)
  SOURCE=$(readlink "$SOURCE")
  [[ "$SOURCE" == /* ]] || SOURCE="$SOURCE_DIR/$SOURCE"
done
HERE=$(cd -P "$(dirname "$SOURCE")" && pwd)
export RUNLET="$HERE/$(basename "$SOURCE")"

CONF_DIR="${RUNLET_CONF:-$HOME/.config/runlet}"
if [[ -r "$CONF_DIR/env" ]]; then set -a; . "$CONF_DIR/env"; set +a; fi
# shellcheck source=lib/platform.sh
. "$HERE/lib/platform.sh" || exit 1
runlet_platform_init
WRANGLER_CFG="${RUNLET_WRANGLER_CONFIG:-$HERE/worker/wrangler.jsonc}"
DB="${RUNLET_DB_NAME:-runlet}"
KEY_FILE="${RUNLET_KEY_FILE:-$CONF_DIR/relay.key}"
POLL="${RUNLET_POLL:-5}"
CMD_TIMEOUT="${RUNLET_CMD_TIMEOUT:-600}"
MAX_OUTPUT="${RUNLET_MAX_OUTPUT:-60000}"
# 1 = serial, the default: each command finishes before the next starts, so
# nothing interleaves and a long job is easy to spot. Higher = that many at
# once, each in its own process; outputs then land in whatever order they
# finish, and jobs compete for the machine. Set it knowingly.
PARALLEL="${RUNLET_PARALLEL:-1}"
[[ "$PARALLEL" =~ ^[1-9][0-9]*$ ]] || PARALLEL=1
# How many rows flagged background=true may run at once, whatever PARALLEL
# says. They are the assistant's choice per command; this is the owner's
# ceiling on that choice.
BACKGROUND_MAX="${RUNLET_BACKGROUND_MAX:-4}"
[[ "$BACKGROUND_MAX" =~ ^[1-9][0-9]*$ ]] || BACKGROUND_MAX=4
# Seconds between looks at whether a running foreground row was detached.
DETACH_CHECK="${RUNLET_DETACH_CHECK:-3}"
[[ "$DETACH_CHECK" =~ ^[1-9][0-9]*$ ]] || DETACH_CHECK=3
# Seconds between copies of a running job's output onto its row (0 = never).
PROGRESS_EVERY="${RUNLET_PROGRESS_EVERY:-10}"
[[ "$PROGRESS_EVERY" =~ ^[0-9]+$ ]] || PROGRESS_EVERY=10
# Do not START new commands while the 1-minute load average is above this
# (0 = no ceiling). Running ones are left alone; pending rows wait.
LOAD_MAX="${RUNLET_LOAD_MAX:-0}"
[[ "$LOAD_MAX" =~ ^[0-9]+(\.[0-9]+)?$ ]] || LOAD_MAX=0
# Who claims rows. Written onto the row so the orphan sweep at startup only
# touches rows THIS runner was running, and two runners on one database
# cannot sweep each other.
RUNNER_ID="${RUNLET_RUNNER_ID:-$(hostname -s 2>/dev/null || hostname)}"
# Finished rows older than this many days are deleted, once a day.
KEEP_DAYS="${RUNLET_KEEP_DAYS:-30}"
[[ "$KEEP_DAYS" =~ ^[1-9][0-9]*$ ]] || KEEP_DAYS=30
LAST_PRUNE=-100000
LAST_STALE=-100000
LOAD_HELD=0
# The serial queue's one lane: pid of the subshell running the current
# foreground row, or empty. poll() starts rows in it without waiting, so the
# loop keeps polling (and starting background rows) while it is busy.
FG_PID=
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/runlet"
SEEN="${RUNLET_NONCE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/runlet/nonces}"

# Under systemd, log straight to the journal with the unit named on each
# entry. Written to stderr, a line from a job's short-lived subshell often
# lost its unit: journald looks the unit up from the writer's pid, which has
# exited by then, so `journalctl -u runlet` missed most "exit" lines.
# systemd-cat has the same race; logger --journald can set USER_UNIT itself.
# Elsewhere (a terminal, --once, tests) it is plain stderr as before.
LOG_UNIT=
if [[ -n "${JOURNAL_STREAM:-}" ]] && command -v logger >/dev/null 2>&1; then
  LOG_UNIT=$(sed -n 's|^0::.*/\([^/]*\.service\)$|\1|p' /proc/self/cgroup 2>/dev/null)
fi
log() {
  local line; line="$(date '+%F %T') runlet: $*"
  if [[ -n "$LOG_UNIT" ]]; then
    # One field per line, so a newline in a logged command must not start a
    # field of its own.
    printf 'MESSAGE=%s\nPRIORITY=6\nSYSLOG_IDENTIFIER=runlet.sh\nUSER_UNIT=%s\n' "${line//$'\n'/ }" "$LOG_UNIT" \
      | logger --journald 2>/dev/null && return
  fi
  printf '%s\n' "$line" >&2
}

usage() {
  cat <<EOF
runlet: run signed shell commands queued by an assistant, on this machine.

  runlet skills        the tools the owner has set up here, and where to read about each
  runlet status [n]    the last n commands (default 10), newest first
  runlet --once        one poll of the queue, for testing
  runlet               poll forever (what the service runs)
  runlet sign <nonce> <command>   the signature this runner expects

Assistant? Start with \`runlet skills\`. If runlet is not on PATH, \`"\$RUNLET" skills\`
works from any command the runner starts.
EOF
}
case "${1:-}" in
  -h|--help|help) usage; exit 0 ;;
  ''|--once|status|sign|skills) ;;
  *) echo "runlet: unknown command '$1'" >&2; usage >&2; exit 2 ;;
esac
# A command the runner is running must not become a second runner: bare
# `runlet` would poll the queue until the timeout killed it, taking rows.
if (( IN_JOB )) && [[ -z "${1:-}" || "$1" == --once ]]; then
  echo "runlet: already running this command; it does not poll from inside a job" >&2
  usage >&2; exit 2
fi

for dep in jq openssl timeout "${RUNLET_PROCESS_DEP}"; do
  command -v "$dep" >/dev/null 2>&1 || { log "missing dependency: $dep"; exit 1; }
done

# `sign <nonce> <command>`: print the signature this runner would expect,
# using the key in RUNLET_KEY_FILE (or RUNLET_KEY). For tests/check-signing.sh,
# which holds this and the Worker's implementation to one set of vectors.
if [[ "${1:-}" == sign ]]; then
  KEY="${RUNLET_KEY:-$(tr -d '[:space:]' < "$KEY_FILE" 2>/dev/null)}"
  [[ -n "$KEY" ]] || { echo "runlet sign: no key (RUNLET_KEY or $KEY_FILE)" >&2; exit 1; }
  printf '%s\n%s' "$2" "$3" | openssl dgst -sha256 -mac HMAC -macopt "key:$KEY" -r 2>/dev/null | cut -d' ' -f1
  exit 0
fi

# `skills`: what this machine offers beyond a bare shell, one entry per file
# in RUNLET_SKILLS_DIR -- a SKILL.md-style file (or a symlink to one, or a
# directory holding one) whose frontmatter has name: and description:. The
# assistant runs this first and reads a file in full only when it needs it.
# The owner curates the directory; nothing is found by scanning the disk.
if [[ "${1:-}" == skills ]]; then
  dir="${RUNLET_SKILLS_DIR:-$CONF_DIR/skills}"
  shopt -s nullglob
  entries=("$dir"/*)
  if [[ -z "${entries[*]:-}" ]]; then
    echo "No skills listed on $(hostname -s 2>/dev/null || hostname). The owner can add one with:"
    echo "  ln -s /path/to/SKILL.md $dir/<name>.md"
    exit 0
  fi
  echo "Skills on $(hostname -s 2>/dev/null || hostname). Read one in full (cat the path) before using it."
  for e in "${entries[@]}"; do
    f=$(readlink -f "$e"); [[ -d "$f" ]] && f="$f/SKILL.md"
    [[ -r "$f" ]] || { echo; echo "$(basename "$e"): unreadable ($f)"; continue; }
    # Only the frontmatter: the block between a first-line --- and the next.
    fm=$(awk 'NR == 1 && !/^---[[:space:]]*$/ { exit } NR > 1 && /^---[[:space:]]*$/ { exit } NR > 1' "$f")
    name=$(sed -n 's/^name:[[:space:]]*//p' <<<"$fm" | head -1)
    desc=$(sed -n 's/^description:[[:space:]]*//p' <<<"$fm" | head -1)
    [[ -n "$name" ]] || { name=$(basename "$e"); name="${name%.md}"; }
    [[ -n "$desc" ]] || desc=$(grep -m1 -v '^\(---\|#\|[[:space:]]*$\)' "$f")
    printf '\n%s: %s\n  %s\n' "$name" "$desc" "$f"
  done
  exit 0
fi

# D1 is reached over its HTTP API with curl: one request per query, about
# 0.1 s, where each `wrangler d1 execute` started Node and took 1.5-2 s --
# several of those per command made every hand-off 10-15 s. The account and
# database ids come from the env file, else from wrangler.jsonc. Without a
# token or ids it falls back to wrangler, as before.
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
DB_ID="${RUNLET_DB_ID:-}"
if [[ -r "$WRANGLER_CFG" ]] && [[ -z "$ACCOUNT_ID" || -z "$DB_ID" ]]; then
  cfg=$(grep -v '^[[:space:]]*//' "$WRANGLER_CFG" | jq -c . 2>/dev/null)
  [[ -n "$ACCOUNT_ID" ]] || ACCOUNT_ID=$(jq -r '.account_id // empty' <<<"$cfg" 2>/dev/null)
  [[ -n "$DB_ID" ]] || DB_ID=$(jq -r --arg n "$DB" '.d1_databases[]? | select(.database_name == $n) | .database_id' <<<"$cfg" 2>/dev/null | head -1)
fi
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "$ACCOUNT_ID" && "$DB_ID" =~ ^[0-9a-f-]{36}$ ]] && command -v curl >/dev/null 2>&1; then
  D1_URL="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DB_ID/query"
else
  D1_URL=
  WRANGLER=$(command -v wrangler || true)
  [[ -n "$WRANGLER" && -x "$HERE/worker/node_modules/.bin/wrangler" ]] && WRANGLER="$HERE/worker/node_modules/.bin/wrangler"
  [[ -n "$WRANGLER" ]] || WRANGLER="$HERE/worker/node_modules/.bin/wrangler"
  [[ -x "$WRANGLER" ]] || { log "wrangler not found; run install.sh"; exit 1; }
  [[ -r "$WRANGLER_CFG" ]] || { log "no wrangler config at $WRANGLER_CFG; run install.sh"; exit 1; }
fi
[[ -r "$KEY_FILE" ]] || { log "no key at $KEY_FILE; run install.sh"; exit 1; }
KEY=$(tr -d '[:space:]' < "$KEY_FILE")
[[ "$KEY" =~ ^[0-9a-fA-F]{32,}$ ]] || { log "key in $KEY_FILE is not a hex string"; exit 1; }
mkdir -p "$(dirname "$SEEN")" "$STATE_DIR"

# --- D1 ----------------------------------------------------------------------
# `d1_exec <sql>`: the raw reply, [{results, meta}], the shape wrangler's
# --json prints, which the HTTP API returns as .result. The SQL goes in on
# stdin, so a 60 KB output literal never meets the argument-length limit.
d1_exec() {
  if [[ -z "$D1_URL" ]]; then
    # stdout only: wrangler's warnings on stderr would spoil the JSON.
    "$WRANGLER" --config "$WRANGLER_CFG" d1 execute "$DB" --remote --json --command "$1"
    return
  fi
  local raw
  # The token goes in through a file descriptor, never on curl's command
  # line, where any user could read it in ps.
  raw=$(jq -Rsc '{sql: .}' <<<"$1" | curl -sS --max-time 60 -X POST "$D1_URL" \
          -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") \
          -H 'Content-Type: application/json' --data-binary @- 2>&1) \
    || { printf '%s' "$raw"; return 1; }
  jq -ce 'if .success then .result else error("\(.errors // [] | map(.message) | join("; "))") end' <<<"$raw" 2>/dev/null \
    || { printf 'D1 API error: %s' "$(jq -r '.errors // [] | map(.message) | join("; ")' <<<"$raw" 2>/dev/null || printf '%s' "${raw:0:200}")"; return 1; }
}
# `d1_changes <sql>`: rows a write changed, 0 on any failure.
d1_changes() { d1_exec "$1" 2>/dev/null | jq -r '.[0].meta.changes // 0' 2>/dev/null || echo 0; }
d1() {  # $1 = sql -> results array on stdout, or non-zero
  local raw
  raw=$(d1_exec "$1") || {
    log "d1 failed: $(printf '%s' "$raw" | grep -v '^\s*$' | tail -1)"; return 1; }
  printf '%s' "$raw" | jq -ce 'if type=="array" then .[0].results // [] else error("bad envelope") end' 2>/dev/null || {
    log "unparseable d1 response: $(printf '%s' "$raw" | head -1)"; return 1; }
}
sql_lit() { printf '%s' "$1" | tr -d '\000' | sed "s/'/''/g"; }

# --- signing: identical to relay-sign.sh relay_hmac / relay_ct_equal ---------
hmac() { printf '%s\n%s' "$1" "$2" | openssl dgst -sha256 -mac HMAC -macopt "key:$KEY" -r 2>/dev/null | cut -d' ' -f1; }
ct_equal() {
  local a="$1" b="$2" i d=0
  (( ${#a} == ${#b} )) || return 1
  for (( i = 0; i < ${#a}; i++ )); do d=$(( d | ( $(printf '%d' "'${a:i:1}") ^ $(printf '%d' "'${b:i:1}") ) )); done
  (( d == 0 ))
}

write_result() {  # $1 = id, $2 = status, $3 = exit code, $4 = output
  d1 "UPDATE commands SET status = '$2', exit_code = $3, output = '$(sql_lit "$4")', updated_at = datetime('now') WHERE id = $1;" >/dev/null
}

run_one() {  # $1 = id, $2 = command, $3 = sig, $4 = nonce
  local id="$1" command="$2" sig="$3" nonce="$4" expected claimed out rc

  # Nonce seen before = a replayed row (someone re-inserted a signed row).
  if grep -qxF -- "$nonce" "$SEEN" 2>/dev/null; then
    log "#$id: nonce already used — rejecting as a replay"
    write_result "$id" rejected -1 "runlet: replayed nonce"; return
  fi
  expected=$(hmac "$nonce" "$command")
  if ! ct_equal "$expected" "$sig"; then
    log "#$id: BAD SIGNATURE — not executing"
    write_result "$id" rejected -1 "runlet: signature did not verify"; return
  fi
  # Claim it. `AND status = 'pending'` means only one runner can win.
  claimed=$(d1_changes "UPDATE commands SET status = 'running', runner = '$(sql_lit "$RUNNER_ID")', updated_at = datetime('now') WHERE id = $id AND status = 'pending';")
  [[ "$claimed" == 1 ]] || { log "#$id: claimed by someone else"; return; }
  # Append only here: parallel jobs may write at once, and appends are safe
  # where a rewrite is not. The file is trimmed by poll(), single-threaded.
  printf '%s\n' "$nonce" >> "$SEEN"

  log "#$id: running: ${command:0:80}"
  # Always in its own process, even in serial mode, so the queue can let go
  # of it (detach) or stop it (cancel) from outside. The process writes its
  # own result.
  execute_and_write "$id" "$command" &
  watch_job "$id" "$!" "${5:-fg}"
}

# Watch a running job for a cancel, and (in the foreground) for a detach.
# Every RUNLET_DETACH_CHECK seconds it reads the row's two flags -- one D1
# read, so a short command never pays for it. A cancel kills the job's whole
# process group and lets execute_and_write record the outcome. A detach in
# the foreground hands the watching over to a background copy of this loop
# and returns, so the queue moves on while the job runs.
watch_job() {  # $1 = id, $2 = pid of execute_and_write, $3 = fg|bg
  local id="$1" pid="$2" mode="$3" flags bg c outf="$STATE_DIR/job.$id.out"
  # Scheduled by the clock, not by loop count: each D1 round trip below costs
  # seconds, so counting iterations drifted badly (a "10 s" progress write
  # landed at 30 s on the first try).
  local start=$SECONDS last_check=$SECONDS last_progress=$SECONDS t
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1; t=$(( SECONDS - start ))
    # Progress: copy what the job has printed so far onto the row, so a
    # get_result on a running job shows it. One D1 write per interval per
    # running job; only while the row is still 'running'.
    if (( PROGRESS_EVERY > 0 && SECONDS - last_progress >= PROGRESS_EVERY )) && [[ -s "$outf" ]]; then
      last_progress=$SECONDS
      d1 "UPDATE commands SET output = '$(sql_lit "$(head -c "$MAX_OUTPUT" "$outf")")', updated_at = datetime('now') WHERE id = $id AND status = 'running';" >/dev/null 2>&1
    fi
    (( SECONDS - last_check >= DETACH_CHECK )) || continue
    last_check=$SECONDS
    flags=$(d1 "SELECT COALESCE(background, 0) AS bg, COALESCE(cancel, 0) AS c FROM commands WHERE id = $id;" 2>/dev/null \
            | jq -r '.[0] | "\(.bg) \(.c)"' 2>/dev/null)
    bg="${flags%% *}"; c="${flags##* }"
    if [[ "$c" == 1 ]]; then cancel_job "$id"; return 0; fi
    if [[ "$mode" == fg && "$bg" == 1 ]]; then
      log "#$id: detached after ${t}s — it keeps running, the queue moves on"
      ( watch_job "$id" "$pid" bg ) &
      return 0
    fi
  done
}

# Kill a job and everything it spawned: the command runs as its own process
# group (setsid), whose id execute_and_write wrote down. The marker file
# tells execute_and_write to record 'cancelled' rather than an exit code,
# with whatever output there was, and it wins over the timeout branch.
cancel_job() {  # $1 = id
  local id="$1" pgid
  pgid=$(cat "$STATE_DIR/job.$id.pgid" 2>/dev/null)
  : > "$STATE_DIR/cancel.$id"
  if [[ "$pgid" =~ ^[0-9]+$ ]]; then
    kill -TERM -- "-$pgid" 2>/dev/null
    local i; for (( i = 0; i < 5; i++ )); do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$pgid" 2>/dev/null
  fi
  log "#$id: cancel requested — killed process group ${pgid:-?}"
}

execute_and_write() {  # $1 = id, $2 = command
  local id="$1" command="$2" out rc outf="$STATE_DIR/job.$id.out"
  # setsid: a fresh process group, whose leader writes its own pid down
  # (equal to the group id) before exec'ing the command under timeout.
  runlet_start_session bash -c 'echo $$ > "$1"; exec timeout --kill-after=10 "$2" bash -lc "$3"' _ \
    "$STATE_DIR/job.$id.pgid" "$CMD_TIMEOUT" "$command" </dev/null >"$outf" 2>&1 &
  wait "$!"; rc=$?
  out=$(head -c "$MAX_OUTPUT" "$outf" 2>/dev/null)
  rm -f "$outf" "$STATE_DIR/job.$id.pgid"
  if [[ -e "$STATE_DIR/cancel.$id" ]]; then
    rm -f "$STATE_DIR/cancel.$id"
    write_result "$id" cancelled -1 "$out
runlet: cancelled after it had started; whatever it did before that is done"
    log "#$id: cancelled, ${#out} bytes of output kept"
  elif (( rc == 124 || rc == 137 )); then
    write_result "$id" timeout "$rc" "$out
runlet: killed after ${CMD_TIMEOUT}s"
    log "#$id: timed out"
  else
    write_result "$id" done "$rc" "$out"
    log "#$id: exit $rc, ${#out} bytes"
  fi
}

# Finished rows older than RUNLET_KEEP_DAYS go. The table is the only thing
# here that grows without bound, and nothing reads an old result. Runs at
# start and then once a day; rows still pending or running are never touched.
prune_old() {
  local n
  n=$(d1_changes "DELETE FROM commands WHERE status NOT IN ('pending', 'running') AND created_at < datetime('now', '-${KEEP_DAYS} days');")
  [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] && log "pruned $n finished row(s) older than ${KEEP_DAYS} days"
  LAST_PRUNE=$SECONDS
  return 0
}

# A row still 'running' when this runner starts belonged to a runner that is
# gone -- a restart mid-job takes its children with it (systemd kills the
# group). Left alone it would stay 'running' forever and a waiting
# get_result would only ever time out. One runner per database is the
# assumption here; a second runner sharing it would see its jobs swept.
sweep_orphans() {
  local n
  n=$(d1_changes "UPDATE commands SET status = 'error', exit_code = -1, output = 'runlet: the runner restarted while this was running; the command may or may not have completed', updated_at = datetime('now') WHERE status = 'running' AND (runner = '$(sql_lit "$RUNNER_ID")' OR runner IS NULL);")
  [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] && log "marked $n orphaned 'running' row(s) of runner '$RUNNER_ID' as error"
  return 0
}

# A row 'running' for longer than the timeout plus a grace period, with no
# result written, belonged to a job whose runner hung rather than restarted:
# the timeout would have killed a live one and recorded it. Swept every few
# minutes, own rows only. Progress writes keep a talkative job's updated_at
# fresh, and a silent one is killed by the timeout first, so a live job is
# never caught by this.
sweep_stale() {
  local n
  n=$(d1_changes "UPDATE commands SET status = 'error', exit_code = -1, output = 'runlet: ran past the timeout without reporting; the runner may have hung', updated_at = datetime('now') WHERE status = 'running' AND runner = '$(sql_lit "$RUNNER_ID")' AND updated_at < datetime('now', '-$(( CMD_TIMEOUT + 120 )) seconds');")
  [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] && log "marked $n stale 'running' row(s) as error"
  LAST_STALE=$SECONDS
  return 0
}

# Settings that may change while the runner is up are re-read every poll, so
# editing ~/.config/runlet/env takes effect within one poll interval and
# no restart is needed. Only these: the token, key and database stay as
# loaded, because changing those under a running job is not "on the fly".
reload_tunables() {
  local v
  [[ -r "$CONF_DIR/env" ]] || return 0
  v=$(sed -n 's/^RUNLET_PARALLEL=//p' "$CONF_DIR/env" | tail -1 | tr -d '[:space:]"'"'"'')
  if [[ "$v" =~ ^[1-9][0-9]*$ && "$v" != "$PARALLEL" ]]; then log "RUNLET_PARALLEL now $v (was $PARALLEL)"; PARALLEL="$v"; fi
  v=$(sed -n 's/^RUNLET_CMD_TIMEOUT=//p' "$CONF_DIR/env" | tail -1 | tr -d '[:space:]"'"'"'')
  if [[ "$v" =~ ^[1-9][0-9]*$ && "$v" != "$CMD_TIMEOUT" ]]; then log "RUNLET_CMD_TIMEOUT now ${v}s (was ${CMD_TIMEOUT}s)"; CMD_TIMEOUT="$v"; fi
  v=$(sed -n 's/^RUNLET_POLL=//p' "$CONF_DIR/env" | tail -1 | tr -d '[:space:]"'"'"'')
  if [[ "$v" =~ ^[1-9][0-9]*$ && "$v" != "$POLL" ]]; then log "RUNLET_POLL now ${v}s (was ${POLL}s)"; POLL="$v"; fi
  v=$(sed -n 's/^RUNLET_BACKGROUND_MAX=//p' "$CONF_DIR/env" | tail -1 | tr -d '[:space:]"'"'"'')
  if [[ "$v" =~ ^[1-9][0-9]*$ && "$v" != "$BACKGROUND_MAX" ]]; then log "RUNLET_BACKGROUND_MAX now $v (was $BACKGROUND_MAX)"; BACKGROUND_MAX="$v"; fi
  v=$(sed -n 's/^RUNLET_PROGRESS_EVERY=//p' "$CONF_DIR/env" | tail -1 | tr -d '[:space:]"'"'"'')
  if [[ "$v" =~ ^[0-9]+$ && "$v" != "$PROGRESS_EVERY" ]]; then log "RUNLET_PROGRESS_EVERY now ${v}s (was ${PROGRESS_EVERY}s)"; PROGRESS_EVERY="$v"; fi
  v=$(sed -n 's/^RUNLET_KEEP_DAYS=//p' "$CONF_DIR/env" | tail -1 | tr -d '[:space:]"'"'"'')
  if [[ "$v" =~ ^[1-9][0-9]*$ && "$v" != "$KEEP_DAYS" ]]; then log "RUNLET_KEEP_DAYS now $v (was $KEEP_DAYS)"; KEEP_DAYS="$v"; fi
  # Absent line = ceiling off, so removing it releases a hold.
  v=$(sed -n 's/^RUNLET_LOAD_MAX=//p' "$CONF_DIR/env" | tail -1 | tr -d '[:space:]"'"'"''); [[ -n "$v" ]] || v=0
  if [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ && "$v" != "$LOAD_MAX" ]]; then log "RUNLET_LOAD_MAX now $v (was $LOAD_MAX)"; LOAD_MAX="$v"; fi
}

# Is the foreground lane still running its row? A detach ends the lane's
# subshell early (the watching moves to a background copy), freeing it.
fg_busy() { [[ -n "$FG_PID" ]] && jobs -rp | grep -qxF -- "$FG_PID"; }
# Background rows running now: every running child except the lane.
bg_running() { jobs -rp | grep -cvxF -- "${FG_PID:-none}"; }

poll() {
  local rows load where
  reload_tunables
  if [[ "$LOAD_MAX" != 0 ]]; then
    load=$(runlet_load_average)
    if awk -v l="$load" -v m="$LOAD_MAX" 'BEGIN { exit !(l > m) }'; then
      (( LOAD_HELD )) || log "load average $load is over RUNLET_LOAD_MAX=$LOAD_MAX — not starting new commands until it drops"
      LOAD_HELD=1; return 0
    fi
    (( LOAD_HELD )) && log "load average $load is back under $LOAD_MAX — resuming"
    LOAD_HELD=0
  elif (( LOAD_HELD )); then
    log "load ceiling removed — resuming"; LOAD_HELD=0
  fi
  # While the lane is busy only background rows can start, so ask only for
  # those; otherwise five queued commands could hide one behind them.
  where="status = 'pending'"
  (( PARALLEL == 1 )) && fg_busy && where="$where AND background = 1"
  rows=$(d1 "SELECT id, command, sig, nonce, COALESCE(background, 0) AS background FROM commands WHERE $where ORDER BY id LIMIT 5;") || return 1
  local n; n=$(printf '%s' "$rows" | jq 'length')
  (( n > 0 )) || return 0
  local i bg id sig nonce cmd
  for (( i = 0; i < n; i++ )); do
    bg=$(jq -r ".[$i].background" <<<"$rows")
    # Read once, keeping any trailing newline: $(...) strips them, and a
    # signature over the stripped text does not verify. The X is a sentinel
    # for the strip, removed right after.
    id=$(jq -r ".[$i].id" <<<"$rows"); sig=$(jq -r ".[$i].sig" <<<"$rows"); nonce=$(jq -r ".[$i].nonce" <<<"$rows")
    # -j, not -r: -r appends a newline of its own, which the X would keep.
    cmd=$(jq -j ".[$i].command" <<<"$rows"; printf X); cmd="${cmd%X}"
    if [[ "$bg" == 1 ]]; then
      # Asked to run alongside the queue (run_command background=true). Its
      # own cap, RUNLET_BACKGROUND_MAX, independent of RUNLET_PARALLEL: the
      # queue stays serial while a long job runs beside it.
      while (( $(bg_running) >= BACKGROUND_MAX )); do sleep 0.5; done
      run_one "$id" "$cmd" "$sig" "$nonce" bg &
    elif (( PARALLEL > 1 )); then
      # Hold here while the cap is full. A row another job already claimed
      # while we waited is refused by the claim's status check.
      while (( $(jobs -rp | wc -l) >= PARALLEL )); do sleep 0.5; done
      run_one "$id" "$cmd" "$sig" "$nonce" bg &
    else
      # Serial: one foreground row at a time, oldest first. A busy lane
      # leaves this row (and every later foreground one) for a later poll.
      fg_busy && continue
      run_one "$id" "$cmd" "$sig" "$nonce" fg &
      FG_PID=$!
    fi
  done
  # Trim the nonce file from the one place that is never concurrent.
  if [[ -s "$SEEN" ]] && (( $(wc -l < "$SEEN") > 6000 )); then
    tail -n 5000 "$SEEN" > "$SEEN.tmp" && mv "$SEEN.tmp" "$SEEN"
  fi
}

# `status`: the last rows, newest first -- "is it stuck?" as one command.
if [[ "${1:-}" == status ]]; then
  d1 "SELECT id, status, exit_code, runner, created_at, updated_at,
             substr(replace(replace(command, char(10), ' '), char(9), ' '), 1, 50) AS command,
             substr(replace(output, char(10), ' | '), 1, 70) AS output
      FROM commands ORDER BY id DESC LIMIT ${2:-10};" \
    | jq -r '.[] | "#\(.id)\t\(.status)\(if .exit_code == null then "" else " exit=\(.exit_code)" end)\t\(.updated_at)\t\(.command)\n\t\t\t\(.output // "")"'
  exit 0
fi

if [[ "${1:-}" == "--once" ]]; then poll; rc=$?; wait; exit $rc; fi
log "polling '$DB' every ${POLL}s; commands run as $(id -un) with a ${CMD_TIMEOUT}s limit$( (( PARALLEL > 1 )) && echo ", up to $PARALLEL at once" )"
sweep_orphans
while :; do
  (( SECONDS - LAST_PRUNE >= 86400 )) && prune_old
  (( SECONDS - LAST_STALE >= 300 )) && sweep_stale
  poll; sleep "$POLL"
done
