/**
 * The Granicus video platform: archived clips are imported at once (any
 * date), events are waited for. Links, the page's playlist (fixture saved
 * from a real Saanich clip), the session, a past start for an archive, and
 * the runner finishing when a finished video has been read.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openDb } from "../src/db.js";
import { Scheduler } from "../src/jobs.js";
import { PLATFORMS, checkLink, findLink, isArchive, platformFor } from "../src/platforms/registry.js";
import { GranicusSession, UA, granicus, playlistOf, refOf, safePlaylist, type Fetched } from "../src/platforms/granicus.js";
import { State, type Platform } from "../src/platforms/types.js";
import { Capture, type Config } from "../src/runner.js";
import { need, tmpDir } from "./helpers.js";

const FIX = path.resolve("test/fixtures/granicus");
const page = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const CLIP = "https://saanich.ca.granicus.com/player/clip/1356";
const PLAYLIST = "https://archive-stream.ca.granicus.com/OnDemand/_definst_/mp4:archive/gstore/saanich/saanich_7117e972-de9d-4e7a-9b5f-e4ccd45e4f54.mp4/playlist.m3u8";

describe("Granicus links", () => {
  it("player and MediaPlayer links, clip or event, on a city's own site; nothing look-alike", () => {
    const ok: [string, string, string][] = [
      [CLIP, "clip", "1356"], [`${CLIP}?view_id=1&redirect=true`, "clip", "1356"], [`${CLIP}/`, "clip", "1356"],
      ["https://saanich.ca.granicus.com/MediaPlayer.php?view_id=1&clip_id=1356", "clip", "1356"],
      ["//saanich.ca.granicus.com/MediaPlayer.php?view_id=1&clip_id=1356", "clip", "1356"],
      ["https://saanich.ca.granicus.com/MediaPlayer.php?view_id=1&event_id=901", "event", "901"],
      ["https://SAANICH.ca.granicus.com/player/event/901", "event", "901"], ["https://pittsburgh.granicus.com/player/clip/42", "clip", "42"],
      ["  https://saanich.ca.granicus.com/player/clip/1356  ", "clip", "1356"],
    ];
    for (const [l, kind, id] of ok) assert.deepEqual([refOf(l)?.kind, refOf(l)?.id, granicus.match(l)], [kind, id, true], l);
    for (const bad of ["", "nope", "https://evil.example/player/clip/1", "https://granicus.com/player/clip/1", "https://saanich.ca.granicus.com.evil.example/player/clip/1",
      "https://notgranicus.com/player/clip/1", "https://x.granicus.com@evil.example/player/clip/1", "https://u:p@saanich.ca.granicus.com/player/clip/1", "https://saanich.ca.granicus.com:8443/player/clip/1",
      "http://saanich.ca.granicus.com/player/clip/1", "https://saanich.ca.granicus.com/player/clip/abc", "https://saanich.ca.granicus.com/player/clip/1/extra", "https://saanich.ca.granicus.com/player/other/1",
      "https://saanich.ca.granicus.com/MediaPlayer.php", "https://saanich.ca.granicus.com/MediaPlayer.php?clip_id=1&event_id=2", "https://saanich.ca.granicus.com/MediaPlayer.php?clip_id=1x",
      "https://saanich.ca.granicus.com/AgendaViewer.php?view_id=1&clip_id=1356", "ftp://saanich.ca.granicus.com/player/clip/1", "https://saanich.ca.granicus.com/player/clip/12345678901"]) {
      assert.equal(granicus.match(bad), false, bad);
      assert.throws(() => granicus.normalize(bad), /not a Granicus video link/, bad);
    }
    assert.equal(granicus.normalize("https://saanich.ca.granicus.com/MediaPlayer.php?view_id=1&clip_id=1356"), CLIP);
    assert.equal(granicus.publicId(CLIP), "saanich clip 1356");
    assert.equal(granicus.publicId("https://saanich.ca.granicus.com/player/event/901"), "saanich event 901");
    assert.equal(granicus.publicUrl!("https://saanich.ca.granicus.com/MediaPlayer.php?view_id=1&clip_id=1356"), CLIP);
    assert.deepEqual([granicus.isArchive!(CLIP), granicus.isArchive!("https://saanich.ca.granicus.com/player/event/901")], [true, false]);
    assert.deepEqual([granicus.methods, granicus.savedLogin], [["stream"], false]);
  });

  it("the registry takes them (Zoom and YouTube keep theirs); an agenda or feed row's link is found", () => {
    assert.equal(platformFor(CLIP)?.id, "granicus");
    assert.equal(platformFor("https://zoom.us/j/84342909811")?.id, "zoom");
    assert.equal(checkLink("https://saanich.ca.granicus.com/MediaPlayer.php?view_id=1&clip_id=1356").link, CLIP);
    assert.deepEqual([isArchive(CLIP), isArchive("https://saanich.ca.granicus.com/player/event/901"), isArchive("https://zoom.us/j/84342909811"), isArchive("nope")], [true, false, false, false]);
    assert.equal(findLink(`<a href="//saanich.ca.granicus.com/MediaPlayer.php?view_id=1&amp;event_id=901">Watch</a>`), "https://saanich.ca.granicus.com/player/event/901");
    assert.equal(findLink("Agenda https://saanich.ca.granicus.com/AgendaViewer.php?view_id=1&clip_id=1356"), undefined);
    assert.equal(findLink("Zoom https://zoom.us/j/84342909811 or https://saanich.ca.granicus.com/player/event/901"), "https://zoom.us/j/84342909811");
  });
});

describe("the player page", () => {
  it("the playlist: video_url, or the page's JSON as a fallback; only http(s) on granicus.com goes to ffmpeg", () => {
    assert.equal(playlistOf(page("player-clip-1356.html")), PLAYLIST);
    assert.equal(playlistOf(page("player-clip-1356.html").replace(/<script>video_url[^]*?<\/script>/, "")), PLAYLIST);        // from the escaped JSON alone
    assert.equal(playlistOf(page("player-event-waiting.html")), null);
    assert.equal(playlistOf(page("player-event-live-GUESSED.html")), "https://live-stream.ca.granicus.com/live/_definst_/saanich_live/playlist.m3u8");
    assert.equal(playlistOf('<script>video_url="javascript:alert(1)"</script>'), null);
    assert.equal(safePlaylist(PLAYLIST), true);
    for (const bad of ["http://archive-stream.ca.granicus.com/x.m3u8", "https://evil.example/x.m3u8", "file:///etc/passwd", "https://granicus.com.evil.example/x.m3u8", "https://u:p@a.granicus.com/x.m3u8", "nope", "https://granicus.com/x.m3u8"]) {
      assert.equal(safePlaylist(bad), false, bad);
    }
  });
});

describe("the session", () => {
  const ok = (body: string, url = CLIP): Fetched => ({ status: 200, url, body });
  const fetcher = (steps: (Fetched | Error)[]) => {
    let i = 0;
    const calls: string[] = [];
    return { fn: (async (u: string) => { calls.push(u); const s = steps[Math.min(i++, steps.length - 1)]; if (s instanceof Error) throw s; return s; }) as never, calls };
  };

  it("a clip is recording-ready at once, read once, and its input says it's finished (once), with the right headers", async () => {
    const f = fetcher([ok(page("player-clip-1356.html"))]);
    let t = 0;
    const s = new GranicusSession(refOf(CLIP)!, { fetchPage: f.fn, now: () => t });
    const changes: string[] = [];
    s.onChange = (x) => changes.push(x);
    await s.open();
    assert.equal(await s.state(), State.IN_MEETING);
    t += 3_600_000;
    assert.equal(await s.state(), State.IN_MEETING);
    assert.deepEqual(f.calls, [CLIP]);                                                                           // fetched once, never again
    assert.deepEqual(changes, ["in_meeting"]);
    const input = s.input();
    assert.equal(input.kind, "stream");
    if (input.kind !== "stream") return;
    assert.deepEqual([input.copy, input.once], [true, true]);
    assert.deepEqual(input.args.slice(0, 4), ["-user_agent", UA, "-headers", "Referer: https://saanich.ca.granicus.com/\r\n"]);
    assert.equal(input.args.at(-1), PLAYLIST);
    assert.equal(input.args.at(-2), "-i");
    assert.match(UA, /^Mozilla\/5\.0 \(compatible; minutes\/0\.2; \+https:\/\/github\.com\//);                      // says who we are, in the form the CDN accepts
  });

  it("an event waits, goes live (not once), and once archived is read like a clip", async () => {
    const f = fetcher([ok(page("player-event-waiting.html")), ok(page("player-event-live-GUESSED.html")), ok(page("player-event-live-GUESSED.html")),
      ok(page("player-clip-1356.html"))]);
    let t = 0;
    const ev = "https://saanich.ca.granicus.com/player/event/901";
    const s = new GranicusSession(refOf(ev)!, { fetchPage: f.fn, now: () => t });
    await s.open();
    assert.equal(await s.state(), State.WAITING);
    t += 31_000;
    assert.equal(await s.state(), State.IN_MEETING);
    const live = s.input();
    assert.ok(live.kind === "stream" && live.once === false);
    t += 20_000; await s.state();
    assert.equal(f.calls.length, 2);                                                                              // live is looked at every minute, not every second
    t += 61_000;
    assert.equal(await s.state(), State.IN_MEETING);
    t += 61_000;
    await s.state();
    const archived = s.input();
    assert.ok(archived.kind === "stream" && archived.once === true);                                              // /OnDemand/: the meeting is archived
  });

  it("not found, off-Granicus redirects, unsafe playlists are INVALID; hiccups keep the state; a clip without video is INVALID", async () => {
    const run = async (r: Fetched | Error) => { const s = new GranicusSession(refOf(CLIP)!, { fetchPage: fetcher([r]).fn }); await s.open(); return s.state(); };
    assert.equal(await run({ status: 404, url: CLIP, body: "" }), State.INVALID);
    assert.equal(await run({ status: 410, url: CLIP, body: "" }), State.INVALID);
    assert.equal(await run(ok(page("player-clip-1356.html"), "https://evil.example/player/clip/1")), State.INVALID);
    assert.equal(await run(ok('<script>video_url="http://archive-stream.ca.granicus.com/x.m3u8"</script>')), State.INVALID);
    assert.equal(await run(ok('<script>video_url="https://evil.example/x.m3u8"</script>')), State.INVALID);
    assert.equal(await run(ok("<html>a clip page with no video</html>")), State.INVALID);
    assert.equal(await run({ status: 503, url: CLIP, body: "" }), State.LOADING);
    assert.equal(await run(new Error("network down")), State.LOADING);
    // A hiccup after it was fine changes nothing.
    let t = 0;
    const live = fetcher([ok(page("player-event-live-GUESSED.html")), new Error("blip")]);
    const s = new GranicusSession(refOf("https://saanich.ca.granicus.com/player/event/901")!, { fetchPage: live.fn, now: () => t });
    await s.open(); t += 61_000;
    assert.equal(await s.state(), State.IN_MEETING);
    assert.throws(() => new GranicusSession(refOf(CLIP)!, { fetchPage: fetcher([ok("nothing")]).fn }).input(), /no video/);
  });
});

describe("a past start for an archive", () => {
  function sched(t: TestContext) {
    const out = mkdtempSync(path.join(os.tmpdir(), "minutes-gr-"));
    const entry = path.join(out, "fake-entry.mjs");
    writeFileSync(entry, `import { mkdirSync, writeFileSync } from "node:fs"; import path from "node:path";
      const a = process.argv; const get = (k) => a[a.indexOf(k) + 1];
      const dir = path.join(get("--out"), get("--slug")); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "args.json"), JSON.stringify(a.slice(2)));
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ outcome: "ended" }));
      setTimeout(() => process.exit(0), 100);`);
    const db = openDb(path.join(out, "minutes.db"));
    const s = new Scheduler({ out, entry, auth: null, defaultName: "Recorder", leadMs: 0, noShowMs: 30 * 60_000, maxConcurrent: 1, width: 1280, height: 720 }, db);
    t.after(async () => { await s.shutdown(); db.close(); rmSync(out, { recursive: true, force: true }); });
    return { s, out };
  }

  it("a clip may be dated any time ago; other links still can't be; the capture is told it's an archive", async (t) => {
    const { s, out } = sched(t);
    assert.throws(() => s.add({ link: "https://zoom.us/j/84342909811", start: "2026-11-23T17:32:00Z", slug: "old-zoom" }), /too far in the past/);
    assert.throws(() => s.add({ link: "https://saanich.ca.granicus.com/player/event/901", start: "2026-11-23T17:32:00Z", slug: "old-event" }), /too far in the past/);
    const j = s.add({ link: "https://saanich.ca.granicus.com/MediaPlayer.php?view_id=1&clip_id=1356", start: "2026-11-23T17:32:00Z", slug: "saanich-council-2026-11-23" });
    assert.equal(s.get(j.id)!.link, CLIP);
    const m = s.meetings.get(j.meetingRef)!;
    assert.deepEqual([m.platform, m.start], ["granicus", "2026-11-23T17:32:00.000Z"]);                             // the meeting keeps its real date
    s.start();
    for (let i = 0; i < 150 && s.get(j.id)!.status !== "done"; i++) await sleep(20);
    assert.equal(s.get(j.id)!.status, "done");
    const args = JSON.parse(readFileSync(path.join(out, "saanich-council-2026-11-23", "args.json"), "utf8")) as string[];
    assert.ok(args.includes("--archive"));
    assert.equal(args[args.indexOf("--start") + 1], "2026-11-23T17:32:00.000Z");
    assert.equal(args[args.indexOf("--method") + 1], "stream");
    // Editing it keeps the allowance only for archives, and a meeting-based schedule is allowed too.
    const j2 = s.add({ link: CLIP.replace("1356", "1357"), start: "2026-12-30T01:00:00Z", slug: "future-clip" });
    assert.throws(() => s.update(j2.id, { link: "https://zoom.us/j/84342909811" }), /that.s a zoom link/i);
  });
});

const skip = need("ffmpeg");
describe("the runner finishes when a finished video has been read", { skip }, () => {
  // A fake archive platform, so the real Capture runs against a local file with real ffmpeg.
  const fake = (src: string): Platform => ({
    id: "fakearchive", label: "Fake archive", methods: ["stream"], savedLogin: false,
    match: (l) => l.startsWith("https://fake.example/"), normalize: (l) => l, publicId: () => "fake", isArchive: () => true,
    create: () => ({
      needsEmail: false, onChange: () => {}, onSpeaker: () => {}, onCaption: () => {},
      open: async () => {}, close: async () => {}, state: async () => State.IN_MEETING, advance: async () => {}, dump: async () => {},
      input: () => ({ kind: "stream" as const, args: ["-i", src], copy: true, once: true }),
    }),
  });
  const config = (out: string, slug: string): Config => ({
    link: "https://fake.example/clip", start: new Date("2026-11-23T17:32:00Z"), slug, out, displayName: "R", auth: null, email: null, debug: false, method: "stream",
    display: "", sink: "", width: 320, height: 240, fps: 15, quality: 30, encoder: "x264", vaapiDevice: "", leadMs: 0, noShowMs: 60_000, archive: true,
    rejoinWaitMs: 60_000, reconnectGraceMs: 5_000, maxDurationMs: 3_600_000, pollMs: 200, retryBaseMs: 100, retryMaxMs: 500, tz: "UTC",
  } as unknown as Config);

  it("reads the whole video once, then ends and stitches (no second part), whatever date it carries", async (t) => {
    const dir = tmpDir(t);
    const src = path.join(dir, "src.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
    (PLATFORMS as Platform[]).push(fake(src));
    t.after(() => { (PLATFORMS as Platform[]).pop(); });
    const code = await new Capture(config(dir, "imported")).run();
    assert.equal(code, 0);
    const m = JSON.parse(readFileSync(path.join(dir, "imported", "manifest.json"), "utf8")) as { outcome: string; parts: unknown[]; output: string; events: { event: string }[] };
    assert.equal(m.outcome, "ended");
    assert.equal(m.parts.length, 1);
    assert.ok(m.events.some((e) => e.event === "archive_read"));
    assert.ok(existsSync(path.join(dir, "imported", m.output)));
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, "imported", m.output)]).toString());
    assert.ok(dur > 2.5 && dur < 4, `${dur}s`);
  });

  it("a video that won't read is given up on after three tries, not retried for ever, and leaves no output", async (t) => {
    const dir = tmpDir(t);
    (PLATFORMS as Platform[]).push(fake(path.join(dir, "missing.mp4")));
    t.after(() => { (PLATFORMS as Platform[]).pop(); });
    const code = await new Capture(config(dir, "broken")).run();
    assert.equal(code, 1);
    const m = JSON.parse(readFileSync(path.join(dir, "broken", "manifest.json"), "utf8")) as { outcome: string; parts: unknown[]; output: string | null; events: { event: string }[] };
    assert.deepEqual([m.outcome, m.parts.length, m.output], ["archive_failed", 0, null]);
    assert.equal(m.events.filter((e) => e.event === "archive_retry").length, 3);
  });
});
