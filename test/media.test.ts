/**
 * Recorder (stream input) and stitch, against real ffmpeg. The screen input
 * needs Xvfb + PulseAudio and is covered by the image, not here.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Recorder, type Part, type RecorderOpts } from "../src/recorder.js";
import { stitch } from "../src/stitch.js";
import { need, tmpDir } from "./helpers.js";

const skip = need("ffmpeg");

function probe(file: string): { duration: number; streams: string[]; chapters: string[] } {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", "-show_chapters", file], { encoding: "utf8" }));
  return {
    duration: parseFloat(j.format.duration),
    streams: j.streams.map((s: { codec_type: string }) => s.codec_type),
    chapters: j.chapters.map((c: { tags?: { title?: string } }) => c.tags?.title ?? ""),
  };
}

/** A 20s test source with video and audio, standing in for a live stream. */
function source(dir: string): string {
  const f = path.join(dir, "source.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=15:d=20",
    "-f", "lavfi", "-i", "sine=d=20", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-c:a", "aac", f]);
  return f;
}

const opts = (outdir: string): RecorderOpts =>
  ({ outdir, width: 320, height: 240, fps: 15, quality: 30, encoder: "x264", vaapiDevice: "" });

async function record(rec: Recorder, index: number, src: string, copy: boolean, ms: number): Promise<Part> {
  // -re reads the file at its own pace, like a live stream.
  const part = rec.start(index, { kind: "stream", args: ["-re", "-i", src], copy });
  await sleep(ms);
  await rec.stop();
  return part;
}

describe("recorder + stitch", { skip }, () => {
  for (const copy of [true, false]) {
    it(`records a stream (${copy ? "copy" : "encode"}) into a readable part`, async (t) => {
      const dir = tmpDir(t);
      const rec = new Recorder(opts(dir));
      const part = await record(rec, 1, source(dir), copy, 3000);
      assert.equal(part.exitCode, 0);
      assert.ok(part.ended);
      assert.ok(part.videoStart, "videoStart is set from -progress");
      const lag = part.videoStart.getTime() - part.started.getTime();
      assert.ok(lag >= 0 && lag < 2500, `first frame ${lag}ms after spawn`);
      const p = probe(part.file);
      assert.deepEqual(p.streams.sort(), ["audio", "video"]);
      assert.ok(p.duration > 1.5 && p.duration < 4, `duration ${p.duration}`);
    });
  }

  it("keeps what a SIGKILLed part wrote", async (t) => {
    const dir = tmpDir(t);
    const rec = new Recorder(opts(dir));
    const part = rec.start(1, { kind: "stream", args: ["-re", "-i", source(dir)], copy: false });
    await sleep(4000);
    execFileSync("pkill", ["-KILL", "-f", part.file]);
    await sleep(300);
    assert.equal(rec.alive, false);
    await rec.stop();
    const { gaps, output, offsets } = await stitch([part], dir, "killed", "UTC");
    assert.ok(output);
    assert.deepEqual(gaps, []);
    assert.ok(offsets[0].dur > 1, `kept ${offsets[0].dur}s`);
  });

  it("stitches parts with a chapter per part and the gap between them", async (t) => {
    const dir = tmpDir(t);
    const src = source(dir);
    const rec = new Recorder(opts(dir));
    const p1 = await record(rec, 1, src, true, 2500);
    await sleep(1500);
    const p2 = await record(rec, 2, src, true, 2500);
    const empty: Part = { index: 3, file: path.join(dir, "part_003.mkv"), started: new Date(), ended: new Date(),
      exitCode: 1, videoStart: null }; // never written: skipped
    const { output, gaps, offsets } = await stitch([p1, p2, empty], dir, "council-test", "America/Vancouver");
    assert.equal(output, path.join(dir, "council-test.mp4"));
    assert.ok(statSync(output).size > 4096);
    assert.equal(offsets.length, 2);
    assert.equal(offsets[0].at, 0);
    assert.equal(offsets[1].at, offsets[0].dur);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].beforePart, 2);
    assert.ok(gaps[0].seconds >= 1 && gaps[0].seconds < 4, `gap ${gaps[0].seconds}s`);
    const p = probe(output);
    assert.equal(p.chapters.length, 2);
    assert.match(p.chapters[0], /^Part 1 \(started \d\d:\d\d:\d\d\)$/);
    assert.match(p.chapters[1], /^Part 2 \(started \d\d:\d\d:\d\d\) after 0m0\ds gap$/);
    assert.ok(Math.abs(p.duration - (offsets[0].dur + offsets[1].dur)) < 0.5);
  });
});
