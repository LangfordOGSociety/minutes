/**
 * CivicWeb parser, with fixtures saved from Colwood's portal (2026-11-28): the meeting list, two meetings'
 * documents and video links. A fixed "now" keeps it independent of the date it runs on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { feedContext } from "../src/feeds/context.js";
import { civicweb, cleanName, toMeetings, type CwDoc, type CwMeeting } from "../src/feeds/parsers/civicweb.js";
import type { HasAfter } from "./helpers.js";

const FIX = path.resolve("test/fixtures/feeds/civicweb");
const read = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const rows = JSON.parse(read("meetings.json")) as CwMeeting[];
const TZ = "America/Vancouver";
const BASE = "https://colwood.civicweb.net/";
const NOW = new Date("2026-11-28T12:00:00Z");
const docs = new Map<number, CwDoc[]>([[3734, JSON.parse(read("documents-3734.json"))], [3733, JSON.parse(read("documents-3733.json"))]]);
const video = new Map<number, string>([[3734, read("videolink-3734.json")], [3733, read("videolink-3733.json")]]);

async function portal(t: HasAfter, o: { failVideo?: boolean } = {}) {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    const u = req.url ?? "";
    hits.push(u);
    const ok = (body: string) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); };
    if (u.startsWith("/Services/MeetingsService.svc/meetings?")) return ok(JSON.stringify(rows));
    const d = /^\/Services\/MeetingsService\.svc\/meetings\/(\d+)\/meetingDocuments/.exec(u);
    if (d && docs.has(+d[1])) return ok(JSON.stringify(docs.get(+d[1])));
    if (d) return ok("[]");
    const v = /^\/api\/videolink\/(\d+)/.exec(u);
    if (v && o.failVideo) { res.writeHead(500); return res.end("boom"); }
    if (v) return ok(video.get(+v[1]) ?? '""');
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits };
}

describe("civicweb", () => {
  it("tidies the portal's names: the day on the end, CANCELLED and POSTPONED", () => {
    assert.deepEqual(cleanName("Council - 23 Nov 2026"), { title: "Council", cancelled: false });
    assert.deepEqual(cleanName("CANCELLED - Capital West Accessibility Advisory Committee - 25 Nov 2026"), { title: "Capital West Accessibility Advisory Committee", cancelled: true });
    assert.deepEqual(cleanName("POSTPONED - Special Council - 09 Feb 2026"), { title: "Special Council", cancelled: true });
    assert.equal(cleanName("CANCELLED- Special Council - 2026 Service Review &amp; Budget 4-Feb-26 - 04 Feb 2026").title, "Special Council - 2026 Service Review & Budget 4-Feb-26");
    assert.deepEqual(cleanName("RESCHEDULED Special Council - 2026 Budget -18 Feb 2026"), { title: "RESCHEDULED Special Council - 2026 Budget", cancelled: false });
  });

  it("local times, cancelled, notices, documents, and the YouTube stream", () => {
    const ms = toMeetings(rows, { baseUrl: BASE, tz: TZ, titles: [], now: NOW, docs, video });
    const by = (id: number) => ms.find((m) => m.externalId === String(id))!;
    // The Dec 14 notice has its own meetings at the same time: dropped. A lone notice (Nov 9 in-camera) stays.
    assert.equal(ms.some((m) => m.externalId === "3841"), false);
    assert.ok(ms.some((m) => m.title === "Notice of In-Camera Meeting"));
    // 18:30 in Vancouver in December: BC is on permanent daylight time (UTC-7) since Nov 2026, so 01:30 UTC the next day.
    assert.equal(by(3735).start.toISOString(), "2026-12-15T01:30:00.000Z");
    assert.equal(by(3735).title, "Council");
    assert.equal(by(3775).cancelled, true);
    assert.equal(by(3775).title, "Capital West Accessibility Advisory Committee");
    assert.ok(ms.some((m) => /Service Re/.test(m.title) && m.cancelled), "POSTPONED is off too");
    // A finished meeting: its documents, the video as a stream page, and no join link (it is over).
    const c = by(3734);
    assert.deepEqual(c.documents!.map((d) => d.title), ["Agenda (HTML)", "Agenda (PDF)", "Agenda Package (PDF)", "Video"]);
    assert.equal(c.documents![1].url, "https://colwood.civicweb.net/document/258913?printPdf=true");
    assert.equal(c.documents![2].url, "https://colwood.civicweb.net/document/258912");
    assert.equal(c.agendaUrl, "https://colwood.civicweb.net/document/258913?printPdf=true");
    assert.equal(c.streamUrl, "https://www.youtube.com/watch?v=Y_YczaGqniY");
    assert.equal(c.link, undefined);
    assert.equal(c.pageUrl, "https://colwood.civicweb.net/Portal/MeetingInformation.aspx?Org=Cal&Id=3734");
    assert.deepEqual(by(3733).documents!.map((d) => d.title), ["Agenda (HTML)", "Agenda (PDF)", "Agenda Package (PDF)", "Minutes (HTML)", "Minutes (PDF)", "Video"]);
    // Titles filter: contains, case-insensitive.
    assert.deepEqual(toMeetings(rows, { baseUrl: BASE, tz: TZ, titles: ["inaugural"], now: NOW }).map((m) => m.externalId), ["3733"]);
  });

  it("an upcoming meeting whose video the city has set up is joined through YouTube; a cancelled one is not", () => {
    const up = new Map([[3735, '"[{\\"ShowVideoLink\\":true,\\"YouTube\\":true,\\"YouTubeEventId\\":\\"abcdefghijk\\"}]"']]);
    const ms = toMeetings(rows, { baseUrl: BASE, tz: TZ, titles: [], now: NOW, video: up });
    assert.match(ms.find((m) => m.externalId === "3735")!.link ?? "", /abcdefghijk/);
    assert.equal(ms.find((m) => m.externalId === "3840")!.link, undefined, "no video set up yet: no link");
    const cancelled = toMeetings(rows, { baseUrl: BASE, tz: TZ, titles: [], now: NOW, video: new Map([[3775, up.get(3735)!]]) });
    assert.equal(cancelled.find((m) => m.externalId === "3775")!.link, undefined);
  });

  it("a join link in the agenda text is used when there is no video", () => {
    const agenda: CwDoc = { Id: 1, Type: 1, DocumentType: 1, Html: "<p>To speak: Zoom Meeting ID: 870 9316 3922 Passcode: 429539</p>" };
    const ms = toMeetings(rows, { baseUrl: BASE, tz: TZ, titles: [], now: NOW, docs: new Map([[3735, [agenda]]]) });
    assert.match(ms.find((m) => m.externalId === "3735")!.link ?? "", /zoom\.us\/j\/87093163922/);
  });

  it("fetch: the list, then documents for published meetings and video links for near ones", async (t) => {
    const { base, hits } = await portal(t);
    const c = civicweb.validate({ baseUrl: base, allowOtherHost: true, timezone: TZ, daysBack: 30 });
    const ctx = feedContext({ tz: "UTC", now: NOW, label: "t" });
    const r = await civicweb.fetch(c, ctx);
    assert.ok("meetings" in r);
    const nov23 = r.meetings.find((m) => m.externalId === "3734")!;
    assert.equal(nov23.streamUrl, "https://www.youtube.com/watch?v=Y_YczaGqniY");
    assert.equal(nov23.documents!.length, 4);
    assert.ok(hits.some((h) => h.startsWith("/Services/MeetingsService.svc/meetings?from=2026-10-29&to=9999-12-31")), hits.join("\n"));
    assert.ok(hits.includes("/Services/MeetingsService.svc/meetings/3734/meetingDocuments"));
    assert.ok(!hits.includes("/Services/MeetingsService.svc/meetings/3735/meetingDocuments"), "an unpublished meeting has no documents to ask for");
    assert.ok(hits.includes("/api/videolink/3734"));
    assert.ok(!hits.includes("/api/videolink/3735"), "Dec 14 is more than two weeks off: the city has not set up a video yet");
  });

  it("fetch: a detail that fails is logged and the feed still gets its meetings", async (t) => {
    const { base } = await portal(t, { failVideo: true });
    const c = civicweb.validate({ baseUrl: base, allowOtherHost: true, timezone: TZ });
    const ctx = feedContext({ tz: "UTC", now: NOW, label: "t" });
    const r = await civicweb.fetch(c, ctx);
    assert.ok("meetings" in r && r.meetings.length > 0);
    assert.ok(ctx.lines.some((l) => /details of .*HTTP 500/.test(l)), ctx.lines.join("\n"));
  });

  it("config and errors", async (t) => {
    assert.throws(() => civicweb.validate({ baseUrl: "https://example.com" }), /CivicWeb portal/);
    assert.equal(civicweb.validate({ baseUrl: "https://colwood.civicweb.net/Portal/MeetingTypeList.aspx" }).baseUrl, BASE);
    assert.throws(() => civicweb.validate({ baseUrl: BASE, timezone: "Nowhere/Land" }), /timezone/);
    const { base } = await portal(t);
    const c = civicweb.validate({ baseUrl: base + "/nope/", allowOtherHost: true });
    await assert.rejects(civicweb.fetch({ ...c, baseUrl: base + "/nope/" }, feedContext({ tz: TZ, label: "t" })), /meetings: .*civicweb/i);
  });
});
