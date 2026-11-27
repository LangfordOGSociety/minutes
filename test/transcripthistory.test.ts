/** Transcription starting, finishing and failing show in a meeting's history, at the times the transcriber wrote. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fixtures } from "./fixtures.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";

describe("transcription in the history", () => {
  it("started, ready and failed are recorded once each, at their real times, and are public", async (t: TestContext) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const out = path.join(tmpDir(hooks), "rec");
    const { app, base } = await startApp(hooks, out);
    fixtures(app, out);
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
    const admin = new Client(base), pub = new Client(base);
    await admin.login("admin@example.com", "admin password 1");
    const mid = app.sched.list().find((j) => j.slug === "council-a")!.meetingRef;
    const status = (o: object) => writeFileSync(path.join(out, "council-a", "transcript.status.json"), JSON.stringify(o));
    const history = async () => ((await admin.get(`/api/admin/meetings/${mid}/changes`)).json as { kind: string; at: string; effect: string }[]).filter((c) => c.kind.startsWith("transcript_")).reverse();

    status({ status: "queued" });
    app.checkTranscripts();
    assert.deepEqual(await history(), []);                        // waiting isn't starting

    status({ status: "running", stage: "transcribing", started: "2026-11-24T05:00:00.000Z" });
    app.checkTranscripts(); app.checkTranscripts();               // looked at twice: one entry
    let h = await history();
    assert.deepEqual(h.map((c) => [c.kind, c.at]), [["transcript_started", "2026-11-24T05:00:00.000Z"]]);

    status({ status: "done", started: "2026-11-24T05:00:00.000Z", finished: "2026-11-24T05:09:30.000Z", elapsed_seconds: 570 });
    app.checkTranscripts();
    h = await history();
    assert.deepEqual(h.map((c) => [c.kind, c.at]), [["transcript_started", "2026-11-24T05:00:00.000Z"], ["transcript_done", "2026-11-24T05:09:30.000Z"]]);

    // Transcribe again: a new start and finish are new entries; a failure too.
    status({ status: "running", started: "2026-11-25T01:00:00.000Z" });
    app.checkTranscripts();
    status({ status: "failed", started: "2026-11-25T01:00:00.000Z", updated: "2026-11-25T01:02:00.000Z", error: "CUDA out of memory" });
    app.checkTranscripts();
    h = await history();
    assert.deepEqual(h.map((c) => c.kind), ["transcript_started", "transcript_done", "transcript_started", "transcript_failed"]);
    assert.equal(h[3].at, "2026-11-25T01:02:00.000Z");

    // The public sees them (no error text), on the meeting and in the recent updates, newest first by when it happened.
    const slug = app.sched.meetings.get(mid)!.slug;
    const pubHist = ((await pub.get(`/api/meetings/${slug}`)).json.history as { kind: string }[]).map((c) => c.kind).filter((k) => k.startsWith("transcript_"));
    assert.deepEqual(pubHist.sort(), ["transcript_done", "transcript_failed", "transcript_started", "transcript_started"]);
    const all = (await pub.get("/api/changes")).json as { at: string }[];
    assert.deepEqual(all.map((c) => c.at), [...all.map((c) => c.at)].sort().reverse());
    assert.doesNotMatch(JSON.stringify([pubHist, all]), /CUDA|out of memory/);
  });
});
