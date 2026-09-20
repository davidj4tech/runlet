#!/usr/bin/env node
// runlet.mjs — the runner, on every platform. It polls its Worker for signed
// commands, runs what verifies, and writes the results back.
//
//   THIS PROCESS EXECUTES COMMANDS READ FROM A DATABASE, as you.
//   The HMAC check below is what stops a row that merely got INTO the
//   database from running: only a row signed with relay.key is executed.
//
// Usage:  node runlet.mjs            poll forever (the service form)
//         node runlet.mjs --help     the above, for a person or an assistant
//         node runlet.mjs --once     one poll, for testing
//         node runlet.mjs status [n] the last n rows (default 10), newest first
//         node runlet.mjs skills     the skills listed in RUNLET_SKILLS_DIR
//         node runlet.mjs sign <nonce> <command>
//
// Every tunable is re-read from the env file each poll, so editing it is live
// within one interval and needs no restart.

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

// The Worker is the only thing that touches D1. This machine holds a bearer
// token for its own Worker and no Cloudflare credential at all: a D1 API
// token is account-wide, so one on every machine would reach every other
// machine's queue.
const WORKER_URL = (cfg.RUNLET_WORKER_URL || '').replace(/\/+$/, '');
const RUNNER_TOKEN = cfg.RUNLET_RUNNER_TOKEN || '';

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

if (sub === '--help' || sub === '-h' || sub === 'help') {
  console.log(`runlet: run signed shell commands queued by an assistant, on this machine.

  runlet skills        the tools the owner has set up here, and where to read about each
  runlet status [n]    the last n rows (default 10), newest first
  runlet --once        one poll, then exit
  runlet               poll forever (what the service runs)
  runlet sign <nonce> <command>   the signature this runner expects

Config: ${ENV_FILE}
  RUNLET_WORKER_URL     this machine's Worker
  RUNLET_RUNNER_TOKEN   its bearer token (no Cloudflare credential lives here)
  RUNLET_KEY_FILE       hex key shared with the Worker (default relay.key beside env)
  RUNLET_POLL           seconds between polls (default 5)
  RUNLET_CMD_TIMEOUT    seconds a command may run (default 600)
  RUNLET_MAX_OUTPUT     bytes of output kept (default 60000)
  RUNLET_PARALLEL       commands run at once (default 1: strictly in order)
  RUNLET_BACKGROUND_MAX rows sent with background=true running at once (default 4)
  RUNLET_DETACH_CHECK   seconds between looks for a detach or cancel (default 3)
  RUNLET_KEEP_DAYS      finished rows older than this are deleted daily (default 30)
  RUNLET_PROGRESS_EVERY seconds between progress copies (default 10; 0 = off)
  RUNLET_LOAD_MAX       hold new commands above this 1-minute load average (0 = off)
  RUNLET_RUNNER_ID      this runner's name on the rows it claims (default: hostname)
  RUNLET_SKILLS_DIR     SKILL.md files that \`skills\` lists (default skills/ beside env)

Every tunable above is re-read each poll: edit the file and it is live within
one interval.`);
  process.exit(0);
}

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

// The runner token goes on every request, so the Worker URL must be https --
// over plaintext to anything but this machine it would be handed to whoever
// is listening. Loopback is allowed because the tests serve the real Worker
// there, and a request that never leaves the machine has nothing to sniff.
function checkWorkerUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'is not a URL'; }
  if (u.protocol === 'https:') return null;
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  if (u.protocol === 'http:' && loopback) return null;
  return 'must be https (http is allowed only on loopback)';
}
const urlProblem = WORKER_URL ? checkWorkerUrl(WORKER_URL) : 'is not set';
if (urlProblem || !RUNNER_TOKEN) {
  throw new Error(`runlet: RUNLET_WORKER_URL ${urlProblem ?? 'is set'}`
    + `${RUNNER_TOKEN ? '' : ' and RUNLET_RUNNER_TOKEN is not set'} in ${ENV_FILE}`
    + ' — re-run the installer if this machine predates them');
}

// `status [n]`: the last rows, newest first -- "is it stuck?" as one command.
if (sub === 'status') {
  const limit = /^[1-9][0-9]*$/.test(rest[0] ?? '') ? Number(rest[0]) : 10;
  const { rows } = await api('status', { limit });
  for (const r of rows) {
    const code = r.exit_code === null ? '' : ` exit=${r.exit_code}`;
    console.log(`#${r.id}\t${r.status}${code}\t${r.updated_at}\t${r.command}`);
    console.log(`\t\t\t${r.output ?? ''}`);
  }
  process.exit(0);
}

// --- the Worker -------------------------------------------------------------
// Every exchange is POST /runner with an `op`. No SQL is built here any more,
// so neither is any SQL escaping.
async function api(op, body = {}) {
  const r = await fetch(`${WORKER_URL}/runner`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, runner: RUNNER_ID, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  // A 404 is what a wrong or missing token looks like, deliberately: the
  // Worker will not confirm that the runner API is there.
  if (r.status === 404) {
    throw new Error('the Worker refused this runner (check RUNLET_RUNNER_TOKEN)');
  }
  const out = await r.json().catch(() => null);
  if (!r.ok || out?.error) throw new Error(`worker: ${out?.error ?? r.status}`);
  return out;
}

const writeResult = (id, status, code, output) =>
  api('result', { id, status, exitCode: code, output });

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
// Is anything left in the job's process group? Not "is the direct child
// alive": a shell that does not trap TERM dies at once while a descendant
// that does traps it survives, and waiting on the child alone would skip the
// forced kill and leave that descendant running. This is the group probe
// runlet.sh made with `kill -0 -- -$pgid`.
function groupAlive(pid) {
  if (WIN) return false;           // taskkill /T walks the tree in one go
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

// TERM first, KILL after a grace period, like `timeout --kill-after=10` and
// cancel_job: a job that traps TERM still gets to clean up before it goes.
// Windows refuses the polite form for a console process outright ("can only
// be terminated forcefully"), and says so immediately, so there the grace
// period is skipped rather than burned -- it cost 10s on every timeout.
async function killTreeGracefully(pid, graceMs, alive) {
  if (!killTree(pid, false)) { killTree(pid, true); return; }
  for (let i = 0; i < Math.ceil(graceMs / 1000); i++) {
    if (!alive() && !groupAlive(pid)) return;
    await sleep(1000);
  }
  killTree(pid, true);
}

// Every job this runner started, so a shutdown can take them with it.
// systemd kills the whole cgroup on stop, but launchd kills only its own
// process group, and a job runs in a session of its own (detached), so it
// would survive -- which is what lib/macos-job.py existed to prevent. Doing
// it here covers launchd, Task Scheduler and a plain Ctrl-C alike.
const live = new Map();          // job id -> pid

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  try {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (live.size) log(`${sig}: stopping ${live.size} running job(s)`);
      for (const pid of live.values()) killTree(pid, true);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  } catch { /* not every signal exists on every platform */ }
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
  live.set(id, child.pid);

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
      // One request per tick: the progress write and the flag read share a
      // round trip, where they used to cost one each.
      let output;
      if (T.PROGRESS_EVERY > 0 && Date.now() - lastProgress >= T.PROGRESS_EVERY * 1000) {
        lastProgress = Date.now();
        output = head(outFile) || undefined;
      }
      const row = await api('heartbeat', { id, output });
      if (!cancelled && Number(row?.cancel) === 1) {
        cancelled = true;
        log(`#${id}: cancel requested — killing the process tree`);
        await killTreeGracefully(child.pid, 5000, alive);
        return;
      }
      if (!detached && Number(row?.background) === 1) {
        detached = true;
        log(`#${id}: detached after ${Math.round((Date.now() - started) / 1000)}s`
          + ' — it keeps running, the queue moves on');
        freeLane();          // the QUEUE moves on; the child is watched below
      }
    } catch { /* a failed poll is not fatal; try again next tick */ }
  }, DETACH_CHECK);

  const done = exited.then(async (code) => {
    clearTimeout(timer); clearInterval(watcher); live.delete(id);
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
//
// The row arrives already claimed: the Worker's claim is one conditional
// statement, so no second runner can hold it. What is still ours to check is
// what the Worker cannot -- that the row carries a signature made with the
// key only this machine and the Worker share, and a nonce new to this
// machine.
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
  if (overLoadCeiling()) return 0;
  // A claimed row is already 'running', so ask only for what can start this
  // moment; anything else would be marked running with nothing running it.
  const bg = Math.max(0, T.BACKGROUND_MAX - bgJobs.size);
  const fg = T.PARALLEL > 1
    ? Math.max(0, T.PARALLEL - (bgJobs.size + (fgBusy() ? 1 : 0)))
    : (fgBusy() ? 0 : 1);
  const { rows } = await api('claim', { fg, bg });
  for (const row of rows) {
    const lane = Number(row.background) === 1 || T.PARALLEL > 1 ? 'bg' : 'fg';
    track(await runOne(row), lane);
  }
  trimNonces();
  return rows.length;
}

// --- maintenance -------------------------------------------------------------
// Finished rows older than RUNLET_KEEP_DAYS go. The table is the only thing
// here that grows without bound, and nothing reads an old result.
async function pruneOld() {
  const { changed } = await api('prune', { keepDays: T.KEEP_DAYS });
  if (changed > 0) log(`pruned ${changed} finished row(s) older than ${T.KEEP_DAYS} days`);
}

// A row still 'running' when this runner starts belonged to a runner that is
// gone — a restart mid-job takes its children with it. Left alone it would
// stay 'running' forever and a waiting get_result would only ever time out.
async function sweepOrphans() {
  const { changed } = await api('sweep', { kind: 'orphans' });
  if (changed > 0) log(`marked ${changed} orphaned 'running' row(s) of runner '${RUNNER_ID}' as error`);
}

// A row 'running' past the timeout plus a grace period belonged to a job
// whose runner hung rather than restarted. Progress writes keep a talkative
// job's updated_at fresh, so a live job is never caught by this.
async function sweepStale() {
  const { changed } = await api('sweep', { kind: 'stale', staleSeconds: T.CMD_TIMEOUT + 120 });
  if (changed > 0) log(`marked ${changed} stale 'running' row(s) as error`);
}

if (sub === '--once') {
  const n = await poll();
  await Promise.all([...inFlight]);      // `runlet.sh --once` ends with `wait`
  log(`polled, ${n} row(s)`);
} else {
  log(`runlet runner starting as ${RUNNER_ID}, polling every ${T.POLL}s`
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
