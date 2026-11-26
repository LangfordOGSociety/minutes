/**
 * #10/#11: what feed runs do to meetings and captures, through the real
 * server: change tracking, the suspect valve, policies, dedup, the review
 * queue, merge/split.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { slugify } from "../src/feeds/sync.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fakeSource } from "./fixtures.js";
import { Client, startApp } from "./server.js";

const ZOOM = "https://zoom.us/j/87093163922?pwd=429539";
const ZOOM2 = "https://zoom.us/j/81234567890?pwd=111222";
const at = (hoursFromNow: number) => new Date(Math.round((Date.now() + hoursFromNow * 3_600_000) / 60_000) * 60_000).toISOString();

async function setup(t: TestContext, policy: string) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const src = await fakeSource(hooks);
  const { app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { pollFeeds: false });
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
  const admin = new Client(base);
  await admin.login("admin@example.com", "admin password 1");
  const feed = (await admin.post("/api/admin/feeds", { name: "Langford", parser: "test-json", config: { url: src.url }, slugPrefix: "langford", policy })).json;
  const run = async () => {
    src.state.etag = String(Math.random());   // defeat the 304
    return (await admin.post(`/api/admin/feeds/${feed.id}/run`)).json.outcome;
  };
  const meetings = async (view = "upcoming") => (await admin.get(`/api/admin/meetings?view=${view}`)).json as any[];
  const byTitle = async (title: string) => (await meetings()).find((m) => m.title === title);
  return { app, admin, src, feed, run, meetings, byTitle };
}

describe("feed sync", () => {
  it("auto: schedules with a link, waits for one, lists past and cancelled; follows time and link changes", async (t) => {
    const { app, src, run, byTitle, admin, feed } = await setup(t, "auto");
    src.state.meetings = [
      { id: "m1", title: "Council Meeting", body: "Council Meeting", start: at(48), link: ZOOM },
      { id: "m2", title: "Committee of the Whole", body: "Committee of the Whole", start: at(72) },
      { id: "m3", title: "Last week", start: at(-24 * 7), link: ZOOM },
      { id: "m4", title: "Called off", start: at(96), link: ZOOM2, cancelled: true },
    ];
    const o1 = await run();
    assert.deepEqual([o1.status, o1.items, o1.changes], ["ok", 4, 4]);
    const m1 = await byTitle("Council Meeting");
    assert.equal(m1.capture.status, "scheduled");
    assert.match(m1.slug, /^langford-council-meeting-\d{4}-\d\d-\d\d$/);
    assert.equal(m1.link, "Zoom 87093163922");
    assert.equal((await byTitle("Committee of the Whole")).capture, null);
    assert.equal((await byTitle("Called off")).status, "cancelled");
    assert.equal((await byTitle("Called off")).capture, null);
    assert.equal(app.sched.list().length, 1);

    // Moved an hour later, a new link, and m2 gets its link.
    const later = at(49);
    src.state.meetings[0] = { ...src.state.meetings[0] as object, start: later, link: ZOOM2, title: "Council Meeting (rescheduled)" } as never;
    (src.state.meetings[1] as { link?: string }).link = ZOOM;
    const o2 = await run();
    assert.equal(o2.status, "ok");
    const job = app.sched.get(m1.capture.id)!;
    assert.equal(job.start, later);
    assert.equal(job.link, "https://zoom.us/j/81234567890?pwd=111222");
    assert.equal(job.status, "scheduled");
    assert.equal((await byTitle("Committee of the Whole")).capture.status, "scheduled");
    const hist = (await admin.get(`/api/admin/meetings/${m1.id}/changes`)).json;
    assert.deepEqual(hist.map((c: { kind: string }) => c.kind).sort(), ["added", "details_changed", "link_changed", "time_changed"]);
    assert.equal(hist.find((c: { kind: string }) => c.kind === "time_changed").effect, `capture ${m1.slug} moved`);
    assert.deepEqual(hist.find((c: { kind: string }) => c.kind === "link_changed").after, { link: "Zoom 81234567890" });
    // Nothing secret in the history or the lists.
    const feedChanges = (await admin.get(`/api/admin/feeds/${feed.id}/changes`)).text;
    assert.doesNotMatch(feedChanges + JSON.stringify(await admin.get("/api/admin/meetings")), /429539|111222/);

    // Same result again: unchanged, nothing new.
    src.state.etag = "x";
    assert.equal((await run()).status, "unchanged");

    // Cancelled: the capture goes. Back on: a new one.
    (src.state.meetings[0] as { cancelled?: boolean }).cancelled = true;
    await run();
    assert.equal(app.sched.get(m1.capture.id)!.status, "cancelled");
    assert.equal((await byTitle("Council Meeting (rescheduled)")).status, "cancelled");
    (src.state.meetings[0] as { cancelled?: boolean }).cancelled = false;
    await run();
    const back = await byTitle("Council Meeting (rescheduled)");
    assert.equal(back.status, "scheduled");
    assert.equal(back.capture.status, "scheduled");
    assert.equal(back.capture.slug, `${m1.slug}-2`);
  });

  it("removed meetings are only flagged; a run losing most of them is suspect and applies nothing", async (t) => {
    const { app, src, run, byTitle, feed, admin } = await setup(t, "auto");
    src.state.meetings = [
      { id: "a", title: "A", start: at(24), link: ZOOM },
      { id: "b", title: "B", start: at(48) },
      { id: "c", title: "C", start: at(72) },
    ];
    await run();
    const a = await byTitle("A");
    // One of three gone: flagged, the capture stays.
    src.state.meetings = src.state.meetings.filter((m) => (m as { id: string }).id !== "a");
    assert.equal((await run()).status, "ok");
    const a2 = await byTitle("A");
    assert.ok(a2.removedAt);
    assert.equal(app.sched.get(a.capture.id)!.status, "scheduled");
    // The parser breaks and returns nothing: suspect, nothing applied, retried next time.
    src.state.meetings = [];
    const o = await run();
    assert.equal(o.status, "suspect");
    assert.match(o.note, /would remove 2 of 2 upcoming meetings/);
    assert.equal((await byTitle("B")).removedAt, null);
    const f = (await admin.get("/api/admin/feeds")).json.feeds.find((x: { id: string }) => x.id === feed.id);
    assert.equal(f.runs[0].status, "suspect");
    assert.equal((await run()).status, "suspect");   // not "unchanged": a suspect result isn't accepted
    // A back: returned.
    src.state.meetings = [{ id: "a", title: "A", start: at(24), link: ZOOM }, { id: "b", title: "B", start: at(48) }, { id: "c", title: "C", start: at(72) }];
    await run();
    assert.equal((await byTitle("A")).removedAt, null);
  });

  it("review: new meetings wait; approve schedules, reject never; audited", async (t) => {
    const { app, src, run, meetings, admin } = await setup(t, "review");
    src.state.meetings = [
      { id: "r1", title: "Council", start: at(48), link: ZOOM },
      { id: "r2", title: "Board", start: at(50), link: ZOOM2 },
      { id: "r3", title: "Committee", start: at(52) },
    ];
    await run();
    const queue = await meetings("review");
    assert.equal(queue.length, 3);
    assert.equal(app.sched.list().length, 0);
    const [r1, r2, r3] = ["Council", "Board", "Committee"].map((t) => queue.find((m: { title: string }) => m.title === t));
    const ok = await admin.post(`/api/admin/meetings/${r1.id}/approve`);
    assert.equal(ok.json.meeting.capture.status, "scheduled");
    assert.equal((await admin.post(`/api/admin/meetings/${r2.id}/reject`)).json.meeting.review, "rejected");
    assert.match((await admin.post(`/api/admin/meetings/${r3.id}/approve`)).json.effect, /once a link is published/);
    assert.equal((await meetings("review")).length, 0);
    // r3's link arrives later: approved, so it's captured; r2's link changes: still rejected.
    (src.state.meetings[2] as { link?: string }).link = "https://zoom.us/j/89999999999";
    (src.state.meetings[1] as { link?: string }).link = ZOOM;
    await run();
    assert.equal((await meetings()).find((m: { id: string }) => m.id === r3.id).capture.status, "scheduled");
    assert.equal((await meetings()).find((m: { id: string }) => m.id === r2.id).capture, null);
    assert.deepEqual(app.audit.list({ action: "meeting" }).map((e) => e.action), ["meeting.approve", "meeting.reject", "meeting.approve"]);
  });

  it("list_only never captures", async (t) => {
    const { app, src, run, meetings } = await setup(t, "list_only");
    src.state.meetings = [{ id: "l1", title: "Council", start: at(48), link: ZOOM }];
    await run();
    assert.equal((await meetings()).length, 1);
    assert.equal(app.sched.list().length, 0);
  });

  it("dedup: same link as a hand-scheduled capture, or same body within 15 min; merge and split", async (t) => {
    const { app, src, run, byTitle, admin } = await setup(t, "auto");
    const start = at(48);
    const manual = app.sched.add({ link: ZOOM, start, slug: "council-by-hand" });
    src.state.meetings = [
      { id: "d1", title: "Council Meeting", body: "Council Meeting", start: at(48 + 0.1), link: ZOOM },
      { id: "d2", title: "Committee", body: "Committee", start: at(72), link: ZOOM2 },
    ];
    await run();
    const d1 = await byTitle("Council Meeting");
    assert.equal(d1.duplicateOf.slug, "council-by-hand");
    assert.equal(d1.capture, null);
    assert.equal(app.sched.list().filter((j) => j.status === "scheduled").length, 2);   // the manual one and d2

    // A second feed reports the committee 10 min later under the same body.
    const src2 = await fakeSource({ after: (fn) => t.after(fn as () => void) });
    src2.state.meetings = [{ id: "y1", title: "Committee (YouTube)", body: "committee", start: at(72 + 1 / 6) }];
    const f2 = (await admin.post("/api/admin/feeds", { name: "YouTube", parser: "test-json", config: { url: src2.url }, slugPrefix: "yt", policy: "auto" })).json;
    await admin.post(`/api/admin/feeds/${f2.id}/run`);
    const y1 = await byTitle("Committee (YouTube)");
    assert.equal(y1.duplicateOf.title, "Committee");

    // Split it, then merge it back by hand.
    const s = await admin.post(`/api/admin/meetings/${y1.id}/split`);
    assert.equal(s.json.meeting.duplicateOf, null);
    const d2 = await byTitle("Committee");
    const m = await admin.post(`/api/admin/meetings/${y1.id}/merge`, { into: d2.id });
    assert.equal(m.json.meeting.duplicateOf.id, d2.id);
    assert.equal((await admin.post(`/api/admin/meetings/${y1.id}/merge`, { into: y1.id })).status, 409);
    assert.ok(manual);
  });

  it("preview shows what would change, saving nothing", async (t) => {
    const { app, src, admin, feed } = await setup(t, "auto");
    src.state.meetings = [{ id: "p1", title: "Council", start: at(48), link: ZOOM }];
    const pv = await admin.post("/api/admin/feeds/preview", { parser: "test-json", config: { url: src.url }, feedId: feed.id });
    assert.deepEqual(pv.json.changes.changes.map((c: { kind: string; effect: string }) => [c.kind, c.effect]), [["added", "capture scheduled"]]);
    assert.equal(app.sched.meetings.list().length, 0);
    assert.equal(app.sched.list().length, 0);
  });

  it("slugs", () => {
    assert.equal(slugify("Parks, Recreation & Culture Committee"), "parks-recreation-and-culture-committee");
    assert.equal(slugify("Séance du conseil"), "seance-du-conseil");
    assert.equal(slugify("!!!"), "meeting");
  });
});
