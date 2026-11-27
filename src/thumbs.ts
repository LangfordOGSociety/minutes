/**
 * Poster images for recordings: one frame of the video, `<slug>.jpg` next to
 * it. Used as the player's poster, the link-preview image (og:image) and the
 * thumbnail in structured data. Made by the server (it has ffmpeg), one at a
 * time, for every recording that has a video and no image yet, so new
 * recordings and old ones both get one. A failure is remembered for an hour
 * so a bad file isn't retried every pass.
 */
import { execFile } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { logger } from "./util.js";

const log = logger("thumbs");

/** Where in the video to look: a little in, past the opening slate, never past the middle. */
export function frameAt(durationS: number | null): number {
  const d = durationS ?? 0;
  if (!(d > 0)) return 5;
  return Math.max(1, Math.min(60, d * 0.05, d / 2));
}

/**
 * The newest frame of a recording in progress, as a PNG: what a capture
 * without a screen (a stream or an archive import) has to show in the
 * admin's live view, where a screen capture would be black. Reads the last
 * few seconds of the growing part. Null when there is no readable frame yet.
 */
export function latestFrame(part: string, width = 960): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-v", "error", "-sseof", "-4", "-i", part, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, out) => resolve(err || !out.length ? null : out));
  });
}

export async function makeThumb(video: string, dest: string, durationS: number | null, o: { timeoutMs?: number } = {}): Promise<boolean> {
  const tmp = `${dest}.tmp.jpg`;
  const frame = (at: number) => new Promise<string | null>((resolve) => {
    execFile("ffmpeg", ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", tmp],
      { timeout: o.timeoutMs ?? 90_000 }, (err) => resolve(err ? String(err.message).split("\n")[0] : null));
  });
  // The recorded duration can be a touch long (a seek past the end writes nothing, and ffmpeg may call that an error): then the first frame.
  let last: string | null = null;
  for (const at of [...new Set([frameAt(durationS), 0])]) {
    last = await frame(at);
    if (!last && existsSync(tmp)) {
      try { renameSync(tmp, dest); return true; } catch { rmSync(tmp, { force: true }); return false; }
    }
    rmSync(tmp, { force: true });
  }
  log.warn(`no poster for ${path.basename(video)}: ${last ?? "no frame"}`);
  return false;
}

/** Makes missing posters, one at a time. */
export class Thumbs {
  private busy = false;
  private failed = new Map<string, number>();

  /** `todo`: recordings with a video and no image. Resolves when this pass is done. */
  async run(todo: { slug: string; video: string; dest: string; duration: number | null }[], now = Date.now()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let made = 0;
    try {
      for (const t of todo) {
        if (now - (this.failed.get(t.slug) ?? -Infinity) < 3_600_000) continue;
        if (await makeThumb(t.video, t.dest, t.duration)) { made++; log.info(`poster for ${t.slug}`); }
        else this.failed.set(t.slug, now);
      }
    } finally { this.busy = false; }
    return made;
  }
}
