#!/usr/bin/env node
// check-windows.mjs — the Node runner (win/runlet.mjs) against a mock D1.
//
//     node tests/check-windows.mjs            every case
//     node tests/check-windows.mjs <name>     one case, in this process
//
// win/runlet.mjs reads its config once at module load, so each case runs in
// its own process. Cases marked `loop:` start the polling loop rather than
// --once, and assert while it runs; the rest use --once and assert after.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { mockD1, sign } from './mock-d1.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'win', 'runlet.mjs');
const KEY = 'ab'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === 'win32';

// The jobs the cases queue, in the shell the runner will actually use on this
// platform: bash -lc, or powershell.exe -Command on Windows. Same observable
// behaviour either way, so the assertions below stay platform-free.
const C = {
  helloExit7: WIN
    ? "Write-Output 'hello'; [Console]::Error.WriteLine('to-stderr'); exit 7"
    : 'echo hello; echo to-stderr >&2; exit 7',
  noop: WIN ? 'exit 0' : 'true',
  sleep: (s) => (WIN ? `Start-Sleep -Seconds ${s}` : `sleep ${s}`),
  startThenSleep: (s) => (WIN
    ? `Write-Output 'starting'; [Console]::Out.Flush(); Start-Sleep -Seconds ${s}`
    : `echo starting; sleep ${s}`),
  touch: (f) => (WIN
    ? `New-Item -ItemType File -Force -Path '${f}' | Out-Null`
    : `touch '${f}'`),
  tenAsHundredBs: WIN
    ? "[Console]::Out.Write('A' * 10); [Console]::Out.Write('B' * 100)"
    : 'printf "AAAAAAAAAA"; printf "B%.0s" $(seq 1 100)',
};
// PowerShell ends its lines with CRLF; the runner keeps bytes as they come.
const norm = (s) => (s ?? '').replace(/\r\n/g, '\n');

// --- per-case scaffolding ----------------------------------------------------
let TMP, MARKER, logs = [];

function setup(envLines = {}, ambient = {}) {
  TMP = mkdtempSync(path.join(tmpdir(), 'runlet-win-'));
  process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
  MARKER = path.join(TMP, 'marker');
  const conf = path.join(TMP, 'conf');
  mkdirSync(conf, { recursive: true });
  writeFileSync(path.join(conf, 'relay.key'), `${KEY}\n`);
  writeFileSync(path.join(conf, 'env'),
    Object.entries(envLines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  Object.assign(process.env, {
    RUNLET_CONF: conf,
    XDG_STATE_HOME: path.join(TMP, 'state'),
    CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'test-token',
    RUNLET_DB_ID: '11111111-2222-3333-4444-555555555555',
    RUNLET_RUNNER_ID: 'testrunner',
    RUNLET_DETACH_CHECK: '1',
    ...ambient,
  });
  // The runner logs through console.error; keep it for assertions and out of
  // the test output unless the case fails.
  const real = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  process.on('exit', () => { console.error = real; });
  return { conf, nonces: path.join(TMP, 'state', 'runlet', 'nonces') };
}

const job = (command, extra = {}) => {
  const nonce = extra.nonce ?? `n${Math.random().toString(36).slice(2)}`;
  return { command, nonce, sig: extra.sig ?? sign(KEY, nonce, command), ...extra };
};

// Start the runner. `mode` is '--once' or 'loop'. Returns the mock's handle.
async function start(rows, mode = '--once') {
  const db = mockD1(rows);
  globalThis.fetch = db.fetchStub;
  process.argv = [process.argv[0], RUNNER, ...(mode === '--once' ? ['--once'] : [])];
  // pathToFileURL, not the bare path: on Windows the ESM loader rejects
  // C:\... as an unsupported 'c:' URL scheme.
  const loaded = import(pathToFileURL(RUNNER).href);
  if (mode === '--once') await loaded; else loaded.catch((e) => { throw e; });
  return db;
}

const until = async (pred, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(100); }
  return false;
};
const logged = (re) => logs.some((l) => re.test(l));

// --- cases -------------------------------------------------------------------
const cases = {
  // THE regression test: the runner passed a not-yet-open createWriteStream to
  // spawn, which throws ERR_INVALID_ARG_VALUE, so every job wedged in 'running'.
  async basic() {
    setup();
    const db = await start([job(C.helloExit7)]);
    assert.equal(db.row(1).status, 'done');
    assert.equal(db.row(1).exit_code, 7);
    // Both streams land in the one file; their order is the shell's business.
    assert.match(norm(db.row(1).output), /hello/);
    assert.match(norm(db.row(1).output), /to-stderr/);
    if (!WIN) assert.equal(db.row(1).output, 'hello\nto-stderr\n');
  },

  async timeout() {
    setup({ RUNLET_CMD_TIMEOUT: 2 });
    const db = await start([job(C.startThenSleep(30))]);
    assert.equal(db.row(1).status, 'timeout');
    // 124 is what `timeout` gives runlet.sh; both runners must agree.
    assert.equal(db.row(1).exit_code, 124);
    assert.match(norm(db.row(1).output), /starting/);
    assert.match(norm(db.row(1).output), /killed after 2s/);
  },

  // A cancel reaches the job once it is up, and the partial output survives.
  async loopCancel() {
    setup({ RUNLET_POLL: 1, RUNLET_CMD_TIMEOUT: 60 });
    const db = await start([job(C.startThenSleep(30))], 'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    db.row(1).cancel = 1;
    assert.ok(await until(() => db.row(1).status === 'cancelled'), 'never cancelled');
    assert.equal(db.row(1).exit_code, -1);
    assert.match(norm(db.row(1).output), /starting/);
    assert.match(norm(db.row(1).output), /cancelled after it had started/);
  },

  // A row whose signature does not verify is rejected and never executed.
  async badSignature() {
    setup();
    const db = await start([job(C.touch(MARKER), { sig: 'f'.repeat(64) })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /signature did not verify/);
    assert.equal(existsSync(MARKER), false, 'a rejected command must not run');
  },

  // A nonce already in the file is a replayed row, whoever signed it.
  async replayedNonce() {
    const { nonces } = setup();
    mkdirSync(path.dirname(nonces), { recursive: true });
    writeFileSync(nonces, 'used-before\n');
    const db = await start([job(C.touch(MARKER), { nonce: 'used-before' })]);
    assert.equal(db.row(1).status, 'rejected');
    assert.match(db.row(1).output, /replayed nonce/);
    assert.equal(existsSync(MARKER), false, 'a replayed command must not run');
  },

  // runlet.sh does `set -a; . env`, so the env FILE wins over the ambient
  // environment. A 2 s timeout in the file must beat a 60 s one in the env.
  async envFileWins() {
    setup({ RUNLET_CMD_TIMEOUT: 2 }, { RUNLET_CMD_TIMEOUT: '60' });
    const started = Date.now();
    const db = await start([job(C.sleep(30))]);
    assert.equal(db.row(1).status, 'timeout');
    assert.ok(Date.now() - started < 20000, 'the file value was not used');
  },

  // Nonces live beside runlet.sh's, under $XDG_STATE_HOME, not in the config
  // directory: a machine that has run both keeps one replay history.
  async stateUnderXdg() {
    const { conf, nonces } = setup();
    const rows = [job(C.noop)];
    await start(rows);
    assert.ok(existsSync(nonces), `no nonce file at ${nonces}`);
    assert.match(readFileSync(nonces, 'utf8'), new RegExp(rows[0].nonce));
    assert.equal(existsSync(path.join(conf, 'seen-nonces')), false,
      'nonces must not be written into the config directory');
  },

  // With no XDG_STATE_HOME, the default is ~/.local/state — and on Windows,
  // which has no XDG at all, %LOCALAPPDATA%: machine-local, never roamed.
  async defaultStateHome() {
    setup();
    const home = path.join(TMP, 'userhome');
    mkdirSync(home, { recursive: true });
    delete process.env.XDG_STATE_HOME;
    Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: home });
    const expected = WIN
      ? path.join(home, 'runlet', 'nonces')
      : path.join(home, '.local', 'state', 'runlet', 'nonces');
    const rows = [job(C.noop)];
    await start(rows);
    assert.ok(existsSync(expected), `no nonce file at ${expected}`);
    assert.match(readFileSync(expected, 'utf8'), new RegExp(rows[0].nonce));
  },

  // RUNLET_NONCE_FILE relocates it, as it does for runlet.sh.
  async nonceFileOverride() {
    const custom = path.join(mkdtempSync(path.join(tmpdir(), 'runlet-nonce-')), 'deep', 'n');
    setup({}, { RUNLET_NONCE_FILE: custom });
    const rows = [job(C.noop)];
    await start(rows);
    assert.match(readFileSync(custom, 'utf8'), new RegExp(rows[0].nonce));
  },

  // The file is trimmed from poll(), or it grows without bound.
  async nonceTrim() {
    const { nonces } = setup();
    mkdirSync(path.dirname(nonces), { recursive: true });
    writeFileSync(nonces, Array.from({ length: 6100 }, (_, i) => `old${i}`).join('\n') + '\n');
    await start([job(C.noop)]);
    const lines = readFileSync(nonces, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 5001, `nonce file not trimmed: ${lines.length} lines`);
    assert.ok(lines.length >= 5000, `trimmed too far: ${lines.length} lines`);
  },

  // runlet.sh keeps the FIRST RUNLET_MAX_OUTPUT bytes (head -c): the start of
  // a failing command's output is the part that says why.
  async outputIsHeadNotTail() {
    setup({ RUNLET_MAX_OUTPUT: 20 });
    const db = await start([job(C.tenAsHundredBs)]);
    assert.equal(db.row(1).output.length, 20);
    assert.match(db.row(1).output, /^AAAAAAAAAA/);
  },

  // A long foreground job must not block the poll loop: a background row
  // queued behind it still starts, and a second foreground row still waits.
  async loopLaneDoesNotBlock() {
    setup({ RUNLET_POLL: 1, RUNLET_CMD_TIMEOUT: 60 });
    const db = await start([job(C.sleep(25))], 'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    db.table.push({ id: 2, status: 'pending', background: 1, cancel: 0, ...job(C.sleep(5)) });
    db.table.push({ id: 3, status: 'pending', background: 0, cancel: 0, ...job(C.noop) });
    assert.ok(await until(() => db.row(2).status === 'running'),
      'a background row did not start beside a running foreground row');
    assert.equal(db.row(1).status, 'running', 'the foreground row should still be running');
    assert.equal(db.row(3).status, 'pending',
      'a second foreground row must wait for the lane');
  },

  // Detaching frees the lane; the job is still watched to its result.
  async loopDetach() {
    setup({ RUNLET_POLL: 1, RUNLET_CMD_TIMEOUT: 60 });
    const db = await start([job(C.sleep(6))], 'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    db.row(1).background = 1;                       // run_command --detach
    assert.ok(await until(() => logged(/#1: detached after/)), 'never detached');
    db.table.push({ id: 2, status: 'pending', background: 0, cancel: 0, ...job(C.noop) });
    assert.ok(await until(() => db.row(2).status === 'done'),
      'the lane was not freed by the detach');
    assert.ok(await until(() => db.row(1).status === 'done'),
      'the detached job never wrote its result');
  },

  // RUNLET_BACKGROUND_MAX caps background rows however many are queued.
  async loopBackgroundMax() {
    setup({ RUNLET_POLL: 1, RUNLET_BACKGROUND_MAX: 1, RUNLET_CMD_TIMEOUT: 60 });
    const db = await start([job(C.sleep(4), { background: 1 }), job(C.sleep(1), { background: 1 })],
      'loop');
    assert.ok(await until(() => db.row(1).status === 'running'), 'row 1 never started');
    await sleep(1500);
    assert.equal(db.row(2).status, 'pending', 'RUNLET_BACKGROUND_MAX was not honoured');
    assert.ok(await until(() => db.row(2).status === 'done', 20000),
      'the second background row never ran');
  },

  // Editing the env file is live within one poll, as it is for runlet.sh.
  async loopReloadTunables() {
    const { conf } = setup({ RUNLET_POLL: 1, RUNLET_CMD_TIMEOUT: 600 });
    await start([], 'loop');
    await sleep(1200);
    writeFileSync(path.join(conf, 'env'), 'RUNLET_POLL=1\nRUNLET_CMD_TIMEOUT=5\n');
    assert.ok(await until(() => logged(/RUNLET_CMD_TIMEOUT now 5s \(was 600s\)/)),
      'the env file was not re-read');
  },

  // A row left 'running' by a runner that died is swept at startup, or a
  // waiting get_result can only ever time out.
  async loopSweepsOrphans() {
    setup({ RUNLET_POLL: 1 });
    const db = await start([{ ...job(C.noop), status: 'running', runner: 'testrunner' }], 'loop');
    assert.ok(await until(() => db.row(1).status === 'error'), 'orphan not swept');
    assert.match(db.row(1).output ?? '', /runner restarted/);
  },

  // `status [n]`: the last rows, newest first, as runlet.sh prints them.
  async statusListing() {
    setup();
    const db = mockD1([
      { ...job('echo one'), status: 'done', exit_code: 0, output: 'first\nsecond', runner: 'w' },
      { ...job('echo two'), status: 'running', runner: 'w' },
    ]);
    globalThis.fetch = db.fetchStub;
    process.argv = [process.argv[0], RUNNER, 'status', '5'];
    const out = [];
    const realLog = console.log, realExit = process.exit;
    console.log = (...a) => out.push(a.join(' '));
    process.exit = () => { throw new Error('__exit__'); };
    try { await import(pathToFileURL(RUNNER).href); }
    catch (e) { if (e.message !== '__exit__') throw e; }
    finally { console.log = realLog; process.exit = realExit; }
    // Newest first, and a row still running has no exit code to show.
    assert.match(out[0], /^#2\trunning\t/);
    assert.ok(!/exit=/.test(out[0]), `a running row must not show an exit code: ${out[0]}`);
    assert.match(out[2], /^#1\tdone exit=0\t/);
    assert.match(out[3], /first \| second/);      // newlines folded onto one line
  },
};

// Cases that need no database run as subprocesses of the real script.
const cliCases = {
  signMatchesVectors() {
    const v = JSON.parse(readFileSync(path.join(HERE, 'vectors.json'), 'utf8'));
    for (const t of v.vectors) {
      const cmd = Buffer.from(t.command_b64, 'base64').toString('utf8');
      const got = execFileSync(process.execPath, [RUNNER, 'sign', t.nonce, cmd],
        { env: { ...process.env, RUNLET_KEY: v.key }, encoding: 'utf8' }).trim();
      assert.equal(got, t.expected, `vector ${t.name}`);
    }
  },

  skillsListing() {
    const tmp = mkdtempSync(path.join(tmpdir(), 'runlet-skills-'));
    const env = { ...process.env, RUNLET_CONF: tmp, RUNLET_SKILLS_DIR: path.join(tmp, 'skills'),
                  RUNLET_KEY: KEY };
    const run = () => execFileSync(process.execPath, [RUNNER, 'skills'], { env, encoding: 'utf8' });
    assert.match(run(), /No skills listed/);
    mkdirSync(env.RUNLET_SKILLS_DIR);
    writeFileSync(path.join(env.RUNLET_SKILLS_DIR, 'deploy.md'),
      '---\nname: deploy\ndescription: push the site live\n---\n\nSteps.\n');
    const out = run();
    assert.match(out, /deploy: push the site live/);
    assert.match(out, /deploy\.md/);
    rmSync(tmp, { recursive: true, force: true });
  },
};

// --- driver ------------------------------------------------------------------
const all = { ...cases, ...cliCases };
const name = process.argv[2];

if (name) {
  const fn = all[name];
  if (!fn) { console.log(`unknown case: ${name}`); process.exit(2); }
  await fn();
  process.exit(0);
} else {
  let failed = 0;
  for (const c of Object.keys(all)) {
    const t0 = Date.now();
    const r = await new Promise((res) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), c],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.stdout.on('data', (d) => { err += d; });
      p.on('close', (code) => res({ code, err }));
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.code === 0) console.log(`  ok    ${c} (${secs}s)`);
    else { failed++; console.log(`  FAIL  ${c} (${secs}s)\n${r.err.replace(/^/gm, '        ')}`); }
  }
  console.log(failed ? `check-windows: ${failed} case(s) failed` : `check-windows: ${Object.keys(all).length} cases, all pass`);
  process.exit(failed ? 1 : 0);
}
