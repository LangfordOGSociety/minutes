/**
 * #8/#9: feed types, store, context, poller, and the admin API, with a
 * fake parser that reads JSON from a local server.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb } from "../src/db.js";
import { feedContext } from "../src/feeds/context.js";
import { Poller, healthOf, resultHash } from "../src/feeds/poller.js";
import { Feeds } from "../src/feeds/store.js";
import { localDate, zonedTime } from "../src/feeds/time.js";
import type { DetectedMeeting } from "../src/feeds/types.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";
import { fakeSource } from "./fixtures.js";



describe("feed time", () => {
  it("local wall time to UTC, including BC's permanent UTC-7 from Nov 2026", () => {
    assert.equal(zonedTime("America/Vancouver", 2026, 7, 1, 12, 0).toISOString(), "2026-07-01T19:00:00.000Z");
    assert.equal(zonedTime("America/Vancouver", 2026, 12, 8, 17, 30).toISOString(), "2026-12-09T00:30:00.000Z");
    assert.equal(zonedTime("America/Toronto", 2027, 1, 15, 19, 0).toISOString(), "2027-01-16T00:00:00.000Z");
    assert.equal(localDate(new Date("2026-12-09T00:30:00Z"), "America/Vancouver"), "2026-12-08");
  });
});

describe("feed store and context", () => {
  it("validates feeds; a new source drops cached validators", (t) => {
    const db = openDb(path.join(tmpDir(t), "minutes.db"));
    t.after(() => db.close());
    const feeds = new Feeds(db);
    const ok = { name: "Langford", parser: "test-json", config: { url: "https://example.com/a" }, slugPrefix: "Langford" };
    assert.throws(() => feeds.create({ ...ok, parser: "nope" }), /unknown parser/);
    assert.throws(() => feeds.create({ ...ok, config: { url: "ftp://x" } }), /url: must be/);
    assert.throws(() => feeds.create({ ...ok, slugPrefix: "../x" }), /folder prefix/);
    assert.throws(() => feeds.create({ ...ok, policy: "yolo" }), /policy/);
    assert.throws(() => feeds.create({ ...ok, intervalMin: 1 }), /interval/);
    const f = feeds.create(ok);
    assert.equal(f.slugPrefix, "langford");
    assert.equal(f.policy, "review");
    feeds.save({ ...f, httpCache: { "https://example.com/a": { etag: "x" } }, lastHash: "h" });
    assert.equal(feeds.update(f.id, { name: "Renamed" }).lastHash, "h");
    const g = feeds.update(f.id, { config: { url: "https://example.com/b" } });
    assert.deepEqual(g.httpCache, {});
    assert.equal(g.lastHash, null);
  });

  it("http: user agent, conditional GET, errors, size cap, http(s) only", async (t) => {
    const src = await fakeSource(t);
    const ctx = feedContext({ tz: "UTC", label: "t" });
    const a = await ctx.http(src.url, { conditional: true });
    assert.equal(a.status, 200);
    const b = await ctx.http(src.url, { conditional: true });
    assert.equal(b.notModified, true);
    await assert.rejects(ctx.http(src.url.replace("/feed", "/big")), /larger than/);
    await assert.rejects(ctx.http("file:///etc/passwd"), /not http/);
    src.state.fail = true;
    await assert.rejects(ctx.http(src.url), /HTTP 500/);
  });
});

describe("poller", () => {
  const H = 3_600_000;
  function setup(t: HasAfter) {
    const db = openDb(path.join(tmpDir(t), "minutes.db"));
    t.after(() => db.close());
    const feeds = new Feeds(db);
    const poller = new Poller(feeds, { tz: "America/Vancouver", random: () => 0.5 });
    return { feeds, poller };
  }

  it("runs, then skips unchanged content (304, same result), records runs", async (t) => {
    const src = await fakeSource(t);
    const { feeds, poller } = setup(t);
    src.state.meetings = [{ id: "m1", title: "Council", start: "2027-01-12T01:30:00Z" }];
    const f = feeds.create({ name: "F", parser: "test-json", config: { url: src.url }, slugPrefix: "f", intervalMin: 60 });
    const now = new Date("2026-12-01T12:00:00Z");
    assert.deepEqual(await poller.run(f.id, "manual", now), { status: "ok", items: 1, changes: null, error: null });
    let g = feeds.get(f.id)!;
    assert.equal(g.lastHash, resultHash([{ externalId: "m1", title: "Council", start: new Date("2027-01-12T01:30:00Z") } as DetectedMeeting]));
    assert.equal(g.failures, 0);
    assert.ok(g.lastOkAt);
    assert.equal(g.nextRunAt && Date.parse(g.nextRunAt) - Date.parse(g.lastRunAt!), 60 * 60_000);   // jitter 0.5 -> exactly 1.0x
    assert.equal((await poller.run(f.id, "manual", now)).status, "not_modified");
    src.state.etag = "v2";                     // new ETag, same content
    assert.equal((await poller.run(f.id, "manual", now)).status, "unchanged");
    assert.deepEqual(feeds.runs(f.id).map((r) => r.status), ["unchanged", "not_modified", "ok"]);
  });

  it("backs off on errors up to 6h, and turns unhealthy after 24h", async (t) => {
    const src = await fakeSource(t);
    const { feeds, poller } = setup(t);
    src.state.fail = true;
    const f = feeds.create({ name: "F", parser: "test-json", config: { url: src.url }, slugPrefix: "f", intervalMin: 60 },
      new Date("2026-12-01T00:00:00Z"));
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out = await poller.run(f.id, "schedule", new Date("2026-12-01T12:00:00Z"));
      assert.equal(out.status, "error");
      assert.match(out.error!, /HTTP 500/);
      const g = feeds.get(f.id)!;
      gaps.push(Math.round((Date.parse(g.nextRunAt!) - Date.parse(g.lastRunAt!)) / 60_000));
    }
    assert.deepEqual(gaps, [120, 240, 360, 360]);
    const g = feeds.get(f.id)!;
    assert.equal(g.failures, 4);
    assert.equal(healthOf(g, new Date("2026-12-01T12:00:00Z")), "failing");
    assert.equal(healthOf(g, new Date(Date.parse("2026-12-02T00:00:00Z") + 1)), "unhealthy");
    src.state.fail = false;
    src.state.meetings = [];
    assert.equal((await poller.run(f.id, "manual")).status, "ok");
    assert.equal(healthOf(feeds.get(f.id)!), "ok");
  });

  it("checks every 5 minutes on a meeting day", async (t) => {
    const src = await fakeSource(t);
    const { feeds, poller } = setup(t);
    const now = new Date("2026-12-08T18:00:00Z");   // 11:00 in Vancouver
    src.state.meetings = [{ id: "m1", title: "Council", start: "2026-12-09T00:30:00Z" }];   // 17:30 the same day
    const f = feeds.create({ name: "F", parser: "test-json", config: { url: src.url }, slugPrefix: "f", intervalMin: 60 });
    await poller.run(f.id, "manual", now);
    const g = feeds.get(f.id)!;
    assert.equal(Math.round((Date.parse(g.nextRunAt!) - Date.parse(g.lastRunAt!)) / 60_000), 5);
  });

  it("one run per host at a time; due feeds only", async (t) => {
    const src = await fakeSource(t);
    src.state.delayMs = 300;
    const { feeds, poller } = setup(t);
    const now = new Date(Date.now() + H);
    feeds.create({ name: "A", parser: "test-json", config: { url: src.url }, slugPrefix: "a" });
    feeds.create({ name: "B", parser: "test-json", config: { url: src.url + "?b" }, slugPrefix: "b" });
    const off = feeds.create({ name: "C", parser: "test-json", config: { url: "https://example.com/c" }, slugPrefix: "c", enabled: false });
    const started = poller.tick(now);
    assert.equal(started.length, 1);            // A and B share a host; C is disabled
    assert.throws(() => poller.run(feeds.list().find((x) => x.name === "B")!.id, "manual"), /in progress/);
    await Promise.all(started);
    assert.equal(poller.tick(now).length, 1);   // B now
    assert.equal(feeds.get(off.id)!.lastRunAt, null);
  });
});

describe("feeds over http", () => {
  let base: string, admin: Client;
  let src: Awaited<ReturnType<typeof fakeSource>>;
  let app: Awaited<ReturnType<typeof startApp>>["app"];
  const cleanups: (() => unknown)[] = [];
  before(async () => {
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    src = await fakeSource(hooks);
    ({ app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { pollFeeds: false }));
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
    admin = new Client(base);
    await admin.login("admin@example.com", "admin password 1");
  });
  after(async () => { for (const f of cleanups.reverse()) await f(); });

  it("admin only", async () => {
    const c = new Client(base);
    assert.equal((await c.get("/api/admin/feeds")).status, 401);
    assert.equal((await c.get("/admin/feeds")).status, 302);
    assert.equal((await c.post("/api/admin/feeds", { name: "x" })).status, 401);
  });

  it("create, preview (links shown by meeting number only), run now, edit, delete; audited", async () => {
    src.state.meetings = [
      { id: "m1", title: "Council", start: "2027-01-12T01:30:00Z", link: "https://zoom.us/j/87093163922?pwd=429539" },
      { id: "m2", title: "Committee", start: "2027-01-13T01:30:00Z", link: "https://example.com/stream" },
      { id: "m3", title: "Board", start: "2027-01-14T01:30:00Z" },
    ];
    const meta = (await admin.get("/api/admin/feeds")).json;
    assert.ok(meta.parsers.some((p: { id: string }) => p.id === "test-json"));
    assert.equal((await admin.post("/api/admin/feeds", { name: "x", parser: "test-json", config: {}, slugPrefix: "x" })).status, 400);

    const pv = await admin.post("/api/admin/feeds/preview", { parser: "test-json", config: { url: src.url } });
    assert.equal(pv.status, 200);
    assert.deepEqual(pv.json.meetings.map((m: { link?: string }) => m.link), ["Zoom 87093163922", "unsupported link", undefined]);
    assert.doesNotMatch(pv.text, /429539/);
    const bad = await admin.post("/api/admin/feeds/preview", { parser: "test-json", config: { url: src.url.replace(/\d+\/feed/, "9/feed") } });
    assert.equal(bad.status, 502);

    const created = await admin.post("/api/admin/feeds", { name: "Langford", parser: "test-json", config: { url: src.url }, slugPrefix: "langford" });
    assert.equal(created.status, 201);
    const id = created.json.id;
    assert.equal(created.json.health, "new");
    assert.equal(created.json.httpCache, undefined);
    const run = await admin.post(`/api/admin/feeds/${id}/run`);
    assert.equal(run.json.outcome.status, "ok");
    assert.equal(run.json.feed.health, "ok");
    assert.equal(run.json.feed.runs[0].items, 3);
    assert.equal((await admin.req("PATCH", `/api/admin/feeds/${id}`, { policy: "auto", intervalMin: 30 })).json.policy, "auto");
    assert.equal((await admin.get(`/api/admin/feeds/${id}/runs`)).json.length, 1);
    assert.equal((await admin.req("DELETE", `/api/admin/feeds/${id}`)).status, 200);
    assert.equal((await admin.get("/api/admin/feeds")).json.feeds.length, 0);
    assert.deepEqual(app.audit.list({ action: "feed" }).map((e) => e.action), ["feed.delete", "feed.update", "feed.run", "feed.create"]);
    assert.deepEqual(app.audit.list({ action: "feed.update" })[0].after, { policy: "auto", intervalMin: 30 });
  });
});
