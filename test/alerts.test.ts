/**
 * Alerts: a saved search that emails its owner when a new meeting's
 * transcript matches. The store, the pass (with a fake mailer that can fail),
 * the API, the email's stop link, and the whole thing through the server.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Alerts, AlertError, MAX_ALERTS, bodyFor, subjectFor, type AlertMeeting, type Recipient } from "../src/alerts.js";
import { openDb } from "../src/db.js";
import { Search, type Seg } from "../src/search.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fixtures, makeRecording } from "./fixtures.js";
import { Client, startApp } from "./server.js";
import { MemoryMailer } from "./smtp.js";

const NOW = new Date("2026-12-09T12:00:00Z");
const seg = (start: number, text: string, label = "Speaker 1"): Seg => ({ start, end: start + 5, text, label });

function world(t: TestContext) {
  const hooks: HasAfter = { after: (fn) => t.after(fn) };
  const dir = tmpDir(hooks);
  const db = openDb(path.join(dir, "x.db"));
  t.after(() => db.close());
  for (const id of ["u1", "u2", "u3"]) db.prepare("INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES (?, ?, '', 'user', 'x', 'x')").run(id, `${id}@example.com`);
  const search = new Search(db), alerts = new Alerts(db);
  const meetings: AlertMeeting[] = [];
  const addMeeting = (id: string, o: Partial<AlertMeeting>, segs: Seg[]) => {
    const f = path.join(dir, `${id}.json`);
    writeFileSync(f, JSON.stringify({ segments: segs }));
    search.sync([...(db.prepare("SELECT rec_slug, meeting_id FROM transcript_index").all() as { rec_slug: string; meeting_id: string }[]).map((r) => ({ recSlug: r.rec_slug, meetingId: r.meeting_id, file: path.join(dir, `${r.rec_slug}.json`) })), { recSlug: id, meetingId: id, file: f }]);
    const m = { id, slug: id, title: `Meeting ${id}`, body: "Council", start: "2026-12-08T01:30:00.000Z", ...o };
    meetings.push(m);
    return m;
  };
  const sent: { to: string; subject: string; text: string }[] = [];
  let failFor: string | null = null;
  const run = (o: { now?: Date; site?: string } = {}) => alerts.process({
    meetings, search, site: o.site ?? "https://m.example.org", tz: "America/Vancouver", now: o.now ?? NOW,
    recipient: (id): Recipient | null => (id === "gone" ? null : { id, email: `${id}@example.com`, name: "" }),
    send: async (to, subject, text) => { if (failFor === to.id) throw new Error("smtp down"); sent.push({ to: to.email, subject, text }); },
  });
  return { db, alerts, search, addMeeting, meetings, sent, run, failWith: (id: string | null) => { failFor = id; } };
}

describe("the alert store", () => {
  it("validates, tidies, limits and finds by token", (t) => {
    const { alerts, db } = world(t);
    const a = alerts.create("u1", { query: "  zoning   bylaw ", body: " Council " }, NOW);
    assert.deepEqual([a.query, a.body, a.userId, a.lastSentAt], ["zoning bylaw", "Council", "u1", null]);
    assert.match(a.token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(alerts.byToken(a.token)?.id, a.id);
    for (const bad of ["", "nope-not-a-token", "x".repeat(65), a.token + "!", "../etc"]) assert.equal(alerts.byToken(bad), undefined, bad);
    for (const [q, re] of [[{}, /type what to watch/], [{ query: "" }, /type what/], [{ query: "x".repeat(201) }, /up to 200/], [{ query: "***" }, /no words/], [{ query: 5 }, /type what/]] as [object, RegExp][]) {
      assert.throws(() => alerts.create("u1", q), (e: AlertError) => e.status === 400 && re.test(e.message));
    }
    assert.throws(() => alerts.create("u1", { query: "ZONING BYLAW", body: "council" }), (e: AlertError) => e.status === 409);     // the same alert
    assert.equal(alerts.create("u1", { query: "zoning bylaw" }).body, null);                                                     // other body: another alert
    for (let i = 0; i < MAX_ALERTS - 2; i++) alerts.create("u1", { query: `topic ${i}` });
    assert.throws(() => alerts.create("u1", { query: "one more" }), (e: AlertError) => e.status === 409 && /up to 10/.test(e.message));
    assert.equal(alerts.create("u2", { query: "one more" }).userId, "u2");                                                       // limits are per person
    db.prepare("INSERT INTO alert_deliveries (alert_id, meeting_id, sent_at) VALUES (?, 'm', 'x')").run(a.id);
    assert.equal(alerts.delete(a.id), true);
    assert.equal(alerts.delete(a.id), false);
    assert.equal(db.prepare("SELECT count(*) n FROM alert_deliveries").get()!.n, 0);
    assert.equal(alerts.deleteFor("u1"), MAX_ALERTS - 1);
    assert.equal(alerts.list("u1").length, 0);
  });
});

describe("a pass", () => {
  it("one email per person per meeting, only for alerts that match; the next pass sends nothing", async (t) => {
    const w = world(t);
    w.addMeeting("m1", {}, [seg(3725, "The harbour zoning amendment passed.", "Mayor Smith"), seg(4000, "More about the harbour."), seg(4100, "A harbour item."), seg(4200, "Another harbour mention."), seg(10, "Unrelated.")]);
    w.alerts.create("u1", { query: "harbour" }); w.alerts.create("u1", { query: "zoning" }); w.alerts.create("u1", { query: "casino" });
    w.alerts.create("u2", { query: "harbour", body: "Committee" });                       // wrong body
    w.alerts.create("u3", { query: "harbour", body: "council" });
    assert.equal(await w.run(), 2);
    assert.deepEqual(w.sent.map((x) => x.to).sort(), ["u1@example.com", "u3@example.com"]);
    const u1 = w.sent.find((x) => x.to === "u1@example.com")!;
    assert.equal(u1.subject, "2 of your alerts came up at Meeting m1 (Dec 7, 2026)");
    assert.match(u1.text, /^Meeting m1, Dec 7, 2026\nhttps:\/\/m\.example\.org\/m\/m1\n/);
    assert.match(u1.text, /Your alert "harbour": 4 passages/);
    assert.match(u1.text, /Your alert "zoning": 1 passage\n/);
    assert.doesNotMatch(u1.text, /casino/);
    assert.match(u1.text, /Your alert "zoning": 1 passage\n  1:02:05  Mayor Smith: The harbour \*zoning\* amendment passed\.\n    https:\/\/m\.example\.org\/m\/m1\?t=3725/);
    assert.match(u1.text, /\.\.\.and 1 more: https:\/\/m\.example\.org\/search\?q=harbour/);                                   // three shown of four
    for (const a of w.alerts.list("u1").filter((x) => x.query !== "casino")) assert.ok(u1.text.includes(`https://m.example.org/alerts/${a.token}/stop`));
    assert.match(u1.text, /Transcripts are machine-made[\s\S]*Your alerts: https:\/\/m\.example\.org\/account/);
    assert.equal(subjectFor({ id: "m", slug: "m", title: "T", body: null, start: "2026-12-08T01:30:00Z" }, ["x"], "America/Vancouver"), '"x" came up at T (Dec 7, 2026)');
    assert.equal(w.alerts.list("u1").find((a) => a.query === "harbour")!.lastSentAt, NOW.toISOString());
    assert.equal(w.alerts.list("u1").find((a) => a.query === "casino")!.lastSentAt, null);
    assert.equal(await w.run(), 0);                                                                                         // handled: nothing again
    assert.equal(w.sent.length, 2);
    // A later alert doesn't resurrect that meeting; a new meeting does reach everyone.
    w.alerts.create("u2", { query: "harbour" });
    assert.equal(await w.run(), 0);
    w.addMeeting("m2", { start: "2026-12-09T01:30:00.000Z", body: "Committee" }, [seg(5, "Harbour dredging.")]);
    assert.equal(await w.run(), 2);                                                                                         // u2 (Committee, and the any-body one)... both alerts in one email
    const last2 = w.sent.slice(-2);                                                                                         // (which of the two goes first doesn't matter)
    assert.deepEqual(last2.map((x) => x.to).sort(), ["u1@example.com", "u2@example.com"]);
    assert.match(last2.find((x) => x.to === "u2@example.com")!.subject, /2 of your alerts came up at Meeting m2/);
    assert.match(last2.find((x) => x.to === "u1@example.com")!.subject, /^"harbour" came up at Meeting m2/);
  });

  it("a failed email isn't lost or doubled: retry sends only what's missing, then the meeting is done", async (t) => {
    const w = world(t);
    w.addMeeting("m1", {}, [seg(5, "Harbour talk.")]);
    w.alerts.create("u1", { query: "harbour" }); w.alerts.create("u2", { query: "harbour" });
    w.failWith("u2");
    assert.equal(await w.run(), 1);
    assert.deepEqual(w.sent.map((x) => x.to), ["u1@example.com"]);
    assert.equal(await w.run(), 1 - 1);                                                                                     // still failing: u1 isn't mailed again
    assert.equal(w.sent.length, 1);
    w.failWith(null);
    assert.equal(await w.run(), 1);
    assert.deepEqual(w.sent.map((x) => x.to), ["u1@example.com", "u2@example.com"]);
    assert.equal(await w.run(), 0);                                                                                         // now it's done
    // Mail that never works: give up after a few tries (the meeting is marked handled).
    const x = world(t);
    x.addMeeting("m1", {}, [seg(5, "Harbour talk.")]);
    x.alerts.create("u1", { query: "harbour" });
    x.failWith("u1");
    for (let i = 0; i < 8; i++) await x.run();
    x.failWith(null);
    assert.equal(await x.run(), 0);
    assert.equal(x.sent.length, 0);
  });

  it("old meetings are never announced; people who can't be mailed lose their alerts; a handled meeting is skipped", async (t) => {
    const w = world(t);
    w.addMeeting("old", { start: "2026-10-01T01:30:00.000Z" }, [seg(5, "Harbour from long ago.")]);
    w.alerts.create("u1", { query: "harbour" });
    assert.equal(await w.run(), 0);                                                                                         // 69 days ago
    assert.equal(w.sent.length, 0);
    w.db.prepare("INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ('gone', 'gone@example.com', '', 'user', 'x', 'x')").run();
    w.alerts.create("gone", { query: "harbour" });
    w.addMeeting("m1", {}, [seg(5, "Harbour now.")]);
    assert.equal(await w.run(), 1);
    assert.equal(w.alerts.list("gone").length, 0);                                                                          // nobody to tell: removed
    assert.equal(w.alerts.list("u1").length, 1);
    assert.deepEqual(w.sent.map((x) => x.to), ["u1@example.com"]);
  });

  it("emails without a site address carry no links; the text is plain", () => {
    const m = { id: "m", slug: "m", title: "T", body: null, start: "2026-12-08T01:30:00Z" };
    const text = bodyFor(m, [{ alert: { id: "a", userId: "u", query: "q", body: null, token: "tok".repeat(8), createdAt: "", lastSentAt: null }, total: 1,
      hits: [{ meetingId: "m", recSlug: "m", start: 65, speaker: "", parts: [{ text: "a ", hit: false }, { text: "q", hit: true }] }] }], "");
    assert.match(text, /^T, Dec 7, 2026\n\nYour alert "q": 1 passage\n  1:05: a \*q\*\n\n/);
    assert.doesNotMatch(text, /https?:|Stop this alert|Your alerts:/);
    assert.doesNotMatch(text, / +\n/);
    // The day is the meeting's local day in the site's timezone, whatever the server process's own is.
    assert.match(bodyFor(m, [], "", "UTC"), /^T, Dec 8, 2026/);
    assert.equal(subjectFor(m, ["x"], "UTC"), '"x" came up at T (Dec 8, 2026)');
  });
});

async function setup(t: TestContext, opts: { mailer?: MemoryMailer | null } = {}) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const out = path.join(tmpDir(hooks), "rec");
  const given = opts.mailer === undefined ? new MemoryMailer() : opts.mailer;
  const mailer = given ?? new MemoryMailer();                                   // `null`: the server has none, but the tests still have something to look at
  const { app, base } = await startApp(hooks, out, { mailer: given, publicUrl: "https://minutes.example.org" });
  fixtures(app, out);
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1", verified: true });
  await app.accounts.create({ email: "reader@example.com", role: "user", password: "reader password 1", verified: true });
  await app.accounts.create({ email: "other@example.com", role: "user", password: "other password 12", verified: true });
  await app.accounts.create({ email: "new@example.com", role: "user", password: "new password 123" });
  const as = async (e: string, p: string) => { const c = new Client(base); assert.equal((await c.login(e, p)).status, 200); return c; };
  return { app, base, out, mailer, admin: await as("admin@example.com", "admin password 1"), reader: await as("reader@example.com", "reader password 1"),
    other: await as("other@example.com", "other password 12"), unverified: await as("new@example.com", "new password 123"), pub: new Client(base) };
}

describe("alerts API", () => {
  it("verified people make, list and delete their own; the stop token is never shown", async (t) => {
    const { reader, other, admin, app } = await setup(t);
    const r = await reader.post("/api/account/alerts", { query: "  zoning  ", body: "Council" });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json).sort(), ["body", "createdAt", "id", "lastSentAt", "query"]);
    assert.equal(r.json.query, "zoning");
    assert.doesNotMatch(JSON.stringify((await reader.get("/api/account/alerts")).json), /token/);
    assert.deepEqual((await other.get("/api/account/alerts")).json, []);
    assert.equal((await other.req("DELETE", `/api/account/alerts/${r.json.id}`)).status, 404);                                  // not theirs
    assert.equal((await reader.post("/api/account/alerts", { query: "zoning", body: "council" })).status, 409);
    assert.equal((await reader.post("/api/account/alerts", { query: "***" })).status, 400);
    assert.equal((await reader.req("DELETE", `/api/account/alerts/${r.json.id}`)).status, 200);
    assert.deepEqual((await reader.get("/api/account/alerts")).json, []);
    const audit = (await admin.get("/api/admin/audit?limit=20")).text;
    assert.match(audit, /alert\.create/); assert.match(audit, /alert\.delete/);
    void app;
  });

  it("needs a session, a confirmed email, mail set up, and a same-origin request", async (t) => {
    const { pub, unverified, reader } = await setup(t);
    assert.equal((await pub.get("/api/account/alerts")).status, 401);
    assert.equal((await unverified.get("/api/account/alerts")).status, 403);
    assert.equal((await unverified.post("/api/account/alerts", { query: "x" })).status, 403);
    assert.equal((await reader.req("POST", "/api/account/alerts", { query: "x" }, { origin: "https://evil.example" })).status, 403);
    const none = await setup(t, { mailer: null });
    const r = await none.reader.get("/api/account/alerts");
    assert.deepEqual([r.status, /email isn't set up/.test(r.json.error)], [503, true]);
  });

  it("the email's link stops one alert without signing in; the page asks first", async (t) => {
    const { app, reader, pub, base } = await setup(t);
    await reader.post("/api/account/alerts", { query: "zoning" });
    const second = await reader.post("/api/account/alerts", { query: "harbour" });
    const token = app.alerts.get(second.json.id)!.token;
    const page = await pub.get(`/alerts/${token}/stop`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.text, /Stop these emails/);
    assert.doesNotMatch(page.text, new RegExp(token));                                                                          // the page doesn't carry it; the address does
    assert.deepEqual((await pub.get(`/api/alerts/${token}`)).json, { query: "harbour", body: null });
    assert.equal(app.alerts.list(app.accounts.byEmail("reader@example.com")!.id).length, 2);                                    // looking changed nothing
    assert.equal((await pub.req("POST", "/api/alerts/stop", { token }, { origin: "https://evil.example" })).status, 403);       // not from another site
    const stop = await pub.post("/api/alerts/stop", { token });
    assert.deepEqual([stop.status, stop.json], [200, { stopped: true, query: "harbour" }]);
    assert.equal((await pub.post("/api/alerts/stop", { token })).status, 404);                                                  // again: already stopped
    assert.equal((await pub.get(`/api/alerts/${token}`)).status, 404);
    for (const bad of ["nope", "x".repeat(40), ""]) assert.equal((await pub.post("/api/alerts/stop", { token: bad })).status, 404, bad);
    assert.equal((await pub.post("/api/alerts/stop", {})).status, 404);
    assert.deepEqual((await reader.get("/api/account/alerts")).json.map((a: { query: string }) => a.query), ["zoning"]);       // only that one
    assert.match((await reader.get("/api/account/alerts")).text, /zoning/);
    void base;
  });
});

describe("alerts through the server", () => {
  it("a new meeting's transcript emails the people watching for it, once", async (t) => {
    const { app, out, reader, other, mailer } = await setup(t);
    app.syncSearch(true);
    await app.processAlerts();                                                                                                  // council-a (already there) is handled: no alerts yet
    assert.equal(mailer.sent.length, 0);
    await reader.post("/api/account/alerts", { query: "harbour" });
    await other.post("/api/account/alerts", { query: "casino" });
    // A recording finishes: its transcript lands, the search index picks it up, alerts run.
    const j = app.sched.add({ link: "https://zoom.us/j/87093163922?pwd=429539", start: new Date(Date.now() + 86_400_000).toISOString(), slug: "council-b" });
    app.sched.cancel(j.id);
    makeRecording(out, "council-b", { video: true });
    writeFileSync(path.join(out, "council-b", "council-b.transcript.json"), JSON.stringify({ segments: [seg(125, "We turn to the harbour redevelopment.", "Mayor Smith")] }));
    app.syncSearch(true);
    for (let i = 0; i < 100 && mailer.sent.length < 1; i++) await sleep(20);
    await sleep(100);
    assert.equal(mailer.sent.length, 1);
    const m = mailer.sent[0];
    assert.equal(m.to, "reader@example.com");
    assert.equal(m.subject, `"harbour" came up at council-b (${new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "America/Vancouver" }).format(new Date(Date.now() + 86_400_000))})`);
    assert.match(m.text, /https:\/\/minutes\.example\.org\/m\/council-b\?t=125/);
    assert.match(m.text, /2:05  Mayor Smith: We turn to the \*harbour\* redevelopment\./);
    assert.match(m.text, /Stop this alert: https:\/\/minutes\.example\.org\/alerts\/[A-Za-z0-9_-]{32}\/stop/);
    assert.doesNotMatch(m.text, /429539|87093163922|zoom\.us/);
    assert.match(m.text, /An automatic message; replies aren't read\./);
    app.syncSearch(true);
    await app.processAlerts();
    await sleep(100);
    assert.equal(mailer.sent.length, 1);                                                                                         // not again
    assert.equal((await reader.get("/api/account/alerts")).json[0].lastSentAt !== null, true);
  });

  it("a hidden meeting is never announced; neither is one whose owner was disabled", async (t) => {
    const { app, out, reader, admin, mailer } = await setup(t);
    app.syncSearch(true); await app.processAlerts();
    await reader.post("/api/account/alerts", { query: "harbour" });
    const j = app.sched.add({ link: "https://zoom.us/j/87093163922?pwd=429539", start: new Date(Date.now() + 86_400_000).toISOString(), slug: "council-c" });
    app.sched.cancel(j.id);
    makeRecording(out, "council-c", { video: true });
    writeFileSync(path.join(out, "council-c", "council-c.transcript.json"), JSON.stringify({ segments: [seg(5, "Harbour talk.")] }));
    await admin.post(`/api/admin/meetings/${j.meetingRef}/hide`);
    app.syncSearch(true); await sleep(150); await app.processAlerts();
    assert.equal(mailer.sent.length, 0);
    // Disabled: their alerts go with the first match, and nothing is sent.
    await admin.post(`/api/admin/meetings/${j.meetingRef}/show`);
    await admin.req("PATCH", `/api/admin/users/${app.accounts.byEmail("reader@example.com")!.id}`, { disabled: true });
    app.syncSearch(true); await sleep(150); await app.processAlerts();
    assert.equal(mailer.sent.length, 0);
  });
});
