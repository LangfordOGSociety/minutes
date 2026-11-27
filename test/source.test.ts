/** The public pages say which municipality (feed) a meeting is from: two cities both have a "Council Meeting". */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fakeSource } from "./fixtures.js";
import { Client, startApp } from "./server.js";

const at = (h: number) => new Date(Math.round((Date.now() + h * 3_600_000) / 60_000) * 60_000).toISOString();

describe("which municipality", () => {
  it("meetings, changes and search results carry their feed's name; the list filters and names its sources", async (t: TestContext) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const [a, b] = [await fakeSource(hooks), await fakeSource(hooks)];
    const { app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { pollFeeds: false });
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
    const admin = new Client(base);
    await admin.login("admin@example.com", "admin password 1");
    const mk = async (name: string, src: typeof a, prefix: string) => {
      const feed = (await admin.post("/api/admin/feeds", { name, parser: "test-json", config: { url: src.url }, slugPrefix: prefix, policy: "list_only" })).json;
      return async () => { src.state.etag = String(Math.random()); return (await admin.post(`/api/admin/feeds/${feed.id}/run`)).json.outcome; };
    };
    const runA = await mk("Langford Council", a, "langford"), runB = await mk("Saanich Council", b, "saanich");
    a.state.meetings = [{ id: "l1", title: "Council Meeting", body: "Council Meeting", start: at(48) }];
    b.state.meetings = [{ id: "s1", title: "Council Meeting", body: "Council Meeting", start: at(72) }];
    await runA(); await runB();
    const pub = new Client(base);
    const up = (await pub.get("/api/meetings?scope=upcoming")).json;
    assert.deepEqual(up.meetings.map((m: { source: string }) => m.source), ["Langford Council", "Saanich Council"]);   // same title, told apart
    assert.deepEqual(up.sources, ["Langford Council", "Saanich Council"]);
    const only = (await pub.get("/api/meetings?scope=upcoming&source=saanich%20council")).json;
    assert.deepEqual(only.meetings.map((m: { source: string }) => m.source), ["Saanich Council"]);
    assert.equal(only.total, 1);
    const one = (await pub.get(`/api/meetings/${up.meetings[1].id}`)).json;
    assert.equal(one.source, "Saanich Council");
    // A change names its meeting's source (here: moved to another day).
    b.state.meetings = [{ id: "s1", title: "Council Meeting", body: "Council Meeting", start: at(96) }];
    await runB();
    const ch = (await pub.get("/api/changes")).json as { meeting: { source: string }; kind: string }[];
    assert.ok(ch.length && ch.every((c) => c.meeting.source), JSON.stringify(ch));
    assert.ok(ch.some((c) => c.kind === "date_changed" && c.meeting.source === "Saanich Council"));
    // A meeting entered by hand has none.
    const hand = (await admin.post("/api/admin/jobs", { link: "https://zoom.us/j/87093163922", start: at(30), slug: "by-hand", title: "By hand" })).json;
    assert.ok(hand?.id, JSON.stringify(hand));
    const all = (await pub.get("/api/meetings?scope=upcoming")).json.meetings as { title: string; source: string | null }[];
    assert.equal(all.find((m) => m.title === "By hand")?.source ?? null, null);
  });
});
