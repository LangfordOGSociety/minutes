/**
 * The encoder worker (src/encoder.ts): which recordings it picks, what it clears at start, and a pass over a real folder.
 * The GPU itself can't be tested here (no VAAPI in CI); the worker's CPU encoder stands in, and renditions.test.ts covers the fallback.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { clearStale, heightsFromEnv, main, scan } from "../src/encoder.js";
import { need, tmpDir } from "./helpers.js";

const ffmpeg = need("ffmpeg");

function recording(root: string, slug: string, o: { audioOnly?: boolean; output?: boolean; copies?: number[]; age?: number } = {}) {
  const d = path.join(root, slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ slug, output: `${slug}.mp4`, offsets: [{ part: 1, at: 0, dur: 2 }], ...(o.audioOnly ? { audioOnly: true } : {}) }));
  if (o.output !== false) {
    writeFileSync(path.join(d, `${slug}.mp4`), "x");
    const t = (Date.now() - (o.age ?? 0) * 86_400_000) / 1000;
    utimesSync(path.join(d, `${slug}.mp4`), t, t);
  }
  for (const h of o.copies ?? []) writeFileSync(path.join(d, `${slug}.${h}p.mp4`), "x");
  return d;
}

describe("encoder worker", () => {
  it("picks recordings with a stitched video, not sound-only ones, newest first, and knows which copies exist", (t) => {
    const root = path.join(tmpDir(t), "rec");
    recording(root, "old", { age: 10 });
    recording(root, "new", { age: 1, copies: [720] });
    recording(root, "sound", { audioOnly: true });          // a YouTube meeting: the video is embedded
    recording(root, "unstitched", { output: false });       // the manifest names a video that isn't there (yet)
    mkdirSync(path.join(root, "no-manifest"), { recursive: true });
    mkdirSync(path.join(root, ".documents"), { recursive: true });
    const d = recording(root, "tmp", { age: 3 });
    writeFileSync(path.join(d, "tmp.720p.mp4.tmp.mp4"), "x");   // a half-made copy is not a copy
    writeFileSync(path.join(d, "other.480p.mp4"), "x");         // another recording's name
    const todo = scan(root);
    assert.deepEqual(todo.map((x) => x.slug), ["new", "tmp", "old"]);
    assert.deepEqual(todo.find((x) => x.slug === "new")!.have, [720]);
    assert.deepEqual(todo.find((x) => x.slug === "tmp")!.have, []);
    assert.equal(todo[0].duration, 2);
    assert.deepEqual(scan(path.join(root, "missing")), []);
  });

  it("clears half-made copies at start, and reads the heights from the environment", (t) => {
    const root = path.join(tmpDir(t), "rec");
    const d = recording(root, "a", { copies: [480] });
    writeFileSync(path.join(d, "a.720p.mp4.tmp.mp4"), "x");
    assert.equal(clearStale(root), 1);
    assert.equal(existsSync(path.join(d, "a.720p.mp4.tmp.mp4")), false);
    assert.equal(existsSync(path.join(d, "a.480p.mp4")), true, "finished copies stay");
    assert.deepEqual(heightsFromEnv(undefined), [720, 480, 360]);
    assert.deepEqual(heightsFromEnv("360, 720,720"), [720, 360]);
    assert.throws(() => heightsFromEnv("720,10"), /RENDITIONS/);
  });

  it("one pass makes the missing copies next to the video and leaves the rest alone", { skip: ffmpeg }, async (t) => {
    const root = path.join(tmpDir(t), "rec");
    const d = recording(root, "council", { copies: [] });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2", "-c:v", "libx264", path.join(d, "council.mp4")]);
    const sound = recording(root, "sound", { audioOnly: true });
    await main({ RECORDINGS: root, RENDITIONS: "240,144", ENCODER: "x264", ENCODE_ONCE: "1" } as unknown as NodeJS.ProcessEnv);
    assert.equal(existsSync(path.join(d, "council.240p.mp4")), true);
    assert.equal(existsSync(path.join(d, "council.144p.mp4")), true);
    assert.equal(existsSync(path.join(d, "council.240p.mp4.tmp.mp4")), false);
    assert.equal(existsSync(path.join(sound, "sound.240p.mp4")), false);
    assert.equal(readFileSync(path.join(d, "manifest.json"), "utf8").includes("council.mp4"), true, "the manifest is never touched");
  });
});
