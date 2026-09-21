#!/usr/bin/env bash
# check-signing.sh — the runner and the Worker must sign identically, or every
# command comes back 'rejected' with no useful error. This holds both to
# tests/vectors.json, which is the same fixture tmux-relay's runner is pinned
# to, so all three agree.
#
#     tests/check-signing.sh        # exit 0 = every vector matches on both sides
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
V="$HERE/vectors.json"
KEY=$(jq -r '.key' "$V")
fail=0 n=0

# Both sides are Node now. On fnm-managed hosts (for example red5) a
# non-interactive shell may not have the default alias on PATH, so use the
# same direct alias path as the fleet dotfiles.
if ! command -v node >/dev/null 2>&1; then
  fnm_node="${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin"
  [[ -x "$fnm_node/node" ]] && export PATH="$fnm_node:$PATH"
fi
command -v node >/dev/null 2>&1 || { echo "check-signing: Node 22.6+ is required" >&2; exit 1; }

# --- the runner side, through sasonica.mjs's own `sign` -------------------
# Fields joined with US (0x1f), not tabs: `read` collapses an empty field
# between tabs (the empty-command vector). The trailing X keeps a command's
# trailing newline through $(...), which strips them.
while IFS=$'\x1f' read -r name nonce cmd_b64 expected; do
  n=$(( n + 1 ))
  cmd=$(printf '%s' "$cmd_b64" | base64 -d; printf X); cmd="${cmd%X}"
  got=$(SASONICA_KEY="$KEY" node "$HERE/../sasonica.mjs" sign "$nonce" "$cmd")
  if [[ "$got" == "$expected" ]]; then echo "  runner  ok    $name"
  else echo "  runner  FAIL  $name: got $got"; fail=1; fi
done < <(jq -r '.vectors[] | [.name, .nonce, .command_b64, .expected] | join("")' "$V")

# --- the Worker side, the real hmacHex from worker/src/index.ts -------------
# Node 22.6+ strips the types itself; nothing to build. Run from the tests
# directory so the relative import resolves (a stdin script resolves against
# the working directory).
cd "$HERE" && node --experimental-strip-types --no-warnings - "$V" <<'JS' || fail=1
import { hmacHex } from '../worker/src/index.ts'
import { readFileSync } from 'node:fs'
const v = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let bad = 0
for (const t of v.vectors) {
  const cmd = Buffer.from(t.command_b64, 'base64').toString('utf8')
  const got = await hmacHex(v.key, `${t.nonce}\n${cmd}`)
  const ok = got === t.expected
  console.log(`  worker  ${ok ? 'ok  ' : 'FAIL'}  ${t.name}${ok ? '' : `: got ${got}`}`)
  if (!ok) bad++
}
process.exit(bad ? 1 : 0)
JS

if (( fail )); then echo "check-signing: MISMATCH — do not deploy"; exit 1; fi
echo "check-signing: $n vectors, runner and Worker agree"
