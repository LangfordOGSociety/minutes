/**
 * The document mirror (docs.ts): documents a feed lists are fetched through
 * an injected fetcher (the real one is a headed browser), stored, read for a
 * join link, and offered as a stored copy. The browser itself is not run here.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { kindOf } from "../src/docs.js";
import type { DocFetcher, Fetched } from "../src/docfetch.js";
import { tmpDir, type HasAfter } from "./helpers.js";
import { fakeSource } from "./fixtures.js";
import { Client, startApp } from "./server.js";

const PDF = (s: string) => Buffer.from(`%PDF-1.4\n% ${s}\n%%EOF\n`);
const BOT = Buffer.from("<!DOCTYPE html><title>Just a moment...</title>");

class FakeFetcher implements DocFetcher {
  files = new Map<string, Fetched | Error>();
  calls: { origin: string; urls: string[] }[] = [];
  async fetchAll(origin: string, urls: string[]) {
    this.calls.push({ origin, urls });
    return new Map(urls.map((u) => [u, this.files.get(u) ?? new Error("HTTP 404")]));
  }
}
const pdf = (s: string): Fetched => ({ bytes: PDF(s), contentType: "application/pdf" });

async function setup(t: TestContext, extra: Record<string, unknown> = {}) {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  const hooks: HasAfter = { after: (fn) => cleanups.push(fn) };
  const src = await fakeSource(hooks);
  const fetcher = new FakeFetcher();
  const text = { current: "" as string | null };
  const { app, base } = await startApp(hooks, path.join(tmpDir(hooks), "rec"), { pollFeeds: false, docMirror: fetcher, docText: async () => text.current, ...extra });
  await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
  const admin = new Client(base);
  await admin.login("admin@example.com", "admin password 1");
  const feed = (await admin.post("/api/admin/feeds", { name: "Langford", parser: "test-json", config: { url: src.url }, slugPrefix: "langford", policy: "auto" })).json;
  const run = async () => { src.state.etag = String(Math.random()); return (await admin.post(`/api/admin/feeds/${feed.id}/run`)).json.outcome; };
  const start = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const doc = (title: string, n: number) => ({ title, type: "AdditionalDocuments", url: `https://city.example/FileStream.ashx?DocumentId=${n}` });
  return { app, admin, src, feed, run, fetcher, text, start, doc, base };
}

const meetingOf = async (admin: Client, title: string) => ((await admin.get("/api/admin/meetings?view=upcoming")).json as any[]).find((m) => m.title === title);

describe("kinds of document", () => {
  it("by first bytes; a web page (the bot check) or an archive isn't kept", () => {
    assert.deepEqual(kindOf(PDF("x")), { ext: "pdf", type: "application/pdf" });
    assert.equal((kindOf(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("word/document.xml")])) as { ext: string }).ext, "docx");
    assert.equal((kindOf(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("xl/workbook.xml")])) as { ext: string }).ext, "xlsx");
    assert.equal(kindOf(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("readme.txt")])), "a zip archive");
    assert.match(kindOf(BOT) as string, /web page.*bot check/);
    assert.equal(kindOf(Buffer.alloc(0)), "empty");
    assert.match(kindOf(Buffer.from("just text")) as string, /not a kind/);
    assert.equal((kindOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])) as { ext: string }).ext, "png");
  });
});

describe("mirroring and join links", () => {
  it("stores the documents, finds the meeting ID, sets the link, and says so in the history each time it changes", async (t) => {
    const { app, admin, src, run, fetcher, text, start, doc } = await setup(t);
    src.state.meetings = [{ id: "s1", title: "Special Council Meeting", body: "Special Council Meeting", start, documents: [doc("Dial in Instructions", 19549), doc("Meeting Notice", 19550)] }];
    await run();
    let m = await meetingOf(admin, "Special Council Meeting");
    assert.equal(m.link, null);                                  // no link published yet
    const history = async () => ((await admin.get(`/api/admin/meetings/${m.id}/changes`)).json as any[]).reverse();

    // The Dial-in PDF is fetched from the city's origin and read.
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=19549", pdf("dial"));
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=19550", pdf("notice"));
    text.current = "ENTER THE MEETING ID NUMBER\n   Special Council Meeting ID: 886 0437 7392\n   Passcode: 424242";
    const r1 = await app.docs.run();
    assert.deepEqual(r1, { stored: 2, failed: 0 });
    assert.deepEqual(fetcher.calls[0], { origin: "https://city.example", urls: ["https://city.example/FileStream.ashx?DocumentId=19549", "https://city.example/FileStream.ashx?DocumentId=19550"] });
    const rows = app.docs.list(m.id);
    assert.equal(rows.length, 2);
    for (const d of rows) { assert.equal(d.status, "stored"); assert.ok(existsSync(app.docs.filePath(d)!)); assert.equal(d.sha256!.length, 64); }
    assert.match(rows[0].name!, /^Dial in Instructions\.pdf$/);
    assert.equal(readFileSync(app.docs.filePath(rows[0])!, "utf8").slice(0, 5), "%PDF-");

    m = await meetingOf(admin, "Special Council Meeting");
    assert.equal(m.link, "Zoom 88604377392");
    assert.equal(m.capture?.status, "scheduled");                // the feed's policy is auto: a link means a capture
    let h = await history();
    const det = h.filter((c) => c.kind === "link_detected");
    assert.equal(det.length, 1);
    assert.deepEqual(det[0].after, { link: "Zoom 88604377392", document: "Dial in Instructions" });
    assert.match(det[0].effect, /set as the meeting's link; capture .* scheduled/);
    assert.ok(!JSON.stringify(h).includes("424242"), "the passcode never reaches the history");

    // Nothing new: no second entry, nothing refetched.
    fetcher.calls.length = 0;
    await app.docs.run();
    assert.equal(fetcher.calls.length, 0);
    assert.equal((await history()).filter((c) => c.kind === "link_detected").length, 1);

    // A different meeting ID in a new document: a new entry, the link follows (it was taken from a document).
    src.state.meetings = [{ id: "s1", title: "Special Council Meeting", body: "Special Council Meeting", start,
      documents: [doc("Dial in Instructions", 19549), doc("Meeting Notice", 19550), doc("Dial in Instructions (revised)", 19600)] }];
    await run();
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=19600", pdf("dial2"));
    text.current = "Meeting ID: 812 3456 7890";
    await app.docs.run();
    h = await history();
    const det2 = h.filter((c) => c.kind === "link_detected");
    assert.equal(det2.length, 2);
    assert.deepEqual(det2[1].before, { link: "Zoom 88604377392" });
    assert.equal(det2[1].after.link, "Zoom 81234567890");
    assert.match(det2[1].effect, /replaced Zoom 88604377392/);
    assert.equal((await meetingOf(admin, "Special Council Meeting")).link, "Zoom 81234567890");

    // The documents stop naming an ID (the revised one is pulled, and the others have none): removed is recorded, the link stays.
    src.state.meetings = [{ id: "s1", title: "Special Council Meeting", body: "Special Council Meeting", start, documents: [doc("Meeting Notice", 19550)] }];
    await run();
    text.current = "no id here";
    for (const d of app.docs.list(m.id)) app.docs["o"].db.prepare("UPDATE meeting_documents SET link = NULL WHERE id = ?").run(d.id);
    await app.docs.run();
    h = await history();
    const gone = h.filter((c) => c.kind === "link_removed");
    assert.equal(gone.length, 1);
    assert.deepEqual(gone[0].before, { link: "Zoom 81234567890" });
    assert.match(gone[0].effect, /link is unchanged/);
    assert.equal((await meetingOf(admin, "Special Council Meeting")).link, "Zoom 81234567890");
    // The pulled document keeps its stored copy.
    const kept = app.docs.list(m.id).find((d) => d.title === "Dial in Instructions")!;
    assert.ok(kept.goneAt && kept.status === "stored" && existsSync(app.docs.filePath(kept)!));
  });

  it("a link the feed gave is kept; a link in a document is only recorded", async (t) => {
    const { app, admin, src, run, fetcher, text, start, doc } = await setup(t);
    src.state.meetings = [{ id: "s2", title: "Council", start, link: "https://zoom.us/j/87093163922?pwd=429539", documents: [doc("Dial in Instructions", 1)] }];
    await run();
    const m = await meetingOf(admin, "Council");
    assert.equal(m.link, "Zoom 87093163922");
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=1", pdf("d"));
    text.current = "Meeting ID: 886 0437 7392";
    await app.docs.run();
    assert.equal((await meetingOf(admin, "Council")).link, "Zoom 87093163922");
    const h = (await admin.get(`/api/admin/meetings/${m.id}/changes`)).json as any[];
    const det = h.find((c) => c.kind === "link_detected");
    assert.equal(det.after.link, "Zoom 88604377392");
    assert.match(det.effect, /kept the existing link \(Zoom 87093163922\)/);
  });

  it("failures: the bot check page isn't stored, is retried later, and gives up after five tries", async (t) => {
    let now = Date.now();
    const { app, admin, src, run, fetcher, start, doc } = await setup(t);
    app.docs["o"].now = () => new Date(now);
    src.state.meetings = [{ id: "s3", title: "Council", start, documents: [doc("Agenda", 7)] }];
    await run();
    const m = await meetingOf(admin, "Council");
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=7", new Error("HTTP 403 (the site's bot check, or an error page)"));
    assert.deepEqual(await app.docs.run(), { stored: 0, failed: 1 });
    const d = app.docs.list(m.id)[0];
    assert.equal(d.status, "failed");
    assert.match(d.error!, /bot check/);
    assert.equal(d.file, null);
    assert.equal(d.tries, 1);
    // Too soon: not tried again.
    fetcher.calls.length = 0;
    await app.docs.run();
    assert.equal(fetcher.calls.length, 0);
    // Later it works.
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=7", pdf("agenda"));
    now += 25 * 60_000;
    assert.deepEqual(await app.docs.run(), { stored: 1, failed: 0 });
    assert.equal(app.docs.list(m.id)[0].status, "stored");
    assert.equal(app.docs.list(m.id)[0].error, null);
    // A web page listed as a document is never going to be a file: one try.
    src.state.meetings = [{ id: "s3", title: "Council", start, documents: [doc("Agenda", 7), doc("Player", 9)] }];
    await run();
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=9", { bytes: BOT, contentType: "text/html" });
    await app.docs.run();
    const page = app.docs.list(m.id).find((x) => x.title === "Player")!;
    assert.deepEqual([page.status, page.tries], ["failed", 5]);
    // A different one that never works stops after five tries.
    src.state.meetings = [{ id: "s3", title: "Council", start, documents: [doc("Agenda", 7), doc("Minutes", 8)] }];
    await run();
    for (let i = 0; i < 8; i++) { now += 24 * 3_600_000; await app.docs.run(); }
    const bad = app.docs.list(m.id).find((x) => x.title === "Minutes")!;
    assert.equal(bad.tries, 5);
    assert.equal(bad.status, "failed");
  });
});

describe("the stored copy, publicly", () => {
  it("is offered on the public meeting and served safely; hidden meetings and wrong names 404", async (t) => {
    const { app, admin, src, run, fetcher, text, start, doc, base } = await setup(t);
    text.current = null;
    src.state.meetings = [{ id: "s4", title: "Special Council Meeting", body: "Special Council Meeting", start, documents: [doc("Dial in Instructions", 3)] }];
    await run();
    const m = await meetingOf(admin, "Special Council Meeting");
    const pub = new Client(base);
    let j = (await pub.get(`/api/meetings/${m.slug}`)).json;
    assert.equal(j.documents[0].copy, null);                     // not fetched yet
    fetcher.files.set("https://city.example/FileStream.ashx?DocumentId=3", pdf("hello"));
    await app.docs.run();
    j = (await pub.get(`/api/meetings/${m.slug}`)).json;
    const copy = j.documents[0].copy as string;
    assert.match(copy, /^\/doc\/\d+\/Dial%20in%20Instructions\.pdf$/);
    assert.equal(j.documents[0].url, "https://city.example/FileStream.ashx?DocumentId=3");   // the city's own link stays
    const r = await fetch(base + copy);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy")!, /sandbox/);
    assert.match(r.headers.get("content-disposition")!, /^inline; filename\*=UTF-8''Dial%20in%20Instructions\.pdf$/);
    assert.equal((await r.text()).slice(0, 5), "%PDF-");
    assert.equal((await fetch(base + copy.replace("Instructions", "Other"))).status, 404);
    assert.equal((await fetch(base + "/doc/9999/x.pdf")).status, 404);
    assert.equal((await fetch(base + "/doc/abc/x.pdf")).status, 404);
    assert.equal((await admin.post(`/api/admin/meetings/${m.id}/hide`)).status, 200);
    assert.equal((await fetch(base + copy)).status, 404);
    // No link was found (no text), so the history has none of this.
    const h = (await admin.get(`/api/admin/meetings/${m.id}/changes`)).json as any[];
    assert.ok(!h.some((c) => c.kind === "link_detected"));
  });
});
