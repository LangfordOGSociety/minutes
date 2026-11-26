/**
 * #21: the YouTube channel feed. Fixtures are trimmed from real pages saved
 * 2026-11-26 (NASA's /streams tab, and three watch pages).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { feedCommand } from "../src/feeds/cli.js";
import { feedContext } from "../src/feeds/context.js";
import { fixtureResolver } from "../src/feeds/fixture.js";
import { ConfigError } from "../src/feeds/types.js";
import { candidates, pageJson, streamsUrl, watchInfo, youtubeChannel } from "../src/feeds/parsers/youtube.js";
import { findLink } from "../src/platforms/registry.js";

const FIX = path.resolve("test/fixtures/feeds/youtube");
const read = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const NOW = new Date("2026-11-26T07:00:00Z");
const routes = [`/@NASA/streams=${FIX}/streams.html`, ...["YLrybIli73I", "nCJQZHBkSsU", "ROboUHfPUrU"].map((v) => `watch?v=${v}=${FIX}/watch-${v}.html`)];

describe("channel input", () => {
  it("URLs, handles and ids become the /streams tab; anything else is refused", () => {
    const want = "https://www.youtube.com/@NASA/streams";
    for (const ok of ["https://www.youtube.com/@NASA", "https://youtube.com/@NASA/", "https://www.youtube.com/@NASA/streams", "https://www.youtube.com/@NASA/videos", "@NASA", " @NASA "]) assert.equal(streamsUrl(ok), want, ok);
    assert.equal(streamsUrl("UCLA_DiR1FfKNvjuUpBHmylQ"), "https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/streams");
    assert.equal(streamsUrl("https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ"), "https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/streams");
    assert.equal(streamsUrl("https://www.youtube.com/c/CityCouncil"), "https://www.youtube.com/c/CityCouncil/streams");
    for (const bad of ["", "NASA", "https://www.youtube.com/watch?v=4xDzrJKXOOY", "https://www.youtube.com/playlist?list=PL1", "https://evil.example/@NASA", "https://youtube.com.evil.example/@NASA",
      "https://user:pw@www.youtube.com/@NASA", "http://www.youtube.com/@NASA", "https://www.youtube.com:8443/@NASA", "https://www.youtube.com/@NASA/../x", "ftp://www.youtube.com/@NASA"]) {
      assert.throws(() => streamsUrl(bad), ConfigError, bad);
    }
    assert.throws(() => youtubeChannel.validate({}), /channel: is required/);
    assert.deepEqual(youtubeChannel.validate({ channel: "@NASA", titleFilter: "Council\nBudget", maxVideos: "5" }), { channel: "@NASA", titleFilter: ["Council", "Budget"], maxVideos: 5 });
    assert.throws(() => youtubeChannel.validate({ channel: "@NASA", maxVideos: 99 }), /maxVideos/);
  });
});

describe("reading YouTube's page data", () => {
  it("pageJson finds the object even with braces and escapes in strings", () => {
    assert.deepEqual(pageJson('<script>var ytInitialData = {"a": "}{\\"x\\"", "b": [1, {"c": 2}]};</script>', "ytInitialData"), { a: '}{"x"', b: [1, { c: 2 }] });
    assert.equal(pageJson("<html>nothing</html>", "ytInitialData"), null);
    assert.equal(pageJson('var ytInitialData = {"broken": ', "ytInitialData"), null);
  });

  it("the channel tab: live and upcoming videos only, not the past ones", () => {
    const c = candidates(pageJson(read("streams.html"), "ytInitialData"));
    assert.deepEqual(c.map((x) => [x.id, x.live, x.upcoming]), [["YLrybIli73I", false, true], ["nCJQZHBkSsU", false, true], ["ROboUHfPUrU", true, false]]);   // 6S12L4yVqSI was "Streamed 10d ago"
    assert.match(c[0].title, /Commercial Resupply Services 25/);
  });

  it("the older videoRenderer layout still works, with its start time", () => {
    const old = { contents: [{ videoRenderer: { videoId: "abcdefghijk", title: { runs: [{ text: "Council" }] }, upcomingEventData: { startTime: "1795965900" }, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: "UPCOMING" } }] } },
      { videoRenderer: { videoId: "lmnopqrstuv", title: { simpleText: "Live now" }, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: "LIVE" } }] } },
      { videoRenderer: { videoId: "wxyzABCDEFG", title: { simpleText: "Old" }, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: "DEFAULT" } }] } }] };
    const c = candidates(old);
    assert.deepEqual(c.map((x) => [x.id, x.live, x.upcoming, x.start?.toISOString() ?? null]), [["abcdefghijk", false, true, "2026-11-29T15:25:00.000Z"], ["lmnopqrstuv", true, false, null]]);
    assert.deepEqual(candidates({ lockupViewModel: { contentId: "not-an-id" } }), []);
  });

  it("a watch page: the real start time (not the viewer's local text), live or not", () => {
    const up = watchInfo(read("watch-YLrybIli73I.html"))!;
    assert.deepEqual([up.start?.toISOString(), up.live, up.upcoming, up.unavailable], ["2026-11-29T15:25:00.000Z", false, true, undefined]);
    const live = watchInfo(read("watch-ROboUHfPUrU.html"))!;
    assert.deepEqual([live.start?.toISOString(), live.live], ["2026-10-22T14:57:23.000Z", true]);
    // Only the offline slate's epoch: still found.
    const slate = `var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { isUpcoming: true }, playabilityStatus: { status: "LIVE_STREAM_OFFLINE", liveStreamability: { liveStreamabilityRenderer: { offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: "1795965900" } } } } } })};`;
    assert.equal(watchInfo(slate)!.start?.toISOString(), "2026-11-29T15:25:00.000Z");
    assert.match(watchInfo(`var ytInitialPlayerResponse = ${JSON.stringify({ playabilityStatus: { status: "ERROR", reason: "Video unavailable" } })};`)!.unavailable!, /unavailable/);
    assert.equal(watchInfo("<html>consent</html>"), null);
  });
});

describe("the YouTube channel parser", () => {
  const run = (config: object, fx = routes) => {
    const ctx = feedContext({ tz: "America/Vancouver", now: NOW, label: "t", fixtures: fixtureResolver({ routes: fx }) });
    return youtubeChannel.fetch(youtubeChannel.validate(config), ctx).then((r) => ({ r, ctx }));
  };

  it("upcoming streams with real start times and the watch link; a 24/7 live loop is skipped", async () => {
    const { r, ctx } = await run({ channel: "https://www.youtube.com/@NASA" });
    assert.ok("meetings" in r);
    assert.deepEqual(r.meetings.map((m) => [m.externalId, m.start.toISOString(), m.link, m.streamUrl === m.link, m.pageUrl === m.link]), [
      ["YLrybIli73I", "2026-11-29T15:25:00.000Z", "https://www.youtube.com/watch?v=YLrybIli73I", true, true],
      ["nCJQZHBkSsU", "2026-11-26T11:30:00.000Z", "https://www.youtube.com/watch?v=nCJQZHBkSsU", true, true]]);
    assert.match(r.meetings[0].title, /Commercial Resupply/);
    assert.ok(ctx.lines.some((l) => /ROboUHfPUrU.*live since 2026-10-22, skipped \(a 24\/7 stream\)/.test(l)), ctx.lines.join("\n"));
    assert.ok(r.meetings.every((m) => findLink(m.link!) === m.link), "the platform takes the links");
    assert.equal(r.meetings.every((m) => m.body === undefined), true);
  });

  it("a stream that just went live is kept; the title filter and the cap apply", async () => {
    const justLive = new Date("2026-10-22T15:30:00Z");
    const ctx = feedContext({ tz: "UTC", now: justLive, label: "t", fixtures: fixtureResolver({ routes }) });
    const r = await youtubeChannel.fetch(youtubeChannel.validate({ channel: "@NASA" }), ctx);
    assert.ok("meetings" in r && r.meetings.some((m) => m.externalId === "ROboUHfPUrU"));
    const f = await run({ channel: "@NASA", titleFilter: ["progress"] });
    assert.deepEqual("meetings" in f.r && f.r.meetings.map((m) => m.externalId), ["nCJQZHBkSsU"]);
    const capped = await run({ channel: "@NASA", maxVideos: 1 });
    assert.deepEqual("meetings" in capped.r && capped.r.meetings.map((m) => m.externalId), ["YLrybIli73I"]);
  });

  it("when YouTube's pages aren't what we expect, it fails loudly or skips one, never returns an empty list quietly", async () => {
    await assert.rejects(run({ channel: "@NASA" }, [`/@NASA/streams=${FIX}/watch-YLrybIli73I.html`]), /didn't return the channel's streams as expected/);
    // A watch page we can't read: that stream is skipped with a log line, the rest still come through.
    const { r, ctx } = await run({ channel: "@NASA" }, [`/@NASA/streams=${FIX}/streams.html`, `watch?v=YLrybIli73I=${FIX}/watch-YLrybIli73I.html`, `watch?v=nCJQZHBkSsU=${FIX}/streams.html`]);
    assert.deepEqual("meetings" in r && r.meetings.map((m) => m.externalId), ["YLrybIli73I"]);
    assert.ok(ctx.lines.some((l) => /nCJQZHBkSsU.*no player data/.test(l)));
    // A request nobody provided a fixture for fails by name.
    await assert.rejects(run({ channel: "@NASA" }, [`/@NASA/streams=${FIX}/streams.html`]).then(({ r: x, ctx }) => { assert.ok("meetings" in x && x.meetings.length === 0); return Promise.reject(new Error(ctx.lines.join("\n"))); }), /no fixture for GET https:\/\/www\.youtube\.com\/watch/);
  });

  it("through `minutes feed test`, offline", async () => {
    const lines: string[] = [];
    const code = await feedCommand(["test", "youtube", "--config", '{"channel": "https://www.youtube.com/@NASA"}', ...routes.flatMap((r) => ["--route", r]), "--now", "2026-11-26T07:00:00Z", "--tz", "America/Vancouver", "--strict"], (s) => lines.push(s));
    assert.equal(code, 0, lines.join("\n"));
    const text = lines.join("\n");
    assert.match(text, /^2026-11-26 03:30  Progress 97 Cargo Ship Docking/m);
    assert.match(text, /join link: YouTube/);
    assert.match(text, /2 meeting\(s\): 2 with a join link, 2 with a stream page/);
  });
});
