// A stand-in for the D1 HTTP API, holding the commands table in memory.
// It understands only the statements the runners actually send, which is the
// point: a query neither runner writes is a test bug, not a silent pass.
import { createHmac } from 'node:crypto';

export const sign = (key, nonce, command) =>
  createHmac('sha256', key).update(`${nonce}\n${command}`).digest('hex');

const unlit = (s) => s.replace(/''/g, "'");

export function mockD1(rows) {
  const table = rows.map((r, i) => ({
    id: i + 1, status: 'pending', background: 0, cancel: 0,
    output: null, exit_code: null, runner: null,
    created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00', ...r,
  }));
  const seen = [];
  const row = (id) => table.find((r) => r.id === Number(id));

  const fetchStub = async (url, opts) => {
    const sql = JSON.parse(opts.body).sql;
    seen.push(sql);
    let results = [], changes = 0, m;

    if ((m = /^SELECT id, command, sig, nonce,[\s\S]*WHERE status = 'pending'( AND background = 1)?/.exec(sql))) {
      results = table.filter((r) => r.status === 'pending' && (!m[1] || r.background === 1))
        .sort((a, b) => a.id - b.id).slice(0, 5)
        .map(({ id, command, sig, nonce, background }) => ({ id, command, sig, nonce, background }));
    } else if ((m = /^SELECT COALESCE\(background, 0\) AS bg,[\s\S]*WHERE id = (\d+);/.exec(sql))) {
      const r = row(m[1]);
      if (r) results = [{ bg: r.background, c: r.cancel }];
    } else if ((m = /^UPDATE commands SET status = 'running', runner = '([\s\S]*?)',[\s\S]*WHERE id = (\d+) AND status = 'pending' RETURNING id;/.exec(sql))) {
      const r = row(m[2]);
      if (r?.status === 'pending') {
        Object.assign(r, { status: 'running', runner: unlit(m[1]) });
        results = [{ id: r.id }]; changes = 1;
      }
    } else if ((m = /^UPDATE commands SET output = '([\s\S]*)', updated_at = datetime\('now'\) WHERE id = (\d+) AND status = 'running';/.exec(sql))) {
      const r = row(m[2]);
      if (r?.status === 'running') { r.output = unlit(m[1]); r.progressWrites = (r.progressWrites ?? 0) + 1; changes = 1; }
    } else if ((m = /^UPDATE commands SET status = '(\w+)', exit_code = (-?\d+), output = '([\s\S]*)', updated_at = datetime\('now'\) WHERE id = (\d+);/.exec(sql))) {
      const r = row(m[4]);
      if (r) { Object.assign(r, { status: m[1], exit_code: Number(m[2]), output: unlit(m[3]) }); changes = 1; }
    } else if ((m = /^UPDATE commands SET status = 'error', exit_code = -1, output = '([\s\S]*?)', updated_at[\s\S]*WHERE status = 'running'/.exec(sql))) {
      const mine = /runner IS NULL/.test(sql)
        ? table.filter((r) => r.status === 'running')
        : [];                       // the stale sweep's time clause never fires in a test
      for (const r of mine) Object.assign(r, { status: 'error', exit_code: -1, output: unlit(m[1]) });
      changes = mine.length;
    } else if (/^DELETE FROM commands/.test(sql)) {
      changes = 0;
    } else {
      throw new Error(`mock-d1: unrecognised statement: ${sql.slice(0, 120)}`);
    }
    return { json: async () => ({ success: true, result: [{ results, meta: { changes } }] }) };
  };

  return { table, row, seen, fetchStub };
}
