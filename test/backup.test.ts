import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { backupNow, listBackups, NightlyBackup, pruneBackups, restoreBackup, verifyBackup } from "../src/backup.js";
import { openDb } from "../src/db.js";
import { Scheduler } from "../src/jobs.js";
import { inDays, tmpDir } from "./helpers.js";

const LINK = "https://zoom.us/j/87093163922?pwd=429539";
const at = (s: string) => new Date(s);   // local time (TZ from the environment)

function server(t: TestContext) {
  const root = tmpDir(t);
  const out = path.join(root, "recordings");
  const auth = path.join(root, "auth", "zoom-auth.json");
  const dir = path.join(root, "backups");
  mkdirSync(path.dirname(auth), { recursive: true });
  writeFileSync(auth, JSON.stringify({ cookies: [{ name: "a", value: "secret" }] }), { mode: 0o600 });
  const db = openDb(path.join(out, "minutes.db"));
  let open = true;
  t.after(() => { if (open) db.close(); });
  const s = new Scheduler({ out, entry: "/nonexistent", auth, defaultName: "R", leadMs: 0, noShowMs: 0,
    maxConcurrent: 1, width: 1, height: 1 }, db);
  return { root, out, auth, dir, db, s, close: () => { db.close(); open = false; } };
}

describe("backups", () => {
  it("backs up the database and saved login, checked", (t) => {
    const { s, db, dir, auth } = server(t);
    s.add({ link: LINK, start: inDays(1), slug: "council-a" });
    const b = backupNow(db, dir, auth, at("2026-11-25T03:00"));
    assert.equal(b.name, "minutes-2026-11-25_0300");
    assert.deepEqual(readdirSync(b.path).sort(), ["backup.json", "minutes.db", "zoom-auth.json"]);
    assert.equal(b.manifest.counts.jobs, 1);
    assert.equal(b.manifest.counts.meetings, 1);
    assert.ok(b.manifest.schema >= 2);
    for (const f of readdirSync(b.path)) assert.equal(statSync(path.join(b.path, f)).mode & 0o777, 0o600, f);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(readFileSync(path.join(b.path, "zoom-auth.json"), "utf8"), readFileSync(auth, "utf8"));
    assert.deepEqual(verifyBackup(b.path).counts, b.manifest.counts);
    // Same minute again: a second folder, not an overwrite.
    assert.equal(backupNow(db, dir, auth, at("2026-11-25T03:00")).name, "minutes-2026-11-25_0300-2");
  });

  it("works without a saved login", (t) => {
    const { db, dir } = server(t);
    const b = backupNow(db, dir, null, at("2026-11-25T03:00"));
    assert.deepEqual(readdirSync(b.path).sort(), ["backup.json", "minutes.db"]);
  });

  it("verify catches a changed or damaged file", (t) => {
    const { db, dir, auth } = server(t);
    const b = backupNow(db, dir, auth, at("2026-11-25T03:00"));
    appendFileSync(path.join(b.path, "zoom-auth.json"), " ");
    assert.throws(() => verifyBackup(b.path), /zoom-auth.json doesn't match/);
    assert.throws(() => verifyBackup(path.join(dir, "nope")), /not a finished backup/);
  });

  it("restores into a stopped server's files, keeping the old ones", (t) => {
    const { s, db, dir, auth, out, close } = server(t);
    const j = s.add({ link: LINK, start: inDays(1), slug: "keep-me" });
    const b = backupNow(db, dir, auth, at("2026-11-25T03:00"));
    // Things go wrong after the backup.
    s.cancel(j.id);
    s.add({ link: LINK, start: inDays(2), slug: "after-backup" });
    writeFileSync(auth, "{}");
    close();

    const restored = restoreBackup(b.path, out, auth, at("2026-11-25T09:15"));
    assert.equal(restored.length, 2);
    assert.ok(!readdirSync(out).some((f) => f.endsWith(".restoring")));
    assert.ok(existsSync(path.join(out, "minutes.db.before-restore-2026-11-25_0915")));
    assert.equal(readFileSync(auth + ".before-restore-2026-11-25_0915", "utf8"), "{}");
    assert.match(readFileSync(auth, "utf8"), /secret/);
    assert.equal(statSync(auth).mode & 0o777, 0o600);

    // The server starts on the restored state.
    const db2 = openDb(path.join(out, "minutes.db"));
    t.after(() => db2.close());
    const s2 = new Scheduler({ out, entry: "/nonexistent", auth, defaultName: "R", leadMs: 0, noShowMs: 0,
      maxConcurrent: 1, width: 1, height: 1 }, db2);
    assert.deepEqual(s2.list().map((x) => [x.slug, x.status]), [["keep-me", "scheduled"]]);
  });

  it("keeps 14 days, and never the newest", (t) => {
    const { db, dir } = server(t);
    for (const d of ["2026-11-01", "2026-11-10", "2026-11-11", "2026-11-24"]) backupNow(db, dir, null, at(`${d}T03:00`));
    mkdirSync(path.join(dir, ".tmp-minutes-2026-11-24_0300"));   // left by a crash
    assert.deepEqual(pruneBackups(dir, 14, at("2026-11-25T03:00")), ["minutes-2026-11-10_0300", "minutes-2026-11-01_0300"]);
    assert.deepEqual(listBackups(dir), ["minutes-2026-11-24_0300", "minutes-2026-11-11_0300"]);
    assert.ok(!existsSync(path.join(dir, ".tmp-minutes-2026-11-24_0300")));
    // Only an old backup left: it stays.
    assert.deepEqual(pruneBackups(dir, 14, at("2027-03-01T03:00")), ["minutes-2026-11-11_0300"]);
    assert.deepEqual(listBackups(dir), ["minutes-2026-11-24_0300"]);
  });

  it("nightly: once a day after the hour, failures notify once", (t) => {
    const { db, dir, auth } = server(t);
    const notes: string[] = [];
    const n = new NightlyBackup({ dir, auth, keepDays: 14, atHour: 3, notifyUrl: null }, db, async (m) => { notes.push(m); });
    assert.equal(n.tick(at("2026-11-25T02:50")), null);
    assert.equal(n.tick(at("2026-11-25T03:05"))?.name, "minutes-2026-11-25_0305");
    assert.equal(n.tick(at("2026-11-25T03:15")), null);            // done for today
    assert.equal(n.tick(at("2026-11-26T03:00"))?.name, "minutes-2026-11-26_0300");

    // Backups can't be written (a file where the folder should be).
    const bad = new NightlyBackup({ dir: path.join(dir, "minutes-2026-11-26_0300", "backup.json"), auth, keepDays: 14,
      atHour: 3, notifyUrl: null }, db, async (m) => { notes.push(m); });
    assert.equal(bad.tick(at("2026-11-27T03:00")), null);
    assert.equal(bad.tick(at("2026-11-27T03:10")), null);            // retried hourly, not every tick
    assert.equal(bad.tick(at("2026-11-27T04:10")), null);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^minutes backup failed/);
  });
});
