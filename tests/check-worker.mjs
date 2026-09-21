#!/usr/bin/env node
// check-worker.mjs -- the Worker's runner API, and who may use its MCP
// endpoint and how each row is attributed, over real SQLite.
//
//     node tests/check-worker.mjs           every case
//
// The runner used to reach D1 with a Cloudflare API token, which is
// account-wide and would reach every other machine's queue. These endpoints
// are what replaces it, so they are the only thing standing between a
// machine's own credential and everyone else's commands.
import assert from 'node:assert/strict';
import { fakeD1 } from './fake-d1.mjs';

const mod = await import('../worker/src/index.ts');
const worker = mod.default;
const TOKEN = 'runner-token-under-test';
const URL_SECRET = 'five-word-url-secret-here';

const envFor = (binding, extra = {}) => ({
  DB: binding, SASONICA_HMAC_KEY: 'ab'.repeat(32),
  SASONICA_URL_SECRET: URL_SECRET, SASONICA_RUNNER_TOKEN: TOKEN, ...extra,
});

const post = (env, body, { token = TOKEN, method = 'POST', path = '/runner' } = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, {
    method,
    headers: token === null ? {} : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  }), env);

const call = async (env, body) => {
  const r = await post(env, body);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const cases = {
  // A wrong token and an absent one must look exactly like an unknown path:
  // whether the API exists cannot depend on getting the credential right.
  async authIsAll404() {
    const f = fakeD1([{ command: 'echo hi' }]);
    const env = envFor(f.binding);
    assert.equal((await post(env, { op: 'claim', fg: 1 }, { token: 'wrong' })).status, 404);
    assert.equal((await post(env, { op: 'claim', fg: 1 }, { token: null })).status, 404);
    assert.equal((await post(env, { op: 'claim', fg: 1 })).status, 200);
    // Nothing was claimed by the refused calls.
    assert.equal(f.row(1).status, 'running');
  },

  // No token configured = the runner API is off, not open.
  async disabledWithoutToken() {
    const f = fakeD1([{ command: 'echo hi' }]);
    const env = envFor(f.binding, { SASONICA_RUNNER_TOKEN: undefined });
    assert.equal((await post(env, { op: 'claim', fg: 1 })).status, 404);
    assert.equal(f.row(1).status, 'pending');
  },

  async getIsRefused() {
    const f = fakeD1([]);
    assert.equal((await post(envFor(f.binding), null, { method: 'GET' })).status, 405);
  },

  // The claim is one atomic statement, so a second runner racing for the same
  // row gets nothing rather than a duplicate execution.
  async claimIsAtomic() {
    const f = fakeD1([{ command: 'one' }, { command: 'two' }]);
    const env = envFor(f.binding);
    const a = await call(env, { op: 'claim', runner: 'first', fg: 5, bg: 5 });
    assert.equal(a.body.rows.length, 2);
    assert.deepEqual(a.body.rows.map((r) => r.command), ['one', 'two']);
    const b = await call(env, { op: 'claim', runner: 'second', fg: 5, bg: 5 });
    assert.equal(b.body.rows.length, 0, 'a second claim must not win the same rows');
    assert.equal(f.row(1).runner, 'first');
    assert.equal(f.row(1).status, 'running');
  },

  // A busy serial lane asks for fg: 0, or queued foreground commands would
  // hide a background one behind them -- and a row it cannot start would be
  // left marked 'running' while nothing ran it.
  async claimBusyLaneTakesBackgroundOnly() {
    const f = fakeD1([{ command: 'fg' }, { command: 'bg', background: 1 }]);
    const r = await call(envFor(f.binding), { op: 'claim', runner: 'w', fg: 0, bg: 4 });
    assert.deepEqual(r.body.rows.map((x) => x.command), ['bg']);
    assert.equal(f.row(1).status, 'pending', 'the foreground row must be left alone');
  },

  // A free lane takes one foreground row and fills the background slots, in
  // the same request.
  async claimTakesBothKinds() {
    const f = fakeD1([
      { command: 'fg1' }, { command: 'fg2' },
      { command: 'bg1', background: 1 }, { command: 'bg2', background: 1 },
    ]);
    const r = await call(envFor(f.binding), { op: 'claim', runner: 'w', fg: 1, bg: 4 });
    assert.deepEqual(r.body.rows.map((x) => x.command).sort(), ['bg1', 'bg2', 'fg1']);
    assert.equal(f.row(2).status, 'pending', 'only one foreground row was asked for');
  },

  // Zero capacity must claim nothing at all, not fall back to a default.
  async claimWithNoCapacityTakesNothing() {
    const f = fakeD1([{ command: 'fg' }, { command: 'bg', background: 1 }]);
    const r = await call(envFor(f.binding), { op: 'claim', runner: 'w', fg: 0, bg: 0 });
    assert.equal(r.body.rows.length, 0);
    assert.equal(f.all().every((x) => x.status === 'pending'), true);
  },

  async claimIsCapped() {
    const f = fakeD1(Array.from({ length: 14 }, (_, i) => ({ command: `c${i}` })));
    const r = await call(envFor(f.binding), { op: 'claim', runner: 'w', fg: 99, bg: 99 });
    assert.equal(r.body.rows.length, 5, 'a caller must not be able to raise the cap');
  },

  // One request per watcher tick: write what the job has printed, read the
  // two flags back.
  async heartbeatWritesAndReads() {
    const f = fakeD1([{ command: 'x', status: 'running', runner: 'w', cancel: 1, background: 1 }]);
    const r = await call(envFor(f.binding), { op: 'heartbeat', id: 1, output: 'so far' });
    assert.deepEqual(r.body, { background: 1, cancel: 1 });
    assert.equal(f.row(1).output, 'so far');
  },

  // A tick that lands after the job finished must not overwrite its result.
  async heartbeatSpareFinishedRows() {
    const f = fakeD1([{ command: 'x', status: 'done', output: 'the real output', exit_code: 0 }]);
    await call(envFor(f.binding), { op: 'heartbeat', id: 1, output: 'late partial' });
    assert.equal(f.row(1).output, 'the real output');
  },

  async heartbeatUnknownRow() {
    const f = fakeD1([]);
    assert.equal((await call(envFor(f.binding), { op: 'heartbeat', id: 42 })).status, 404);
  },

  async resultWritesTerminalState() {
    const f = fakeD1([{ command: 'x', status: 'running', runner: 'w' }]);
    const r = await call(envFor(f.binding), { op: 'result', id: 1, status: 'timeout', exitCode: 124, output: 'partial' });
    assert.equal(r.status, 200);
    assert.equal(f.row(1).status, 'timeout');
    assert.equal(f.row(1).exit_code, 124);
    assert.equal(f.row(1).output, 'partial');
  },

  // Only the statuses the schema documents; 'running' is not a result.
  async resultRejectsNonTerminal() {
    const f = fakeD1([{ command: 'x', status: 'running' }]);
    for (const bad of ['running', 'pending', 'whatever']) {
      const r = await call(envFor(f.binding), { op: 'result', id: 1, status: bad });
      assert.equal(r.status, 400, `status '${bad}' should be refused`);
    }
    assert.equal(f.row(1).status, 'running');
  },

  // Own rows only: two runners on one database must not sweep each other.
  async sweepOrphansTakesOwnRowsOnly() {
    const f = fakeD1([
      { command: 'mine', status: 'running', runner: 'me' },
      { command: 'theirs', status: 'running', runner: 'someone-else' },
      { command: 'unclaimed', status: 'running', runner: null },
      { command: 'queued', status: 'pending' },
    ]);
    const r = await call(envFor(f.binding), { op: 'sweep', kind: 'orphans', runner: 'me' });
    assert.equal(r.body.changed, 2);
    assert.equal(f.row(1).status, 'error');
    assert.match(f.row(1).output, /runner restarted/);
    assert.equal(f.row(2).status, 'running', "another runner's row must be left alone");
    assert.equal(f.row(3).status, 'error');
    assert.equal(f.row(4).status, 'pending');
  },

  // A live job keeps updated_at fresh through heartbeats, so only one that
  // has gone quiet past the timeout is caught.
  async sweepStaleRespectsAge() {
    const f = fakeD1([
      { command: 'fresh', status: 'running', runner: 'me' },
      { command: 'old', status: 'running', runner: 'me' },
    ]);
    f.age(1, 10); f.age(2, 5000);
    const r = await call(envFor(f.binding), { op: 'sweep', kind: 'stale', runner: 'me', staleSeconds: 720 });
    assert.equal(r.body.changed, 1);
    assert.equal(f.row(1).status, 'running', 'a job that reported recently is alive');
    assert.equal(f.row(2).status, 'error');
    assert.match(f.row(2).output, /may have hung/);
  },

  async pruneKeepsUnfinishedWork() {
    const f = fakeD1([
      { command: 'old done', status: 'done', created_at: '2020-01-01 00:00:00' },
      { command: 'old pending', status: 'pending', created_at: '2020-01-01 00:00:00' },
      { command: 'old running', status: 'running', created_at: '2020-01-01 00:00:00' },
      { command: 'recent done', status: 'done', created_at: '2999-01-01 00:00:00' },
    ]);
    const r = await call(envFor(f.binding), { op: 'prune', keepDays: 30 });
    assert.equal(r.body.changed, 1);
    assert.deepEqual(f.all().map((x) => x.command), ['old pending', 'old running', 'recent done']);
  },

  async statusIsNewestFirstAndBounded() {
    const f = fakeD1([
      { command: 'first', status: 'done', exit_code: 0, output: 'a\nb' },
      { command: 'second', status: 'running' },
    ]);
    const r = await call(envFor(f.binding), { op: 'status', limit: 5 });
    assert.deepEqual(r.body.rows.map((x) => x.id), [2, 1]);
    assert.equal(r.body.rows[1].output, 'a | b', 'newlines are folded for one-line display');
    const capped = await call(envFor(f.binding), { op: 'status', limit: 9999 });
    assert.ok(capped.body.rows.length <= 100);
  },

  async unknownOp() {
    const f = fakeD1([]);
    const r = await call(envFor(f.binding), { op: 'nope' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /unknown op/);
  },

  // The router gained a branch; the assistant's path must be untouched.
  async mcpPathStillWorks() {
    const f = fakeD1([]);
    const res = await worker.fetch(new Request(`https://w.example/${URL_SECRET}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), envFor(f.binding));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result.tools.length >= 1, 'tools/list stopped answering');
    // And the runner path is not reachable through the URL secret.
    const viaSecret = await worker.fetch(new Request(`https://w.example/${URL_SECRET}/runner`, {
      method: 'POST', body: '{}',
    }), envFor(f.binding));
    assert.equal(viaSecret.status, 404);
  },

  // --- who is asking ---------------------------------------------------------
  // The shared URL keeps working exactly as before per-client URLs existed:
  // no clients rows needed, and the row says 'default'.
  async defaultSecretStillWorks() {
    const f = fakeD1([]);
    const r = await mcp(envFor(f.binding), URL_SECRET, 'run_command', { command: 'echo hi', wait: 0 });
    assert.equal(r.status, 200);
    assert.match(r.text, /^#1 pending/);
    assert.equal(f.row(1).client, 'default');
  },

  async addedClientWorks() {
    const f = fakeD1([]);
    f.addClient('chatgpt', 'chatgpt-secret-words-here');
    const r = await mcp(envFor(f.binding), 'chatgpt-secret-words-here', 'run_command', { command: 'id', wait: 0 });
    assert.equal(r.status, 200);
    assert.equal(f.row(1).client, 'chatgpt');
    // The table holds a digest, not the URL.
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM clients WHERE secret_sha256 LIKE ?')
      .get('%secret%').n, 0);
  },

  async revokedClientIs404() {
    const f = fakeD1([]);
    f.addClient('old-phone', 'old-phone-secret', { revoked: true });
    const r = await mcp(envFor(f.binding), 'old-phone-secret', 'tools/list');
    assert.equal(r.status, 404);
    assert.equal(r.text, 'not found', 'a revoked URL must look like any unknown path');
  },

  async unknownSecretIs404() {
    const f = fakeD1([]);
    f.addClient('chatgpt', 'chatgpt-secret');
    for (const bad of ['nope', `${URL_SECRET}x`, 'chatgpt-secre', '']) {
      const r = await mcp(envFor(f.binding), bad, 'tools/list');
      assert.equal(r.status, 404, `secret '${bad}' should be 404`);
    }
    assert.equal(f.all().length, 0);
  },

  // Revoking the shared URL is a 'default' row holding its hash. It wins
  // over the env secret; once that secret is rotated the row no longer
  // matches, and the new shared URL works.
  async revokedDefaultIs404() {
    const f = fakeD1([]);
    f.addClient('default', URL_SECRET, { revoked: true });
    assert.equal((await mcp(envFor(f.binding), URL_SECRET, 'tools/list')).status, 404);
    f.addClient('laptop', 'laptop-secret');
    assert.equal((await mcp(envFor(f.binding), 'laptop-secret', 'tools/list')).status, 200,
      'revoking the shared URL must leave the per-client ones alone');
    const rotated = envFor(f.binding, { SASONICA_URL_SECRET: 'a-new-shared-secret' });
    assert.equal((await mcp(rotated, 'a-new-shared-secret', 'tools/list')).status, 200);
  },

  // A revocation lands within the cache window, not instantly: the isolate
  // remembers a lookup for up to 30 s. Here the window is ended by hand.
  async revocationAfterCacheExpiry() {
    const f = fakeD1([]);
    f.addClient('tablet', 'tablet-secret');
    const env = envFor(f.binding);
    assert.equal((await mcp(env, 'tablet-secret', 'tools/list', {}, { reset: false })).status, 200);
    f.db.prepare(`UPDATE clients SET revoked_at = 'now' WHERE label = 'tablet'`).run();
    assert.equal((await mcp(env, 'tablet-secret', 'tools/list', {}, { reset: false })).status, 200,
      'within the window the cached lookup is used');
    mod.resetClientCache();
    assert.equal((await mcp(env, 'tablet-secret', 'tools/list', {}, { reset: false })).status, 404);
  },

  // A database the installer has not migrated has no clients table. The
  // shared URL must survive that; nothing else can match.
  async noClientsTableKeepsDefault() {
    const f = fakeD1([]);
    f.db.exec('DROP TABLE clients');
    const said = [], real = console.error;
    console.error = (...a) => said.push(a.join(' '));
    try {
      const r = await mcp(envFor(f.binding), URL_SECRET, 'tools/list');
      assert.equal(r.status, 200);
      assert.equal((await mcp(envFor(f.binding), 'anything-else', 'tools/list')).status, 404);
    } finally { console.error = real; }
    assert.match(said.join('\n'), /clients lookup failed/, 'the missing table should be logged');
  },

  async sessionIdCarriesTheAgent() {
    const f = fakeD1([]);
    const env = envFor(f.binding);
    const init = await mcp(env, URL_SECRET, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'claude-ai', version: '0.1.0' },
    }, { method: 'initialize', headers: { 'user-agent': 'Claude-User' } });
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid, 'initialize must return an Mcp-Session-Id');
    assert.match(sid, /^[\x21-\x7e]+$/, 'the spec allows visible ASCII only');
    // Two sessions for the same name are still distinct ids.
    const again = await mcp(env, URL_SECRET, 'initialize', { clientInfo: { name: 'claude-ai', version: '0.1.0' } },
      { method: 'initialize' });
    assert.notEqual(again.headers.get('mcp-session-id'), sid);

    await mcp(env, URL_SECRET, 'run_command', { command: 'true', wait: 0 },
      { headers: { 'mcp-session-id': sid, 'user-agent': 'Claude-User' } });
    assert.equal(f.row(1).agent, 'claude-ai@0.1.0');
    assert.equal(f.row(1).client, 'default');
  },

  // Tampered, foreign or garbage ids fall back to the User-Agent, and never
  // refuse the request.
  async badSessionIdFallsBack() {
    const f = fakeD1([]);
    const env = envFor(f.binding);
    const init = await mcp(env, URL_SECRET, 'initialize', { clientInfo: { name: 'claude-ai' } }, { method: 'initialize' });
    const sid = init.headers.get('mcp-session-id');
    const [name, nonce, mac] = sid.split('.');
    const forged = `${Buffer.from('someone-else').toString('base64url')}.${nonce}.${mac}`;
    const flipped = `${name}.${nonce}.${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`;
    for (const bad of [forged, flipped, 'garbage', `${sid}.extra`]) {
      const r = await mcp(env, URL_SECRET, 'run_command', { command: 'true', wait: 0 },
        { headers: { 'mcp-session-id': bad, 'user-agent': 'python-httpx/0.28.1 extra' } });
      assert.equal(r.status, 200, `a bad session id must not refuse the call: ${bad}`);
    }
    assert.deepEqual([...new Set(f.all().map((x) => x.agent))], ['ua:python-httpx/0.28.1']);
    // No session id and no User-Agent at all.
    await mcp(env, URL_SECRET, 'run_command', { command: 'true', wait: 0 });
    assert.equal(f.all().at(-1).agent, 'unknown');
  },

  // An id minted on one URL means nothing on another.
  async sessionIdIsBoundToItsUrl() {
    const f = fakeD1([]);
    f.addClient('chatgpt', 'chatgpt-secret');
    const env = envFor(f.binding);
    const init = await mcp(env, URL_SECRET, 'initialize', { clientInfo: { name: 'claude-ai' } }, { method: 'initialize' });
    await mcp(env, 'chatgpt-secret', 'run_command', { command: 'true', wait: 0 },
      { headers: { 'mcp-session-id': init.headers.get('mcp-session-id') } });
    assert.deepEqual([f.row(1).client, f.row(1).agent], ['chatgpt', 'unknown']);
  },

  // The session key is derived, so a session id is never a command
  // signature, whatever name was asked for: a name shaped like a signed
  // message ("<nonce>\n<command>") must not come back as that message's sig.
  async sessionIdIsNotACommandSignature() {
    const f = fakeD1([]);
    const env = envFor(f.binding);
    const init = await mcp(env, URL_SECRET, 'initialize', { clientInfo: { name: 'n' } }, { method: 'initialize' });
    const mac = init.headers.get('mcp-session-id').split('.')[2];
    const [b64, nonce] = init.headers.get('mcp-session-id').split('.');
    const same = await mod.hmacHex(env.SASONICA_HMAC_KEY, `default\n${b64}.${nonce}`);
    assert.notEqual(mac, same, 'the session MAC must not use the command key');
  },

  // Without clientInfo the User-Agent names the session; with neither there
  // is no id at all, and nothing breaks.
  async initializeWithoutClientInfo() {
    const f = fakeD1([]);
    const env = envFor(f.binding);
    const ua = await mcp(env, URL_SECRET, 'initialize', {}, { method: 'initialize', headers: { 'user-agent': 'Claude-User' } });
    const sid = ua.headers.get('mcp-session-id');
    assert.equal(await mod.agentFromSessionId(env, 'default', sid), 'ua:Claude-User');
    const none = await mcp(env, URL_SECRET, 'initialize', {}, { method: 'initialize' });
    assert.equal(none.status, 200);
    assert.equal(none.headers.get('mcp-session-id'), null);
  },

  // What the runner's status op returns, for `sasonica status`.
  async statusShowsClientAndAgent() {
    const f = fakeD1([]);
    f.addClient('chatgpt', 'chatgpt-secret');
    await mcp(envFor(f.binding), 'chatgpt-secret', 'run_command', { command: 'true', wait: 0 },
      { headers: { 'user-agent': 'openai-mcp/1.0' } });
    const r = await call(envFor(f.binding), { op: 'status', limit: 5 });
    assert.equal(r.body.rows[0].client, 'chatgpt');
    assert.equal(r.body.rows[0].agent, 'ua:openai-mcp/1.0');
  },
};

// One MCP request. A tools/call unless `method` says otherwise; the client
// cache is reset first unless the case is testing the cache itself.
async function mcp(env, secret, nameOrMethod, args = {}, { method, headers = {}, reset = true } = {}) {
  if (reset) mod.resetClientCache();
  const isCall = !method && !['tools/list', 'initialize', 'ping'].includes(nameOrMethod);
  const body = isCall
    ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: nameOrMethod, arguments: args } }
    : { jsonrpc: '2.0', id: 1, method: method ?? nameOrMethod, params: args };
  const res = await worker.fetch(new Request(`https://w.example/${secret}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env);
  const raw = await res.text();
  let text = raw;
  try { text = JSON.parse(raw).result?.content?.[0]?.text ?? raw; } catch { /* a plain 404 */ }
  return { status: res.status, headers: res.headers, text };
}

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
console.log(failed ? `check-worker: ${failed} case(s) failed` : `check-worker: ${Object.keys(cases).length} cases, all pass`);
process.exit(failed ? 1 : 0);
