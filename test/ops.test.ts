/**
 * Messages to the operator: captures starting, finishing and not starting,
 * transcripts ready or failed; each once, nothing secret.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openDb } from "../src/db.js";
import type { Job, JobEvent } from "../src/jobs.js";
import { Scheduler } from "../src/jobs.js";
import { Ops, describeOutcome } from "../src/ops.js";
import { notify } from "../src/util.js";
import { fixtures } from "./fixtures.js";
import { startApp } from "./server.js";
import { MemoryMailer } from "./smtp.js";
import { tmpDir } from "./helpers.js";

const job = (o: Partial<Job> = {}): Job => ({ id: "j1", meetingRef: "m1", link: "https://zoom.us/j/87093163922?pwd=429539", start: "2026-12-08T01:30:00.000Z", slug: "council", name: "Recorder",
  status: "running", createdAt: "x", launchedAt: "2026-12-08T01:15:00.000Z", ...o });

function world(t: TestContext, site = "https://minutes.example.org") {
  const db = openDb(path.join(tmpDir(t), "x.db"));
  t.after(() => db.close());
  const sent: { text: string; priority?: string; tags?: string }[] = [];
  const ops = new Ops(db, { notify: async (text, o) => { sent.push({ text, ...o }); }, site, titleOf: (j) => (j.slug === "council" ? "Regular Council Meeting" : j.slug), platformOf: () => "Zoom" });
  return { db, ops, sent };
}

describe("outcomes in words", () => {
  it("what happened, and whether it needs a look", () => {
    const d = (o: Partial<Job>) => describeOutcome({ status: "done", ...o }, "Zoom");
    assert.deepEqual(d({ outcome: "ended" }), { text: "the meeting ended and was stitched into one video", bad: false });
    for (const [outcome, re] of [["not_started", /never started/], ["blocked", /Zoom refused it \(a bot check/], ["invalid_link", /isn't a meeting/], ["email_required", /wants an email/], ["ended_after_interruption", /interruption/]] as const) {
      const r = d({ outcome });
      assert.deepEqual([r.bad, re.test(r.text)], [true, true], outcome);
    }
    assert.deepEqual(d({ outcome: "stopped", status: "stopped" }), { text: "it was stopped by hand", bad: false });
    assert.deepEqual(d({ status: "failed", error: "capture exited 1" }), { text: "it failed: capture exited 1", bad: true });
    assert.deepEqual(d({ status: "failed" }), { text: "it failed", bad: true });
    assert.deepEqual(d({ status: "stopped" }), { text: "it was stopped by hand", bad: false });
    assert.deepEqual(d({ outcome: "mystery" }), { text: "outcome: mystery", bad: true });
    assert.equal(d({}).bad, false);
  });
});

describe("capture messages", () => {
  it("started, finished well, finished badly, overdue: once each, in plain words, nothing secret", (t) => {
    const { ops, sent } = world(t);
    const ev = (kind: JobEvent["kind"], o: Partial<Job> = {}): JobEvent => ({ kind, job: job(o) });
    ops.job(ev("started")); ops.job(ev("started"));                                                              // twice: once
    assert.deepEqual(sent, [{ text: "Recording started: Regular Council Meeting.", priority: "low", tags: "red_circle" }]);
    ops.job(ev("finished", { status: "done", outcome: "ended", endedAt: "2026-12-08T03:46:00.000Z" }));
    assert.deepEqual(sent.at(-1), { text: "Recording finished: Regular Council Meeting, 151 min: the meeting ended and was stitched into one video.", priority: "default", tags: "white_check_mark" });
    ops.job(ev("finished", { status: "done", outcome: "ended" }));
    assert.equal(sent.length, 2);
    ops.job(ev("finished", { id: "j2", slug: "other", status: "done", outcome: "blocked", endedAt: "2026-12-08T01:16:00.000Z" }));
    assert.deepEqual(sent.at(-1), { text: "Recording problem: other, 1 min: Zoom refused it (a bot check or a sign-in requirement). Check /admin.", priority: "high", tags: "warning" });
    ops.job(ev("finished", { id: "j3", slug: "third", status: "failed", error: "couldn't set up display/audio: Xvfb :100 didn't start", launchedAt: undefined }));
    assert.match(sent.at(-1)!.text, /^Recording problem: third: it failed: couldn't set up display\/audio/);
    ops.job(ev("overdue", { id: "j4", slug: "late", status: "queued", start: new Date(Date.now() - 14 * 60_000).toISOString() }));
    assert.match(sent.at(-1)!.text, /^Not recording yet: late was due 14 min ago and the capture hasn't started \(waiting for a free slot\)\. Check \/admin\.$/);
    assert.equal(sent.at(-1)!.priority, "high");
    ops.job(ev("overdue", { id: "j4", slug: "late", status: "queued" }));
    assert.equal(sent.length, 6 - 1);                                                                             // that overdue wasn't sent twice
    assert.doesNotMatch(JSON.stringify(sent), /429539|87093163922|zoom\.us|pwd/);
  });

  it("an operator message that can't be sent is lost quietly, never thrown into the scheduler", (t) => {
    const db = openDb(path.join(tmpDir(t), "x.db"));
    t.after(() => db.close());
    const ops = new Ops(db, { notify: () => { throw new Error("boom"); }, site: "", titleOf: () => "T", platformOf: () => "Zoom" });
    assert.doesNotThrow(() => ops.job({ kind: "started", job: job() }));
  });
});

describe("transcript messages", () => {
  const rec = (slug: string, status: string, o: { error?: string; public?: boolean } = {}) => ({ slug, title: `Meeting ${slug}`, transcript: { status, error: o.error ?? null }, public: o.public ?? true });

  it("the first look only records what's there; after that, ready and failed are told once", (t) => {
    const { ops, sent } = world(t);
    ops.transcripts([rec("old", "done"), rec("older", "failed", { error: "x" }), rec("working", "running")]);
    assert.equal(sent.length, 0);                                                                                 // no flood about the archive
    ops.transcripts([rec("old", "done"), rec("working", "running"), rec("new", "done")]);
    assert.deepEqual(sent.map((s) => s.text), ["Transcript ready: Meeting new. https://minutes.example.org/m/new"]);
    ops.transcripts([rec("working", "done"), rec("bad", "failed", { error: "CUDA out of memory" }), rec("quiet", "done", { public: false })]);
    assert.deepEqual(sent.slice(1).map((s) => s.text), ["Transcript ready: Meeting working. https://minutes.example.org/m/working",
      "Transcription FAILED: Meeting bad: CUDA out of memory. Check the transcriber.", "Transcript ready: Meeting quiet."]);                // not public: no link
    assert.deepEqual(sent.slice(1).map((s) => s.priority), ["default", "high", "default"]);
    ops.transcripts([rec("working", "done"), rec("bad", "failed", { error: "again" })]);
    assert.equal(sent.length, 4);                                                                                 // nothing repeats
    ops.transcripts([{ slug: "n", title: "N", transcript: null, public: true }]);
    assert.equal(sent.length, 4);
  });

  it("it is remembered across restarts (the same database)", (t) => {
    const dir = tmpDir(t);
    const sent: string[] = [];
    const mk = () => { const db = openDb(path.join(dir, "x.db")); return { db, ops: new Ops(db, { notify: async (x) => { sent.push(x); }, site: "", titleOf: () => "T", platformOf: () => "Zoom" }) }; };
    let w = mk();
    w.ops.transcripts([]);                                                                                         // seeded
    w.ops.transcripts([rec("a", "done")]);
    w.db.close();
    w = mk();
    w.ops.transcripts([rec("a", "done"), rec("b", "done")]);
    w.db.close();
    assert.deepEqual(sent, ["Transcript ready: Meeting a.", "Transcript ready: Meeting b."]);
  });
});

describe("the scheduler's events", () => {
  function sched(t: TestContext, entryBody: string, o: { maxConcurrent?: number; leadMs?: number } = {}) {
    const out = mkdtempSync(path.join(os.tmpdir(), "minutes-ops-"));
    const entry = path.join(out, "fake-entry.mjs");
    writeFileSync(entry, entryBody);
    const db = openDb(path.join(out, "minutes.db"));
    const s = new Scheduler({ out, entry, auth: null, defaultName: "Recorder", leadMs: o.leadMs ?? 5 * 60_000, noShowMs: 30 * 60_000, maxConcurrent: o.maxConcurrent ?? 1, width: 1280, height: 720 }, db);
    // One hook, in this order: the scheduler writes to the folder while it shuts down.
    t.after(async () => { await s.shutdown(); db.close(); rmSync(out, { recursive: true, force: true }); });
    const events: { kind: string; slug: string; status: string; outcome?: string }[] = [];
    s.onEvent = (e) => events.push({ kind: e.kind, slug: e.job.slug, status: e.job.status, outcome: e.job.outcome });
    return { s, out, events };
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 150 && !f(); i++) await sleep(20); };
  // A fake capture: writes the manifest the real one would, then exits.
  const fake = (outcome: string, code: number) => `import { mkdirSync, writeFileSync } from "node:fs"; import path from "node:path";
    const a = process.argv; const get = (k) => a[a.indexOf(k) + 1];
    const dir = path.join(get("--out"), get("--slug")); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ outcome: ${JSON.stringify(outcome)} }));
    setTimeout(() => process.exit(${code}), 150);`;
  const soon = () => new Date(Date.now() + 2 * 60_000).toISOString();     // inside the lead time: due now

  it("started, then finished with the runner's outcome", async (t) => {
    const { s, events } = sched(t, fake("ended", 0));
    const j = s.add({ link: "https://www.youtube.com/watch?v=4xDzrJKXOOY", start: soon(), slug: "yt-one" });      // a stream job: no display needed
    s.start();
    await waitFor(() => events.some((e) => e.kind === "finished"));
    assert.deepEqual(events, [{ kind: "started", slug: "yt-one", status: "running", outcome: undefined }, { kind: "finished", slug: "yt-one", status: "done", outcome: "ended" }]);
    assert.equal(s.get(j.id)!.status, "done");
  });

  it("a capture that exits badly is finished/failed; a throwing listener can't hurt it", async (t) => {
    const { s, events } = sched(t, fake("blocked", 1));
    s.onEvent = (e) => { events.push({ kind: e.kind, slug: e.job.slug, status: e.job.status, outcome: e.job.outcome }); throw new Error("listener bug"); };
    s.add({ link: "https://www.youtube.com/watch?v=4xDzrJKXOOY", start: soon(), slug: "yt-two" });
    s.start();
    await waitFor(() => events.some((e) => e.kind === "finished"));
    assert.deepEqual(events.map((e) => [e.kind, e.status, e.outcome]), [["started", "running", undefined], ["finished", "failed", "blocked"]]);
  });

  it("a capture still waiting 10 minutes after its meeting started is overdue, once", async (t) => {
    const { s, events } = sched(t, fake("ended", 0), { maxConcurrent: 0 });                                         // no slot: it stays queued
    const j = s.add({ link: "https://www.youtube.com/watch?v=4xDzrJKXOOY", start: new Date(Date.now() + 60_000).toISOString(), slug: "yt-late" });
    s.start();
    await sleep(100);
    assert.equal(events.length, 0);                                                                                // due, but not late
    const row = (s as unknown as { jobs: Job[] }).jobs.find((x) => x.id === j.id)!;
    row.start = new Date(Date.now() - 11 * 60_000).toISOString();                                                   // time passes
    (s as unknown as { tick(): Promise<void> }).tick();
    await sleep(100);
    (s as unknown as { tick(): Promise<void> }).tick();
    await sleep(100);
    assert.deepEqual(events.map((e) => [e.kind, e.status]), [["overdue", "queued"]]);                              // once
  });
});

describe("the operator's email", () => {
  async function app(t: TestContext, extra: Record<string, unknown>) {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks = { after: (fn: () => unknown) => cleanups.push(fn) };
    const out = path.join(tmpDir(hooks), "rec");
    const r = await startApp(hooks, out, extra);
    fixtures(r.app, out);
    return { ...r, out };
  }

  it("with OPERATOR_EMAIL, every operator message also goes by email (login, backups and feeds too), not secret", async (t) => {
    const mailer = new MemoryMailer();
    await app(t, { mailer, operatorEmail: "ops@example.com", publicUrl: "https://minutes.example.org" });
    await notify(null, "Zoom login expired. Run minutes login before the next capture.", { priority: "high" });
    await notify(null, "minutes backup OK again.");
    assert.deepEqual(mailer.sent.map((m) => [m.to, m.subject]), [["ops@example.com", "minutes: Zoom login expired. Run minutes login before the next capture."], ["ops@example.com", "minutes: minutes backup OK again."]]);
    assert.match(mailer.sent[0].text, /\n-- \nminutes · https:\/\/minutes\.example\.org\nThis one needs a look\.\n$/);
    assert.doesNotMatch(mailer.sent[1].text, /needs a look/);
  });

  it("a transcript that finishes is emailed; without the setting nothing is sent; a mail failure is only logged", async (t) => {
    const mailer = new MemoryMailer();
    const { app: a, out } = await app(t, { mailer, operatorEmail: "ops@example.com", publicUrl: "https://minutes.example.org" });
    a.checkTranscripts();                                                                                          // the first look: records the existing ones
    assert.equal(mailer.sent.length, 0);
    const dir = path.join(out, "failed-d");
    writeFileSync(path.join(dir, "transcript.status.json"), JSON.stringify({ status: "failed", error: "CUDA out of memory" }));
    a.checkTranscripts();
    await sleep(50);
    assert.deepEqual(mailer.sent.map((m) => m.subject), ["minutes: Transcription FAILED: failed-d: CUDA out of memory. Check the transcriber."]);
    a.checkTranscripts(); await sleep(50);
    assert.equal(mailer.sent.length, 1);
    // No address configured: nothing goes anywhere (and nothing breaks).
    const quiet = new MemoryMailer();
    await app(t, { mailer: quiet });
    await notify(null, "nobody to tell");
    assert.equal(quiet.sent.length, 0);
    // A mailer that fails: logged, never thrown.
    const broken = { from: "x", send: async () => { throw new Error("smtp down"); } };
    await app(t, { mailer: broken, operatorEmail: "ops@example.com" });
    await assert.doesNotReject(notify(null, "hello"));
  });
});
