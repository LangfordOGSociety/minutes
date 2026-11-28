/**
 * Lower-quality copies of a recording for viewers on slow connections or small screens:
 * `<slug>.720p.mp4`, `<slug>.480p.mp4`, `<slug>.360p.mp4` next to the original. The player
 * offers them in a Quality menu (Auto picks one); the original stays as it was recorded.
 *
 * Plain progressive MP4 (H.264 + AAC, faststart), not HLS/DASH: it plays everywhere, seeks
 * with Range requests, needs no player library (the repo has no runtime dependencies) and
 * keeps the transcript, chapters and captions in step because it is the same timeline.
 * Why not other codecs, and the numbers: docs/streaming-quality.md.
 *
 * Made one at a time, niced, and not while a capture is running or about to start (the
 * capture encodes in real time on the same machine). A failure is remembered for an hour.
 */
import { execFile } from "node:child_process";
import { renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { logger } from "./util.js";

const log = logger("renditions");

/** Heights offered by default, best first. */
export const DEFAULT_LADDER = [720, 480, 360];

export const renditionFile = (slug: string, height: number): string => `${slug}.${height}p.mp4`;
export const RENDITION_RE = /^(.+)\.(\d{3,4})p\.mp4$/;

/** x264 settings per height: constant quality, so a still slide costs almost nothing and a busy shot costs what it needs. */
export function videoArgs(height: number): string[] {
  return ["-vf", `scale=-2:${height},fps=30`, "-c:v", "libx264", "-preset", RENDITION_PRESET, "-crf", String(height >= 720 ? RENDITION_CRF : RENDITION_CRF + 2),
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", "60", "-keyint_min", "30", "-sc_threshold", "40"];
}
export const RENDITION_PRESET = "medium";
export const RENDITION_CRF = 27;

export function audioArgs(height: number): string[] {
  return ["-c:a", "aac", "-b:a", height >= 720 ? "96k" : "64k", "-ac", "2"];
}

/** About what our copy of a given height costs (video, kbps) on a slides-and-speaker meeting: 720p ~350, scaling with the picture's area. */
export const targetKbps = (height: number): number => Math.round(350 * (height / 720) ** 2);

/** Which of the ladder's heights a source should get: every smaller one, and one at the source's own height when the source
 *  is much bigger than our copy would be (a city's 2.5 Mbps 720p stream: viewers at 720p should not have to download that). */
export function planHeights(sourceHeight: number, ladder: number[], sourceKbps: number | null = null): number[] {
  return ladder.filter((h) => h < sourceHeight - 8 || (Math.abs(h - sourceHeight) <= 8 && sourceKbps !== null && sourceKbps > targetKbps(h) * 2.5));
}

/** Height and video bit rate of the first video stream (the rate from the stream, else the file's size over its length, less 128 kbps of sound). */
function probeVideo(file: string, bytes: number, durationS: number | null): Promise<{ height: number; kbps: number | null } | null> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height,bit_rate", "-of", "csv=p=0", file], { timeout: 30_000 },
      (err, out) => {
        const [h, br] = String(out).trim().split(",");
        const height = Number.parseInt(h, 10);
        if (err || !(height > 0)) { resolve(null); return; }
        const rate = Number.parseInt(br, 10);
        const kbps = rate > 0 ? rate / 1000 : durationS && durationS > 0 ? Math.max(bytes * 8 / durationS / 1000 - 128, 0) : null;
        resolve({ height, kbps });
      });
  });
}

export interface RenditionTask { slug: string; video: string; dir: string; duration: number | null; have: number[] }

export class Renditions {
  private busy = false;
  private failed = new Map<string, number>();
  /** Recordings with nothing more to make (their size was checked): remembered by name and byte size, so a pass doesn't probe them again. */
  private settled = new Map<string, string>();

  constructor(private ladder: number[] = DEFAULT_LADDER) {}

  /** One pass over recordings that have a video. `stop()` says a capture needs the machine: nothing new is started while it is true. Returns how many were made. */
  async run(todo: RenditionTask[], stop: () => boolean = () => false, now = Date.now()): Promise<number> {
    if (this.busy || !this.ladder.length) return 0;
    this.busy = true;
    let made = 0;
    try {
      for (const t of todo) {
        if (stop()) break;
        const file = path.join(t.dir, t.video);
        let bytes = 0;
        try { bytes = statSync(file).size; } catch { continue; }
        const key = `${bytes}:${t.have.join(",")}`;
        if (this.settled.get(t.slug) === key) continue;
        const v = await probeVideo(file, bytes, t.duration);
        if (!v) { this.failed.set(`${t.slug}`, now); continue; }
        const want = planHeights(v.height, this.ladder, v.kbps).filter((x) => !t.have.includes(x));
        if (!want.length) { this.settled.set(t.slug, key); continue; }
        for (const height of want) {
          if (stop()) return made;
          if (now - (this.failed.get(`${t.slug}:${height}`) ?? -Infinity) < 3_600_000) continue;
          const ok = await this.make(file, path.join(t.dir, renditionFile(t.slug, height)), height, t.duration);
          if (ok) { made++; log.info(`${t.slug}: ${height}p`); } else this.failed.set(`${t.slug}:${height}`, now);
        }
      }
    } finally { this.busy = false; }
    return made;
  }

  private make(src: string, dest: string, height: number, durationS: number | null): Promise<boolean> {
    const tmp = `${dest}.tmp.mp4`;
    // A generous limit, in case the machine is busy: an hour, or four times the recording's length.
    const timeout = Math.max(3_600_000, (durationS ?? 0) * 4000);
    return new Promise((resolve) => {
      execFile("nice", ["-n", "19", "ffmpeg", "-v", "error", "-y", "-threads", "4", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
        ...videoArgs(height), ...audioArgs(height), "-movflags", "+faststart", tmp], { timeout }, (err) => {
        if (err) { log.warn(`no ${height}p for ${path.basename(src)}: ${String(err.message).split("\n")[0]}`); rmSync(tmp, { force: true }); resolve(false); return; }
        try { renameSync(tmp, dest); resolve(true); } catch { rmSync(tmp, { force: true }); resolve(false); }
      });
    });
  }
}
