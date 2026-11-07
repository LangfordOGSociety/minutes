/**
 * Repair and stitch recorded parts into one MP4. Every interruption becomes
 * a chapter boundary, and the gaps are returned for manifest.json.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Part } from "./recorder.js";
import { logger } from "./util.js";

const log = logger("stitch");
const execFileP = promisify(execFile);

export interface Gap {
  beforePart: number;
  seconds: number;
  atOffsetSeconds: number;
}

async function run(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch (e: any) {
    log.warn(`${cmd} failed: ${String(e?.stderr ?? e).slice(-2000)}`);
    return false;
  }
}

async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ]);
    const n = parseFloat(stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function fmtGap(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
  return h ? `${h}h${mm}m${ss}s` : `${m}m${ss}s`;
}

const metaEscape = (s: string) => s.replace(/([\\=;#\n])/g, "\\$1");
const concatEscape = (s: string) => s.replace(/'/g, `'\\''`);

/** Where each included part starts in the stitched video (skipped parts are absent). */
export interface PartOffset { part: number; at: number; dur: number }

export async function stitch(parts: Part[], outdir: string, name: string, tz: string):
    Promise<{ output: string | null; gaps: Gap[]; offsets: PartOffset[] }> {
  const clock = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });

  const clips: { part: Part; src: string; dur: number }[] = [];
  for (const part of parts) {
    if (!existsSync(part.file) || statSync(part.file).size < 4096) {
      log.warn(`skipping empty part ${path.basename(part.file)}`);
      continue;
    }
    // Remux first: rebuilds the index of a part that was killed uncleanly
    // and gives ffprobe a real duration to work with.
    const fixed = part.file.replace(/\.mkv$/, ".fixed.mkv");
    const ok = await run("ffmpeg", ["-y", "-v", "error", "-i", part.file, "-map", "0", "-c", "copy", fixed]);
    const src = ok ? fixed : part.file;
    const dur = await probeDuration(src);
    if (dur < 1) {
      log.warn(`skipping unreadable part ${path.basename(part.file)}`);
      continue;
    }
    clips.push({ part, src, dur });
  }
  if (!clips.length) return { output: null, gaps: [], offsets: [] };

  const out = path.join(outdir, `${name}.mp4`);
  const listFile = path.join(outdir, "concat.txt");
  const metaFile = path.join(outdir, "chapters.txt");

  const gaps: Gap[] = [];
  const offsets: PartOffset[] = [];
  const meta = [";FFMETADATA1", `title=${metaEscape(name)}`];
  let offset = 0;
  let prevEnd: Date | null = null;
  for (const { part, dur } of clips) {
    let title = `Part ${part.index} (started ${clock.format(part.started)})`;
    if (prevEnd) {
      const gap = Math.max(0, (part.started.getTime() - prevEnd.getTime()) / 1000);
      gaps.push({ beforePart: part.index, seconds: +gap.toFixed(1), atOffsetSeconds: +offset.toFixed(1) });
      title += ` after ${fmtGap(gap)} gap`;
    }
    meta.push("[CHAPTER]", "TIMEBASE=1/1000",
      `START=${Math.round(offset * 1000)}`, `END=${Math.round((offset + dur) * 1000)}`,
      `title=${metaEscape(title)}`);
    offsets.push({ part: part.index, at: offset, dur });
    offset += dur;
    prevEnd = part.ended ?? new Date(part.started.getTime() + dur * 1000);
  }

  writeFileSync(listFile, clips.map((c) => `file '${concatEscape(path.resolve(c.src))}'\n`).join(""));
  writeFileSync(metaFile, meta.join("\n") + "\n");

  const base = ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile,
    "-i", metaFile, "-map", "0", "-map_metadata", "1", "-map_chapters", "1"];
  let ok = await run("ffmpeg", [...base, "-c", "copy", "-movflags", "+faststart", out]);
  if (!ok) {
    // Parts can disagree on stream params after an odd crash. Slower, but works.
    log.warn("stream-copy concat failed, re-encoding");
    ok = await run("ffmpeg", [...base, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
  }

  for (const c of clips) if (c.src.endsWith(".fixed.mkv")) try { unlinkSync(c.src); } catch { /* fine */ }

  if (!ok) return { output: null, gaps, offsets };
  log.info(`stitched ${clips.length} part(s) -> ${path.basename(out)} (${offset.toFixed(0)}s)`);
  return { output: out, gaps, offsets };
}
