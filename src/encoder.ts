/**
 * The encoder worker: the minutes-encoder container, run on the GPU node (k3s-07). It makes the smaller copies of
 * each recording (`<slug>.720p.mp4`, ... renditions.ts) on the AMD GPU's video encoder through VAAPI, so neither the web
 * server's 8 cores nor a capture's cores are used for it. It shares the recordings volume with the web server and the
 * transcriber, reads only each folder's manifest and the stitched video, and writes the copies next to them (a temporary
 * name first, then a rename). It never opens the database: the web server decides what is public, and finds the copies by
 * name on its next look at the folder.
 *
 * Environment:
 *   RECORDINGS       the volume (default /recordings)
 *   RENDITIONS       heights, "720,480,360" by default
 *   ENCODER          "vaapi" (default; falls back to x264 on the CPU if the GPU can't be used) or "x264"
 *   VAAPI_DEVICE     /dev/dri/renderD128
 *   ENCODER_THREADS  CPU threads for decoding and scaling (default 4)
 *   SCAN_S           seconds between looks at the volume (default 120)
 *   ENCODE_ONCE=1    one pass, then exit (tests, a manual run)
 *
 * Recordings whose parts hold sound only (a YouTube meeting: the video is embedded from YouTube) are skipped.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LADDER, RENDITION_RE, Renditions, type RenditionTask } from "./renditions.js";
import { logger, SLUG_RE } from "./util.js";

const log = logger("encoder");
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The recordings that have a stitched video and may want copies. */
export function scan(root: string): RenditionTask[] {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const todo: RenditionTask[] = [];
  for (const slug of names) {
    if (!SLUG_RE.test(slug)) continue;
    const dir = path.join(root, slug);
    let m: { output?: unknown; audioOnly?: unknown; offsets?: { dur?: number }[] };
    try { m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { continue; }
    if (m.audioOnly === true || typeof m.output !== "string" || !FILE_RE.test(m.output) || !existsSync(path.join(dir, m.output))) continue;
    const have: number[] = [];
    try {
      for (const f of readdirSync(dir)) {
        const r = RENDITION_RE.exec(f);
        if (r && r[1] === slug) have.push(Number(r[2]));
      }
    } catch { continue; }
    const dur = (m.offsets ?? []).reduce((s, o) => s + (Number(o.dur) || 0), 0);
    todo.push({ slug, video: m.output, dir, duration: dur > 0 ? dur : null, have });
  }
  // Newest first: a meeting people are waiting for before an old backfill.
  return todo.sort((a, b) => statSync(path.join(b.dir, b.video)).mtimeMs - statSync(path.join(a.dir, a.video)).mtimeMs);
}

/** Half-made copies from a worker that was stopped hard: this is the only worker, so every temporary copy is stale at start. */
export function clearStale(root: string): number {
  let n = 0;
  try {
    for (const slug of readdirSync(root)) {
      const dir = path.join(root, slug);
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) if (/\.\d{3,4}p\.mp4\.tmp\.mp4$/.test(f)) { rmSync(path.join(dir, f), { force: true }); n++; }
    }
  } catch { /* no volume yet */ }
  return n;
}

export function heightsFromEnv(v: string | undefined): number[] {
  if (!v?.trim()) return DEFAULT_LADDER;
  const hs = v.split(",").map((x) => Number.parseInt(x, 10));
  if (hs.some((h) => !(h >= 144 && h <= 2160))) throw new Error("RENDITIONS: heights like 720,480,360");
  return [...new Set(hs)].sort((a, b) => b - a);
}

export async function main(env = process.env): Promise<void> {
  const root = env.RECORDINGS ?? "/recordings";
  const ladder = heightsFromEnv(env.RENDITIONS);
  const encoder = env.ENCODER === "x264" ? "x264" : "vaapi";
  const r = new Renditions(ladder, { encoder, device: env.VAAPI_DEVICE || "/dev/dri/renderD128", threads: Number.parseInt(env.ENCODER_THREADS ?? "", 10) || 4 });
  const every = (Number.parseInt(env.SCAN_S ?? "", 10) || 120) * 1000;
  let stopping = false, wake: (() => void) | null = null;
  const stop = () => { stopping = true; r.abort(); wake?.(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  log.info(`encoding ${ladder.join(", ")}p with ${encoder} for ${root}`);
  const cleared = clearStale(root);
  if (cleared) log.info(`removed ${cleared} half-made copy(ies) from a stopped run`);
  for (;;) {
    try {
      const made = await r.run(scan(root));
      if (made) log.info(`pass done: ${made} copy(ies) made`);
    } catch (e) { log.warn("a pass failed", e); }
    if (stopping || env.ENCODE_ONCE === "1") return;
    await new Promise<void>((res) => { wake = res; setTimeout(res, every).unref?.(); });
    wake = null;
    if (stopping) return;
  }
}

// Run as the container's command (not when imported by a test).
if (process.argv[1] && /encoder\.js$/.test(process.argv[1])) {
  main().then(() => process.exit(0), (e) => { log.error("the encoder stopped", e); process.exit(1); });
}
