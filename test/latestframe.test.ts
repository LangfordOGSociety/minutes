/** The admin's live view of a capture with no screen shows the newest frame of the recording. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { latestFrame } from "../src/thumbs.js";
import { need, tmpDir } from "./helpers.js";

describe("latest frame of a recording", { skip: need("ffmpeg") }, () => {
  it("a PNG of the last seconds; null when there is nothing to read", async (t) => {
    const dir = tmpDir(t);
    const part = path.join(dir, "part_001.mkv");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=8", "-c:v", "libx264", "-preset", "ultrafast",
      "-flush_packets", "1", "-cluster_time_limit", "1000", part]);
    const png = await latestFrame(part, 320);
    assert.ok(png && png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "a PNG");
    assert.ok(png!.length > 500);
    assert.equal(await latestFrame(path.join(dir, "missing.mkv")), null);
    assert.equal(await latestFrame(path.join(dir, "empty.mkv")), null);
  });
});
