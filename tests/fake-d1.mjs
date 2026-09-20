// A D1 binding backed by real SQLite, so the Worker's SQL is executed rather
// than pattern-matched: RETURNING, datetime('now', ...) and the conditional
// claim all behave as they do on D1. Needs Node 22.5+ (--experimental-sqlite
// before 24).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function fakeD1(rows = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(path.join(HERE, '..', 'schema.sql'), 'utf8'));
  // The columns schema.sql adds by ALTER for older databases are in the
  // CREATE TABLE here, so nothing extra is needed.
  const insert = db.prepare(
    `INSERT INTO commands (command, status, sig, nonce, background, cancel, runner,
       output, exit_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    insert.run(r.command ?? 'true', r.status ?? 'pending', r.sig ?? 'sig', r.nonce ?? `n${Math.random()}`,
      r.background ?? 0, r.cancel ?? 0, r.runner ?? null, r.output ?? null,
      r.exit_code ?? null, r.created_at ?? '2026-01-01 00:00:00',
      r.updated_at ?? '2026-01-01 00:00:00');
  }

  const binding = {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args; return stmt; },
        async all() {
          const st = db.prepare(sql);
          // node:sqlite refuses .all() on a statement returning no rows.
          let results = [];
          let changes = 0;
          if (/RETURNING|^\s*SELECT/is.test(sql)) results = st.all(...params);
          else changes = st.run(...params).changes;
          return { results, meta: { changes: changes || results.length }, success: true };
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
        async run() {
          const info = db.prepare(sql).run(...params);
          return { results: [], meta: { changes: Number(info.changes) }, success: true };
        },
      };
      return stmt;
    },
  };
  return {
    db, binding,
    all: () => db.prepare('SELECT * FROM commands ORDER BY id').all(),
    row: (id) => db.prepare('SELECT * FROM commands WHERE id = ?').get(id),
    // Tests that care about age set it relative to now, so the Worker's own
    // datetime('now', '-N seconds') comparison is the thing under test.
    age: (id, seconds) => db.prepare(
      `UPDATE commands SET updated_at = datetime('now', ?) WHERE id = ?`,
    ).run(`-${seconds} seconds`, id),
  };
}
