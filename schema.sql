-- Sasonica Shell schema. One table. Applied by install.mjs; safe to re-run.
CREATE TABLE IF NOT EXISTS commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  command    TEXT    NOT NULL,
  status     TEXT    NOT NULL,          -- pending | running | done | error | rejected | timeout | cancelled
  output     TEXT,
  exit_code  INTEGER,
  sig        TEXT    NOT NULL,          -- HMAC-SHA256 hex over nonce "\n" command
  background INTEGER NOT NULL DEFAULT 0, -- 1: may run alongside the queue
  cancel     INTEGER NOT NULL DEFAULT 0, -- 1: stop it (the runner kills it)
  runner     TEXT,                       -- which runner claimed it (hostname)
  nonce      TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commands_pending ON commands (id) WHERE status = 'pending';

-- Added later: a row the runner may start alongside the queue rather than in
-- turn (run_command background=true). install.sh adds this column to a
-- database created before it existed; ALTER TABLE is not idempotent in
-- SQLite, so it is not repeated here.
-- ALTER TABLE commands ADD COLUMN background INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE commands ADD COLUMN cancel INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE commands ADD COLUMN runner TEXT;
