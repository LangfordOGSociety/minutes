import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { appendTimeline, finalizeTimelines } from "../src/timeline.js";
import { tmpDir } from "./helpers.js";

describe("timeline", () => {
  it("maps speaker and caption changes onto the stitched clock", (t) => {
    const dir = tmpDir(t);
    const v1 = new Date("2026-11-24T01:00:00.000Z");   // part 1 first frame
    const v2 = new Date("2026-11-24T01:05:00.000Z");   // part 2 first frame
    const at = (base: Date, s: number) => new Date(base.getTime() + s * 1000).toISOString();
    // partOffset counts from spawn and is ignored when videoStart is known.
    const sp = (part: number, base: Date, s: number, value: string) =>
      appendTimeline(dir, "speakers", { t: at(base, s), part, partOffset: 999, value });
    sp(1, v1, -1, "Early");      // before the first frame: clamps to 0
    sp(1, v1, 2, "Alice");
    sp(1, v1, 6, "Bob");
    sp(2, v2, 1, "Carol");
    sp(2, v2, 100, "Lost tail");  // after the part's stitched end: dropped
    const cap = (s: number, value: string) => appendTimeline(dir, "captions", { t: at(v1, s), part: 1, partOffset: 0, value });
    cap(1, "Hello");
    cap(2, "Hello there <b>");
    cap(4, "");
    cap(5, "Next one");
    appendFileSync(path.join(dir, "captions.jsonl"), '{"t": "torn'); // hard kill mid-line

    const offsets = [{ part: 1, at: 0, dur: 10 }, { part: 2, at: 10, dur: 5 }];
    const written = finalizeTimelines(dir, "m", offsets, new Map([[1, v1], [2, v2]]));
    assert.deepEqual(written, { speakers: "m.speakers.json", zoomCaptions: "m.zoom-captions.vtt" });

    const speakers = JSON.parse(readFileSync(path.join(dir, "m.speakers.json"), "utf8"));
    assert.deepEqual(speakers, [
      { at: 0, until: 2, name: "Early" },
      { at: 2, until: 6, name: "Alice" },
      { at: 6, until: 10, name: "Bob" },
      { at: 11, until: 15, name: "Carol" },
    ]);
    const captions = JSON.parse(readFileSync(path.join(dir, "m.zoom-captions.json"), "utf8"));
    assert.deepEqual(captions, [
      { at: 1, until: 4, text: "Hello there <b>" },
      { at: 5, until: 10, text: "Next one" },
    ]);
    const vtt = readFileSync(path.join(dir, "m.zoom-captions.vtt"), "utf8");
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /00:00:01\.000 --> 00:00:04\.000\nHello there &lt;b&gt;/);
  });
});
