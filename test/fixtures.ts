/** Recording folders and jobs, as the runner and transcriber leave them. */
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { App } from "../src/serve.js";
import { registerParser } from "../src/feeds/registry.js";
import { cfg, type FeedParser } from "../src/feeds/types.js";
import { inDays, type HasAfter } from "./helpers.js";

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

/** A source: GET /feed returns `meetings` as JSON, with an ETag. */
export async function fakeSource(t: HasAfter) {
  const state = { meetings: [] as unknown[], etag: "v1", hits: 0, fail: false, delayMs: 0 };
  const s = http.createServer(async (req, res) => {
    state.hits++;
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.fail) { res.writeHead(500); return res.end("boom"); }
    if (req.url === "/big") { res.writeHead(200); return res.end("x".repeat(9 * 1024 * 1024)); }
    if (req.headers["if-none-match"] === state.etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { "content-type": "application/json", etag: state.etag });
    res.end(JSON.stringify(state.meetings));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { state, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/feed` };
}

export const testParser: FeedParser<{ url: string }> = {
  id: "test-json", label: "Test JSON", description: "JSON list from a URL (tests only)",
  fields: [{ name: "url", label: "URL", type: "url", required: true }],
  validate(c) { return { url: cfg.url(cfg.obj(c), "url") }; },
  host(c) { return c.url; },
  async fetch(c, ctx) {
    const r = await ctx.http(c.url, { conditional: true });
    if (r.notModified) return { notModified: true };
    const rows = JSON.parse(r.body) as { id: string; title: string; start: string; link?: string; body?: string; cancelled?: boolean; agendaUrl?: string;
      documents?: { title: string; type?: string; url: string }[]; streamUrl?: string }[];
    return { meetings: rows.map((x) => ({ externalId: x.id, title: x.title, start: new Date(x.start), link: x.link, body: x.body,
      cancelled: x.cancelled, agendaUrl: x.agendaUrl, documents: x.documents, streamUrl: x.streamUrl })) };
  },
};
registerParser(testParser);
