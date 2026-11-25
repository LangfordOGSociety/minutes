/** Recording folders and jobs, as the runner and transcriber leave them. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { App } from "../src/serve.js";
import { inDays } from "./helpers.js";

export const LINK = "https://zoom.us/j/87093163922?pwd=429539";

/** A recording folder as the runner and transcriber leave it. */
export function makeRecording(out: string, slug: string, o: { video?: boolean; live?: boolean } = {}): void {
  const d = path.join(out, slug);
  mkdirSync(d, { recursive: true });
  const t0 = "2026-11-24T01:32:00.000Z";
  writeFileSync(path.join(d, "manifest.json"), JSON.stringify({
    slug, link: LINK, scheduledStart: "2026-11-24T01:30:00.000Z", outcome: o.video ? "ended" : "blocked",
    parts: o.video || o.live ? [{ index: 1, file: "part_001.mkv", started: t0, ended: null }] : [],
    offsets: o.video ? [{ part: 1, at: 0, dur: 2760.4 }] : [], output: o.video ? `${slug}.mp4` : null,
  }));
  writeFileSync(path.join(d, "capture.log"), `joining ${LINK}\n`);
  writeFileSync(path.join(d, "part_001.mkv"), "x");
  if (o.video) {
    for (const f of [`${slug}.mp4`, `${slug}.vtt`, `${slug}.srt`, `${slug}.txt`, `${slug}.zoom-captions.vtt`]) writeFileSync(path.join(d, f), "x".repeat(100));
    writeFileSync(path.join(d, `${slug}.transcript.json`), JSON.stringify({ segments: [{ start: 1, text: "Call to order." }] }));
    writeFileSync(path.join(d, `${slug}.speakers.json`), "[]");
    writeFileSync(path.join(d, "transcript.status.json"), JSON.stringify({ status: "done" }));
  }
  if (o.live) writeFileSync(path.join(d, "live.json"), JSON.stringify({ updated: t0, segments: [{ at: t0, text: "Good evening." }] }));
}

/** Jobs and folders: one public, one hidden, one orphan, one failed, one live. */
export function fixtures(app: App, out: string): void {
  const done = (slug: string) => { const j = app.sched.add({ link: LINK, start: inDays(1), slug }); app.sched.cancel(j.id); return j; };
  done("council-a");
  makeRecording(out, "council-a", { video: true });
  const h = done("hidden-b");
  makeRecording(out, "hidden-b", { video: true });
  const m = app.sched.meetings.get(h.meetingRef)!;
  m.visibility = "hidden";
  app.sched.meetings.save(m);
  makeRecording(out, "orphan-c", { video: true });          // no job: admin only
  done("failed-d");
  makeRecording(out, "failed-d");                            // never got in: no video
  app.sched.add({ link: LINK, start: inDays(1), slug: "live-e" });   // scheduled = active
  makeRecording(out, "live-e", { live: true });
}
