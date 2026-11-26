/** Asking the transcriber to do a recording again, from the admin page. */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fixtures, makeRecording } from "./fixtures.js";
import { Client, startApp } from "./server.js";

async function setup(t: TestContext) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  const { app, base } = await startApp(hooks, out);
  fixtures(app, out);
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1", verified: true });
  await app.accounts.create({ email: "reader@example.com", role: "user", password: "reader password 1", verified: true });
  const as = async (e: string, p: string) => { const c = new Client(base); assert.equal((await c.login(e, p)).status, 200); return c; };
  const status = (slug: string, s: object) => writeFileSync(path.join(out, slug, "transcript.status.json"), JSON.stringify(s));
  return { app, out, admin: await as("admin@example.com", "admin password 1"), reader: await as("reader@example.com", "reader password 1"), pub: new Client(base), status };
}

describe("transcribe again", () => {
  it("removes the status so the transcriber picks the recording up again; the old transcript stays; audited", async (t) => {
    const { out, admin, status } = await setup(t);
    const url = "/api/admin/recordings/council-a/retranscribe";
    const r = await admin.post(url);
    assert.deepEqual([r.status, r.json], [200, { requested: true }]);                                              // fixtures: status done
    assert.equal(existsSync(path.join(out, "council-a", "transcript.status.json")), false);
    for (const f of ["council-a.transcript.json", "council-a.vtt", "council-a.mp4"]) assert.ok(existsSync(path.join(out, "council-a", f)), f);   // nothing else touched
    assert.match((await admin.get("/api/admin/audit?limit=10")).text, /transcript\.redo/);
    // It's waiting now: asking again is refused (nothing to do), and so is asking while it works.
    const again = await admin.post(url);
    assert.deepEqual([again.status, /already waiting/.test(again.json.error)], [409, true]);
    status("council-a", { status: "running", stage: "align", progress: 40 });
    const busy = await admin.post(url);
    assert.deepEqual([busy.status, /already working on it \(running\)/.test(busy.json.error)], [409, true]);
    assert.equal(existsSync(path.join(out, "council-a", "transcript.status.json")), true);
    // A failed one can be retried.
    status("council-a", { status: "failed", error: "CUDA out of memory" });
    assert.equal((await admin.post(url)).status, 200);
    assert.equal(existsSync(path.join(out, "council-a", "transcript.status.json")), false);
  });

  it("not for a recording without a video, one still being captured, or an unknown one; admin only, same-origin only", async (t) => {
    const { app, out, admin, reader, pub, status } = await setup(t);
    assert.equal((await admin.post("/api/admin/recordings/failed-d/retranscribe")).status, 404);                   // no video
    assert.equal((await admin.post("/api/admin/recordings/nope/retranscribe")).status, 404);
    assert.equal((await admin.post("/api/admin/recordings/..%2Fx/retranscribe")).status, 404);
    const j = app.sched.add({ link: "https://zoom.us/j/87093163922?pwd=429539", start: new Date(Date.now() + 86_400_000).toISOString(), slug: "council-x" });
    makeRecording(out, "council-x", { video: true });
    status("council-x", { status: "done" });
    const live = await admin.post("/api/admin/recordings/council-x/retranscribe");
    assert.deepEqual([live.status, /still being captured/.test(live.json.error)], [409, true]);
    app.sched.cancel(j.id);
    assert.equal((await admin.post("/api/admin/recordings/council-x/retranscribe")).status, 200);                  // once the capture is over
    assert.equal((await pub.post("/api/admin/recordings/council-a/retranscribe")).status, 401);
    assert.equal((await reader.post("/api/admin/recordings/council-a/retranscribe")).status, 403);
    assert.equal((await admin.req("POST", "/api/admin/recordings/council-a/retranscribe", {}, { origin: "https://evil.example" })).status, 403);
    assert.equal(existsSync(path.join(out, "council-a", "transcript.status.json")), true);                         // none of those touched it
  });
});
