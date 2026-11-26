/**
 * PrimeGov parser, with fixtures saved from Saanich's portal (2026-11-25):
 * ListUpcomingMeetings and the November 2026 part of ListArchivedMeetings.
 * A fixed "now" keeps it independent of the date it runs on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { feedContext } from "../src/feeds/context.js";
import { primegov, toMeetings, type PgMeeting } from "../src/feeds/parsers/primegov.js";
import type { HasAfter } from "./helpers.js";

const FIX = path.resolve("test/fixtures/feeds/primegov");
const upcoming = JSON.parse(readFileSync(path.join(FIX, "upcoming.json"), "utf8")) as PgMeeting[];
const archived = JSON.parse(readFileSync(path.join(FIX, "archived-2026-nov.json"), "utf8")) as PgMeeting[];
const TZ = "America/Vancouver";
const SAANICH = "https://saanichca.primegov.com/";

async function portal(t: HasAfter, up: PgMeeting[]) {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const json = (v: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.url === "/api/v2/PublicPortal/ListUpcomingMeetings") return json(up);
    if (req.url === "/api/v2/PublicPortal/ListArchivedMeetings?year=2026") return json(archived);
    if (req.url?.startsWith("/Portal/Meeting?meetingTemplateId=4481")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<p>Join by Zoom: Webinar ID: 855 1234 5678 Passcode: 135790</p>");
    }
    if (req.url?.startsWith("/Portal/Meeting")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<p>In person.</p>"); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits };
}

describe("primegov", () => {
  it("Saanich's meetings: local times, sane ends, documents, video, no join link", () => {
    const ms = toMeetings([...upcoming, ...archived], { baseUrl: SAANICH, tz: TZ, titles: [] });
    assert.deepEqual(ms.map((m) => [m.externalId, m.start.toISOString(), m.title]), [
      ["856", "2026-11-03T01:30:00.000Z", "Council Meeting"],
      ["912", "2026-11-13T01:00:00.000Z", "Board of Variance"],
      ["904", "2026-11-24T01:30:00.000Z", "Council Meeting and In-camera Meeting Notice"],
      ["921", "2026-11-30T13:30:00.000Z", "Special Council Meeting and In-camera Meeting Notice"],   // 06:30 AM, as Saanich lists it
      ["905", "2026-12-01T01:30:00.000Z", "Committee of the Whole Meeting"],
      ["405", "2026-12-02T20:00:00.000Z", "Advisory Design Panel"],
    ]);
    const cotw = ms.find((m) => m.externalId === "905")!;
    assert.equal(cotw.end, undefined);   // endDateTime 08:08 is before the 18:30 start
    assert.equal(ms.find((m) => m.externalId === "405")!.end?.toISOString(), "2026-12-03T07:00:00.000Z");
    assert.deepEqual(cotw.documents, [
      { title: "HTML Agenda", type: "HTML Agenda", url: SAANICH + "Portal/Meeting?meetingTemplateId=4481" },
      { title: "Agenda (PDF)", type: "Agenda", url: SAANICH + "Public/CompiledDocument?meetingTemplateId=4481&compileOutputType=1" },
    ]);
    assert.equal(cotw.agendaUrl, SAANICH + "Portal/Meeting?meetingTemplateId=4481");
    const nov23 = ms.find((m) => m.externalId === "904")!;
    assert.deepEqual(nov23.documents?.at(-1), { title: "Video", type: "Video", url: "https://saanich.ca.granicus.com/MediaPlayer.php?clip_id=1356" });
    assert.ok(ms.every((m) => !m.link && !m.cancelled));
    // No titles configured: every meeting, whatever its kind.
    assert.equal(toMeetings([...upcoming, ...archived], { baseUrl: SAANICH, tz: TZ, titles: primegov.validate({ baseUrl: SAANICH }).titles }).length, 6);
    // Title filter: contains, case-insensitive.
    assert.deepEqual(toMeetings(upcoming, { baseUrl: SAANICH, tz: TZ, titles: ["council meeting"] }).map((m) => m.externalId), ["921"]);
  });

  it("fetch: upcoming + this year's archive in the window; links from zoomMeetingLink or the agenda", async (t) => {
    const up = structuredClone(upcoming);
    const s = up.find((m) => m.id === 921)!;
    Object.assign(s, { isZoomMeeting: true, zoomMeetingLink: "https://us02web.zoom.us/j/84444444444?pwd=xyz" });
    const { base, hits } = await portal(t, up);
    const c = primegov.validate({ baseUrl: base + "/public/portal", allowOtherHost: true, timezone: TZ, daysBack: 10 });
    const ctx = feedContext({ tz: "UTC", now: new Date("2026-11-26T00:00:00Z"), label: "t" });
    const r = await primegov.fetch(c, ctx);
    assert.ok("meetings" in r);
    // Nov 16-on: the Nov 23 archived meeting, and the three upcoming.
    assert.deepEqual(r.meetings.map((m) => [m.externalId, m.link ?? null]), [
      ["904", null],
      ["921", "https://us02web.zoom.us/j/84444444444?pwd=xyz"],
      ["905", "https://zoom.us/j/85512345678?pwd=135790"],
      ["405", null],
    ]);
    assert.ok(hits.includes("/api/v2/PublicPortal/ListArchivedMeetings?year=2026"));
    // Agendas read only for upcoming meetings without a link (905, 405), not the past one.
    assert.deepEqual(hits.filter((h) => h.startsWith("/Portal/")).sort(), ["/Portal/Meeting?meetingTemplateId=2021", "/Portal/Meeting?meetingTemplateId=4481"]);
  });

  it("config and errors", async (t) => {
    assert.throws(() => primegov.validate({ baseUrl: "https://example.com" }), /PrimeGov portal/);
    assert.equal(primegov.validate({ baseUrl: "https://saanichca.primegov.com/public/portal" }).baseUrl, SAANICH);
    assert.throws(() => primegov.validate({ baseUrl: SAANICH, timezone: "Nowhere/Land" }), /timezone/);
    const { base } = await portal(t, upcoming);
    const c = primegov.validate({ baseUrl: base + "/nope/", allowOtherHost: true });
    await assert.rejects(primegov.fetch({ ...c, baseUrl: base + "/nope/" }, feedContext({ tz: TZ, label: "t" })), /HTTP 404/);
  });
});
