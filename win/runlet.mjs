#!/usr/bin/env node
// runlet.mjs — the Windows runner. Same wire protocol, same v1 signature
// scheme and same D1 schema as runlet.sh; only the OS plumbing differs.
//
//   THIS PROCESS EXECUTES COMMANDS READ FROM A DATABASE, as you.
//   The HMAC check below is what stops a row that merely got INTO the
//   database from running: only a row signed with relay.key is executed.
//
// Usage:  node runlet.mjs            poll forever (the service form)
//         node runlet.mjs --once     one poll, for testing
//         node runlet.mjs sign <nonce> <command>
//
// STATUS: config, signing, D1, the poll/claim loop, execution, timeout,
// cancel, detach and progress are implemented. Untested on real Windows.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, createWriteStream, mkdirSync,
         statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// --- config -----------------------------------------------------------------
// Windows has no XDG. Prefer %APPDATA%\runlet, fall back to ~/.config/runlet
// so a WSL-made config still works if someone migrates across.
const CONF = process.env.RUNLET_CONF
  || (process.platform === 'win32' && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'runlet')
      : path.join(homedir(), '.config', 'runlet'));

function loadEnv() {           // re-read every poll: edits go live in one interval
  const f = path.join(CONF, 'env');
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return out;
}

const cfg = { ...loadEnv(), ...process.env };
const KEY = (cfg.RUNLET_KEY
  ?? readFileSync(cfg.RUNLET_KEY_FILE || path.join(CONF, 'relay.key'), 'utf8')).trim();
const POLL = Number(cfg.RUNLET_POLL ?? 5) * 1000;
const RUNNER_ID = cfg.RUNLET_RUNNER_ID || process.env.COMPUTERNAME || 'windows';
const SEEN = path.join(CONF, 'seen-nonces');
const STATE_DIR = path.join(CONF, 'state');
mkdirSync(STATE_DIR, { recursive: true });
const CMD_TIMEOUT = Number(cfg.RUNLET_CMD_TIMEOUT ?? 600) * 1000;
const MAX_OUTPUT = Number(cfg.RUNLET_MAX_OUTPUT ?? 60000);
const DETACH_CHECK = Number(cfg.RUNLET_DETACH_CHECK ?? 3) * 1000;
const PROGRESS_EVERY = Number(cfg.RUNLET_PROGRESS_EVERY ?? 10) * 1000;
// Account and database ids come from the env file, else from wrangler.jsonc,
// exactly as runlet.sh resolves them. install.sh does not write RUNLET_DB_ID.
function fromWrangler() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const f = cfg.RUNLET_WRANGLER_CONFIG
    || path.join(here, '..', 'worker', 'wrangler.jsonc');
  try {
    // jsonc: strip // and /* */ comments and trailing commas before parsing.
    const raw = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    const j = JSON.parse(raw);
    const db = (j.d1_databases ?? [])
      .find((d) => d.database_name === (cfg.RUNLET_DB_NAME || 'runlet'));
    return { account: j.account_id, dbId: db?.database_id };
  } catch { return {}; }
}
const fallback = (cfg.CLOUDFLARE_ACCOUNT_ID && cfg.RUNLET_DB_ID) ? {} : fromWrangler();
const ACCOUNT_ID = cfg.CLOUDFLARE_ACCOUNT_ID || fallback.account;
const DB_ID = cfg.RUNLET_DB_ID || fallback.dbId;
if (!/^[0-9a-f-]{36}$/.test(DB_ID ?? '')) {
  throw new Error('runlet: no D1 database id — set RUNLET_DB_ID in the env file'
    + ' or point RUNLET_WRANGLER_CONFIG at worker/wrangler.jsonc');
}
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
  + `/d1/database/${DB_ID}/query`;

const log = (m) => console.error(`${new Date().toISOString()} ${m}`);

// --- signing: identical to relay_hmac / relay_ct_equal ----------------------
// Note the newline between nonce and command — it is part of the signed text.
const hmac = (nonce, command) =>
  createHmac('sha256', KEY).update(`${nonce}\n${command}`).digest('hex');

function ctEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- D1 ---------------------------------------------------------------------
async function d1(sql) {
  const r = await fetch(D1_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.CLOUDFLARE_API_TOKEN}`,
               'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await r.json().catch(() => null);
  if (!body?.success) {
    throw new Error(`D1: ${(body?.errors ?? []).map((e) => e.message).join('; ') || r.status}`);
  }
  return body.result?.[0]?.results ?? [];
}

const lit = (s) => String(s).replace(/\u0000/g, '').replace(/'/g, "''");

const writeResult = (id, status, code, output) =>
  d1(`UPDATE commands SET status = '${status}', exit_code = ${code}, `
   + `output = '${lit(output)}', updated_at = datetime('now') WHERE id = ${id};`);


// --- execution --------------------------------------------------------------
// Windows has no process groups in the POSIX sense. The equivalent is to
// spawn detached (which makes a new process group on win32) and kill the
// whole tree with taskkill /T, since a bare kill leaves grandchildren alive.
const SHELL = process.platform === 'win32'
  ? (cfg.RUNLET_SHELL || 'powershell.exe') : '/bin/bash';
const shellArgs = (command) => process.platform === 'win32'
  ? ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', command]
  : ['-lc', command];

const tail = (file) => {                    // last MAX_OUTPUT bytes, no full read
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - MAX_OUTPUT);
    const buf = Buffer.alloc(Math.min(size, MAX_OUTPUT));
    const fd = openSync(file, 'r');
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
};

function killTree(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { /* already gone */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

async function executeAndWatch(id, command) {
  const outFile = path.join(STATE_DIR, `job.${id}.out`);
  const sink = createWriteStream(outFile);
  const child = spawn(SHELL, shellArgs(command), {
    detached: true, windowsHide: true, stdio: ['ignore', sink, sink],
  });

  let cancelled = false, timedOut = false, detached = false;
  const started = Date.now();
  const exited = new Promise((res) => child.on('close', (code) => res(code ?? -1)));

  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, CMD_TIMEOUT);

  // Poll the row for cancel and background, and copy progress onto it, in
  // step with the bash watcher. Scheduled by the clock, not by loop count.
  let lastProgress = Date.now();
  const watcher = setInterval(async () => {
    try {
      if (PROGRESS_EVERY > 0 && Date.now() - lastProgress >= PROGRESS_EVERY) {
        lastProgress = Date.now();
        const so_far = tail(outFile);
        if (so_far) {
          await d1(`UPDATE commands SET output = '${lit(so_far)}', `
            + `updated_at = datetime('now') WHERE id = ${id} AND status = 'running';`);
        }
      }
      const [row] = await d1('SELECT COALESCE(background, 0) AS bg, '
        + `COALESCE(cancel, 0) AS c FROM commands WHERE id = ${id};`);
      if (Number(row?.c) === 1) { cancelled = true; killTree(child.pid); return; }
      if (!detached && Number(row?.bg) === 1) {
        detached = true;
        log(`#${id}: detached after ${Math.round((Date.now() - started) / 1000)}s`
          + ' — it keeps running, the queue moves on');
      }
    } catch { /* a failed poll is not fatal; try again next tick */ }
  }, DETACH_CHECK);

  // Detaching lets the QUEUE move on; the child is still watched to the end.
  const settle = exited.then(async (code) => {
    clearTimeout(timer); clearInterval(watcher);
    const out = tail(outFile);
    try { unlinkSync(outFile); } catch {}
    if (cancelled) {
      await writeResult(id, 'cancelled', -1, `${out}\nrunlet: cancelled after it had `
        + 'started; whatever it did before that is done');
      log(`#${id}: cancelled, ${out.length} bytes of output kept`);
    } else if (timedOut) {
      await writeResult(id, 'timeout', code, `${out}\nrunlet: killed after `
        + `${CMD_TIMEOUT / 1000}s`);
      log(`#${id}: timed out`);
    } else {
      await writeResult(id, 'done', code, out);
      log(`#${id}: exit ${code}, ${out.length} bytes`);
    }
  });

  // Wait for the job unless it asked to go to the background.
  await Promise.race([settle, (async () => {
    while (!detached) { await new Promise((r) => setTimeout(r, 250)); }
  })()]);
}

// --- the loop ---------------------------------------------------------------
const seen = (nonce) =>
  existsSync(SEEN) && readFileSync(SEEN, 'utf8').split(/\r?\n/).includes(nonce);

async function runOne({ id, command, sig, nonce }) {
  if (seen(nonce)) {
    log(`#${id}: nonce already used — rejecting as a replay`);
    return writeResult(id, 'rejected', -1, 'runlet: replayed nonce');
  }
  if (!ctEqual(hmac(nonce, command), sig)) {
    log(`#${id}: BAD SIGNATURE — not executing`);
    return writeResult(id, 'rejected', -1, 'runlet: signature did not verify');
  }
  // AND status = 'pending' means only one runner can win the row.
  const claimed = await d1(`UPDATE commands SET status = 'running', `
    + `runner = '${lit(RUNNER_ID)}', updated_at = datetime('now') `
    + `WHERE id = ${id} AND status = 'pending' RETURNING id;`);
  if (!claimed.length) return log(`#${id}: claimed by someone else`);
  appendFileSync(SEEN, `${nonce}\n`);     // append-only: safe under parallelism

  log(`#${id}: running: ${command.slice(0, 80)}`);
  return executeAndWatch(id, command);
}

async function poll() {
  const rows = await d1('SELECT id, command, sig, nonce, '
    + 'COALESCE(background, 0) AS background FROM commands '
    + "WHERE status = 'pending' ORDER BY id LIMIT 5;");
  for (const row of rows) await runOne(row);
  return rows.length;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'sign') {
  console.log(hmac(rest[0], rest.slice(1).join(' ')));
} else if (cmd === '--once') {
  log(`polled, ${await poll()} row(s)`);
} else {
  log(`runlet windows runner starting as ${RUNNER_ID}, polling every ${POLL / 1000}s`);
  for (;;) {
    try { await poll(); } catch (e) { log(`poll failed: ${e.message}`); }
    await new Promise((r) => setTimeout(r, POLL));
  }
}
