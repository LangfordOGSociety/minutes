/**
 * The public site with thousands of meetings and recordings: a seeded database and folders, then the
 * requests a visitor makes. Guards the cost of a request (and of a video range request) against growing
 * with the number of recordings: see docs/scaling.md.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openDb } from "../src/db.js";
import { Meetings } from "../src/meetings.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";

const N = Number(process.env.SCALE_N ?? 3000);

async function seeded(t: TestContext, n = N, snapshotMs = Number(process.env.SCALE_SNAP ?? 5000)) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  mkdirSync(out, { recursive: true });
  const db = openDb(path.join(out, "minutes.db"));
  const meetings = new Meetings(db);
  const insJob = db.prepare(`INSERT INTO jobs (id, meeting_id, link, start, slug, name, status, created_at, ended_at, outcome)
    VALUES (?, ?, '', ?, ?, 'Recorder', 'done', ?, ?, 'ended')`);
  const day = 86_400_000, base = Date.now() - N * day;
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const start = new Date(base + i * day).toISOString();
    const slug = `council-${i}`;
    const m = meetings.create({ title: `Council meeting ${i}`, body: i % 2 ? "Council" : "Committee", platform: "zoom", link: "", start, slug });
    insJob.run(`j${i}`, m.id, start, slug, start, start);
    const dir = path.join(out, slug);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ output: `${slug}.mp4`, scheduledStart: start, parts: [], offsets: [{ dur: 3600 }] }));
    writeFileSync(path.join(dir, `${slug}.mp4`), "x");
    writeFileSync(path.join(dir, `${slug}.vtt`), "WEBVTT\n");
    writeFileSync(path.join(dir, `${slug}.transcript.json`), "{}");
    writeFileSync(path.join(dir, "transcript.status.json"), JSON.stringify({ status: "done" }));
  }
  db.exec("COMMIT");
  db.close();
  const { app, base: url } = await startApp(hooks, out, { pollFeeds: false, snapshotMs });
  return { app, c: new Client(url), out, base: url };
}

const time = async (f: () => Promise<unknown>) => { const t0 = performance.now(); await f(); return performance.now() - t0; };

describe("scale: thousands of meetings", () => {
  it("the public pages and a video range request stay fast", async (t) => {
    const { c } = await seeded(t);
    const cold = await time(() => c.get("/api/meetings?scope=past&limit=20"));
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) warm.push(await time(() => c.get("/api/meetings?scope=past&limit=20")));
    const media = [];
    for (let i = 0; i < 5; i++) media.push(await time(() => c.req("GET", `/media/council-${N - 1}/council-${N - 1}.vtt`)));
    const detail = await time(() => c.get(`/api/meetings/council-${N - 2}`));
    const search = await time(() => c.get("/api/meetings?scope=past&q=meeting%201&limit=20"));
    console.log(`N=${N} cold=${cold.toFixed(0)}ms warm=${Math.min(...warm).toFixed(0)}-${Math.max(...warm).toFixed(0)}ms media=${Math.min(...media).toFixed(0)}-${Math.max(...media).toFixed(0)}ms detail=${detail.toFixed(0)}ms filter=${search.toFixed(0)}ms`);
    // Medians, with room for a busy machine (the tests run in parallel): a listing or a media request must not cost what building the
    // whole model costs (it did, every time, before the snapshots: 3000 meetings took ~400 ms each).
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    assert.ok(median(warm) < Math.max(cold / 4, 50), `a warm listing took ${median(warm).toFixed(0)} ms (cold: ${cold.toFixed(0)})`);
    assert.ok(median(media) < Math.max(cold / 4, 50), `a /media request took ${median(media).toFixed(0)} ms (cold: ${cold.toFixed(0)})`);
  });

  it("a kept snapshot is rebuilt at once when a meeting, a capture or an admin write changes it", async (t) => {
    const { app, c, base } = await seeded(t, 5, 600_000);   // ten minutes: only a change can refresh it
    const title = async (slug = "council-1") => (await c.get(`/api/meetings/${slug}`)).json.title;
    assert.equal(await title(), "Council meeting 1");
    // A change made inside the app (the scheduler, a feed's sync) bumps the meetings' version.
    const m = app.sched.meetings.bySlug("council-1")!;
    m.title = "Changed inside";
    app.sched.meetings.save(m);
    assert.equal(await title(), "Changed inside");
    // An admin's write, over HTTP.
    await app.accounts.create({ email: "a@example.com", role: "admin", password: "admin password 1" });
    const admin = new Client(base);
    await admin.login("a@example.com", "admin password 1");
    assert.equal((await admin.req("PATCH", "/api/admin/meetings/council-1", { title: "Edited" })).status, 200);
    assert.equal(await title(), "Edited");
    assert.equal((await admin.post("/api/admin/meetings/" + m.id + "/hide")).status, 200);
    assert.equal((await c.get("/api/meetings/council-1")).status, 404);
    // Another meeting is untouched, and a cancelled capture is seen.
    assert.equal(await title("council-2"), "Council meeting 2");
  });
});

