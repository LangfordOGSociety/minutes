/**
 * #12: the iCal and generic HTML parsers, and finding join links in text.
 * Fixtures in test/fixtures/feeds/.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { chromium } from "playwright";
import { feedContext } from "../src/feeds/context.js";
import { html, parseLooseDate, rowsToMeetings } from "../src/feeds/parsers/html.js";
import { ical, parseIcs } from "../src/feeds/parsers/ical.js";
import { findLink } from "../src/platforms/registry.js";
import type { HasAfter } from "./helpers.js";

const FIX = path.resolve("test/fixtures/feeds");
const TZ = "America/Vancouver";

async function serve(t: HasAfter, files: Record<string, { type: string; body: string }>) {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const f = files[req.url ?? ""];
    if (!f) { res.writeHead(404); return res.end(); }
    const etag = '"' + f.body.length + '"';
    if (req.headers["if-none-match"] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { "content-type": f.type, etag });
    res.end(f.body);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits };
}

describe("join links in text", () => {
  it("zoom URLs, or Meeting ID + Passcode as printed in agendas", () => {
    assert.equal(findLink("Join: https://us06web.zoom.us/j/84342909811?pwd=abc123."), "https://us06web.zoom.us/j/84342909811?pwd=abc123");
    assert.equal(findLink("Enter the Meeting ID: 843 4290 9811 Dial In: 1-855-703-8985"), "https://zoom.us/j/84342909811");
    assert.equal(findLink("Webinar ID: 843-4290-9811\nPasscode: 429539"), "https://zoom.us/j/84342909811?pwd=429539");
    assert.equal(findLink("Call 1-855-703-8985 or 778 907 2071"), undefined);
    assert.equal(findLink("https://teams.microsoft.com/l/meetup-join/x"), undefined);
  });

  it("zoom's public URL drops the passcode", async () => {
    const { zoom } = await import("../src/platforms/zoom.js");
    assert.equal(zoom.publicUrl!("https://us06web.zoom.us/j/84342909811?pwd=abc123"), "https://zoom.us/j/84342909811");
    assert.equal(zoom.publicUrl!("84342909811"), "https://zoom.us/j/84342909811");
  });
});

describe("ical", () => {
  const ics = readFileSync(path.join(FIX, "municipal.ics"), "utf8");
  const from = new Date("2026-11-01T00:00:00Z"), to = new Date("2027-03-01T00:00:00Z");

  it("times, recurrence, exceptions, overrides, links, cancellations", () => {
    const ms = parseIcs(ics, { tz: TZ, from, to, body: "Council" });
    const got = ms.map((m) => [m.externalId, m.title, m.start.toISOString(), m.link ?? null, m.cancelled ?? false]);
    assert.deepEqual(got, [
      ["cotw@example.ca@2026-11-03T19:00", "Committee of the Whole", "2026-11-04T02:00:00.000Z", "https://zoom.us/j/81234567890", false],
      ["board@example.ca@2026-11-10T12:00", "Board of Variance", "2026-11-10T19:00:00.000Z", null, false],
      ["cotw@example.ca@2026-11-17T19:00", "Committee of the Whole", "2026-11-18T02:00:00.000Z", "https://zoom.us/j/81234567890", false],
      ["board@example.ca@2026-12-08T12:00", "Board of Variance", "2026-12-08T19:00:00.000Z", null, false],
      // BC on permanent UTC-7 from Nov 2026: the file's own PST rules (-8) are ignored.
      ["council-2026-12-08@example.ca", "Regular Council Meeting", "2026-12-09T00:30:00.000Z", "https://us06web.zoom.us/j/84342909811?pwd=abc123", false],
      ["cotw@example.ca@2026-12-15T19:00", "Committee of the Whole (moved)", "2026-12-17T01:00:00.000Z", null, true],
      ["cotw@example.ca@2026-12-29T19:00", "Committee of the Whole", "2026-12-30T02:00:00.000Z", "https://zoom.us/j/81234567890", false],
      ["utc@example.ca", "Special Council", "2027-01-05T02:00:00.000Z", null, false],
      ["board@example.ca@2027-01-12T12:00", "Board of Variance", "2027-01-12T19:00:00.000Z", null, false],
      ["cotw@example.ca@2027-01-12T19:00", "Committee of the Whole", "2027-01-13T02:00:00.000Z", "https://zoom.us/j/81234567890", false],
      ["board@example.ca@2027-02-09T12:00", "Board of Variance", "2027-02-09T19:00:00.000Z", null, false],
    ]);
    const council = ms.find((m) => m.externalId.startsWith("council"))!;
    assert.equal(council.pageUrl, "https://example.ca/meetings/council-2026-12-08");
    assert.equal(council.end?.toISOString(), "2026-12-09T02:30:00.000Z");
    assert.equal(council.body, "Council");
  });

  it("the window limits instances", () => {
    const ms = parseIcs(ics, { tz: TZ, from: new Date("2026-12-01T00:00:00Z"), to: new Date("2026-12-31T00:00:00Z") });
    assert.equal(ms.length, 4);
  });

  it("fetches with conditional GET and refuses what isn't a calendar", async (t) => {
    const { base, hits } = await serve(t, {
      "/cal.ics": { type: "text/calendar", body: ics }, "/page": { type: "text/html", body: "<html>nope</html>" } });
    const c = ical.validate({ url: base + "/cal.ics", daysAhead: 400 });
    const cache = {};
    const ctx = feedContext({ tz: TZ, now: from, label: "t", cache });
    const r1 = await ical.fetch(c, ctx);
    assert.ok("meetings" in r1 && r1.meetings.length >= 11);
    const ctx2 = feedContext({ tz: TZ, now: from, label: "t", cache: ctx.cache });
    assert.deepEqual(await ical.fetch(c, ctx2), { notModified: true });
    await assert.rejects(ical.fetch(ical.validate({ url: base + "/page" }), feedContext({ tz: TZ, label: "t" })), /iCalendar/);
    assert.equal(hits.length, 3);
    assert.throws(() => ical.validate({ url: "nope" }), /url: must be a URL/);
  });
});

describe("html dates and rows", () => {
  it("reads dates loosely, needs a time", () => {
    const cases: [string, string | null][] = [
      ["Dec 8, 2026 5:30 p.m.", "2026-12-8 17:30"],
      ["Tuesday, December 8th, 2026 at 7 PM", "2026-12-8 19:00"],
      ["8 December 2026 19:00", "2026-12-8 19:00"],
      ["2026-12-08 noon", "2026-12-8 12:00"],
      ["12/08/2026 9:00 am", "2026-12-8 9:00"],
      ["Sept. 3, 2027 - 12:30 PM", "2027-9-3 12:30"],
      ["Dec 8, 2026", null],
      ["sometime soon", null],
    ];
    for (const [s, want] of cases) {
      const d = parseLooseDate(s);
      assert.equal(d ? `${d.y}-${d.mo}-${d.d} ${d.h}:${String(d.mi).padStart(2, "0")}` : null, want, s);
    }
    assert.deepEqual(parseLooseDate("08/12/2026 18:00", "DMY"), { y: 2026, mo: 12, d: 8, h: 18, mi: 0 });
  });

  it("rows to meetings: links, pages, cancelled, skipped", () => {
    const log: string[] = [];
    const ms = rowsToMeetings([
      { title: "Council", date: "Dec 8, 2026", time: "5:30 PM", href: "https://example.ca/m/1", text: "Council Dec 8" },
      { title: "COTW", date: "Dec 15, 2026", time: "7 PM", href: "https://zoom.us/j/81234567890?pwd=777888", text: "" },
      { title: "Board (Cancelled)", date: "Dec 9, 2026 noon", time: "", href: "", text: "Board (Cancelled)" },
      { title: "Parks", date: "Dec 10, 2026", time: "TBD", href: "", text: "Parks" },
    ], { tz: TZ, order: "MDY", log: (m) => log.push(m) });
    assert.deepEqual(ms.map((m) => [m.title, m.start.toISOString(), m.link ?? null, m.pageUrl ?? null, !!m.cancelled]), [
      ["Council", "2026-12-09T00:30:00.000Z", null, "https://example.ca/m/1", false],
      ["COTW", "2026-12-16T02:00:00.000Z", "https://zoom.us/j/81234567890?pwd=777888", null, false],
      ["Board (Cancelled)", "2026-12-09T19:00:00.000Z", null, null, true],
    ]);
    assert.equal(ms[0].externalId, "https://example.ca/m/1");
    assert.match(log[0], /Parks/);
  });

  it("validates selectors and order", () => {
    assert.throws(() => html.validate({ url: "https://x.ca", row: "tr", title: "td" }), /date: is required/);
    assert.throws(() => html.validate({ url: "https://x.ca", row: "tr", title: "td", date: "td", order: "XYZ" }), /order/);
  });
});

const noChromium = existsSync(chromium.executablePath()) ? false : process.env.CI ? (() => { throw new Error("Chromium is required in CI"); })() : "Playwright Chromium not installed";

describe("html in Chromium", { skip: noChromium }, () => {
  it("reads the rendered page, incl. rows added by script", async (t) => {
    const page = readFileSync(path.join(FIX, "meetings.html"), "utf8");
    const { base } = await serve(t, { "/meetings": { type: "text/html", body: page } });
    const c = html.validate({ url: base + "/meetings", row: "table.meetings tbody tr", title: "td:nth-child(1)", date: "td:nth-child(2)",
      time: "td:nth-child(3)", link: "a", body: "Council" });
    const ctx = feedContext({ tz: TZ, label: "t" });
    try {
      const r = await html.fetch(c, ctx);
      assert.ok("meetings" in r);
      assert.deepEqual(r.meetings.map((m) => [m.title, m.start.toISOString(), m.link ?? null, m.pageUrl ?? null, !!m.cancelled]), [
        ["Regular Council", "2026-12-09T00:30:00.000Z", null, base + "/meetings/101", false],
        ["Committee of the Whole", "2026-12-16T02:00:00.000Z", "https://zoom.us/j/81234567890?pwd=777888", null, false],
        ["Board of Variance (CANCELLED)", "2027-01-12T19:00:00.000Z", null, base + "/meetings/103", true],
        ["Special Council", "2027-01-27T01:00:00.000Z", null, base + "/meetings/105", false],
      ]);
      assert.ok(ctx.lines.some((l) => /Parks Committee/.test(l)));
    } finally {
      await ctx.close();
    }
  });
});
