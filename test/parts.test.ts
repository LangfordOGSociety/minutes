/**
 * Raw capture parts are removed only when the stitched MP4 is verified and old enough (parts.ts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pruneParts } from "../src/parts.js";
import { need, tmpDir } from "./helpers.js";

const ffmpeg = need("ffmpeg");
const DAY = 86_400_000;

function recording(out: string, slug: string, o: { dur?: number; partBytes?: number; age?: number; output?: boolean } = {}) {
  const d = path.join(out, slug);
  mkdirSync(d, { recursive: true });
  const mp4 = path.join(d, `${slug}.mp4`);
  if (o.output !== false) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4]);
    const t = (Date.now() - (o.age ?? 10) * DAY) / 1000;
    utimesSync(mp4, t, t);
  }
  if (o.partBytes === undefined && o.output !== false) copyFileSync(mp4, path.join(d, "part_001.mkv")); else writeFileSync(path.join(d, "part_001.mkv"), "x".repeat(o.partBytes ?? 1000));
  writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ output: `${slug}.mp4`, offsets: [{ part: 1, at: 0, dur: o.dur ?? 2 }] }));
  return d;
}
const run = (out: string, busy: string[] = []) => pruneParts({ out, days: 7, isBusy: (s) => busy.includes(s) });

describe("raw parts", { skip: ffmpeg }, () => {
  it("are removed once the MP4 is verified and old enough", async (t) => {
    const out = path.join(tmpDir(t), "rec");
    const d = recording(out, "ok");
    const freed = await run(out);
    assert.deepEqual(freed.map((x) => x[0]), ["ok"]);
    assert.equal(existsSync(path.join(d, "part_001.mkv")), false);
    assert.equal(existsSync(path.join(d, "ok.mp4")), true);
    assert.equal(existsSync(path.join(d, "manifest.json")), true);
  });

  it("stay when anything is in doubt", async (t) => {
    const out = path.join(tmpDir(t), "rec");
    const kept = [
      recording(out, "young", { age: 2 }),                       // MP4 is newer than the limit
      recording(out, "short", { dur: 600 }),                     // the MP4 is far shorter than the stitch recorded
      recording(out, "reencoded", { partBytes: 5_000_000 }),     // not a stream copy: the parts are the better quality
      recording(out, "nomp4", { output: false }),               // nothing to rely on
      recording(out, "busy"),                                    // a capture is using it
    ];
    const freed = await run(out, ["busy"]);
    assert.deepEqual(freed, []);
    for (const d of kept) assert.equal(existsSync(path.join(d, "part_001.mkv")), true, d);
  });
});
