/**
 * #23: `minutes feed test`, a parser run offline from saved files; the
 * fixture resolver; the parser-author lint.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { chromium } from "playwright";
import { feedCommand, lint } from "../src/feeds/cli.js";
import { fixtureResolver } from "../src/feeds/fixture.js";
import type { DetectedMeeting } from "../src/feeds/types.js";

const FIX = path.resolve("test/fixtures/feeds");
async function run(args: string[]) {
  const lines: string[] = [];
  const realErr = console.error, errs: string[] = [];
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  try {
    const code = await feedCommand(args, (s) => lines.push(s));
    return { code, text: lines.join("\n"), err: errs.join("\n") };
  } finally { console.error = realErr; }
}

describe("minutes feed parsers", () => {
  it("lists the built-ins with their config", async () => {
    const r = await run(["parsers"]);
    assert.equal(r.code, 0);
    for (const id of ["ical", "html", "escribe", "granicus", "primegov"]) assert.match(r.text, new RegExp(`^${id}: `, "m"), id);
    assert.match(r.text, /config: baseUrl\* \(url\)/);
  });
});

describe("minutes feed test", () => {
  it("eScribe from saved files: routes answer the calendar and the agenda; join link shown without a passcode", async () => {
    const r = await run(["test", "escribe", "--config", '{"baseUrl": "https://pub-langford.escribemeetings.com", "meetingTypes": ["Council Meeting"]}',
      "--route", `GetCalendarMeetings=${FIX}/escribe/calendar.json`, "--route", `Meeting.aspx=${FIX}/escribe/agenda-b3e00e65.html`,
      "--tz", "America/Vancouver", "--now", "2026-11-24T12:00:00Z"]);        // the 24th is still ahead, so its agenda is read
    assert.equal(r.code, 0, r.err);
    assert.match(r.text, /^2026-11-24 17:30  Council Meeting/m);
    assert.match(r.text, /join link: Zoom 84342909811/);
    assert.doesNotMatch(r.text, /pwd=|zoom\.us/);
    assert.match(r.text, /\d+ meeting\(s\): \d+ with a join link, \d+ with a stream page/);
    assert.match(r.text, /^log: \d+ meeting\(s\)/m);
    assert.equal(r.err, "");
  });

  it("one fixture for every request, --json, and PrimeGov's two endpoints by route", async () => {
    const j = await run(["test", "primegov", "--config", '{"baseUrl": "https://saanichca.primegov.com", "timezone": "America/Vancouver"}',
      "--route", `ListUpcomingMeetings=${FIX}/primegov/upcoming.json`, "--route", `ListArchivedMeetings=${FIX}/primegov/archived-2026-nov.json`,
      "--now", "2026-11-25T12:00:00Z", "--json"]);
    assert.equal(j.code, 0, j.err);
    const d = JSON.parse(j.text) as { meetings: { title: string; start: string; link: string | null }[]; warnings: string[]; log: string[] };
    assert.ok(d.meetings.length > 3);
    assert.ok(d.meetings.every((m) => /^\d{4}-\d\d-\d\dT/.test(m.start)));
    assert.doesNotMatch(j.text, /pwd=/);
    const one = await run(["test", "granicus", "--config", '{"baseUrl": "https://pittsburgh.granicus.com", "timezone": "America/New_York", "agendas": false}',
      "--fixture", `${FIX}/granicus/pittsburgh-upcoming.html`, "--now", "2026-11-25T12:00:00Z", "--tz", "America/New_York"]);
    assert.equal(one.code, 0, one.err);
    assert.match(one.text, /^2026-11-30 14:30  Committee on Hearings and Policy/m);
    assert.match(one.text, /6 meeting\(s\)/);
  });

  it("a missing fixture says which request has none; never a real fetch", async () => {
    const r = await run(["test", "escribe", "--config", '{"baseUrl": "https://pub-langford.escribemeetings.com"}', "--route", `GetCalendarMeetings=${FIX}/escribe/calendar.json`,
      "--now", "2026-11-24T12:00:00Z"]);
    // The calendar is answered, so the agenda reads fail softly inside the parser (it logs them), not as a network call.
    assert.equal(r.code, 0, r.err);
    assert.match(r.text, /agenda for .*no fixture for GET https:\/\/pub-langford\.escribemeetings\.com\/Meeting\.aspx/);
    const none = await run(["test", "ical", "--config", '{"url": "https://example.ca/cal.ics"}', "--fixture", "/nonexistent/x.ics"]);
    assert.equal(none.code, 1);
    assert.match(none.err, /the parser failed: .*ENOENT/);
    const bare = await run(["test", "ical", "--config", '{"url": "https://example.ca/cal.ics"}', "--route", "other=" + FIX + "/municipal.ics"]);
    assert.equal(bare.code, 1);
    assert.match(bare.err, /no fixture for GET https:\/\/example\.ca\/cal\.ics \(give --fixture/);
  });

  it("iCal from a file; refuses bad arguments with a message", async () => {
    const r = await run(["test", "ical", "--config", '{"url": "https://example.ca/cal.ics", "daysAhead": 400}', "--fixture", `${FIX}/municipal.ics`, "--now", "2026-11-01T00:00:00Z", "--tz", "America/Vancouver"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.text, /Regular Council Meeting/);
    assert.match(r.text, /Committee of the Whole \(moved\)  CANCELLED/);
    for (const [args, re] of [
      [["test"], /unknown parser ""/], [["test", "nope"], /unknown parser "nope"; built in: ical/], [["test", "ical", "--config", "{nope"], /--config isn't JSON/],
      [["test", "ical", "--config", "{}"], /config: url: must be a URL/], [["test", "ical", "--config", '{"url":"https://x.ca/c.ics"}', "--now", "soon"], /--now isn't a date/],
      [["test", "ical", "--config", '{"url":"https://x.ca/c.ics"}', "--route", "noequals"], /--route wants <substring>=<file>/], [["wat"], /usage: minutes feed/],
      [["test", "ical", "--bogus"], /Unknown option/],
    ] as [string[], RegExp][]) {
      const e = await run(args);
      assert.equal(e.code, 1, args.join(" "));
      assert.match(e.err, re, args.join(" "));
    }
  });
});

describe("fixture resolver", () => {
  it("first matching route wins, then the fallback; content types by extension", () => {
    const f = fixtureResolver({ fallback: `${FIX}/municipal.ics`, routes: [`GET https://a.ca/x=${FIX}/escribe/calendar.json`, `b.ca=${FIX}/meetings.html`] });
    assert.equal(f("https://a.ca/x", "GET")!.type, "application/json");
    assert.equal(f("https://a.ca/x", "POST")!.type, "text/calendar");         // the route names the method
    assert.equal(f("https://b.ca/page", "GET")!.type, "text/html");
    assert.equal(f("https://c.ca/", "GET")!.type, "text/calendar");
    assert.equal(fixtureResolver({})("https://c.ca/", "GET"), null);
    assert.throws(() => fixtureResolver({ routes: ["=x"] }), /--route wants/);
  });
});

describe("lint", () => {
  const m = (o: Partial<DetectedMeeting>): DetectedMeeting => ({ externalId: "a", title: "T", start: new Date("2026-12-08T01:00:00Z"), ...o });
  const now = new Date("2026-11-25T00:00:00Z");
  it("flags what a parser author should look at", () => {
    assert.deepEqual(lint([m({}), m({ externalId: "b", link: "https://zoom.us/j/84342909811", pageUrl: "https://city.ca/m/1" })], now), []);
    const w = lint([m({}), m({ title: " ", start: new Date("2031-01-01T00:00:00Z"), link: "https://teams.microsoft.com/l/meetup-join/x", end: new Date("2031-01-01T00:00:00Z") }),
      m({ externalId: "c", end: new Date("2026-12-07T00:00:00Z"), streamUrl: "https://x.ca/v?pwd=1", pageUrl: "ftp://x" }), m({ externalId: "d", start: new Date("nope") })], now);
    const want = [/appears 2 times: it must identify ONE meeting/, /empty title/, /over 3 years from now/, /link isn't one any platform takes/,
      /ends before it starts/, /a public URL carries a passcode/, /pageUrl isn't http/, /start isn't a valid date/];
    assert.equal(w.length, want.length, w.join("\n"));
    want.forEach((re, i) => assert.match(w[i], re));
  });
});

const noChromium = existsSync(chromium.executablePath()) ? false : process.env.CI ? (() => { throw new Error("Chromium is required in CI"); })() : "Playwright Chromium not installed";
describe("minutes feed test, pages that need a browser", { skip: noChromium }, () => {
  it("the html parser reads its saved page in Chromium, with no network", async () => {
    const r = await run(["test", "html", "--config", JSON.stringify({ url: "https://city.example/meetings", row: "table.meetings tbody tr", title: "td:nth-child(1)",
      date: "td:nth-child(2)", time: "td:nth-child(3)", link: "a", body: "Council" }), "--fixture", `${FIX}/meetings.html`, "--tz", "America/Vancouver", "--now", "2026-11-25T12:00:00Z"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.text, /Regular Council/);
    assert.match(r.text, /join link: Zoom 81234567890 \(passcode found\)/);
    assert.doesNotMatch(r.text, /pwd=777888/);
  });
});
