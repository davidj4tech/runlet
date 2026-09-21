# Typed tools, phone approvals, and assistants as threads (proposal, 21 Sep 2026)

Status: **proposal; §3's client labels are built** (21 Sep 2026), the rest is not. How Sasonica Shell and the assistants that use it
(Claude.ai, ChatGPT custom connectors, any remote MCP host) fit into the
Sasonica umbrella (`umbrella.md`) beyond "a shell with a skills list".

Five changes, most useful first. The first two are the ones worth building
soon; they reinforce each other.

## Where it stands

- An assistant gets one real capability, `run_command`, which is any
  `bash -lc` string as the user. Four tools in all (`worker/src/index.ts`).
- The skills directory tells it what is worth running. On red5 today:
  `agent-mail`, `agent-memory-search`, `claude-sessions`, `music`,
  `music-transit`, `red5-map`, `speak`. To use one, the assistant runs
  `sasonica skills`, reads a SKILL.md, then composes a shell command from the
  prose. That is three round trips before the first useful call, and the
  command is free text every time.
- **The HMAC protects D1, not the Worker.** The Worker holds
  `SASONICA_HMAC_KEY` and signs whatever the secret URL asks for. So whoever
  holds the URL has a shell, and nothing on the runner can tell a legitimate
  row from one queued by a leaked URL. The README says so plainly ("no
  command allowlist"). Everything below keeps that true for `run_command`
  and adds a narrower door beside it.

## 1. Typed tools

**Idea:** a skill can declare actions with typed arguments. The runner
publishes them; the Worker lists them as ordinary MCP tools; a call runs a
**fixed argv template** with the arguments filled in, **never through a
shell**.

### The manifest

A sidecar, not new keys in SKILL.md: those files are shared with Claude
Code and the other harnesses through agent-config, and they are read as
prose. `~/.config/sasonica/tools/<skill>.json`:

```json
{
  "skill": "speak",
  "tools": [
    {
      "name": "speak",
      "description": "Say something out loud to David through agent-media's voice.",
      "input": {
        "type": "object",
        "properties": {"text": {"type": "string", "maxLength": 2000}},
        "required": ["text"]
      },
      "argv": ["media", "say", "--", "{text}"],
      "timeout_s": 30
    }
  ]
}
```

- `argv` is an array; each `{name}` is replaced by exactly one argument,
  never split and never interpreted. Run with `execFile`, no shell, so there
  is no quoting to get wrong and no injection to defend against.
- `input` is JSON Schema. It is checked by the Worker (for a quick, useful
  error) **and again by the runner** (the check that counts).
- Tool names get a prefix on the wire (`speak__speak`,
  `music__music_play`), so a skill cannot shadow `run_command`.

### How it flows

1. **Publish.** On start, and whenever the manifests change, the runner
   sends `POST /runner/tools` with the manifests and their sha256. The
   Worker stores them in a new table `tools(runner, name, manifest,
   sha256, updated_at)`.
2. **List.** `tools/list` answers the four built-ins plus every published
   tool. MCP clients re-list on `notifications/tools/list_changed`; the
   Worker sends it when the set changes.
3. **Call.** `tools/call speak__speak {"text": "…"}` queues a row with
   `kind = 'tool'` and `command = {"tool": "speak__speak", "args": {…},
   "manifest_sha": "…"}` (canonical JSON), signed exactly as today — the
   signing scheme and its test vectors do not change.
4. **Run.** The runner re-validates the arguments against **its own copy**
   of the manifest, rejects a `manifest_sha` it does not have, builds the
   argv and runs it. The result goes back exactly as today, so
   `get_result`, `detach` and `cancel` work unchanged.

**What a leaked URL can do with a tool row:** call a tool the owner
declared, with arguments that pass the runner's schema. It cannot change
the argv — the template lives only on the runner. That is the whole point:
a tool row is safe to run without asking; a free-text row may not be (§2).

### The first manifests

For agent-media: `speak(text)`, `music_play(query)`, `music_pause()`,
`music_now()`, `memory_search(query)`, `sessions_list()`, `mail_send(to,
subject, body)`, `mail_inbox()`. Each is a thin argv over a command that
exists today. `ask_session` is §4.

### Worker and runner changes

- Worker: the `tools` table, `POST /runner/tools`, merging tools into
  `tools/list`, `kind` on the row (`ALTER TABLE commands ADD COLUMN kind
  TEXT NOT NULL DEFAULT 'shell'`), schema validation, `list_changed`.
- Runner: load the manifests, publish them, and for `kind = 'tool'` run
  `execFile(argv)` instead of `bash -lc`. No new dependencies — the schema
  subset needed (type, required, maxLength, enum, pattern) is small enough
  to check by hand.
- Tests: signing vectors for a tool row; a runner test that a template
  cannot be widened by its arguments (`"; rm -rf ~"` arrives as one
  harmless argv element); a Worker test that an unpublished tool is refused.

## 2. Approvals on the phone

**Idea:** a runner-side policy decides which rows run straight away and
which wait for a tap in the Sasonica app. The approval **never passes
through the Worker**, so a leaked connector URL cannot approve its own
commands.

### Policy

`~/.config/sasonica/policy.json`, read by the runner:

```json
{
  "tool": "run",
  "shell": "approve",
  "shell_allow": ["^git (status|log|diff)\\b", "^ls\\b", "^cat \\S+$"],
  "approve_timeout_s": 300
}
```

- `tool` rows run (their argv is fixed by the owner).
- `shell` rows either `run` (today's behaviour, and the default so nothing
  changes for existing users), `approve`, or `refuse`. `shell_allow`
  patterns run without asking.
- A policy that is missing or unreadable means today's behaviour, and the
  runner logs this at start. Failing closed would break every existing
  install on upgrade.

### The path

1. The runner claims a row that needs approval and writes status
   **`awaiting`** (new; `get_result` shows it, so the assistant can tell
   the person "approve it on your phone").
2. The runner asks agent-media, **locally** (a unix socket or
   `127.0.0.1`, never the Worker): "row 42 from `claude.ai` wants to run
   `<command>`". agent-media puts it in the app as an approval, the same
   tool UI the app uses for permission prompts (server-contract §14).
3. The person taps allow or deny in the app. That request reaches the
   Sasonica server with the app's device token (server-contract §9). The
   runner is told locally, then runs or rejects.
4. No answer within `approve_timeout_s` → `rejected` with "not approved".

The approval travels phone → agent-media → runner. The Worker only ever
sees the final status. A leaked URL can queue rows, but approving them
takes the phone.

Without agent-media installed, `approve` falls back to a desktop
notification with a local confirm command (`sasonica approve 42`) — so
Sasonica Shell stays usable on its own, as its README promises.

## 3. Assistants as threads in the app

**Idea:** what a third-party assistant does through Sasonica Shell shows up in the
Sasonica app as a thread, next to the desk's Claude Code sessions. The phone
becomes the one place to see what every agent is doing.

- **Who asked. Done.** Two answers, side by side on every row:
  - `client`: **one connector URL per client**. A `clients(label,
    secret_sha256, created_at, revoked_at)` table beside the shared
    `SASONICA_URL_SECRET` (label `default`), managed with `sasonica client
    add|list|revoke` using the installer's Cloudflare token, never the
    runner's. It gives per-client revocation (within the Worker's 30 s
    cache) instead of rotating the one secret everyone shares.
  - `agent`: what the assistant calls itself — `clientInfo.name@version`
    from `initialize`, else `ua:<User-Agent>`. The Worker hands it back in
    a signed, stateless `Mcp-Session-Id` (key derived from
    `SASONICA_HMAC_KEY`, bound to the URL's label) and reads it on later
    requests; a client that does not echo it still works. Attribution on a
    shared URL, not security.
  - `name`: a label the caller puts in the URL, `/<secret>/<name>/mcp` or
    `?as=<name>` (`sasonica url --name`); it tells apart connectors on one
    secret, and is in the session id's MAC, but grants nothing.

  `sasonica status` shows `client/agent`, or `client/name (agent)` when the
  URL carried a name; the thread below can name itself from them.
- **The thread.** The runner already sees every row. It appends each row
  (client, command or tool call, status, trimmed output) to a local
  journal, and agent-media reads that journal as a thread source. In
  `/targets` the thread is "Sasonica Shell · claude.ai", and each row is a message:
  the command as the user turn, the output as the reply. The thread is
  read-only in v1. Replying from the app would mean pushing text back into
  a third-party chat, and nothing supports that.
- **Nothing new in the Worker** beyond the client label. D1 stays a queue,
  not an archive, which matters for the read quota.

## 4. Desk sessions from anywhere

**Idea:** an `ask_session` tool (a §1 manifest) lets Claude.ai or ChatGPT hand
work to a Claude Code session and read its answer.

- `sessions_list()` → the rows of agent-media's `/targets`.
- `ask_session(session, text)` → the same routing `/ask` and `/reply` use
  (a new chat, or into a live or revived session), returning the session
  id.
- `session_log(session, since)` → the conversation log's lines after
  `since`.

These go through agent-media's own CLI (`media ask …`, `media session-log
…`, the latter new) rather than HTTP, so no token is needed on the runner.
The app contract's rules still apply: only directories `/targets`
published, and never raw keystrokes.

The typing lands in David's real sessions, so `ask_session` should default
to `approve` in the §2 policy even though it is a typed tool — a per-tool
override: `"tool_overrides": {"claude_sessions__ask_session": "approve"}`.

## 5. Push instead of polling

The runner polls the Worker, and the Worker reads D1 on every poll. The
tmux-relay's poll ran D1 out of daily reads once (agent-media memory
`d1-quota-clips-silently`); Sasonica Shell has the same shape.

**A Durable Object per runner**, holding a WebSocket from `sasonica.mjs`:
- the Worker notifies the DO when it enqueues a row;
- the DO pushes "work available" down the socket;
- the runner claims as it does now.

D1 stays the record. Polling is kept at a slow interval as the fallback for
networks that drop long-lived sockets. The payoff: commands start in tens
of milliseconds instead of a poll interval, and idle D1 reads drop to
almost nothing. This is the least urgent of the five — the queue works —
but it is the one that makes interactive use (§4) feel immediate.

## Order

1. §3's client labels — tiny, and every later step wants to know who asked.
   **Done**, with the self-reported agent name alongside.
2. §1 typed tools, with the agent-media manifests.
3. §2 policy and approvals — needs the app's approval UI (the rebuild, in
   progress) and a local approval endpoint in agent-media.
4. §4 `ask_session`, gated by §2.
5. §3's thread view in the app.
6. §5 when latency or the D1 quota starts to matter.

## Not proposed

- **A command allowlist in the Worker.** The Worker is exactly the party
  that cannot be trusted with the decision; the runner is.
- **Folding the Sasonica link into Sasonica Shell.** Settled in `umbrella.md`: two
  transports, two credentials, two off switches.
- **Persistent shells.** Still out, for the reasons in the README.
