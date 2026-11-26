/**
 * Transcript search: passages, the query syntax (nothing a person types is
 * FTS5 syntax), the index, and the public API/page through the real server.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openDb } from "../src/db.js";
import { Search, parseQuery, passages, type Seg } from "../src/search.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fixtures } from "./fixtures.js";
import { Client, startApp } from "./server.js";

describe("passages", () => {
  const s = (start: number, text: string, label = "Speaker 1", extra: Partial<Seg> = {}): Seg => ({ start, end: start + 3, text, label, ...extra });
  it("joins a speaker's segments up to ~45 s or 450 characters; a new speaker starts a new passage", () => {
    const p = passages([s(0, "Thank you."), s(4, " Next item."), s(8, "Moving on", "Speaker 2"), s(12, "Yes.", "Speaker 2"), s(60, "Much later."), s(61, ""), s(62, "  "), { start: NaN, text: "bad" }]);
    assert.deepEqual(p, [{ start: 0, speaker: "Speaker 1", text: "Thank you. Next item." }, { start: 8, speaker: "Speaker 2", text: "Moving on Yes." }, { start: 60, speaker: "Speaker 1", text: "Much later." }]);
    const long = passages(Array.from({ length: 40 }, (_, i) => s(i * 2, "word ".repeat(10))));
    assert.ok(long.length > 1 && long.every((x) => x.text.length < 520), long.map((x) => x.text.length).join(","));
    const names = passages([{ start: 1, text: "a", zoom_speaker: "Mayor" }, { start: 2, text: "b", label: "", zoom_speaker: "Mayor" }, { start: 3, text: "c" }]);
    assert.deepEqual(names.map((x) => [x.speaker, x.text]), [["Mayor", "a b"], ["", "c"]]);
    assert.deepEqual(passages([]), []);
  });
});

describe("query syntax", () => {
  it("words are ANDed, the last is a prefix, \"phrases\" stay together", () => {
    assert.equal(parseQuery("budget amendment")!.match, '"budget" "amendment"*');
    assert.equal(parseQuery('public "zoning bylaw" hearing')!.match, '"zoning bylaw" "public" "hearing"*');
    assert.equal(parseQuery("it's the mayor’s")!.match, '"it s" "the" "mayor s"');
    assert.equal(parseQuery("go")!.match, '"go"');                                  // too short to be a prefix
    assert.equal(parseQuery("café ÉCOLE")!.match, '"café" "ÉCOLE"*');
    assert.deepEqual(parseQuery("budget amendment")!.terms, ["budget", "amendment"]);
  });

  it("nothing typed is FTS syntax: operators, columns, wildcards and quotes are only words or nothing", () => {
    for (const evil of ['budget" OR "x', "budget AND NOT council", "NEAR(a b, 2)", "text:secret", "meeting_id:abc", "^start", "* OR *", "a*", '"', '""', "(", "-budget", "budget; DROP TABLE x", "'", "\u0002\u0003", "{}[]"]) {
      const q = parseQuery(evil);
      if (q) assert.ok(/^("[^"]*"\*?)( "[^"]*"\*?)*$/.test(q.match), `${evil} -> ${q.match}`);   // only quoted terms
    }
    assert.equal(parseQuery("budget AND council")!.match, '"budget" "AND" "council"*');   // AND is a word
    assert.equal(parseQuery("text:secret")!.match, '"text" "secret"*');                   // not a column filter
    for (const none of ["", "   ", "***", '""', "()", "—", "\u0002"]) assert.equal(parseQuery(none), null, JSON.stringify(none));
    assert.equal(parseQuery("a b c d e f g h i j k l")!.terms.length, 8);                  // capped
    assert.ok(parseQuery("x".repeat(500))!.terms[0].length <= 200);
  });
});

describe("the index", () => {
  function store(t: TestContext) {
    const hooks: HasAfter = { after: (fn) => t.after(fn) };
    const dir = tmpDir(hooks);
    const db = openDb(path.join(dir, "x.db"));
    t.after(() => db.close());
    const write = (slug: string, segs: Seg[], mtime?: number) => {
      const f = path.join(dir, `${slug}.transcript.json`);
      writeFileSync(f, JSON.stringify({ segments: segs }));
      if (mtime) utimesSync(f, mtime, mtime);
      return f;
    };
    return { db, dir, write, search: new Search(db) };
  }
  const seg = (start: number, text: string, label = "Speaker 1"): Seg => ({ start, end: start + 5, text, label });

  it("indexes new and changed files, skips unchanged ones, drops removed ones", (t) => {
    const { write, search, dir } = store(t);
    const a = write("a", [seg(0, "The budget amendment passed."), seg(70, "Public hearing on zoning.")], 1000);
    assert.deepEqual(search.sync([{ recSlug: "a", meetingId: "m1", file: a }]), { indexed: 1, removed: 0 });
    assert.deepEqual(search.stats(), { recordings: 1, passages: 2 });
    assert.deepEqual(search.sync([{ recSlug: "a", meetingId: "m1", file: a }]), { indexed: 0, removed: 0 });     // unchanged
    write("a", [seg(0, "Something else entirely.")], 2000);
    assert.equal(search.sync([{ recSlug: "a", meetingId: "m1", file: a }]).indexed, 1);
    assert.equal(search.search("budget", { meetingIds: ["m1"] }).total, 0);                                      // the old text is gone
    assert.equal(search.search("entirely", { meetingIds: ["m1"] }).total, 1);
    // The meeting it belongs to changed: re-indexed under the new id.
    assert.equal(search.sync([{ recSlug: "a", meetingId: "m2", file: a }]).indexed, 1);
    assert.equal(search.search("entirely", { meetingIds: ["m1"] }).total, 0);
    assert.equal(search.search("entirely", { meetingIds: ["m2"] }).total, 1);
    // A half-written / garbage file is skipped, and the old index kept for next time.
    writeFileSync(a, '{"segments": [', "utf8"); utimesSync(a, 3000, 3000);
    assert.deepEqual(search.sync([{ recSlug: "a", meetingId: "m2", file: a }]), { indexed: 0, removed: 0 });
    assert.equal(search.search("entirely", { meetingIds: ["m2"] }).total, 1);
    // Gone from disk (or no longer listed): dropped.
    assert.deepEqual(search.sync([]), { indexed: 0, removed: 1 });
    assert.deepEqual(search.stats(), { recordings: 0, passages: 0 });
    assert.equal(existsSync(dir), true);
  });

  it("finds stems, phrases and prefixes; ranks the better match first; only in the meetings you pass", (t) => {
    const { write, search } = store(t);
    const a = write("a", [seg(10, "We discussed the budget amendments at length. The budget is large and the budget matters."), seg(200, "Zoning bylaw for the harbour.")]);
    const b = write("b", [seg(5, "A single mention of the budget here.", "Mayor Smith"), seg(300, "The public hearing on zoning begins.", "Councillor Jones")]);
    search.sync([{ recSlug: "a", meetingId: "m1", file: a }, { recSlug: "b", meetingId: "m2", file: b }]);
    const both = ["m1", "m2"];
    const r = search.search("budget", { meetingIds: both });
    assert.equal(r.total, 2);
    assert.deepEqual(r.hits.map((h) => [h.meetingId, h.start]), [["m1", 10], ["m2", 5]]);                        // three mentions beat one
    assert.deepEqual(r.hits[0].parts.filter((p) => p.hit).map((p) => p.text.toLowerCase()), ["budget", "budget", "budget"].slice(0, r.hits[0].parts.filter((p) => p.hit).length));
    assert.ok(r.hits[0].parts.some((p) => p.hit) && r.hits[0].parts.every((p) => !p.text.includes("\u0002")));
    assert.equal(search.search("amendment", { meetingIds: both }).total, 1);                                    // stemming: amendments -> amendment
    assert.equal(search.search("amend", { meetingIds: both }).total, 1);                                        // prefix on the last word
    assert.equal(search.search('"public hearing"', { meetingIds: both }).hits[0].meetingId, "m2");
    assert.equal(search.search('"hearing public"', { meetingIds: both }).total, 0);                             // a phrase is in order
    assert.equal(search.search("zoning harbour", { meetingIds: both }).hits[0].meetingId, "m1");               // both words, same passage
    assert.equal(search.search("zoning begins", { meetingIds: both }).total, 1);
    assert.equal(search.search("mayor smith", { meetingIds: both }).hits[0].speaker, "Mayor Smith");           // by who said it
    assert.equal(search.search("budget", { meetingIds: ["m2"] }).hits.length, 1);
    assert.deepEqual(search.search("budget", { meetingIds: [] }), { total: 0, hits: [], terms: ["budget"] });
    assert.deepEqual(search.search("   ", { meetingIds: both }).hits, []);
    const page = search.search("zoning OR budget", { meetingIds: both, limit: 1, offset: 1 });                   // "OR" is a word, so this needs all three
    assert.equal(page.total, 0);
    const p2 = search.search("the", { meetingIds: both, limit: 2, offset: 2 });
    assert.deepEqual([p2.total, p2.hits.length], [4, 2]);
    assert.equal(search.search("café", { meetingIds: both }).total, 0);
  });
});

async function setup(t: TestContext) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  const { app, base } = await startApp(hooks, out);
  fixtures(app, out);
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1", verified: true });
  const admin = new Client(base);
  await admin.login("admin@example.com", "admin password 1");
  const transcript = (slug: string, segs: Seg[]) => { mkdirSync(path.join(out, slug), { recursive: true }); writeFileSync(path.join(out, slug, `${slug}.transcript.json`), JSON.stringify({ segments: segs })); };
  return { app, base, out, admin, pub: new Client(base), transcript };
}

describe("search through the server", () => {
  it("public, only visible meetings with transcripts, linking to the second; hiding removes it at once", async (t) => {
    const { app, admin, pub, transcript } = await setup(t);
    transcript("council-a", [{ start: 61.4, end: 70, text: "The harbour zoning amendment was approved.", label: "Mayor Smith" }, { start: 300, text: "Adjourned." }]);
    transcript("hidden-b", [{ start: 5, text: "A secret harbour discussion." }]);
    transcript("orphan-c", [{ start: 5, text: "An orphan harbour recording." }]);       // no job: never public
    transcript("failed-d", [{ start: 5, text: "Harbour talk in a failed capture." }]);
    app.syncSearch(true);
    const r = await pub.get("/api/search?q=harbour+zoning");
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.query, r.json.total, r.json.hits.length], ["harbour zoning", 1, 1]);
    const h = r.json.hits[0];
    assert.deepEqual([h.meeting.id, h.meeting.title, h.t, h.speaker, h.url], ["council-a", "council-a", 61, "Mayor Smith", "/m/council-a?t=61"]);
    assert.deepEqual(h.parts.filter((p: { hit: boolean }) => p.hit).map((p: { text: string }) => p.text.toLowerCase()), ["harbour", "zoning"]);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.doesNotMatch(r.text, /secret|orphan|failed capture|manifest|pwd|zoom\.us|rec_slug|meeting_id/);
    // The same through /api/v1, the one the docs describe.
    assert.equal((await pub.get("/api/v1/search?q=harbour")).json.total, 1);
    // Hidden by the admin: gone from the next search, not at the next index run.
    const mid = app.sched.list().find((j) => j.slug === "council-a")!.meetingRef;
    assert.equal((await admin.post(`/api/admin/meetings/${mid}/hide`)).status, 200);
    assert.equal((await pub.get("/api/search?q=harbour")).json.total, 0);
    assert.equal((await admin.post(`/api/admin/meetings/${mid}/show`)).status, 200);
    assert.equal((await pub.get("/api/search?q=harbour")).json.total, 1);
  });

  it("filters by body and dates, pages, picks up a transcript that appears later, and treats bad input as nothing", async (t) => {
    const { app, pub, transcript } = await setup(t);
    const m = app.sched.meetings.get(app.sched.list().find((j) => j.slug === "council-a")!.meetingRef)!;
    m.body = "Council"; m.start = "2026-11-24T01:30:00.000Z";
    app.sched.meetings.save(m);
    transcript("council-a", Array.from({ length: 6 }, (_, i) => ({ start: i * 100, text: `Item ${i}: the budget line ${i}.`, label: `Speaker ${i}` })));
    // Written after the server is up, with no explicit sync: the search picks it up (within its 30 s window it'd wait, so force the window).
    app.syncSearch(true);
    const all = (await pub.get("/api/search?q=budget&limit=2")).json;
    assert.deepEqual([all.total, all.hits.length], [6, 2]);
    assert.equal((await pub.get("/api/search?q=budget&limit=2&offset=4")).json.hits.length, 2);
    assert.equal((await pub.get("/api/search?q=budget&body=council")).json.total, 6);
    assert.equal((await pub.get("/api/search?q=budget&body=committee")).json.total, 0);
    assert.equal((await pub.get("/api/search?q=budget&from=2026-11-23&to=2026-11-23")).json.total, 6);          // local day (Vancouver): the 23rd evening
    assert.equal((await pub.get("/api/search?q=budget&from=2026-11-25")).json.total, 0);
    assert.equal((await pub.get("/api/search?q=budget&to=2026-11-22")).json.total, 0);
    for (const bad of ["/api/search", "/api/search?q=", "/api/search?q=%22", "/api/search?q=***", "/api/search?q=budget&limit=abc&offset=-3&from=nonsense", "/api/search?q=" + "a".repeat(5000)]) {
      const r = await pub.get(bad);
      assert.equal(r.status, bad.length > 3000 ? 414 : 200, bad.slice(0, 50));
    }
    assert.deepEqual((await pub.get("/api/search?q=%22")).json.hits, []);
    assert.equal((await pub.get("/api/search?q=budget%22%20OR%20%22x")).status, 200);                           // no FTS syntax error
    assert.equal((await pub.get("/api/search?q=text%3Abudget")).status, 200);
  });

  it("the page, the home page's search box, and the docs", async (t) => {
    const { pub, base } = await setup(t);
    const page = await pub.get("/search?q=budget");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'sha256-/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.text, /role="search"/);
    assert.doesNotMatch(page.text, /api\/admin|renderMe\(document\.getElementById\("me"\), true\)/);
    assert.match((await pub.get("/")).text, /<form class="hsearch" action="\/search" method="get" role="search">/);
    assert.match((await pub.get("/m/council-a")).text, /href="\/search">Search transcripts/);
    assert.match((await pub.get("/api/docs")).text, /\/api\/v1\/search/);
    const doc = (await pub.get("/api/v1/openapi.json")).json;
    assert.ok(doc.paths["/api/v1/search"].get.parameters.some((p: { name: string }) => p.name === "q"));
    assert.equal((await new Client(base).req("OPTIONS", "/api/v1/search", undefined, { origin: "https://openlangford.ca", "access-control-request-method": "GET" })).status, 204);
  });
});

describe("search is rate limited per client", () => {
  it("60 a minute by default, then 429 with Retry-After; another client is unaffected; other endpoints aren't counted", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
    const { base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { searchesPerMinute: 5, trustedProxies: "127.0.0.1" });
    const from = (ip: string, p = "/api/search?q=harbour") => new Client(base).req("GET", p, undefined, { "x-forwarded-for": ip });
    for (let i = 0; i < 5; i++) assert.equal((await from("203.0.113.9")).status, 200);
    const blocked = await from("203.0.113.9", "/api/v1/search?q=harbour");                                          // the v1 route shares the limit
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.equal(blocked.headers.get("access-control-allow-origin"), "*");
    assert.equal((await from("198.51.100.7")).status, 200);                                                         // someone else
    assert.equal((await from("203.0.113.9", "/api/meetings")).status, 200);                                         // the rest of the site isn't limited
    assert.equal((await from("203.0.113.9", "/search?q=x")).status, 200);                                           // nor is the page
  });
});
