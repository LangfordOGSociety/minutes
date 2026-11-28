/**
 * Smaller copies of a recording (renditions.ts): which heights a source gets, a real encode with ffmpeg,
 * how they are found on disk and served, and that none are made while a capture needs the machine.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { publicFiles, toPublic } from "../src/recordings.js";
import { Renditions, planHeights, renditionFile, targetKbps, vaapiArgs, vaapiKbps, videoArgs } from "../src/renditions.js";
import { fixtures, makeRecording } from "./fixtures.js";
import { need, tmpDir, type HasAfter } from "./helpers.js";
import { Client, startApp } from "./server.js";

const ffmpeg = need("ffmpeg");
/** Cleanups in reverse order: the app closes before its folder is removed. */
function hooksOf(t: TestContext): HasAfter {
  const cleanups: (() => unknown)[] = [];
  t.after(async () => { for (const f of cleanups.reverse()) await f(); });
  return { after: (fn) => cleanups.push(fn) };
}
const height = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", f]).toString().trim());

describe("renditions", () => {
  it("only sizes smaller than the original are planned", () => {
    assert.deepEqual(planHeights(1080, [720, 480, 360]), [720, 480, 360]);
    assert.deepEqual(planHeights(720, [720, 480, 360]), [480, 360]);
    assert.deepEqual(planHeights(480, [720, 480, 360]), [360]);
    assert.deepEqual(planHeights(360, [720, 480, 360]), []);
    assert.equal(renditionFile("council-a", 720), "council-a.720p.mp4");
    // A source already at a ladder height gets a copy of that height only when it is far heavier than ours would be.
    assert.deepEqual(planHeights(720, [720, 480, 360], 2500), [720, 480, 360], "a 2.5 Mbps 720p stream");
    assert.deepEqual(planHeights(720, [720, 480, 360], 600), [480, 360], "already light");
    assert.deepEqual(planHeights(720, [720, 480, 360], null), [480, 360], "rate unknown");
    assert.deepEqual(planHeights(1080, [720, 480, 360], 100000), [720, 480, 360], "1080p never gets a 1080p copy");
    assert.equal(targetKbps(720), 350);
  });

  it("makes them with ffmpeg, once, and not while a capture needs the machine", { skip: ffmpeg }, async (t) => {
    const dir = tmpDir(t);
    const src = path.join(dir, "rec.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=duration=3",
      "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
    const task = { slug: "rec", video: "rec.mp4", dir, duration: 3, have: [] as number[] };
    const r = new Renditions([480, 240, 144]);
    assert.equal(await r.run([task], () => true), 0, "a capture is running: nothing is started");
    assert.equal(existsSync(path.join(dir, "rec.240p.mp4")), false);
    assert.equal(await r.run([task]), 2, "480 is not smaller than 360: only 240 and 144");
    assert.equal(height(path.join(dir, "rec.240p.mp4")), 240);
    assert.equal(height(path.join(dir, "rec.144p.mp4")), 144);
    assert.equal(existsSync(path.join(dir, "rec.480p.mp4")), false);
    // faststart: the index is at the front, so playback starts before the download ends.
    const bytes = readFileSync(path.join(dir, "rec.240p.mp4"));
    assert.ok(bytes.indexOf("moov") > 0 && bytes.indexOf("moov") < bytes.indexOf("mdat"));
    // Already there (the next pass lists them): nothing more to make, and nothing probed again.
    assert.equal(await r.run([{ ...task, have: [240, 144] }]), 0);
  });

  it("the GPU encoder: CPU decoding and scaling, hardware encoding, a bit rate scaled from x264's; the CPU encoder is capped to a few threads", () => {
    assert.deepEqual([vaapiKbps(720), vaapiKbps(480), vaapiKbps(360)], [501, 223, 126]);
    const a = vaapiArgs(720, 1080, "/dev/dri/renderD128");
    assert.deepEqual(a.input, ["-threads", "4", "-vaapi_device", "/dev/dri/renderD128"]);
    assert.ok(a.output.includes("h264_vaapi") && a.output.includes("501k") && a.output.includes("1002k"));
    assert.equal(a.output[a.output.indexOf("-vf") + 1], "scale=-2:720,fps=30,format=nv12,hwupload");
    // A source already at the wanted height (a city's 720p stream) is not scaled at all.
    assert.equal(vaapiArgs(720, 720, "/dev/dri/renderD128").output[1], "fps=30,format=nv12,hwupload");
    // x264: the threads and the lookahead are limited, so it can't take every core the container may use.
    const x = videoArgs(720);
    assert.deepEqual([x[x.indexOf("-threads") + 1], x[x.indexOf("-filter_threads") + 1], x[x.indexOf("-x264-params") + 1]], ["2", "1", "lookahead-threads=1"]);
  });

  it("falls back to x264 when the GPU can't be used", { skip: ffmpeg }, async (t) => {
    const dir = tmpDir(t);
    const src = path.join(dir, "rec.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2", "-c:v", "libx264", src]);
    const r = new Renditions([240], { encoder: "vaapi", device: "/dev/dri/does-not-exist" });
    assert.equal(await r.run([{ slug: "rec", video: "rec.mp4", dir, duration: 2, have: [] }]), 1);
    assert.equal(height(path.join(dir, "rec.240p.mp4")), 240);
    assert.equal(existsSync(path.join(dir, "rec.240p.mp4.tmp.mp4")), false);
  });

  it("are listed on the recording, served by /media, and listed by the API; the original is untouched", async (t) => {
    const hooks = hooksOf(t);
    const out = path.join(tmpDir(hooks), "rec");
    const { app, base } = await startApp(hooks, out);
    fixtures(app, out);
    for (const h of [720, 360]) writeFileSync(path.join(out, "council-a", renditionFile("council-a", h)), "s".repeat(h));
    const c = new Client(base);
    const rec = (await c.get("/api/recordings")).json.find((x: { slug: string }) => x.slug === "council-a");
    assert.deepEqual(rec.renditions.map((x: { height: number; file: string; bytes: number }) => [x.height, x.file, x.bytes]), [[720, "council-a.720p.mp4", 720], [360, "council-a.360p.mp4", 360]]);
    assert.equal(rec.video, "council-a.mp4");
    assert.equal((await c.req("GET", "/media/council-a/council-a.720p.mp4")).status, 200);
    assert.equal((await c.req("GET", "/media/council-a/council-a.1080p.mp4")).status, 404, "only the files that exist");
    const files = (await c.get("/api/v1/meetings/council-a/files")).json as { kind: string; height?: number }[];
    assert.deepEqual(files.filter((f) => f.kind === "video-smaller").map((f) => f.height), [720, 360]);
    const listed = publicFiles(toPublic({ ...rec, files: rec.files }));
    assert.ok(listed.has("council-a.360p.mp4") && listed.has("council-a.mp4"));
  });

  it("another recording's copy, or a half-made one, isn't taken for this recording's own", async (t) => {
    const hooks = hooksOf(t);
    const out = path.join(tmpDir(hooks), "rec");
    mkdirSync(out, { recursive: true });
    const { app, base } = await startApp(hooks, out);
    makeRecording(out, "a", { video: true });
    writeFileSync(path.join(out, "a", "b.720p.mp4"), "x");
    writeFileSync(path.join(out, "a", "a.720p.mp4.tmp.mp4"), "x");
    writeFileSync(path.join(out, "a", "a.480p.mp4"), "x");
    await app.accounts.create({ email: "admin@example.com", role: "admin", password: "admin password 1" });
    const admin = new Client(base);
    await admin.login("admin@example.com", "admin password 1");
    const rec = (await admin.get("/api/admin/recordings")).json.find((x: { slug: string }) => x.slug === "a");
    assert.deepEqual(rec.renditions.map((x: { file: string }) => x.file), ["a.480p.mp4"]);
  });
});
