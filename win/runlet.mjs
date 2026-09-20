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
//         node runlet.mjs status [n] the last n rows (default 10), newest first
//         node runlet.mjs skills     the skills listed in RUNLET_SKILLS_DIR
//         node runlet.mjs sign <nonce> <command>
//
// Every tunable runlet.sh re-reads each poll is re-read here too, from the
// same env file, so editing it is live within one interval on both runners.
//
// Verified on Windows (Node 22.20.0, PowerShell 5.1) by tests/check-windows.mjs,
// which runs on either platform.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, readdirSync,
         realpathSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { homedir, hostname, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`${new Date().toISOString()} runlet: ${m}`);

// --- config -----------------------------------------------------------------
// Windows has no XDG. Prefer %APPDATA%\runlet, fall back to ~/.config/runlet
// so a WSL-made config still works if someone migrates across.
const CONF = process.env.RUNLET_CONF
  || (WIN && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'runlet')
      : path.join(homedir(), '.config', 'runlet'));
const ENV_FILE = path.join(CONF, 'env');

// runlet.sh does `set -a; . env`, so the FILE wins over the ambient
// environment. Spread it last to match; getting this backwards means a stale
// exported token silently beats the one install.sh wrote.
function loadEnv() {
  const out = {};
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return out;
}

// The token, key and database ids stay as loaded: changing those under a
// running job is not "on the fly". Only T below is re-read each poll.
const cfg = { ...process.env, ...loadEnv() };

const KEY = (cfg.RUNLET_KEY
  ?? readFileSync(cfg.RUNLET_KEY_FILE || path.join(CONF, 'relay.key'), 'utf8')).replace(/\s+/g, '');
const RUNNER_ID = cfg.RUNLET_RUNNER_ID || hostname().split('.')[0];
const MAX_OUTPUT = Number(cfg.RUNLET_MAX_OUTPUT ?? 60000);

// State, not config: the same split runlet.sh makes, so a machine that has
// run both keeps one nonce history. %LOCALAPPDATA% is the Windows
// $XDG_STATE_HOME — data that belongs to this machine and is not roamed.
const STATE_HOME = process.env.XDG_STATE_HOME
  || (WIN && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA
      : path.join(homedir(), '.local', 'state'));
const STATE_DIR = path.join(STATE_HOME, 'runlet');
const SEEN = cfg.RUNLET_NONCE_FILE || path.join(STATE_DIR, 'nonces');
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(path.dirname(SEEN), { recursive: true });

// Validated exactly as runlet.sh validates them: a junk value falls back to
// the default rather than disabling the limit it describes.
const num = (v, re, dflt) => (re.test(String(v ?? '')) ? Number(v) : dflt);
const POS = /^[1-9][0-9]*$/, NAT = /^[0-9]+$/, DEC = /^[0-9]+(\.[0-9]+)?$/;
const DETACH_CHECK = num(cfg.RUNLET_DETACH_CHECK, POS, 3) * 1000;   // not reloaded
const T = {
  PARALLEL:       num(cfg.RUNLET_PARALLEL, POS, 1),
  BACKGROUND_MAX: num(cfg.RUNLET_BACKGROUND_MAX, POS, 4),
  CMD_TIMEOUT:    num(cfg.RUNLET_CMD_TIMEOUT, POS, 600),
  POLL:           num(cfg.RUNLET_POLL, POS, 5),
  PROGRESS_EVERY: num(cfg.RUNLET_PROGRESS_EVERY, NAT, 10),
  KEEP_DAYS:      num(cfg.RUNLET_KEEP_DAYS, POS, 30),
  LOAD_MAX:       num(cfg.RUNLET_LOAD_MAX, DEC, 0),
};
const RELOADABLE = [
  ['PARALLEL', 'RUNLET_PARALLEL', POS, 1, ''],
  ['BACKGROUND_MAX', 'RUNLET_BACKGROUND_MAX', POS, 4, ''],
  ['CMD_TIMEOUT', 'RUNLET_CMD_TIMEOUT', POS, 600, 's'],
  ['POLL', 'RUNLET_POLL', POS, 5, 's'],
  ['PROGRESS_EVERY', 'RUNLET_PROGRESS_EVERY', NAT, 10, 's'],
  ['KEEP_DAYS', 'RUNLET_KEEP_DAYS', POS, 30, ''],
  ['LOAD_MAX', 'RUNLET_LOAD_MAX', DEC, 0, ''],
];
function reloadTunables() {
  if (!existsSync(ENV_FILE)) return;
  const env = loadEnv();
  for (const [field, key, re, dflt, unit] of RELOADABLE) {
    // An absent line means the default, so deleting RUNLET_LOAD_MAX releases
    // a hold rather than leaving the last value latched.
    const want = key in env ? num(env[key], re, T[field]) : dflt;
    if (want !== T[field]) {
      log(`${key} now ${want}${unit} (was ${T[field]}${unit})`);
      T[field] = want;
    }
  }
}

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

// --- signing: identical to relay_hmac / relay_ct_equal ----------------------
// Note the newline between nonce and command — it is part of the signed text.
const hmac = (nonce, command) =>
  createHmac('sha256', KEY).update(`${nonce}\n${command}`).digest('hex');

function ctEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- subcommands that need no database --------------------------------------
const [sub, ...rest] = process.argv.slice(2);

if (sub === 'sign') {
  // rest[1] whole, never rest.slice(1).join(' '): a command's own runs of
  // spaces are part of the signed text, and argv has already split nothing.
  console.log(hmac(rest[0], rest[1] ?? ''));
  process.exit(0);
}

if (sub === 'skills') {
  // What this machine offers beyond a bare shell, one entry per file in
  // RUNLET_SKILLS_DIR. The owner curates the directory; nothing is found by
  // scanning the disk. The assistant reads a file in full only when it needs it.
  const dir = cfg.RUNLET_SKILLS_DIR || path.join(CONF, 'skills');
  let entries = [];
  try { entries = readdirSync(dir).sort(); } catch { /* missing = none */ }
  if (!entries.length) {
    console.log(`No skills listed on ${RUNNER_ID}. The owner can add one with:`);
    console.log(`  ln -s /path/to/SKILL.md ${path.join(dir, '<name>.md')}`);
    process.exit(0);
  }
  console.log(`Skills on ${RUNNER_ID}. Read one in full (cat the path) before using it.`);
  for (const e of entries) {
    let f = path.join(dir, e), text;
    try {
      f = realpathSync(f);
      if (statSync(f).isDirectory()) f = path.join(f, 'SKILL.md');
      text = readFileSync(f, 'utf8');
    } catch {
      console.log(`\n${e}: unreadable (${f})`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    // Only the frontmatter: the block between a first-line --- and the next.
    let fm = [];
    if (/^---\s*$/.test(lines[0] ?? '')) {
      const end = lines.slice(1).findIndex((l) => /^---\s*$/.test(l));
      fm = lines.slice(1, end === -1 ? lines.length : end + 1);
    }
    const field = (k) => fm.map((l) => new RegExp(`^${k}:\\s*(.*)$`).exec(l))
      .find(Boolean)?.[1];
    const name = field('name') || e.replace(/\.md$/, '');
    const desc = field('description')
      || lines.find((l) => l.trim() && !/^(---|#)/.test(l)) || '';
    console.log(`\n${name}: ${desc}\n  ${f}`);
  }
  process.exit(0);
}

if (!/^[0-9a-f-]{36}$/.test(DB_ID ?? '')) {
  throw new Error('runlet: no D1 database id — set RUNLET_DB_ID in the env file'
    + ' or point RUNLET_WRANGLER_CONFIG at worker/wrangler.jsonc');
}
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
  + `/d1/database/${DB_ID}/query`;

// --- D1 ---------------------------------------------------------------------
async function d1Raw(sql) {
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
  return body.result?.[0] ?? {};
}
const d1 = async (sql) => (await d1Raw(sql)).results ?? [];
// Rows a write changed, 0 on any failure — the maintenance sweeps only log it.
const d1Changes = async (sql) => {
  try { return Number((await d1Raw(sql)).meta?.changes ?? 0); } catch { return 0; }
};

const lit = (s) => String(s).replace(/\u0000/g, '').replace(/'/g, "''");

// `status [n]`: the last rows, newest first -- "is it stuck?" as one command.
if (sub === 'status') {
  const n = /^[1-9][0-9]*$/.test(rest[0] ?? '') ? rest[0] : 10;
  const rows = await d1('SELECT id, status, exit_code, runner, created_at, updated_at, '
    + "substr(replace(replace(command, char(10), ' '), char(9), ' '), 1, 50) AS command, "
    + "substr(replace(output, char(10), ' | '), 1, 70) AS output "
    + `FROM commands ORDER BY id DESC LIMIT ${n};`);
  for (const r of rows) {
    const code = r.exit_code === null ? '' : ` exit=${r.exit_code}`;
    console.log(`#${r.id}\t${r.status}${code}\t${r.updated_at}\t${r.command}`);
    console.log(`\t\t\t${r.output ?? ''}`);
  }
  process.exit(0);
}

const writeResult = (id, status, code, output) =>
  d1(`UPDATE commands SET status = '${status}', exit_code = ${code}, `
   + `output = '${lit(output)}', updated_at = datetime('now') WHERE id = ${id};`);

// --- execution --------------------------------------------------------------
// Windows has no process groups in the POSIX sense, and detached is NOT the
// equivalent: on win32 it sets DETACHED_PROCESS, which denies the child a
// console, and PowerShell 5.1 then exits 0 immediately having run nothing.
// Detached is for POSIX, where it is setsid() and gives the process group
// that killTree's process.kill(-pid) needs. On Windows nothing is needed:
// taskkill /T walks the parent-child tree by pid, which a bare kill misses.
const SHELL = WIN ? (cfg.RUNLET_SHELL || 'powershell.exe') : '/bin/bash';
const shellArgs = (command) => WIN
  ? ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', command]
  : ['-lc', command];

// The FIRST MAX_OUTPUT bytes, as runlet.sh's `head -c` keeps: the start of a
// failing command's output is the part that says why. Read without pulling a
// multi-gigabyte log into memory.
const head = (file) => {
  try {
    const size = Math.min(statSync(file).size, MAX_OUTPUT);
    if (!size) return '';
    const buf = Buffer.alloc(size);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, size, 0); } finally { closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
};

// Returns false when the polite request was refused outright, so the caller
// can escalate now instead of waiting out a grace period that cannot pass.
function killTree(pid, force) {
  if (WIN) {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try { execFileSync('taskkill', args, { stdio: 'ignore' }); return true; }
    catch { return false; }          // already gone, or "/F required"
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
  return true;
}
// TERM first, KILL after a grace period, like `timeout --kill-after=10` and
// cancel_job: a job that traps TERM still gets to clean up before it goes.
// Windows refuses the polite form for a console process outright ("can only
// be terminated forcefully"), and says so immediately, so there the grace
// period is skipped rather than burned -- it cost 10s on every timeout.
async function killTreeGracefully(pid, graceMs, alive) {
  if (!killTree(pid, false)) { killTree(pid, true); return; }
  for (let i = 0; i < Math.ceil(graceMs / 1000); i++) {
    if (!alive()) return;
    await sleep(1000);
  }
  killTree(pid, true);
}

// Returns { lane, done }. `lane` settles when the queue may move on — the job
// exited, or it was detached. `done` settles when the result is on the row.
function executeAndWatch(id, command) {
  const outFile = path.join(STATE_DIR, `job.${id}.out`);
  // A raw fd, not createWriteStream: a fresh stream's .fd is still null when
  // spawn validates stdio, and spawn rejects it (ERR_INVALID_ARG_VALUE).
  // spawn dups the fd for the child, so the parent's copy closes right after.
  const fd = openSync(outFile, 'w');
  let child;
  try {
    child = spawn(SHELL, shellArgs(command), {
      detached: !WIN, windowsHide: true, stdio: ['ignore', fd, fd],
    });
  } finally { closeSync(fd); }

  let running = true, cancelled = false, timedOut = false, detached = false;
  const started = Date.now();
  const exited = new Promise((res) => child.on('close', (code) => { running = false; res(code ?? -1); }));
  let freeLane;
  const lane = new Promise((res) => { freeLane = res; });
  const alive = () => running;

  const timer = setTimeout(() => {
    timedOut = true;
    log(`#${id}: over the ${T.CMD_TIMEOUT}s limit — stopping it`);
    killTreeGracefully(child.pid, 10_000, alive);
  }, T.CMD_TIMEOUT * 1000);

  // Poll the row for cancel and background, and copy progress onto it, in
  // step with the bash watcher. Scheduled by the clock, not by loop count.
  let lastProgress = Date.now();
  const watcher = setInterval(async () => {
    try {
      if (T.PROGRESS_EVERY > 0 && Date.now() - lastProgress >= T.PROGRESS_EVERY * 1000) {
        lastProgress = Date.now();
        const soFar = head(outFile);
        if (soFar) {
          await d1(`UPDATE commands SET output = '${lit(soFar)}', `
            + `updated_at = datetime('now') WHERE id = ${id} AND status = 'running';`);
        }
      }
      const [row] = await d1('SELECT COALESCE(background, 0) AS bg, '
        + `COALESCE(cancel, 0) AS c FROM commands WHERE id = ${id};`);
      if (!cancelled && Number(row?.c) === 1) {
        cancelled = true;
        log(`#${id}: cancel requested — killing the process tree`);
        await killTreeGracefully(child.pid, 5000, alive);
        return;
      }
      if (!detached && Number(row?.bg) === 1) {
        detached = true;
        log(`#${id}: detached after ${Math.round((Date.now() - started) / 1000)}s`
          + ' — it keeps running, the queue moves on');
        freeLane();          // the QUEUE moves on; the child is watched below
      }
    } catch { /* a failed poll is not fatal; try again next tick */ }
  }, DETACH_CHECK);

  const done = exited.then(async (code) => {
    clearTimeout(timer); clearInterval(watcher);
    const out = head(outFile);
    try { unlinkSync(outFile); } catch {}
    if (cancelled) {
      await writeResult(id, 'cancelled', -1, `${out}\nrunlet: cancelled after it had `
        + 'started; whatever it did before that is done');
      log(`#${id}: cancelled, ${out.length} bytes of output kept`);
    } else if (timedOut) {
      // 124, the code `timeout` gives runlet.sh, so both runners report a
      // timeout the same way to anything reading exit_code.
      await writeResult(id, 'timeout', 124, `${out}\nrunlet: killed after `
        + `${T.CMD_TIMEOUT}s`);
      log(`#${id}: timed out`);
    } else {
      await writeResult(id, 'done', code, out);
      log(`#${id}: exit ${code}, ${out.length} bytes`);
    }
  }).finally(freeLane);

  return { lane, done };
}

// --- the loop ---------------------------------------------------------------
const seen = (nonce) =>
  existsSync(SEEN) && readFileSync(SEEN, 'utf8').split(/\r?\n/).includes(nonce);

// Returns { lane, done } like executeAndWatch; a row that never starts has
// both already settled.
async function runOne({ id, command, sig, nonce }) {
  const settled = { lane: Promise.resolve(), done: Promise.resolve() };
  if (seen(nonce)) {
    log(`#${id}: nonce already used — rejecting as a replay`);
    await writeResult(id, 'rejected', -1, 'runlet: replayed nonce');
    return settled;
  }
  if (!ctEqual(hmac(nonce, command), sig)) {
    log(`#${id}: BAD SIGNATURE — not executing`);
    await writeResult(id, 'rejected', -1, 'runlet: signature did not verify');
    return settled;
  }
  // AND status = 'pending' means only one runner can win the row.
  const claimed = await d1(`UPDATE commands SET status = 'running', `
    + `runner = '${lit(RUNNER_ID)}', updated_at = datetime('now') `
    + `WHERE id = ${id} AND status = 'pending' RETURNING id;`);
  if (!claimed.length) { log(`#${id}: claimed by someone else`); return settled; }
  appendFileSync(SEEN, `${nonce}\n`);     // append-only: safe under parallelism

  log(`#${id}: running: ${command.slice(0, 80)}`);
  // The row is claimed and the nonce is spent, so it can never be retried:
  // anything thrown from here has to land on the row, not in the poll loop.
  try {
    return executeAndWatch(id, command);
  } catch (e) {
    log(`#${id}: failed to start: ${e.message}`);
    await writeResult(id, 'error', -1, `runlet: ${e.message}`);
    return settled;
  }
}

// The queue's one serial lane, and the jobs running beside it. A detached
// foreground row leaves the lane while it keeps running, exactly as the bash
// watcher hands over to a background copy of itself.
let fgLane = null;
const bgJobs = new Set();
const inFlight = new Set();      // every unfinished job, for --once to wait on
const fgBusy = () => fgLane !== null;

function track(job, where) {
  const done = job.done.catch((e) => log(`job failed: ${e.message}`));
  inFlight.add(done);
  done.finally(() => inFlight.delete(done));
  if (where === 'bg') {
    bgJobs.add(done);
    done.finally(() => bgJobs.delete(done));
  } else {
    fgLane = job.lane;
    job.lane.finally(() => { if (fgLane === job.lane) fgLane = null; });
  }
}

// Not started while the 1-minute load average is over the ceiling. Windows
// has no load average (os.loadavg() is always zeroes), so the ceiling is
// refused there rather than silently never firing.
let loadHeld = false, loadWarned = false;
function overLoadCeiling() {
  if (T.LOAD_MAX === 0) {
    if (loadHeld) { log('load ceiling removed — resuming'); loadHeld = false; }
    return false;
  }
  if (WIN) {
    if (!loadWarned) { log('RUNLET_LOAD_MAX is set but Windows has no load average — ignoring it'); loadWarned = true; }
    return false;
  }
  const load = loadavg()[0];
  if (load > T.LOAD_MAX) {
    if (!loadHeld) log(`load average ${load.toFixed(2)} is over RUNLET_LOAD_MAX=${T.LOAD_MAX} — not starting new commands until it drops`);
    loadHeld = true;
    return true;
  }
  if (loadHeld) log(`load average ${load.toFixed(2)} is back under ${T.LOAD_MAX} — resuming`);
  loadHeld = false;
  return false;
}

// Trim from poll(), the one place that is never concurrent with an append.
function trimNonces() {
  try {
    // filter(Boolean) first: the file ends in a newline, so a bare split
    // leaves a trailing '' that would cost one real nonce off the tail.
    const lines = readFileSync(SEEN, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 6000) writeFileSync(SEEN, `${lines.slice(-5000).join('\n')}\n`);
  } catch { /* no file yet */ }
}

async function poll() {
  reloadTunables();
  if (overLoadCeiling()) return;
  // While the lane is busy only background rows can start, so ask only for
  // those; otherwise five queued commands could hide one behind them.
  let where = "status = 'pending'";
  if (T.PARALLEL === 1 && fgBusy()) where += ' AND background = 1';
  const rows = await d1('SELECT id, command, sig, nonce, '
    + `COALESCE(background, 0) AS background FROM commands WHERE ${where} `
    + 'ORDER BY id LIMIT 5;');
  for (const row of rows) {
    if (Number(row.background) === 1) {
      // Its own cap, independent of RUNLET_PARALLEL: the queue stays serial
      // while a long job runs beside it.
      while (bgJobs.size >= T.BACKGROUND_MAX) await sleep(500);
      track(await runOne(row), 'bg');
    } else if (T.PARALLEL > 1) {
      while (bgJobs.size + (fgBusy() ? 1 : 0) >= T.PARALLEL) await sleep(500);
      track(await runOne(row), 'bg');
    } else {
      // Serial: one foreground row at a time, oldest first. A busy lane
      // leaves this row (and every later foreground one) for a later poll.
      if (fgBusy()) continue;
      track(await runOne(row), 'fg');
    }
  }
  trimNonces();
  return rows.length;
}

// --- maintenance -------------------------------------------------------------
// Finished rows older than RUNLET_KEEP_DAYS go. The table is the only thing
// here that grows without bound, and nothing reads an old result.
async function pruneOld() {
  const n = await d1Changes("DELETE FROM commands WHERE status NOT IN ('pending', 'running') "
    + `AND created_at < datetime('now', '-${T.KEEP_DAYS} days');`);
  if (n > 0) log(`pruned ${n} finished row(s) older than ${T.KEEP_DAYS} days`);
}

// A row still 'running' when this runner starts belonged to a runner that is
// gone — a restart mid-job takes its children with it. Left alone it would
// stay 'running' forever and a waiting get_result would only ever time out.
async function sweepOrphans() {
  const n = await d1Changes("UPDATE commands SET status = 'error', exit_code = -1, "
    + "output = 'runlet: the runner restarted while this was running; the command may or may not have completed', "
    + `updated_at = datetime('now') WHERE status = 'running' `
    + `AND (runner = '${lit(RUNNER_ID)}' OR runner IS NULL);`);
  if (n > 0) log(`marked ${n} orphaned 'running' row(s) of runner '${RUNNER_ID}' as error`);
}

// A row 'running' past the timeout plus a grace period belonged to a job
// whose runner hung rather than restarted. Progress writes keep a talkative
// job's updated_at fresh, so a live job is never caught by this.
async function sweepStale() {
  const n = await d1Changes("UPDATE commands SET status = 'error', exit_code = -1, "
    + "output = 'runlet: ran past the timeout without reporting; the runner may have hung', "
    + `updated_at = datetime('now') WHERE status = 'running' AND runner = '${lit(RUNNER_ID)}' `
    + `AND updated_at < datetime('now', '-${T.CMD_TIMEOUT + 120} seconds');`);
  if (n > 0) log(`marked ${n} stale 'running' row(s) as error`);
}

if (sub === '--once') {
  const n = await poll();
  await Promise.all([...inFlight]);      // `runlet.sh --once` ends with `wait`
  log(`polled, ${n} row(s)`);
} else {
  log(`runlet windows runner starting as ${RUNNER_ID}, polling every ${T.POLL}s`
    + ` with a ${T.CMD_TIMEOUT}s limit per command`
    + (T.PARALLEL > 1 ? `, up to ${T.PARALLEL} at once` : ''));
  await sweepOrphans();
  let lastPrune = 0, lastStale = Date.now();
  for (;;) {
    try {
      if (Date.now() - lastPrune >= 86_400_000) { lastPrune = Date.now(); await pruneOld(); }
      if (Date.now() - lastStale >= 300_000) { lastStale = Date.now(); await sweepStale(); }
      await poll();
    } catch (e) { log(`poll failed: ${e.message}`); }
    await sleep(T.POLL * 1000);
  }
}
