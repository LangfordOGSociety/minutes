/**
 * #13: the eScribe parser against fixtures saved from Langford's portal
 * (2026-11-25): the calendar JSON for Nov 2026 - Jan 2027 and the HTML
 * agenda of the 2026-11-24 council meeting. A fixed "now" keeps the
 * tests independent of the date they run on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { feedContext } from "../src/feeds/context.js";
import { calendarToMeetings, decodeEntities, escribe, textOf, typeFilter } from "../src/feeds/parsers/escribe.js";
import type { HasAfter } from "./helpers.js";

const FIX = path.resolve("test/fixtures/feeds/escribe");
const TZ = "America/Vancouver";
const calendar = readFileSync(path.join(FIX, "calendar.json"), "utf8");
const agenda = readFileSync(path.join(FIX, "agenda-b3e00e65.html"), "utf8");

/** A fake portal: the calendar endpoint and one agenda. */
async function portal(t: HasAfter) {
  const seen: { method: string; url: string; body: string }[] = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.method === "POST" && req.url === "/MeetingsCalendarView.aspx/GetCalendarMeetings") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(calendar);
      }
      if (req.url?.startsWith("/Meeting.aspx?Id=b3e00e65-8200-4120-b0bd-ebbdbe192c08&Agenda=Agenda")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(agenda);
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

describe("escribe", () => {
  it("calendar rows: times, bodies, cancellations (not postponements), agendas", () => {
    const rows = JSON.parse(calendar).d;
    const ms = calendarToMeetings(rows, { baseUrl: "https://pub-langford.escribemeetings.com/", tz: TZ, meetingTypes: [] });
    assert.deepEqual(ms.map((m) => [m.start.toISOString(), m.title, m.cancelled ?? false]), [
      ["2026-11-03T01:30:00.000Z", "Special Inaugural Council Meeting", false],
      ["2026-11-03T02:00:00.000Z", "Inaugural Council Meeting", true],          // "Inaugural Council Meeting Cancellation Notice"
      ["2026-11-10T02:00:00.000Z", "Sustainable Development Advisory Committee", true],
      ["2026-11-18T00:30:00.000Z", "Special Council Meeting", false],
      ["2026-11-25T00:30:00.000Z", "Council Meeting", false],                   // had a "Postponement Notice", went ahead
      ["2026-11-25T02:00:00.000Z", "Community Advisory Committee", true],
      ["2026-12-09T00:30:00.000Z", "Council Meeting", false],
    ]);
    const nov24 = ms.find((m) => m.externalId === "b3e00e65-8200-4120-b0bd-ebbdbe192c08")!;
    assert.equal(nov24.body, "Council Meeting");
    assert.equal(nov24.end?.toISOString(), "2026-11-25T01:30:00.000Z");
    assert.equal(nov24.agendaUrl, "https://pub-langford.escribemeetings.com/Meeting.aspx?Id=b3e00e65-8200-4120-b0bd-ebbdbe192c08&Agenda=Agenda&lang=English");
    assert.equal(nov24.pageUrl, nov24.agendaUrl);
    // Only the chosen types.
    const council = calendarToMeetings(rows, { baseUrl: "https://x.escribemeetings.com/", tz: TZ, meetingTypes: ["council meeting"] });
    assert.deepEqual(council.map((m) => m.start.toISOString()), ["2026-11-25T00:30:00.000Z", "2026-12-09T00:30:00.000Z"]);
  });

  it("fetch: one calendar POST for the window, agendas only for upcoming meetings, the Zoom ID from the agenda", async (t) => {
    const { base, seen } = await portal(t);
    const c = escribe.validate({ baseUrl: base + "/?fillWidth=1", allowOtherHost: true, daysBack: 30, daysAhead: 60 });
    const ctx = feedContext({ tz: TZ, now: new Date("2026-11-24T16:00:00Z"), label: "t" });
    const r = await escribe.fetch(c, ctx);
    assert.ok("meetings" in r);
    const nov24 = r.meetings.find((m) => m.externalId === "b3e00e65-8200-4120-b0bd-ebbdbe192c08")!;
    // Langford's agenda: "Enter the Meeting ID: 843 4290 9811" (a webinar, no passcode).
    assert.equal(nov24.link, "https://zoom.us/j/84342909811");
    assert.equal(r.meetings.filter((m) => m.link).length, 1);
    const post = seen.find((x) => x.method === "POST")!;
    assert.deepEqual(JSON.parse(post.body), { calendarStartDate: "2026-10-25", calendarEndDate: "2027-01-23" });
    // Past meetings' and cancelled meetings' agendas aren't read.
    assert.deepEqual(seen.filter((x) => x.method === "GET").map((x) => x.url.split("&")[0]), ["/Meeting.aspx?Id=b3e00e65-8200-4120-b0bd-ebbdbe192c08"]);
    assert.match(ctx.lines.join("\n"), /7 meeting\(s\), 1 agenda\(s\) read/);
  });

  it("meeting types: one per line, or comma-separated on one line (as first configured on Langford)", () => {
    const rows = JSON.parse(calendar).d;
    const opts = { baseUrl: "https://x.escribemeetings.com/", tz: TZ };
    const oneLine = calendarToMeetings(rows, { ...opts, meetingTypes: ["Council Meeting, Special Council Meeting, Committee of the Whole Meeting"] });
    const perLine = calendarToMeetings(rows, { ...opts, meetingTypes: ["Council Meeting", "Special Council Meeting", "Committee of the Whole Meeting"] });
    assert.deepEqual(oneLine.map((m) => m.externalId), perLine.map((m) => m.externalId));
    assert.deepEqual(perLine.map((m) => m.title), ["Special Council Meeting", "Council Meeting", "Council Meeting"]);
    // A type with commas in its name stays whole when it's a real type.
    const parks = "Parks, Recreation, Culture and Beautification Committee";
    assert.deepEqual([...typeFilter([parks], [parks, "Council Meeting"])], [parks.toLowerCase()]);
    assert.ok(typeFilter(["Council Meeting,  Board of Variance"], ["Council Meeting"]).has("board of variance"));
  });

  it("says which types exist when the filter leaves nothing", async (t) => {
    const { base } = await portal(t);
    const c = escribe.validate({ baseUrl: base, allowOtherHost: true, meetingTypes: ["Regular Council"], daysBack: 30, daysAhead: 60 });
    const ctx = feedContext({ tz: TZ, now: new Date("2026-11-24T16:00:00Z"), label: "t" });
    const r = await escribe.fetch(c, ctx);
    assert.deepEqual("meetings" in r && r.meetings, []);
    assert.match(ctx.lines.join("\n"), /none of the 7 meeting\(s\) in this window are of the chosen types; types here: Community Advisory Committee \| Council Meeting \| /);
  });

  it("errors and config", async (t) => {
    const { base } = await portal(t);
    assert.throws(() => escribe.validate({ baseUrl: "https://example.com" }), /eScribe portal/);
    assert.equal(escribe.validate({ baseUrl: "https://pub-langford.escribemeetings.com/?fillWidth=1" }).baseUrl, "https://pub-langford.escribemeetings.com/");
    const c = escribe.validate({ baseUrl: base + "/nope/", allowOtherHost: true });
    await assert.rejects(escribe.fetch({ ...c, baseUrl: base + "/nope/" }, feedContext({ tz: TZ, label: "t" })), /HTTP 404/);
  });

  it("text helpers", () => {
    assert.equal(decodeEntities("Parks, Recreation &amp; Culture &#8211; &#x2019;s"), "Parks, Recreation & Culture – ’s");
    assert.match(textOf(agenda), /Enter the Meeting ID: 843 4290 9811/);
    assert.doesNotMatch(textOf("<script>var x = 'Meeting ID: 1'</script><p>hi</p>"), /Meeting ID/);
  });
});
