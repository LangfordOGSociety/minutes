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

  // 6: feeds (#8, #9): where meetings are found, and each poll of them.
  `CREATE TABLE feeds (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     parser       TEXT NOT NULL,          -- registry id: ical, html, escribe, granicus
     config       TEXT NOT NULL,          -- JSON, as validated by the parser
     slug_prefix  TEXT NOT NULL,          -- folder names: <prefix>-<title>-<date>
     policy       TEXT NOT NULL DEFAULT 'review',   -- auto | review | list_only
     interval_min INTEGER NOT NULL DEFAULT 60,
     enabled      INTEGER NOT NULL DEFAULT 1,
     http_cache   TEXT,                   -- JSON {url: {etag, lastModified}}
     last_hash    TEXT,                   -- of the last parsed result
     last_run_at  TEXT,
     last_ok_at   TEXT,
     next_run_at  TEXT,
     failures     INTEGER NOT NULL DEFAULT 0,   -- in a row
     last_error   TEXT,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   );
   CREATE TABLE feed_runs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     feed_id     TEXT NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
     trigger     TEXT NOT NULL,           -- schedule | manual
     started_at  TEXT NOT NULL,
     finished_at TEXT,
     status      TEXT NOT NULL,           -- running | ok | unchanged | not_modified | error | suspect
     items       INTEGER,
     hash        TEXT,
     changes     INTEGER,
     error       TEXT
   );
   CREATE INDEX feed_runs_feed ON feed_runs (feed_id, id);`,

  // 7: what feeds change (#10, #11). Meetings get review state, a link to
  // the meeting they duplicate, and a removal flag; every change a feed
  // makes to a meeting is logged with what it did to captures.
  `ALTER TABLE meetings ADD COLUMN page_url TEXT;        -- the meeting on the source site (public)
   ALTER TABLE meetings ADD COLUMN review TEXT;          -- pending | approved | rejected; NULL = none needed
   ALTER TABLE meetings ADD COLUMN duplicate_of TEXT;    -- meetings.id this is the same meeting as
   ALTER TABLE meetings ADD COLUMN removed_at TEXT;      -- missing from its feed since (only a flag)
   ALTER TABLE meetings ADD COLUMN last_seen_at TEXT;    -- in its feed's last run
   CREATE INDEX meetings_feed ON meetings (feed_id, external_id);
   CREATE TABLE meeting_changes (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     meeting_id TEXT NOT NULL,
     feed_id    TEXT,
     run_id     INTEGER,
     at         TEXT NOT NULL,
     kind       TEXT NOT NULL,         -- added | time_changed | link_changed | cancelled | reinstated | removed | returned | details_changed | approved | rejected | merged | split
     before     TEXT,                  -- JSON, links as meeting numbers only
     after      TEXT,
     effect     TEXT                   -- what it did to captures, for people
   );
   CREATE INDEX meeting_changes_meeting ON meeting_changes (meeting_id, id);
   CREATE INDEX meeting_changes_feed ON meeting_changes (feed_id, id);`,

  // 8: each meeting's documents as its feed last listed them (agenda,
  // revised agenda, addenda, notices, minutes), to log what's posted or
  // pulled. NULL = never listed (older rows): the first list isn't news.
  `ALTER TABLE meetings ADD COLUMN documents TEXT;`,

  // 9: the meeting's public stream page (live or recorded), separate from
  // its join link: Granicus player, eScribe live stream, PrimeGov video.
  `ALTER TABLE meetings ADD COLUMN stream_url TEXT;`,

  // 10: API tokens (#16) and their usage (#18). Only a sha256 of a token is
  // stored. api_usage rows are kept 90 days; api_usage_daily (requests and
  // bytes per token per UTC day) stays. `limits` is for a later per-token
  // rate limit (JSON, unused).
  `CREATE TABLE api_tokens (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES users (id),
     prefix       TEXT NOT NULL UNIQUE,
     hash         TEXT NOT NULL,
     label        TEXT NOT NULL,
     scopes       TEXT NOT NULL,        -- JSON array: read, download
     created_at   TEXT NOT NULL,
     expires_at   TEXT,
     revoked_at   TEXT,
     last_used_at TEXT,
     limits       TEXT
   );
   CREATE INDEX api_tokens_user ON api_tokens (user_id);
   CREATE TABLE api_usage (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     at       TEXT NOT NULL,
     token_id TEXT NOT NULL,
     user_id  TEXT NOT NULL,
     route    TEXT NOT NULL,
     file     TEXT,
     status   INTEGER NOT NULL,
     bytes    INTEGER NOT NULL,
     ip       TEXT
   );
   CREATE INDEX api_usage_at ON api_usage (at);
   CREATE INDEX api_usage_token ON api_usage (token_id, at);
   CREATE TABLE api_usage_daily (
     day      TEXT NOT NULL,
     token_id TEXT NOT NULL,
     user_id  TEXT NOT NULL,
     requests INTEGER NOT NULL,
     bytes    INTEGER NOT NULL,
     PRIMARY KEY (day, token_id)
   );
   CREATE INDEX api_usage_daily_user ON api_usage_daily (user_id, day);`,

  // 11: full-text search over transcripts (src/search.ts). transcript_search
  // holds ~30 s passages; transcript_index records which transcript file
  // each came from, so a changed or removed file is re-indexed or dropped.
  // Rebuildable from the files on disk at any time.
  `CREATE VIRTUAL TABLE transcript_search USING fts5(
     text, speaker, meeting_id UNINDEXED, rec_slug UNINDEXED, start UNINDEXED,
     tokenize = 'porter unicode61 remove_diacritics 2'
   );
   CREATE TABLE transcript_index (
     rec_slug   TEXT PRIMARY KEY,
     meeting_id TEXT NOT NULL,
     size       INTEGER NOT NULL,
     mtime_ms   INTEGER NOT NULL,
     passages   INTEGER NOT NULL,
     indexed_at TEXT NOT NULL
   );`,

  // 12: alerts (src/alerts.ts): a saved search whose owner is emailed when a
  // new meeting's transcript matches. `token` lets the email's link stop it
  // without signing in. alert_deliveries makes a send once per alert and
  // meeting; alert_runs marks a meeting as handled.
  `CREATE TABLE alerts (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES users (id),
     query        TEXT NOT NULL,
     body         TEXT,
     token        TEXT NOT NULL UNIQUE,
     created_at   TEXT NOT NULL,
     last_sent_at TEXT
   );
   CREATE INDEX alerts_user ON alerts (user_id);
   CREATE TABLE alert_deliveries (
     alert_id   TEXT NOT NULL,
     meeting_id TEXT NOT NULL,
     sent_at    TEXT NOT NULL,
     PRIMARY KEY (alert_id, meeting_id)
   );
   CREATE TABLE alert_runs (
     meeting_id TEXT PRIMARY KEY,
     done_at    TEXT NOT NULL
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
