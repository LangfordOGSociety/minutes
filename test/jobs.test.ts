import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openDb, type DB } from "../src/db.js";
import { BadRequest, Scheduler, type SchedulerOpts } from "../src/jobs.js";
import { inDays, tmpDir } from "./helpers.js";

const LINK = "https://zoom.us/j/87093163922?pwd=429539";

function setup(t: TestContext, out = tmpDir(t)): { s: Scheduler; db: DB; out: string; reopen: () => Scheduler } {
  const o: SchedulerOpts = {
    out, entry: "/nonexistent/index.js", auth: null, defaultName: "Recorder",
    leadMs: 0, noShowMs: 30 * 60_000, maxConcurrent: 1, width: 1280, height: 720,
  };
  const db = openDb(path.join(out, "minutes.db"));
  t.after(() => db.close());
  // Starts are days ahead, so nothing is ever due and no capture launches.
  return { s: new Scheduler(o, db), db, out, reopen: () => new Scheduler(o, db) };
}

/** Assert fn throws a BadRequest with this HTTP status. */
function refuses(fn: () => unknown, status: number, msg?: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof BadRequest, String(e));
    assert.equal(e.status, status);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

describe("Scheduler", () => {
  it("adds a job with its own meeting and keeps it across restarts", (t) => {
    const { s, reopen } = setup(t);
    const j = s.add({ link: LINK, start: inDays(2), slug: "council-a", name: "Rec\u0007 (Eric)" });
    assert.equal(j.status, "scheduled");
    assert.equal(j.name, "Rec (Eric)");
    const m = s.meetings.get(j.meetingRef);
    assert.equal(m?.link, LINK);
    assert.equal(m?.slug, "council-a");
    assert.equal(m?.platform, "zoom");
    const again = reopen().get(j.id);
    assert.equal(again?.slug, "council-a");
    assert.equal(again?.meetingRef, j.meetingRef);
  });

  it("validates new jobs", (t) => {
    const { s, out } = setup(t);
    refuses(() => s.add({ start: inDays(1) }), 400, /link is required/);
    refuses(() => s.add({ link: "https://example.com/j/87093163922", start: inDays(1) }), 400, /meeting link/);
    refuses(() => s.add({ link: LINK }), 400, /start is required/);
    refuses(() => s.add({ link: LINK, start: "whenever" }), 400, /parse/);
    refuses(() => s.add({ link: LINK, start: inDays(-1) }), 400, /past/);
    refuses(() => s.add({ link: LINK, start: inDays(1), slug: "../etc" }), 400, /name must be/);
    refuses(() => s.add({ link: LINK, start: inDays(1), email: "nope" }), 400, /email/);
    s.add({ link: LINK, start: inDays(1), slug: "dup" });
    refuses(() => s.add({ link: LINK, start: inDays(1), slug: "dup" }), 409, /already exists/);
    mkdirSync(path.join(out, "on-disk"));
    refuses(() => s.add({ link: LINK, start: inDays(1), slug: "on-disk" }), 409, /already exists/);
  });

  it("edits: blank keeps the link and email, start goes to the meeting", (t) => {
    const { s } = setup(t);
    const j = s.add({ link: LINK, start: inDays(1), slug: "a", email: "rec@example.com" });
    const start = inDays(3);
    const e = s.update(j.id, { link: "", start, slug: "b", email: "" });
    assert.equal(e.link, LINK);
    assert.equal(e.email, "rec@example.com");
    assert.equal(e.slug, "b");
    assert.equal(e.start, start);
    assert.equal(s.meetings.get(j.meetingRef)?.start, start);
    assert.equal(s.meetings.get(j.meetingRef)?.slug, "b");
    assert.equal(s.update(j.id, { clearEmail: true }).email, undefined);
    // Nothing is applied when any field is bad.
    refuses(() => s.update(j.id, { slug: "c", start: "never" }), 400);
    assert.equal(s.get(j.id)?.slug, "b");
  });

  it("cancels, then refuses to edit or cancel again", (t) => {
    const { s } = setup(t);
    const j = s.add({ link: LINK, start: inDays(1), slug: "a" });
    assert.equal(s.cancel(j.id).status, "cancelled");
    refuses(() => s.update(j.id, { name: "x" }), 409, /only scheduled/);
    refuses(() => s.cancel(j.id), 409, /already cancelled/);
    refuses(() => s.cancel("nope"), 404);
  });

  it("retry makes a new attempt in its own folder", (t) => {
    const { s, out } = setup(t);
    const j = s.add({ link: LINK, start: inDays(1), slug: "council", name: "Rec", email: "rec@example.com" });
    refuses(() => s.retry(j.id), 409, /only a finished one/);
    s.cancel(j.id);
    mkdirSync(path.join(out, "council-2")); // a folder left by something else
    const r = s.retry(j.id);
    assert.equal(r.slug, "council-3");
    assert.equal(r.meetingRef, j.meetingRef);
    assert.equal(r.link, LINK);
    assert.equal(r.name, "Rec");
    assert.equal(r.email, "rec@example.com");
    assert.equal(r.start, s.meetings.get(j.meetingRef)?.start);
    // One active attempt per meeting.
    refuses(() => s.retry(j.id), 409, /already scheduled/);
  });

  it("imports jobs.json once and marks lost captures interrupted", (t) => {
    const out = tmpDir(t);
    const old = [
      { id: "j1", link: LINK, start: inDays(-1), slug: "was-running", name: "Rec", status: "running", createdAt: inDays(-2) },
      { id: "j2", link: LINK, start: inDays(1), slug: "later", name: "Rec", status: "scheduled", createdAt: inDays(-2) },
    ];
    writeFileSync(path.join(out, "jobs.json"), JSON.stringify(old));
    const { s } = setup(t, out);
    assert.ok(!existsSync(path.join(out, "jobs.json")));
    assert.ok(existsSync(path.join(out, "jobs.json.migrated")));
    assert.equal(s.get("j1")?.status, "interrupted");
    assert.equal(s.get("j2")?.status, "scheduled");
    for (const id of ["j1", "j2"]) assert.ok(s.meetings.get(s.get(id)!.meetingRef), `meeting for ${id}`);
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, "active.json"), "utf8")), []);
  });
});
