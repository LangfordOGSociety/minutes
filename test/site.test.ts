/**
 * Phase 3: the public site's meetings API (/api/meetings, /api/changes,
 * /m/:slug): stages, visibility, filters, the public history, and that
 * nothing secret is in any of it.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Job } from "../src/jobs.js";
import type { Meeting } from "../src/meetings.js";
import type { Recording } from "../src/recordings.js";
import { embedAncestors } from "../src/net.js";
import { isUpcoming, stageOf, visible, type PublicMeeting } from "../src/site.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fakeSource, fixtures } from "./fixtures.js";
import { Client, startApp } from "./server.js";

const H = 3_600_000;
const NOW = Date.parse("2026-12-08T20:00:00Z");
const meeting = (o: Partial<Meeting> = {}): Meeting => ({ id: "m", title: "Council", platform: "zoom", link: "", start: new Date(NOW + 24 * H).toISOString(),
  status: "scheduled", visibility: "public", slug: "council", createdAt: "", updatedAt: "", ...o });
const job = (status: Job["status"], o: Partial<Job> = {}): Job => ({ id: "j", meetingRef: "m", link: "", start: "", slug: "council", name: "", status, createdAt: "", ...o });
const rec = (o: Partial<Recording> = {}): Recording => ({ slug: "council", title: "", public: true, scheduledStart: null, outcome: "", active: false, video: null,
  videoBytes: null, duration: null, parts: [], chapters: [], transcript: null, files: {}, ...o });

describe("stages", () => {
  const at = (hours: number) => new Date(NOW + hours * H).toISOString();
  it("upcoming, live, processing, video, ready, failed, not recorded, cancelled", () => {
    assert.equal(stageOf(meeting(), [], undefined, NOW), "upcoming");                                      // listed only, tomorrow
    assert.equal(stageOf(meeting({ start: at(1) }), [job("scheduled")], undefined, NOW), "upcoming");
    assert.equal(stageOf(meeting({ start: at(-1) }), [job("running")], rec({ active: true }), NOW), "live");
    assert.equal(stageOf(meeting({ start: at(-1) }), [job("stopping")], undefined, NOW), "live");
    // An import of a finished video (a Granicus clip) is being processed, not a meeting in progress, whatever its date.
    assert.equal(stageOf(meeting({ start: at(-72) }), [job("running", { link: "https://saanich.ca.granicus.com/player/clip/1356" })], rec({ active: true }), NOW), "stitching");
    assert.equal(stageOf(meeting({ start: at(-3) }), [job("done", { endedAt: at(-0.5) })], undefined, NOW), "stitching");
    assert.equal(stageOf(meeting({ start: at(-3) }), [job("done", { endedAt: at(-0.5) })], rec({ video: "council.mp4" }), NOW), "video_ready");
    assert.equal(stageOf(meeting({ start: at(-3) }), [job("done")], rec({ video: "council.mp4", files: { transcript: "council.transcript.json" } }), NOW), "ready");
    assert.equal(stageOf(meeting({ start: at(-30) }), [job("done", { endedAt: at(-27) })], undefined, NOW), "failed");   // never stitched
    assert.equal(stageOf(meeting({ start: at(-2) }), [job("failed")], rec(), NOW), "failed");
    assert.equal(stageOf(meeting({ start: at(-30) }), [], undefined, NOW), "not_recorded");                // listed, never captured
    assert.equal(stageOf(meeting({ start: at(-30) }), [job("scheduled")], undefined, NOW), "not_recorded");
    assert.equal(stageOf(meeting({ start: at(-2) }), [], undefined, NOW), "upcoming");                      // happening now, not ours
    assert.equal(stageOf(meeting({ status: "cancelled", start: at(5) }), [], undefined, NOW), "cancelled");
    // A retry after a failure: the video of whichever attempt has one.
    assert.equal(stageOf(meeting({ start: at(-3) }), [job("failed"), job("done")], rec({ video: "council-2.mp4" }), NOW), "video_ready");
  });

  it("who is shown, and which section", () => {
    assert.equal(visible(meeting()), true);
    for (const o of [{ visibility: "hidden" as const }, { duplicateOf: "x" }, { review: "pending" as const }, { review: "rejected" as const }]) {
      assert.equal(visible(meeting(o)), false, JSON.stringify(o));
    }
    assert.equal(visible(meeting({ review: "approved" })), true);
    const p = (stage: PublicMeeting["stage"], hours: number) => ({ stage, start: at(hours) }) as PublicMeeting;
    assert.equal(isUpcoming(p("upcoming", 2), NOW), true);
    assert.equal(isUpcoming(p("live", -1), NOW), true);
    assert.equal(isUpcoming(p("cancelled", 5), NOW), true);     // cancelled but not yet past: stays visible up top
    assert.equal(isUpcoming(p("cancelled", -48), NOW), false);
    assert.equal(isUpcoming(p("ready", -1), NOW), false);
  });
});

async function setup(t: TestContext) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const src = await fakeSource(hooks);
  const out = path.join(tmpDir(hooks), "rec");
  const { app, base } = await startApp(hooks, out, { pollFeeds: false });
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
  const admin = new Client(base);
  await admin.login("admin@example.com", "admin password 1");
  const pub = new Client(base);
  const mk = async (policy: string) => (await admin.post("/api/admin/feeds", { name: "Langford", parser: "test-json", config: { url: src.url }, slugPrefix: "langford", policy })).json;
  const run = async (feed: { id: string }) => {
    src.state.etag = String(Math.random());
    return (await admin.post(`/api/admin/feeds/${feed.id}/run`)).json.outcome;
  };
  return { app, out, admin, pub, src, mk, run, base };
}

const ZOOM = "https://zoom.us/j/87093163922?pwd=429539";
const at = (hoursFromNow: number) => new Date(Math.round((Date.now() + hoursFromNow * H) / 60_000) * 60_000).toISOString();

describe("public meetings API", () => {
  it("lists meetings and their stage, never the join link; review and hidden are not public", async (t) => {
    const { admin, pub, src, mk, run } = await setup(t);
    const feed = await mk("review");
    src.state.meetings = [
      { id: "a", title: "Council Meeting", body: "Council", start: at(48), link: ZOOM, agendaUrl: "https://city.example/agenda/1",
        streamUrl: "https://city.example/video/1", documents: [{ title: "Agenda", type: "Agenda", url: "https://city.example/agenda/1" }, { title: "Evil", url: "javascript:alert(1)" }] },
      { id: "b", title: "Committee of the Whole", body: "Committee", start: at(72), link: ZOOM },
      { id: "c", title: "Last month", body: "Council", start: at(-24 * 30) },
      { id: "d", title: "Called off", body: "Council", start: at(96), cancelled: true },
    ];
    await run(feed);
    // Nothing is public until reviewed (the cancelled and past ones need no review).
    let up = (await pub.get("/api/meetings?scope=upcoming")).json;
    assert.deepEqual(up.meetings.map((m: { title: string }) => m.title), ["Called off"]);
    const all = (await admin.get("/api/admin/meetings?view=review")).json as { id: string; title: string }[];
    assert.deepEqual(all.map((m) => m.title).sort(), ["Committee of the Whole", "Council Meeting"]);
    const council = all.find((m) => m.title === "Council Meeting")!, cttee = all.find((m) => m.title === "Committee of the Whole")!;
    assert.equal((await admin.post(`/api/admin/meetings/${council.id}/approve`)).status, 200);

    up = (await pub.get("/api/meetings?scope=upcoming")).json;
    assert.deepEqual(up.meetings.map((m: { title: string }) => m.title), ["Council Meeting", "Called off"]);
    const c = up.meetings[0];
    assert.deepEqual(Object.keys(c).sort(), ["agendaUrl", "body", "cancelled", "documents", "duration", "end", "hasTranscript", "hasVideo", "id", "join", "live", "pageUrl", "poster", "source", "stage", "start", "streamUrl", "title"]);
    assert.deepEqual([c.stage, c.body, c.agendaUrl, c.streamUrl], ["upcoming", "Council", "https://city.example/agenda/1", "https://city.example/video/1"]);
    assert.deepEqual(c.documents, [{ title: "Agenda", type: "Agenda", url: "https://city.example/agenda/1", copy: null }]);   // not the javascript: URL
    assert.equal(up.meetings[1].stage, "cancelled");
    assert.deepEqual(up.bodies, ["Council"]);                                    // "Committee" isn't public yet

    const past = (await pub.get("/api/meetings?scope=past")).json;
    assert.deepEqual(past.meetings.map((m: { title: string }) => m.title), ["Last month"]);
    assert.equal(past.meetings[0].stage, "not_recorded");

    // The admin hides one: its page, listing and history 404; showing it brings it back.
    assert.equal((await admin.post(`/api/admin/meetings/${council.id}/hide`)).json.effect, "hidden from the public site");
    assert.deepEqual((await pub.get("/api/meetings?scope=upcoming")).json.meetings.map((m: { title: string }) => m.title), ["Called off"]);
    assert.equal((await pub.get(`/api/meetings/${council.id}`)).status, 404);
    assert.equal((await admin.post(`/api/admin/meetings/${council.id}/show`)).status, 200);
    assert.equal((await admin.post(`/api/admin/meetings/${cttee.id}/reject`)).status, 200);
    assert.equal((await pub.get("/api/meetings?scope=upcoming")).json.meetings.length, 2);    // rejected stays out

    // Not one secret anywhere in what the public gets.
    const text = [(await pub.get("/api/meetings?scope=upcoming")).text, (await pub.get("/api/meetings?scope=past")).text, (await pub.get("/api/changes")).text].join("\n");
    assert.doesNotMatch(text, /429539|pwd|feed|link|externalId|capture/i);
    // What it does show of a feed meeting that hasn't happened: how to join, from the number alone.
    const ups = (await pub.get("/api/meetings?scope=upcoming")).json.meetings as { title: string; join: unknown }[];
    assert.deepEqual(ups.find((m) => m.title === "Called off")!.join, null);
    for (const m of ups.filter((x) => x.join)) assert.deepEqual(m.join, { platform: "Zoom", id: "870 9316 3922", url: "https://zoom.us/j/87093163922" });
    assert.ok(ups.some((m) => m.join), "an upcoming feed meeting with a link has a join link");
    assert.doesNotMatch(JSON.stringify(ups), /87093163922\?|\?pwd/);
  });

  it("the meeting's page data, its history, and /m/:slug", async (t) => {
    const { admin, pub, src, mk, run } = await setup(t);
    const feed = await mk("auto");
    src.state.meetings = [{ id: "a", title: "Council Meeting", body: "Council", start: at(48), link: ZOOM,
      documents: [{ title: "Agenda", type: "Agenda", url: "https://city.example/a.pdf" }] }];
    await run(feed);
    const m = (await admin.get("/api/admin/meetings")).json[0];
    // Moved a day, a new document, then cancelled; an internal link change must not appear.
    src.state.meetings = [{ id: "a", title: "Council Meeting", body: "Council", start: at(72), link: "https://zoom.us/j/81234567890?pwd=1",
      documents: [{ title: "Agenda", type: "Agenda", url: "https://city.example/a.pdf" }, { title: "Staff report", url: "https://city.example/r.pdf" }] }];
    await run(feed);
    src.state.meetings = [{ ...src.state.meetings[0] as object, cancelled: true } as never];
    await run(feed);

    const d = (await pub.get(`/api/meetings/${m.slug}`)).json;
    assert.deepEqual([d.id, d.stage, d.recording, d.startedAt], [m.slug, "cancelled", null, null]);
    assert.deepEqual(d.history.map((c: { kind: string }) => c.kind), ["cancelled", "document_added", "date_changed", "added"]);
    const moved = d.history.find((c: { kind: string }) => c.kind === "date_changed");
    assert.ok(moved.from && moved.to && moved.from !== moved.to);
    assert.equal(d.history.find((c: { kind: string }) => c.kind === "document_added").doc.title, "Staff report");
    assert.doesNotMatch(JSON.stringify(d), /link_changed|429539|81234567890|87093163922|zoom/);
    assert.equal((await pub.get(`/api/meetings/${m.slug}/status`)).json.stage, "cancelled");
    assert.equal((await pub.get("/api/meetings/nope")).status, 404);
    assert.equal((await pub.get("/api/meetings/nope/status")).status, 404);

    // The page: same shell for every meeting, with its own title; 404 for an unknown or hidden one.
    const page = await pub.get(`/m/${m.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Council Meeting \(\w+ \d+, \d{4}\)<\/title>/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'sha256-/);
    assert.equal((await pub.get("/m/nope")).status, 404);
    assert.equal((await pub.get("/m/..%2Fadmin")).status, 404);
    await admin.post(`/api/admin/meetings/${m.id}/hide`);
    assert.equal((await pub.get(`/m/${m.slug}`)).status, 404);
  });

  it("recent changes skip history imports and internal changes; filters and paging", async (t) => {
    const { admin, pub, src, mk, run } = await setup(t);
    const feed = await mk("auto");
    src.state.meetings = [
      { id: "old", title: "Old one", body: "Council", start: at(-24 * 40) },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, title: `Past ${i}`, body: i % 2 ? "Committee" : "Council", start: at(-24 * (i + 1)) })),
      { id: "new", title: "Next council", body: "Council", start: at(24) },
    ];
    await run(feed);
    assert.deepEqual((await pub.get("/api/changes")).json.map((c: { meeting: { title: string } }) => c.meeting.title), ["Next council"]);   // not the 31 listed after the fact

    const page1 = (await pub.get("/api/meetings?scope=past&limit=10")).json;
    assert.deepEqual([page1.meetings.length, page1.total], [10, 31]);
    assert.equal(page1.meetings[0].title, "Past 0");                             // newest first
    const page2 = (await pub.get("/api/meetings?scope=past&limit=10&offset=10")).json;
    assert.equal(page2.meetings[0].title, "Past 10");
    assert.deepEqual((await pub.get("/api/meetings?scope=past&body=committee&limit=200")).json.total, 15);
    assert.deepEqual((await pub.get("/api/meetings?scope=past&q=PAST%201&limit=200")).json.meetings.length, 11);   // Past 1, Past 10-19
    // Dates are local days, both ends inclusive.
    const day = (h: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date(Date.now() + h * H));
    const one = (await pub.get(`/api/meetings?scope=past&from=${day(-24 * 5)}&to=${day(-24 * 3)}&limit=200`)).json;
    assert.ok(one.total >= 3 && one.total <= 4, String(one.total));
    assert.equal((await pub.get("/api/meetings?scope=past&from=nonsense&limit=abc&offset=-5")).status, 200);   // bad params fall back
    assert.equal((await admin.get("/api/meetings")).status, 200);
  });

  it("recordings: ready with a video and transcript, hidden ones 404 for files too", async (t) => {
    const { app, out, admin, pub } = await setup(t);
    fixtures(app, out);
    const list = (await pub.get("/api/meetings?scope=past&limit=50")).json.meetings as { id: string; stage: string; hasVideo: boolean; hasTranscript: boolean; duration: number | null }[];
    const a = list.find((m) => m.id === "council-a")!;
    assert.deepEqual([a.stage, a.hasVideo, a.hasTranscript, a.duration], ["ready", true, true, 2760]);
    assert.ok(!list.some((m) => m.id === "hidden-b"));
    const d = (await pub.get("/api/meetings/council-a")).json;
    assert.equal(d.recording.video, "council-a.mp4");
    assert.deepEqual(Object.keys(d.recording).sort(), ["active", "chapters", "duration", "files", "scheduledStart", "slug", "title", "transcript", "video", "videoBytes"]);
    // A shared link with the recording's folder name still finds the meeting.
    assert.equal((await pub.get("/api/meetings/council-a/status")).json.stage, "ready");
    assert.equal((await pub.get("/media/council-a/council-a.mp4")).status, 200);
    assert.equal((await pub.get("/media/hidden-b/hidden-b.mp4")).status, 404);
    assert.equal((await pub.get("/api/meetings/hidden-b")).status, 404);
    assert.equal((await pub.get("/m/hidden-b")).status, 404);
    assert.doesNotMatch(JSON.stringify(d), /429539|87093163922|manifest|capture\.log/);
    // Pulled from the public site: the files go too (the existing rule).
    const mid = app.sched.list().find((j) => j.slug === "council-a")!.meetingRef;
    assert.equal((await admin.post(`/api/admin/meetings/${mid}/hide`)).status, 200);
    assert.equal((await pub.get("/media/council-a/council-a.mp4")).status, 404);
  });
});

describe("permalinks, embeds and oEmbed", () => {
  it("who may frame what: EMBED_ORIGINS", () => {
    assert.equal(embedAncestors(undefined), "*");
    assert.equal(embedAncestors("  "), "*");
    assert.equal(embedAncestors("*"), "*");
    assert.equal(embedAncestors("none"), "'none'");
    assert.equal(embedAncestors("https://openlangford.ca, https://*.example.org:8443"), "https://openlangford.ca https://*.example.org:8443");
    for (const bad of ["openlangford.ca", "https://x.ca/path", "javascript:alert(1)", "https://x.ca; script-src *", "'self'"]) {
      assert.throws(() => embedAncestors(bad), /EMBED_ORIGINS/, bad);
    }
  });

  it("/embed/<slug> may be framed; every other page may not; hidden and unknown 404", async (t) => {
    const { app, out, admin, pub } = await setup(t);
    fixtures(app, out);
    const e = await pub.get("/embed/council-a");
    assert.equal(e.status, 200);
    assert.equal(e.headers.get("x-frame-options"), null);
    assert.match(e.headers.get("content-security-policy") ?? "", /frame-ancestors \*(;|$)/);
    assert.match(e.headers.get("content-security-policy") ?? "", /script-src 'sha256-[A-Za-z0-9+/=]{44}'(;|$)/);
    assert.match(e.text, /<title>council-a<\/title>/);
    assert.match(e.text, /var SLUG = "council-a";/);
    assert.doesNotMatch(e.text, /api\/admin|renderMe\(document|429539|87093163922/);       // no sign-in, no admin
    for (const p of ["/", "/m/council-a", "/login", "/admin"]) {
      const r = await admin.get(p);
      assert.equal(r.headers.get("x-frame-options"), "DENY", p);
      assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, p);
    }
    assert.equal((await pub.get("/embed/hidden-b")).status, 404);
    assert.equal((await pub.get("/embed/nope")).status, 404);
    assert.equal((await pub.get("/embed/..%2Fadmin")).status, 404);
    // Pulled from the public site: the embed goes with it.
    const mid = app.sched.list().find((j) => j.slug === "council-a")!.meetingRef;
    await admin.post(`/api/admin/meetings/${mid}/hide`);
    assert.equal((await pub.get("/embed/council-a")).status, 404);
  });

  it("EMBED_ORIGINS limits who may frame it", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const out = path.join(tmpDir(hooks), "rec");
    const { app, base } = await startApp(hooks, out, { embedOrigins: "https://openlangford.ca https://*.example.org" });
    fixtures(app, out);
    const r = await new Client(base).get("/embed/council-a");
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/openlangford\.ca https:\/\/\*\.example\.org$/);
    assert.equal(r.headers.get("x-frame-options"), null);
    const none = await startApp(hooks, path.join(tmpDir(hooks), "rec2"), { embedOrigins: "none" });
    fixtures(none.app, path.join(tmpDir(hooks), "x"));
  });

  it("the meeting page's metadata: canonical, previews and oEmbed discovery, escaped", async (t) => {
    const { app, out, pub, admin, src, mk, run } = await setup(t);
    fixtures(app, out);
    // Without PUBLIC_URL: the request's own address; titles are plain text in the head.
    const p = await pub.get("/m/council-a");
    assert.match(p.text, /<meta property="og:title" content="council-a \(\w+ \d+, \d{4}\)">/);
    assert.match(p.text, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/m\/council-a">/);
    assert.match(p.text, /<link rel="alternate" type="application\/json\+oembed" href="http:\/\/127\.0\.0\.1:\d+\/oembed\?format=json&#38;url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fm%2Fcouncil-a"/);
    assert.match(p.text, /Share/);
    // A hostile title can't break out of any attribute or the page.
    const feed = await mk("auto");
    src.state.meetings = [{ id: "x", title: 'Evil "><img src=x onerror=alert(1)><script>alert(2)</script>', start: at(24) }];
    await run(feed);
    const m = (await admin.get("/api/admin/meetings")).json.find((x: { title: string }) => x.title.startsWith("Evil"));
    const e = await pub.get(`/m/${m.slug}`);
    assert.equal(e.status, 200);
    assert.doesNotMatch(e.text, /<img src=x|<script>alert\(2\)|"><img/);
    assert.match(e.text, /&#34;&#62;&#60;img src=x/);
    const d = (await pub.get(`/oembed?url=${encodeURIComponent("http://x/m/" + m.slug)}`)).json;
    assert.doesNotMatch(d.html, /<img|"><script/);
  });

  it("oEmbed, absolute when PUBLIC_URL is set", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const out = path.join(tmpDir(hooks), "rec");
    const { app, base } = await startApp(hooks, out, { publicUrl: "https://minutes.example.org/" });
    fixtures(app, out);
    const c = new Client(base);
    const r = await c.get(`/oembed?url=${encodeURIComponent("https://minutes.example.org/m/council-a")}&format=json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual([r.json.version, r.json.type, r.json.provider_name, r.json.title, r.json.width, r.json.height],
      ["1.0", "video", "minutes", "council-a", 640, 360]);
    assert.equal(r.json.html, '<iframe src="https://minutes.example.org/embed/council-a" width="640" height="360" frameborder="0" allow="fullscreen" allowfullscreen title="council-a"></iframe>');
    assert.equal((await c.get(`/oembed?url=${encodeURIComponent("/embed/council-a")}&maxwidth=320`)).json.height, 180);
    assert.equal((await c.get(`/oembed?url=${encodeURIComponent("/m/council-a")}&format=xml`)).status, 501);
    for (const bad of ["", "/m/nope", "/m/hidden-b", "/admin", "/m/council-a/extra", "javascript:alert(1)"]) {
      assert.equal((await c.get(`/oembed?url=${encodeURIComponent(bad)}`)).status, 404, bad);
    }
    const page = await c.get("/m/council-a");
    assert.match(page.text, /<link rel="canonical" href="https:\/\/minutes\.example\.org\/m\/council-a">/);
    assert.doesNotMatch(page.text, /127\.0\.0\.1/);
  });
});
