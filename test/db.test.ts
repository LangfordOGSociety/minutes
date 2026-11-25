import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, it } from "node:test";
import { openDb, tx } from "../src/db.js";
import { Meetings } from "../src/meetings.js";
import { tmpDir } from "./helpers.js";

describe("db", () => {
  it("migrates an empty database to the latest schema", (t) => {
    const db = openDb(path.join(tmpDir(t), "minutes.db"));
    t.after(() => db.close());
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.ok(v >= 2);
    const cols = (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("meeting_id"));
  });

  it("migration 2 gives each existing job its own meeting", (t) => {
    const file = path.join(tmpDir(t), "minutes.db");
    // A schema-1 database, as left by the first SQLite build.
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, link TEXT NOT NULL, start TEXT NOT NULL, slug TEXT NOT NULL,
      name TEXT NOT NULL, email TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, launched_at TEXT, ended_at TEXT,
      exit_code INTEGER, outcome TEXT, error TEXT);
      CREATE INDEX jobs_status ON jobs (status); CREATE INDEX jobs_slug ON jobs (slug);
      INSERT INTO jobs (id, link, start, slug, name, status, created_at)
        VALUES ('j1', '87093163922', '2026-11-16T03:00:00.000Z', 'council-a', 'Rec', 'done', '2026-11-10T00:00:00.000Z');
      PRAGMA user_version = 1;`);
    old.close();

    const db = openDb(file);
    t.after(() => db.close());
    const j = db.prepare("SELECT meeting_id FROM jobs WHERE id = 'j1'").get() as { meeting_id: string };
    assert.equal(j.meeting_id, "m-j1");
    const m = new Meetings(db).get("m-j1");
    assert.equal(m?.slug, "council-a");
    assert.equal(m?.link, "87093163922");
    assert.equal(m?.start, "2026-11-16T03:00:00.000Z");
  });

  it("refuses a database newer than the build", (t) => {
    const file = path.join(tmpDir(t), "minutes.db");
    const d = new DatabaseSync(file);
    d.exec("PRAGMA user_version = 999");
    d.close();
    assert.throws(() => openDb(file), /newer than this build/);
  });

  it("tx rolls back on error and nests", (t) => {
    const db = openDb(path.join(tmpDir(t), "minutes.db"));
    t.after(() => db.close());
    const meetings = new Meetings(db);
    const input = { title: "x", platform: "zoom", link: "87093163922", start: "2026-12-01T00:00:00.000Z", slug: "x" };
    assert.throws(() => tx(db, () => {
      tx(db, () => meetings.create(input));
      throw new Error("boom");
    }), /boom/);
    assert.equal(meetings.list().length, 0);
    tx(db, () => tx(db, () => meetings.create(input)));
    assert.equal(meetings.list().length, 1);
  });
});
