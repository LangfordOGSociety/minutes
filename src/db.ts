/**
 * The server's database: <out>/minutes.db, node:sqlite (built into Node 24,
 * so still no runtime deps beyond playwright).
 *
 * One writer, the server process. Capture children never open it; they
 * keep writing only their own manifest.json. WAL mode so readers (backups,
 * a sqlite3 shell) don't block the server.
 *
 * Migrations are numbered by position in MIGRATIONS and tracked in
 * PRAGMA user_version. Append only: never edit or reorder a shipped one.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { logger } from "./util.js";

const log = logger("db");

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: capture jobs (was jobs.json).
  `CREATE TABLE jobs (
     id          TEXT PRIMARY KEY,
     link        TEXT NOT NULL,
     start       TEXT NOT NULL,          -- ISO UTC
     slug        TEXT NOT NULL,
     name        TEXT NOT NULL,
     email       TEXT,                   -- never sent to the browser
     status      TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     launched_at TEXT,
     ended_at    TEXT,
     exit_code   INTEGER,
     outcome     TEXT,
     error       TEXT
   );
   CREATE INDEX jobs_status ON jobs (status);
   CREATE INDEX jobs_slug ON jobs (slug);`,

  // 2: meetings, separate from capture attempts (jobs). Each existing job
  // becomes the only attempt of its own meeting.
  `CREATE TABLE meetings (
     id          TEXT PRIMARY KEY,
     feed_id     TEXT,                   -- NULL: entered by hand
     external_id TEXT,                   -- the feed's stable id
     title       TEXT NOT NULL,
     body        TEXT,
     platform    TEXT NOT NULL,
     method      TEXT,
     link        TEXT NOT NULL,          -- secret, never sent to the browser
     start       TEXT NOT NULL,          -- ISO UTC
     end_est     TEXT,
     agenda_url  TEXT,
     status      TEXT NOT NULL,          -- scheduled | cancelled
     visibility  TEXT NOT NULL,          -- public | hidden
     slug        TEXT NOT NULL,          -- base for its jobs' folder names
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (feed_id, external_id)
   );
   CREATE INDEX meetings_start ON meetings (start);
   ALTER TABLE jobs ADD COLUMN meeting_id TEXT REFERENCES meetings (id);
   INSERT INTO meetings (id, title, platform, link, start, status, visibility, slug, created_at, updated_at)
     SELECT 'm-' || id, slug, 'zoom', link, start, 'scheduled', 'public', slug, created_at, created_at FROM jobs;
   UPDATE jobs SET meeting_id = 'm-' || id;
   CREATE INDEX jobs_meeting ON jobs (meeting_id);`,

  // 3: accounts (#5). Sessions store only a hash of the cookie token.
  `CREATE TABLE users (
     id                   TEXT PRIMARY KEY,
     email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name                 TEXT NOT NULL DEFAULT '',
     role                 TEXT NOT NULL,          -- see ROLE_CAPS in accounts.ts
     password_hash        TEXT,                   -- scrypt$N$r$p$salt$hash
     must_change_password INTEGER NOT NULL DEFAULT 0,
     email_verified_at    TEXT,
     disabled_at          TEXT,
     last_login_at        TEXT,
     created_at           TEXT NOT NULL,
     updated_at           TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token_hash   TEXT PRIMARY KEY,               -- sha256 of the cookie value
     user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     created_at   TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     expires_at   TEXT NOT NULL,
     ip           TEXT,
     user_agent   TEXT
   );
   CREATE INDEX sessions_user ON sessions (user_id);
   CREATE INDEX sessions_expires ON sessions (expires_at);`,

  // 4: audit log of admin actions (#7). Values are redacted before they
  // get here (audit.ts): no passcodes, emails, passwords or tokens.
  `CREATE TABLE audit_log (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     at           TEXT NOT NULL,
     actor_id     TEXT,                   -- users.id; NULL for the CLI
     actor        TEXT NOT NULL,          -- email at the time, or "cli"
     ip           TEXT,
     action       TEXT NOT NULL,          -- "job.create", "user.role", ...
     target_type  TEXT NOT NULL,
     target_id    TEXT,
     target_label TEXT,                   -- e.g. the slug or email, for reading
     before       TEXT,                   -- JSON, changed fields only
     after        TEXT
   );
   CREATE INDEX audit_at ON audit_log (at);
   CREATE INDEX audit_action ON audit_log (action);
   CREATE INDEX audit_target ON audit_log (target_type, target_id);`,

  // 5: emailed codes for sign-up verification and password reset (#32).
  // One live code per user and purpose; only a hash is stored.
  `CREATE TABLE email_codes (
     user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     purpose    TEXT NOT NULL,              -- verify | reset
     code_hash  TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     attempts   INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     PRIMARY KEY (user_id, purpose)
   );`,
];

export function openDb(file: string): DB {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const have = row.user_version;
  if (have > MIGRATIONS.length) {
    throw new Error(`minutes.db is at schema ${have}, newer than this build knows (${MIGRATIONS.length}); refusing to run an older build on it`);
  }
  for (let v = have; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    log.info(`database migrated to schema ${v + 1}`);
  }
}

/** Run fn in a transaction; rolls back if it throws. Inside another
 *  transaction it just runs fn (the outer one commits or rolls back). */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
