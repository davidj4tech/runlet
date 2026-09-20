/**
 * runlet — the smallest relay that works.
 *
 * One MCP server, four tools: run_command queues a shell command for a runner
 * on your machine; get_result fetches it later; detach lets a slow foreground
 * command keep running without holding the queue; cancel stops pending or running
 * work. No Claude Code on the host, no panes, no mail.
 *
 * ###########################################################################
 * ##  This queues commands that a machine will EXECUTE as a real user.     ##
 * ##  Whoever can reach this Worker's URL can run arbitrary shell on the   ##
 * ##  runner host. Two things stand in the way:                            ##
 * ##                                                                       ##
 * ##   1. The URL secret. The MCP endpoint is /<RUNLET_URL_SECRET>/mcp, and ##
 * ##      any other path is 404. Treat that URL like a password: it goes   ##
 * ##      into the connector settings of ONE assistant and nowhere else.   ##
 * ##   2. HMAC. Every row is signed with RUNLET_HMAC_KEY, held only here    ##
 * ##      and on the runner. Database access alone cannot make the runner ##
 * ##      execute anything.                                                ##
 * ###########################################################################
 *
 * The signature is byte-for-byte the v1 scheme of tmux-relay's runner
 * (nonce + "\n" + command, HMAC-SHA256 keyed with the ASCII hex key), so
 * runlet.sh and tmux-relay's d1-runner.sh agree; tests/vectors.json in that
 * repo pins it.
 */

interface Env {
  DB: D1Database
  /** Hex key shared with the runner (relay.key). Set with `wrangler secret put`. */
  RUNLET_HMAC_KEY: string
  /** The path secret. Set with `wrangler secret put`. */
  RUNLET_URL_SECRET: string
  /**
   * Bearer token a runner presents at /runner. One per machine, so the
   * machine that executes commands holds no Cloudflare credential at all --
   * a D1 API token is account-wide, and would reach every other queue.
   * Absent = the runner API is off, and every request to it is a 404.
   */
  RUNLET_RUNNER_TOKEN?: string
  /** Seconds run_command waits by default / at most. */
  RUNLET_WAIT_DEFAULT?: string
  RUNLET_WAIT_MAX?: string
}

const PROTOCOL_VERSION = '2025-06-18'
// Cap on any `wait`. The claude.ai connector drops a call that stays silent
// for about a minute, and sometimes sooner, so a longer wait fails there even
// though the Worker answers. Measured 2026-09-17; keep this well under that.
const WAIT_MAX = 30
const TERMINAL = ['done', 'error', 'rejected', 'timeout', 'cancelled']
const FAILED = ['error', 'rejected', 'timeout', 'cancelled']
const MAX_COMMAND_CHARS = 8000

// --- signing (mirrors tmux-relay relay-sign.sh relay_hmac) -----------------
// Exported for tests/check-signing.sh, which holds this and the runner's
// openssl implementation to the same vectors.
export async function hmacHex(keyText: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  // The key is the ASCII characters of the hex string, not the decoded bytes:
  // bash passes `-macopt key:$KEY`, which takes the literal text.
  const key = await crypto.subtle.importKey('raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// --- MCP -------------------------------------------------------------------
const TOOLS = [
  {
    name: 'run_command',
    description:
      "Run a shell command on the user's own machine and return its output. The " +
      'command is queued for a runner there, which executes it as the user with ' +
      'bash -lc, a 600 s limit and up to 60 KB of output kept; this call waits up ' +
      'to `wait` seconds for the result. Anything you send here RUNS on a real ' +
      "machine: prefer read-only commands unless the user asked for a change, and " +
      'never run something destructive on a guess.\n\n' +
      'Start with `runlet skills` (or `"$RUNLET" skills` if runlet is not on ' +
      'PATH): it lists the tools the owner has set up on this machine ' +
      '(messaging, services, project helpers), each with a file to read before ' +
      'using it. Check it before assuming something is not there. ' +
      '`runlet --help` shows the rest.\n\n' +
      'How to operate it:\n' +
      '- The result starts with "#<id> <status> exit=<code>" then the output. ' +
      'Status done means it ran; check exit= before trusting the output.\n' +
      '- Commands run ONE AT A TIME in the order queued (unless the host set ' +
      'RUNLET_PARALLEL), so a long command holds everything behind it -- unless ' +
      'you pass background=true, which lets that one run alongside the queue.\n' +
      '- For anything long: pass background=true and a short wait, note the id, ' +
      'and call get_result with a wait when you want the output. Meanwhile other ' +
      'commands still run in turn.\n' +
      '- Output over 60 KB is cut; pipe through head, tail or grep instead of ' +
      'dumping large files.\n' +
      '- There is no working directory or shell state between calls: each ' +
      "command starts fresh in the user's home. Use cd inside the command.\n" +
      '- Quote carefully: the string is passed to bash exactly as given.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command, run with bash -lc from the home directory.' },
        wait: { type: 'number', description: 'Seconds to wait for the result (default 30, max 30). Use 0 to queue and return the id at once.' },
        background: {
          type: 'boolean',
          description:
            'true: start this command alongside the queue instead of in turn, so it does not ' +
            'block commands queued after it. For builds, downloads, long scripts. The host caps ' +
            'how many background jobs run at once (default 4); past the cap it waits.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'cancel',
    description:
      'Stop a command: one still queued never starts; one already running is killed by the ' +
      'runner (with everything it spawned) and its status becomes cancelled. Whatever the ' +
      'command had already done stays done -- this stops it, it does not undo it. ' +
      'Waits briefly (default 15 s, `wait` to change) for the runner to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Row id from run_command.' },
        wait: { type: 'number', description: 'Seconds to wait for the runner to confirm (default 15, max 30).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'detach',
    description:
      'Let a command that is already running (or still queued) stop holding up the queue: ' +
      'it keeps running in the background and commands after it proceed. Use it when ' +
      'something is taking longer than expected and you want to do other things meanwhile. ' +
      'Collect its output later with get_result and a wait. Does not stop or kill anything.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Row id from run_command.' } },
      required: ['id'],
    },
  },
  {
    name: 'get_result',
    description:
      'Fetch the status and output of a command queued earlier, by the id run_command ' +
      'returned. Pass `wait` to block up to that many seconds until it finishes, so a ' +
      'long job needs one call rather than a polling loop; without it you get the ' +
      'current state at once. Status pending or running means it has not finished; ' +
      'a running job shows the output it has produced so far (refreshed every ~10 s).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Row id from run_command.' },
        wait: { type: 'number', description: 'Seconds to wait for it to finish (default 0: answer now; max 30).' },
      },
      required: ['id'],
    },
  },
]

interface Row {
  id: number
  status: string
  exit_code: number | null
  output: string | null
}

function render(row: Row, timedOut: boolean): string {
  const head = `#${row.id} ${row.status}${row.exit_code === null ? '' : ` exit=${row.exit_code}`}`
  if (timedOut) {
    const partial = row.status === 'running' && row.output ? `\n--- output so far ---\n${row.output}` : ''
    return `${head}\nStill running after the wait. Call get_result(id=${row.id}, wait=…) for the rest.${partial}`
  }
  return `${head}\n${row.output ?? ''}`
}

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}
function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } })
}
function toolText(id: unknown, text: string, isError = false): Response {
  return rpc(id, { content: [{ type: 'text', text }], isError })
}

// Poll a row until it is terminal or the wait runs out. Shared by
// run_command and get_result, so "wait for it" means the same thing in
// both: 250 ms growing to 2 s between looks, and the wait is a ceiling.
async function awaitRow(env: Env, id: number, waitSeconds: number): Promise<{ row: Row | null; timedOut: boolean }> {
  const deadline = Date.now() + waitSeconds * 1000
  let delay = 250
  for (;;) {
    const row = await env.DB.prepare(`SELECT id, status, exit_code, output FROM commands WHERE id = ?`).bind(id).first<Row>()
    if (row && TERMINAL.includes(row.status)) return { row, timedOut: false }
    if (Date.now() >= deadline) return { row, timedOut: true }
    await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))))
    delay = Math.min(Math.round(delay * 1.5), 2000)
  }
}

// --- the runner API ---------------------------------------------------------
// Everything a runner used to do with its own D1 credential, as one POST with
// an `op`. Six ops, chosen so a poll costs one request and a watcher tick
// costs one: `claim` returns rows already claimed, and `heartbeat` writes
// progress and reads the cancel/background flags in the same round trip.
//
// The runner is not the assistant: it authenticates with a Bearer header
// rather than a path secret, so its credential stays out of URLs and logs.
const CLAIM_LIMIT = 5

function runnerJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

export async function runnerApi(request: Request, env: Env): Promise<Response> {
  const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  // Same 404 as an unknown path: whether the API exists must not depend on
  // whether the token was right.
  if (!env.RUNLET_RUNNER_TOKEN || !timingSafeEqual(offered, env.RUNLET_RUNNER_TOKEN)) {
    return new Response('not found', { status: 404 })
  }
  if (request.method !== 'POST') return new Response('POST JSON here', { status: 405 })

  let body: any
  try { body = await request.json() } catch { return runnerJson({ error: 'parse error' }, 400) }
  const runner = String(body?.runner ?? '')
  const id = Number(body?.id)

  switch (body?.op) {
    // Claim up to CLAIM_LIMIT pending rows and return them already claimed.
    // The runner used to SELECT and then UPDATE, and two runners could race
    // for the same row; doing both here makes the claim atomic by
    // construction. `backgroundOnly` is the busy serial lane asking for the
    // rows it can still start.
    case 'claim': {
      const where = body?.backgroundOnly ? "status = 'pending' AND background = 1" : "status = 'pending'"
      const { results = [] } = await env.DB.prepare(
        `UPDATE commands SET status = 'running', runner = ?, updated_at = datetime('now')
         WHERE id IN (SELECT id FROM commands WHERE ${where} ORDER BY id LIMIT ?)
         RETURNING id, command, sig, nonce, COALESCE(background, 0) AS background`,
      ).bind(runner, Math.min(Number(body?.limit) || CLAIM_LIMIT, CLAIM_LIMIT)).all()
      return runnerJson({ rows: results })
    }

    // One tick of the watcher: store whatever the job has printed so far and
    // report the two flags back. Progress is only written while the row is
    // still running, so a finished row is never overwritten by a late tick.
    case 'heartbeat': {
      if (typeof body?.output === 'string') {
        await env.DB.prepare(
          `UPDATE commands SET output = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'running'`,
        ).bind(body.output, id).run()
      }
      const row = await env.DB.prepare(
        `SELECT COALESCE(background, 0) AS background, COALESCE(cancel, 0) AS cancel
         FROM commands WHERE id = ?`,
      ).bind(id).first<{ background: number; cancel: number }>()
      if (!row) return runnerJson({ error: 'no such row' }, 404)
      return runnerJson({ background: Number(row.background), cancel: Number(row.cancel) })
    }

    case 'result': {
      const status = String(body?.status ?? '')
      if (!TERMINAL.includes(status)) return runnerJson({ error: `bad status: ${status}` }, 400)
      await env.DB.prepare(
        `UPDATE commands SET status = ?, exit_code = ?, output = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(status, Number(body?.exitCode ?? -1), String(body?.output ?? ''), id).run()
      return runnerJson({ ok: true })
    }

    // Rows this runner left 'running': 'orphans' at startup (it restarted and
    // took its children with it), 'stale' for one whose runner hung rather
    // than restarted, which only the timeout can tell apart.
    case 'sweep': {
      const orphans = body?.kind === 'orphans'
      const note = orphans
        ? 'runlet: the runner restarted while this was running; the command may or may not have completed'
        : 'runlet: ran past the timeout without reporting; the runner may have hung'
      const sql = `UPDATE commands SET status = 'error', exit_code = -1, output = ?,
                     updated_at = datetime('now')
                   WHERE status = 'running' AND ` + (orphans
        ? '(runner = ? OR runner IS NULL)'
        : "runner = ? AND updated_at < datetime('now', ?)")
      const stmt = orphans
        ? env.DB.prepare(sql).bind(note, runner)
        : env.DB.prepare(sql).bind(note, runner, `-${Math.max(Number(body?.staleSeconds) || 720, 60)} seconds`)
      const { meta } = await stmt.run()
      return runnerJson({ changed: meta?.changes ?? 0 })
    }

    case 'prune': {
      const days = Math.max(Number(body?.keepDays) || 30, 1)
      const { meta } = await env.DB.prepare(
        `DELETE FROM commands WHERE status NOT IN ('pending', 'running')
         AND created_at < datetime('now', ?)`,
      ).bind(`-${days} days`).run()
      return runnerJson({ changed: meta?.changes ?? 0 })
    }

    // Backs `runlet status`, so the owner can ask a machine what it has been
    // doing without a Cloudflare credential in the picture.
    case 'status': {
      const { results = [] } = await env.DB.prepare(
        `SELECT id, status, exit_code, runner, created_at, updated_at,
                substr(replace(replace(command, char(10), ' '), char(9), ' '), 1, 50) AS command,
                substr(replace(output, char(10), ' | '), 1, 70) AS output
         FROM commands ORDER BY id DESC LIMIT ?`,
      ).bind(Math.min(Math.max(Number(body?.limit) || 10, 1), 100)).all()
      return runnerJson({ rows: results })
    }

    default:
      return runnerJson({ error: `unknown op: ${body?.op}` }, 400)
  }
}

function clampWait(env: Env, asked: unknown, fallback: number): number {
  const max = Number(env.RUNLET_WAIT_MAX ?? WAIT_MAX)
  const n = Number(asked ?? fallback)
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, 0), max)
}

// `background` is scheduling advice, not part of what is signed: it changes
// WHEN the runner starts the row, never what runs, so a forged flag can at
// most start a signed command sooner.
async function enqueue(env: Env, command: string, waitSeconds: number, background: boolean): Promise<{ row: Row; timedOut: boolean }> {
  const nonce = randomHex(16)
  const sig = await hmacHex(env.RUNLET_HMAC_KEY, `${nonce}\n${command}`)
  const ins = await env.DB.prepare(
    `INSERT INTO commands (command, status, sig, nonce, background, created_at, updated_at)
     VALUES (?, 'pending', ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(command, sig, nonce, background ? 1 : 0)
    .run()
  const id = Number(ins.meta.last_row_id)
  const r = await awaitRow(env, id, waitSeconds)
  return { row: r.row ?? { id, status: 'pending', exit_code: null, output: null }, timedOut: r.timedOut }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // The path IS the credential. Constant-time compare, and every miss is a
    // plain 404 so the endpoint cannot be found by probing.
    const parts = url.pathname.split('/').filter(Boolean)
    // The runner's own API, on a fixed path behind a Bearer token. Checked
    // first so it never has to be reachable through the assistant's secret.
    if (parts.length === 1 && parts[0] === 'runner') return runnerApi(request, env)
    if (parts.length !== 2 || parts[1] !== 'mcp' || !env.RUNLET_URL_SECRET || !timingSafeEqual(parts[0], env.RUNLET_URL_SECRET)) {
      return new Response('not found', { status: 404 })
    }
    if (request.method !== 'POST') return new Response('POST JSON-RPC here', { status: 405 })

    let body: any
    try {
      body = await request.json()
    } catch {
      return rpcError(null, -32700, 'parse error')
    }
    const { method, id, params } = body ?? {}
    if (id === undefined || id === null) return new Response(null, { status: 202 }) // a notification

    switch (method) {
      case 'initialize':
        return rpc(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'runlet', version: '0.1.0' },
        })
      case 'ping':
        return rpc(id, {})
      case 'tools/list':
        return rpc(id, { tools: TOOLS })
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (name === 'run_command') {
          const command = String(args.command ?? '')
          if (!command.trim()) return toolText(id, 'run_command needs a command.', true)
          if (command.length > MAX_COMMAND_CHARS) return toolText(id, `Command is ${command.length} characters; the limit is ${MAX_COMMAND_CHARS}.`, true)
          const wait = clampWait(env, args.wait, Number(env.RUNLET_WAIT_DEFAULT ?? 30))
          const r = await enqueue(env, command, wait, args.background === true)
          return toolText(id, render(r.row, r.timedOut), !r.timedOut && FAILED.includes(r.row.status))
        }
        if (name === 'cancel') {
          const rid = Number(args.id)
          if (!Number.isInteger(rid)) return toolText(id, 'cancel needs a numeric id.', true)
          const row = await env.DB.prepare(`SELECT id, status, exit_code, output FROM commands WHERE id = ?`).bind(rid).first<Row>()
          if (!row) return toolText(id, `No command #${rid}.`, true)
          if (TERMINAL.includes(row.status)) return toolText(id, `#${rid} already finished (${row.status}); nothing to cancel.\n${render(row, false)}`)
          // Still queued: it never starts. The runner claims only 'pending'
          // rows, so flipping the status here is enough and needs no runner.
          const q = await env.DB.prepare(
            `UPDATE commands SET status = 'cancelled', exit_code = -1, output = 'runlet: cancelled before it started', updated_at = datetime('now')
              WHERE id = ? AND status = 'pending'`,
          ).bind(rid).run()
          if (q.meta.changes === 1) return toolText(id, `#${rid} cancelled before it started.`)
          // Running: ask the runner to kill it, and wait a little for the
          // row to settle so the caller learns whether it did.
          await env.DB.prepare(`UPDATE commands SET cancel = 1, updated_at = datetime('now') WHERE id = ?`).bind(rid).run()
          const r = await awaitRow(env, rid, clampWait(env, args.wait, 15))
          if (r.row && r.row.status === 'cancelled') return toolText(id, `#${rid} cancelled: the runner killed it.\n${render(r.row, false)}`)
          if (r.row && TERMINAL.includes(r.row.status)) return toolText(id, `#${rid} finished on its own before the cancel took effect.\n${render(r.row, false)}`)
          return toolText(id, `#${rid}: cancel requested; the runner had not confirmed within the wait. Check with get_result(id=${rid}, wait=…).`)
        }
        if (name === 'detach') {
          const rid = Number(args.id)
          if (!Number.isInteger(rid)) return toolText(id, 'detach needs a numeric id.', true)
          const row = await env.DB.prepare(`SELECT id, status, exit_code, output FROM commands WHERE id = ?`).bind(rid).first<Row>()
          if (!row) return toolText(id, `No command #${rid}.`, true)
          if (TERMINAL.includes(row.status)) return toolText(id, `#${rid} already finished (${row.status}); nothing to detach.\n${render(row, false)}`)
          await env.DB.prepare(`UPDATE commands SET background = 1, updated_at = datetime('now') WHERE id = ?`).bind(rid).run()
          return toolText(
            id,
            `#${rid} detached: it keeps running, and commands queued after it no longer wait for it ` +
              `(the runner notices within a few seconds). Collect its output later with get_result(id=${rid}, wait=…).`,
          )
        }
        if (name === 'get_result') {
          const rid = Number(args.id)
          if (!Number.isInteger(rid)) return toolText(id, 'get_result needs a numeric id.', true)
          // Cece's suggestion (2026-09-17): let a check-back wait too, so one
          // call returns the moment the job finishes instead of the caller
          // polling by hand. Default 0 keeps the old immediate answer.
          const wait = clampWait(env, args.wait, 0)
          const r = await awaitRow(env, rid, wait)
          if (!r.row) return toolText(id, `No command #${rid}.`, true)
          return toolText(id, render(r.row, r.timedOut), FAILED.includes(r.row.status))
        }
        return rpcError(id, -32601, `unknown tool ${JSON.stringify(name)}`)
      }
      default:
        return rpcError(id, -32601, `unknown method ${JSON.stringify(method)}`)
    }
  },
}
