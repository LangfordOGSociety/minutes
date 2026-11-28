/**
 * #20: the YouTube stream platform. Links, what yt-dlp's answers mean
 * (fixtures trimmed from a real yt-dlp 2026.10.21 run on a live stream), the
 * session's state machine, the ffmpeg inputs, running a (fake) yt-dlp, and
 * a real two-input recording.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { Recorder, type RecorderOpts } from "../src/recorder.js";
import { checkLink, findLink, platformFor } from "../src/platforms/registry.js";
import { State } from "../src/platforms/types.js";
import { YouTubeSession, classifyError, describeVideo, recorderInput, stateOf, streamsOf, videoIdOf, youtube, type Described, type YtInfo } from "../src/platforms/youtube.js";
import { tmpDir, need } from "./helpers.js";
import { fixtures } from "./fixtures.js";
import { startApp } from "./server.js";

const FIX = path.resolve("test/fixtures/youtube");
const load = (n: string) => JSON.parse(readFileSync(path.join(FIX, `${n}.json`), "utf8")) as YtInfo;
const ID = "4xDzrJKXOOY";

describe("YouTube links", () => {
  it("watch, youtu.be, live and embed links; nothing look-alike", () => {
    for (const ok of [`https://www.youtube.com/watch?v=${ID}`, `https://youtube.com/watch?v=${ID}&t=5s`, `https://m.youtube.com/watch?v=${ID}`, `http://www.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`, `https://youtu.be/${ID}?si=abc`, `https://www.youtube.com/live/${ID}`, `https://www.youtube.com/live/${ID}?feature=share`, `https://www.youtube.com/embed/${ID}`,
      `  https://www.youtube.com/watch?v=${ID}  `]) {
      assert.equal(videoIdOf(ok), ID, ok);
      assert.equal(youtube.match(ok), true, ok);
      assert.equal(youtube.normalize(ok), `https://www.youtube.com/watch?v=${ID}`, ok);
    }
    for (const bad of ["", "nope", ID, `https://youtube.com.evil.example/watch?v=${ID}`, `https://evil.example/watch?v=${ID}`, `https://notyoutube.com/watch?v=${ID}`,
      `https://youtube.com@evil.example/watch?v=${ID}`, `https://user:pw@www.youtube.com/watch?v=${ID}`, `https://www.youtube.com:8443/watch?v=${ID}`,
      "https://www.youtube.com/watch?v=short", "https://www.youtube.com/watch", "https://www.youtube.com/channel/UC123", "https://www.youtube.com/playlist?list=PL123",
      `https://www.youtube.com/watch?v=${ID}x`, `ftp://www.youtube.com/watch?v=${ID}`, `javascript:alert(1)//youtube.com/watch?v=${ID}`, `https://www.youtube.com/live/${ID}/extra`]) {
      assert.equal(youtube.match(bad), false, bad);
      assert.throws(() => youtube.normalize(bad), /not a YouTube video link/, bad);
    }
    assert.equal(youtube.publicId(`https://youtu.be/${ID}`), ID);
    assert.equal(youtube.publicUrl!(`https://youtu.be/${ID}?si=x`), `https://www.youtube.com/watch?v=${ID}`);
  });

  it("the registry takes them (Zoom first), and finds one in an agenda's text", () => {
    assert.equal(platformFor(`https://youtu.be/${ID}`)?.id, "youtube");
    assert.equal(platformFor("https://zoom.us/j/84342909811")?.id, "zoom");
    assert.deepEqual(checkLink(`https://youtu.be/${ID}`).link, `https://www.youtube.com/watch?v=${ID}`);
    assert.throws(() => checkLink("https://vimeo.com/123"), /YouTube/);
    assert.equal(findLink(`Watch live: https://www.youtube.com/watch?v=${ID}&amp;feature=share.`), `https://www.youtube.com/watch?v=${ID}`);
    assert.equal(findLink("Our channel https://www.youtube.com/@city and https://www.youtube.com/channel/UC123"), undefined);
    assert.equal(findLink(`Zoom: https://zoom.us/j/84342909811 or YouTube https://youtu.be/${ID}`), "https://zoom.us/j/84342909811");   // a join link wins
    assert.deepEqual(youtube.methods, ["stream"]);
    assert.equal(youtube.savedLogin, false);
  });
});

describe("what yt-dlp says", () => {
  it("live_status -> State, from the real fixture", () => {
    assert.equal(stateOf(load("live")), State.IN_MEETING);
    assert.equal(stateOf(load("upcoming")), State.WAITING);
    assert.equal(stateOf(load("post-live")), State.ENDED);
    assert.equal(stateOf(load("was-live")), State.ENDED);
    assert.equal(stateOf({ live_status: "not_live" }), State.ENDED);
    assert.equal(stateOf({ live_status: "is_live", requested_formats: [] }), null);     // live, but nothing to read yet
    assert.equal(stateOf({ is_live: true, url: "https://x/y.m3u8", vcodec: "avc1", acodec: "mp4a" }), State.IN_MEETING);
    assert.equal(stateOf({}), null);
  });

  it("the real run's streams: a video playlist and an audio playlist (whose acodec is null)", () => {
    const live = load("live");
    assert.deepEqual(live.requested_formats!.map((f) => [f.format_id, f.vcodec, f.acodec ?? null]), [["270", "avc1.640028", "none"], ["234", "none", null]]);
    const s = streamsOf(live)!;
    assert.match(s.video!, /\/270\.m3u8$/);
    assert.match(s.audio!, /\/234\.m3u8$/);
    assert.equal(s.combined, undefined);
    assert.deepEqual(streamsOf({ requested_formats: [{ url: "https://x/c.m3u8", vcodec: "avc1", acodec: "mp4a" }] }), { combined: "https://x/c.m3u8" });
    assert.deepEqual(streamsOf({ url: "https://x/a.m3u8", vcodec: "none", acodec: "mp4a" }), { audio: "https://x/a.m3u8", video: undefined });
    assert.equal(streamsOf({ requested_formats: [{ url: "javascript:alert(1)" }, { url: "file:///etc/passwd" }] }), null);   // only http(s)
    assert.equal(streamsOf({}), null);
  });

  it("error messages -> what to do", () => {
    const cases: [string, ReturnType<typeof classifyError>][] = [
      ["ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser", "blocked"],
      ["ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate", "blocked"],
      ["ERROR: [youtube] x: Join this channel to get access to members-only content", "blocked"],
      ["ERROR: [youtube] x: This live stream recording is not available.", "ended"],
      ["ERROR: [youtube] x: This live event will begin in 2 hours.", "waiting"],
      ["ERROR: [youtube] x: Premieres in 3 days", "waiting"],
      ["ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", "invalid"],
      ["ERROR: [youtube] x: Video unavailable", "invalid"],
      ["ERROR: [youtube] x: This video has been removed by the uploader", "invalid"],
      ["ERROR: Unsupported URL: https://example.com", "invalid"],
      ["ERROR: unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>", "transient"],
      ["ERROR: HTTP Error 429: Too Many Requests", "transient"], ["", "transient"],
    ];
    for (const [text, want] of cases) assert.equal(classifyError(text), want, text);
  });

  it("sound only by default: one audio input, marked audioOnly (the video is embedded from YouTube)", () => {
    const live = load("live");
    const a = recorderInput(live, { fromStart: false });
    assert.equal(a.kind, "stream");
    if (a.kind !== "stream") return;
    assert.equal(a.audioOnly, true);
    assert.deepEqual(a.map, ["-map", "0:a:0"]);
    assert.equal(a.args.filter((x) => x === "-i").length, 1);
    assert.ok(a.args.some((x) => /audio|^https/.test(x)));
    const start = recorderInput(live, { fromStart: true });
    assert.equal(start.kind === "stream" && start.args.filter((x) => x === "-live_start_index").length, 1);
    // A single combined stream still gives only its sound.
    const one = recorderInput({ requested_formats: [{ url: "https://x/c.m3u8", vcodec: "avc1", acodec: "mp4a" }] }, { fromStart: false });
    assert.deepEqual(one.kind === "stream" && [one.map, one.audioOnly], [["-map", "0:a:0"], true]);
    assert.throws(() => recorderInput({}, { fromStart: false }), /no stream/);
  });

  it("with the picture (YOUTUBE_RECORD=video): two playlists mapped by hand; from the start of the playlist only when asked", () => {
    const live = load("live");
    const now = recorderInput(live, { fromStart: false, video: true });
    assert.equal(now.kind, "stream");
    if (now.kind !== "stream") return;
    assert.equal(now.copy, true);
    assert.deepEqual(now.map, ["-map", "0:v:0", "-map", "1:a:0"]);
    assert.deepEqual(now.args.filter((a) => a === "-i").length, 2);
    assert.ok(!now.args.includes("-live_start_index"));
    assert.equal(now.args.filter((a) => a === "-reconnect").length, 2);
    const start = recorderInput(live, { fromStart: true, video: true });
    assert.equal(start.kind === "stream" && start.args.filter((a) => a === "-live_start_index").length, 2);
    const one = recorderInput({ requested_formats: [{ url: "https://x/c.m3u8", vcodec: "avc1", acodec: "mp4a" }] }, { fromStart: false, video: true });
    assert.deepEqual(one.kind === "stream" && one.map, ["-map", "0:v:0?", "-map", "0:a:0?"]);
    assert.throws(() => recorderInput({}, { fromStart: false, video: true }), /no stream/);
  });
});

describe("the session", () => {
  const script = (steps: Described[]) => {
    let i = 0;
    const calls: number[] = [];
    return { fn: (() => { calls.push(i); const d = steps[Math.min(i++, steps.length - 1)]; return { promise: Promise.resolve(d), kill: () => {} }; }) as never, calls };
  };
  const ok = (name: string): Described => ({ ok: true, info: load(name) });
  const fail = (problem: "blocked" | "invalid" | "ended" | "waiting" | "transient", message = "x"): Described => ({ ok: false, problem, message });

  it("waits while upcoming, records while live, ends after; one yt-dlp call per interval", async () => {
    let t = 1_000_000;
    const s = script([ok("upcoming"), ok("upcoming"), ok("live"), ok("live"), ok("post-live")]);
    const sess = new YouTubeSession(ID, { now: () => t, describeFn: s.fn });
    const changes: string[] = [];
    sess.onChange = (x) => changes.push(x);
    await sess.open();
    assert.equal(await sess.state(), State.WAITING);
    assert.equal(await sess.state(), State.WAITING);                      // same instant: no second call
    assert.equal(s.calls.length, 1);
    t += 21_000;
    assert.equal(await sess.state(), State.WAITING);                      // waiting is polled every 20 s
    t += 21_000;
    assert.equal(await sess.state(), State.IN_MEETING);
    t += 30_000;
    await sess.state();
    assert.equal(s.calls.length, 3);                                      // live is polled every 45 s: not yet
    t += 20_000;
    assert.equal(await sess.state(), State.IN_MEETING);
    t += 46_000;
    assert.equal(await sess.state(), State.ENDED);
    assert.deepEqual(changes, ["waiting", "in_meeting", "ended"]);
  });

  it("a hiccup while recording keeps recording; before that it's loading; blocked and invalid are final states", async () => {
    let t = 0;
    const live = script([ok("live"), fail("transient", "network"), fail("transient"), ok("live")]);
    const a = new YouTubeSession(ID, { now: () => t, describeFn: live.fn });
    await a.open();
    assert.equal(a.state.call(a) instanceof Promise, true);
    assert.equal(await a.state(), State.IN_MEETING);
    t += 50_000; assert.equal(await a.state(), State.IN_MEETING);        // the failed call
    t += 50_000; assert.equal(await a.state(), State.IN_MEETING);
    const early = new YouTubeSession(ID, { now: () => t, describeFn: script([fail("transient")]).fn });
    await early.open();
    assert.equal(await early.state(), State.LOADING);
    for (const [p, want] of [["blocked", State.BLOCKED], ["invalid", State.INVALID], ["ended", State.ENDED], ["waiting", State.WAITING]] as const) {
      const x = new YouTubeSession(ID, { now: () => t, describeFn: script([fail(p)]).fn });
      await x.open();
      assert.equal(await x.state(), want, p);
    }
    // Live but no readable streams yet: not in the meeting.
    const noFormats = new YouTubeSession(ID, { now: () => t, describeFn: script([{ ok: true, info: { live_status: "is_live" } }]).fn });
    await noFormats.open();
    assert.equal(await noFormats.state(), State.LOADING);
  });

  it("starts the first part at the start of the playlist only for a stream already live a while; later parts at the live edge", async () => {
    const info = load("live");
    const at = (secondsAfterRelease: number) => (info.release_timestamp ?? 0) * 1000 + secondsAfterRelease * 1000;
    const early = new YouTubeSession(ID, { now: () => at(30), describeFn: script([ok("live")]).fn });
    await early.open();
    const e = early.input();
    assert.ok(e.kind === "stream" && !e.args.includes("-live_start_index"), "on time: the live edge");
    const late = new YouTubeSession(ID, { now: () => at(3600), describeFn: script([ok("live")]).fn });
    await late.open();
    const first = late.input(), second = late.input();
    assert.ok(first.kind === "stream" && first.args.includes("-live_start_index"), "an hour late: from the start");
    assert.ok(second.kind === "stream" && !second.args.includes("-live_start_index"), "after a drop: not again");
    const none = new YouTubeSession(ID, { describeFn: script([ok("upcoming")]).fn });
    await none.open();
    assert.throws(() => none.input(), /no stream/);
  });

  it("dump keeps the shape of the answer, not the signed URLs", async (t) => {
    const dir = tmpDir(t);
    const sess = new YouTubeSession(ID, { describeFn: script([ok("live")]).fn });
    await sess.open();
    await sess.dump(path.join(dir, "debug"), "001-in_meeting");
    const d = readFileSync(path.join(dir, "debug", "001-in_meeting.yt.json"), "utf8");
    assert.match(d, /"live_status": "is_live"/);
    assert.doesNotMatch(d, /googlevideo|\.m3u8|https:/);
  });
});

describe("running yt-dlp", () => {
  function fake(dir: string, body: string) {
    const bin = path.join(dir, "yt-dlp");
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it("asks for JSON with a height cap, and returns what it printed", async (t) => {
    const dir = tmpDir(t);
    const bin = fake(dir, `cat "${FIX}/live.json"`);
    const r = await describeVideo(ID, { bin, maxHeight: 720, video: true }).promise;
    assert.ok(r.ok && r.info.live_status === "is_live");
    const args = readFileSync(path.join(dir, "args"), "utf8");
    assert.match(args, /--dump-single-json/);
    assert.match(args, /--skip-download/);
    assert.match(args, /--no-playlist/);
    assert.match(args, /--ignore-no-formats-error/);
    assert.match(args, /bv\*\[height<=\?720\]\+ba\/b\[height<=\?720\]/);
    assert.match(args, new RegExp(`https://www\\.youtube\\.com/watch\\?v=${ID}\\s*$`));
    // By default only the sound is asked for.
    await describeVideo(ID, { bin }).promise;
    assert.match(readFileSync(path.join(dir, "args"), "utf8"), /-f\s+ba\/b\s/);
  });

  it("failures: classified from stderr, a missing binary and a hang are transient", async (t) => {
    const dir = tmpDir(t);
    const bot = await describeVideo(ID, { bin: fake(dir, `echo "ERROR: [youtube] ${ID}: Sign in to confirm you’re not a bot" >&2; echo null; exit 1`) }).promise;
    assert.deepEqual([bot.ok, !bot.ok && bot.problem, !bot.ok && /not a bot/.test(bot.message)], [false, "blocked", true]);
    const gone = await describeVideo(ID, { bin: path.join(dir, "no-such-binary") }).promise;
    assert.deepEqual([gone.ok, !gone.ok && gone.problem, !gone.ok && /can't run/.test(gone.message)], [false, "transient", true]);
    const slow = await describeVideo(ID, { bin: fake(dir, "sleep 5"), timeoutMs: 300 }).promise;
    assert.deepEqual([slow.ok, !slow.ok && slow.problem], [false, "transient"]);
    const junk = await describeVideo(ID, { bin: fake(dir, "echo 'not json'") }).promise;
    assert.equal(junk.ok, false);
    const { fn } = { fn: describeVideo(ID, { bin: fake(dir, "sleep 30"), timeoutMs: 60_000 }) };
    fn.kill();
    assert.equal((await fn.promise).ok, false);                           // closing the session kills it
  });
});

const skip = need("ffmpeg");
describe("recording two playlists", { skip }, () => {
  it("a video input and an audio input mapped into one part", async (t) => {
    const dir = tmpDir(t);
    const v = path.join(dir, "v.mp4"), a = path.join(dir, "a.m4a");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", v]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:a", "aac", a]);
    const o: RecorderOpts = { outdir: dir, width: 320, height: 240, fps: 15, quality: 30, encoder: "x264", vaapiDevice: "" };
    const rec = new Recorder(o);
    const part = rec.start(1, { kind: "stream", args: ["-re", "-i", v, "-re", "-i", a], copy: true, map: ["-map", "0:v:0", "-map", "1:a:0"] });
    await new Promise((r) => setTimeout(r, 3000));
    await rec.stop();
    const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", part.file]).toString()) as { streams: { codec_type: string }[] };
    assert.deepEqual(out.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
    assert.equal(part.exitCode, 0);
    void mkdirSync;
  });
});

describe("a YouTube meeting through the scheduler", () => {
  it("is a stream job: its platform is YouTube, and it gets no display or sink", async (t) => {
    const cleanups: (() => unknown)[] = [];
    t.after(async () => { for (const f of cleanups.reverse()) await f(); });
    const hooks = { after: (fn: () => unknown) => cleanups.push(fn) };
    const out = path.join(tmpDir(hooks), "rec");
    const { app } = await startApp(hooks, out);
    fixtures(app, out);
    const j = app.sched.add({ link: `https://youtu.be/${ID}`, start: new Date(Date.now() + 86_400_000).toISOString(), slug: "yt-council" });
    const m = app.sched.meetings.get(j.meetingRef)!;
    assert.deepEqual([m.platform, m.link], ["youtube", `https://www.youtube.com/watch?v=${ID}`]);
    assert.equal(app.sched.list().find((x) => x.id === j.id)!.link, `https://www.youtube.com/watch?v=${ID}`);
  });
});
