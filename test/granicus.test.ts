/**
 * #34: the Granicus parser. Fixtures (2026-11-25, trimmed to the upcoming
 * table): Pittsburgh's ViewPublisher with upcoming events, Saanich's with
 * none listed. Saanich-style upcoming rows are built from its archive rows'
 * markup.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { feedContext } from "../src/feeds/context.js";
import { granicus, rowsToMeetings, upcomingRows } from "../src/feeds/parsers/granicus.js";
import type { HasAfter } from "./helpers.js";

const FIX = path.resolve("test/fixtures/feeds/granicus");
const pittsburgh = readFileSync(path.join(FIX, "pittsburgh-upcoming.html"), "utf8");
const saanichEmpty = readFileSync(path.join(FIX, "saanich-no-upcoming.html"), "utf8");

/** Saanich's page with two upcoming events, in its archive rows' markup.
 *  Links are relative here (Saanich's are //saanich.ca.granicus.com/...),
 *  so they resolve to the test server: no real network in tests. */
const saanichUpcoming = saanichEmpty.replace(/<tr>\s*<td class="listItem" colspan="4"[\s\S]*?<\/tr>/, `
  <tr class="listingRow"><td class="listItem" headers="Name" scope="row">Council Meeting</td>
    <td class="listItem" headers="Date">Dec&nbsp;7,&nbsp;2026 - 06:00&nbsp;PM</td>
    <td class="listItem"><a href="/AgendaViewer.php?view_id=1&amp;event_id=901" target="_blank">Agenda</a></td>
    <td class="listItem"><a href="javascript:void(0);" onclick="window.open('/MediaPlayer.php?view_id=1&amp;event_id=901','player')">Video</a> <a href="/MediaPlayer.php?view_id=1&amp;event_id=901">Watch</a></td></tr>
  <tr class="listingRow"><td class="listItem" headers="Name" scope="row">Committee of the Whole - CANCELLED</td>
    <td class="listItem" headers="Date">Dec&nbsp;14,&nbsp;2026 - 06:00&nbsp;PM</td><td class="listItem">&nbsp;</td><td class="listItem">&nbsp;</td></tr>`);

async function site(t: HasAfter, page: string) {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url?.startsWith("/ViewPublisher.php?view_id=1")) {
      if (req.headers["if-none-match"] === '"p1"') { res.writeHead(304); return res.end(); }
      res.writeHead(200, { "content-type": "text/html", etag: '"p1"' });
      return res.end(page);
    }
    if (req.url?.startsWith("/AgendaViewer.php")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><body><p>Join electronically: Zoom Meeting ID: 821 1234 5678 Passcode: 246810</p></body></html>");
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits };
}

describe("granicus", () => {
  it("Pittsburgh's upcoming table: names, local times (not the hidden timestamp), agenda links", () => {
    const ms = rowsToMeetings(upcomingRows(pittsburgh), { baseUrl: "https://pittsburgh.granicus.com/", tz: "America/New_York" });
    assert.deepEqual(ms.map((m) => [m.start.toISOString(), m.title.slice(0, 40), m.agendaUrl ?? null]), [
      ["2026-11-30T19:30:00.000Z", "Committee on Hearings and Policy: Bills ", "https://pittsburgh.granicus.com/AgendaViewer.php?view_id=2&event_id=3042"],
      ["2026-12-01T15:00:00.000Z", "City Council", null],
      ["2026-12-01T18:30:00.000Z", "Committee on Hearings and Policy: BUDGET", null],
      ["2026-12-07T15:00:00.000Z", "Post Agenda: 3rd Quarter Financial Repor", "https://pittsburgh.granicus.com/AgendaViewer.php?view_id=2&event_id=3056"],
      ["2026-12-10T15:00:00.000Z", "Committee on Hearings and Policy: Tax, B", "https://pittsburgh.granicus.com/AgendaViewer.php?view_id=2&event_id=3050"],
      ["2026-12-14T15:00:00.000Z", "Post Agenda: Gun Violence in Pittsburgh ", "https://pittsburgh.granicus.com/AgendaViewer.php?view_id=2&event_id=3058"],
    ]);
    // Stable ids: same row, same id; the decoded "&" in names.
    assert.equal(new Set(ms.map((m) => m.externalId)).size, 6);
    assert.deepEqual(rowsToMeetings(upcomingRows(pittsburgh), { baseUrl: "https://pittsburgh.granicus.com/", tz: "America/New_York" }).map((m) => m.externalId), ms.map((m) => m.externalId));
    assert.match(ms[0].title, /Wabash Park & Field/);
  });

  it("Saanich: nothing listed -> no meetings; listed -> watch page, agenda's Zoom ID, cancelled", async (t) => {
    assert.equal(upcomingRows(saanichEmpty).length, 1);   // "Currently there are no Upcoming Events"
    assert.deepEqual(rowsToMeetings(upcomingRows(saanichEmpty), { baseUrl: "https://saanich.ca.granicus.com/", tz: "America/Vancouver" }), []);

    const { base, hits } = await site(t, saanichUpcoming);
    const c = granicus.validate({ baseUrl: base, allowOtherHost: true, timezone: "America/Vancouver" });
    const ctx = feedContext({ tz: "UTC", label: "t" });
    const r = await granicus.fetch(c, ctx);
    assert.ok("meetings" in r);
    assert.deepEqual(r.meetings.map((m) => [m.title, m.start.toISOString(), m.link ?? null, m.pageUrl ?? null, !!m.cancelled]), [
      ["Council Meeting", "2026-12-08T01:00:00.000Z", "https://zoom.us/j/82112345678?pwd=246810",
        `${base}/MediaPlayer.php?view_id=1&event_id=901`, false],
      ["Committee of the Whole - CANCELLED", "2026-12-15T01:00:00.000Z", null, null, true],
    ]);
    assert.equal(r.meetings[0].streamUrl, `${base}/MediaPlayer.php?view_id=1&event_id=901`);
    assert.equal(r.meetings[1].streamUrl, undefined);
    // One agenda read (not the cancelled meeting's; it has none anyway), then a 304.
    assert.deepEqual(hits.map((h) => h.split("?")[0]), ["/ViewPublisher.php", "/AgendaViewer.php"]);
    const again = await granicus.fetch(c, feedContext({ tz: "UTC", label: "t", cache: ctx.cache }));
    assert.deepEqual(again, { notModified: true });
  });

  it("config", () => {
    assert.throws(() => granicus.validate({ baseUrl: "https://example.com" }), /Granicus site/);
    const c = granicus.validate({ baseUrl: "https://saanich.ca.granicus.com/ViewPublisher.php?view_id=7" });
    assert.deepEqual([c.baseUrl, c.viewId, c.timezone], ["https://saanich.ca.granicus.com/", 7, undefined]);
    assert.throws(() => granicus.validate({ baseUrl: "https://saanich.ca.granicus.com", timezone: "Mars/Olympus" }), /timezone/);
  });
});
