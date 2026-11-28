/**
 * Raw capture parts (`part_001.mkv`...) next to the stitched MP4. The MP4 is made from them by a stream copy, so
 * once it is good they are the same bytes twice (about half of the recordings volume). They matter only for
 * stitching again, and while a capture is running: the transcriber's live draft reads the growing part, and its
 * final pass reads the MP4.
 *
 * Off unless KEEP_PARTS_DAYS is set. A recording's parts are deleted only when all of these hold: its capture is
 * finished, the MP4 is older than that many days, the MP4's length matches what the stitch recorded, and its size is
 * within 3% of the parts' (a stream copy: if the stitch had to re-encode, the parts are the better quality and stay).
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUDIO_DELETED } from "./recordings.js";
import { logger, SLUG_RE } from "./util.js";

const log = logger("parts");
const PART_RE = /^part_\d{3}\.mkv$/;

function duration(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 60_000 },
      (err, out) => { const d = Number.parseFloat(String(out).trim()); resolve(err || !(d > 0) ? null : d); });
  });
}

export interface PruneOpts { out: string; days: number; now?: number; isBusy: (slug: string) => boolean }

/** One pass. Returns what was removed: [slug, bytes freed]. */
export async function pruneParts(o: PruneOpts): Promise<[string, number][]> {
  const now = o.now ?? Date.now();
  const freed: [string, number][] = [];
  let names: string[] = [];
  try { names = readdirSync(o.out); } catch { return freed; }
  for (const slug of names) {
    if (!SLUG_RE.test(slug) || o.isBusy(slug)) continue;
    const dir = path.join(o.out, slug);
    let parts: string[] = [];
    try { parts = readdirSync(dir).filter((f) => PART_RE.test(f)); } catch { continue; }
    if (!parts.length) continue;
    let m: { output?: unknown; offsets?: { dur?: number }[] };
    try { m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { continue; }
    if (typeof m.output !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.output)) continue;
    const video = path.join(dir, m.output);
    if (!existsSync(video)) continue;
    const vs = statSync(video);
    if (now - vs.mtimeMs < o.days * 86_400_000) continue;
    const want = (m.offsets ?? []).reduce((s, x) => s + (Number(x.dur) || 0), 0);
    if (!(want > 0)) continue;   // nothing recorded to check the MP4 against: keep them
    const got = await duration(video);
    if (got === null || Math.abs(got - want) > Math.max(2, want * 0.01)) continue;
    const partBytes = parts.reduce((s, f) => s + statSync(path.join(dir, f)).size, 0);
    if (!(partBytes > 0) || Math.abs(vs.size - partBytes) / partBytes > 0.03) continue;
    for (const f of parts) { try { unlinkSync(path.join(dir, f)); } catch { /* gone already */ } }
    freed.push([slug, partBytes]);
    log.info(`${slug}: removed ${parts.length} raw part(s), ${(partBytes / 1e6).toFixed(0)} MB (the MP4 is verified and ${Math.round((now - vs.mtimeMs) / 86_400_000)} days old)`);
  }
  return freed;
}

/**
 * The sound of a YouTube meeting (its video is embedded from YouTube, so we only keep the sound long enough to make the
 * transcript and tell the voices apart). Once the transcript is done and its files are there, the sound (the stitched file and
 * the parts, and the live draft's chunks) is deleted and `audio.deleted` is left in the folder, so the recording is still
 * listed and its transcript still served. `days` (KEEP_AUDIO_DAYS, default 0) is how long to keep it after the transcript was
 * finished, for transcribing again.
 */
export function deleteAudio(o: { out: string; slug: string; days: number; now?: number }): number | null {
  const dir = path.join(o.out, o.slug);
  try {
    const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { audioOnly?: boolean; output?: unknown };
    if (m.audioOnly !== true || existsSync(path.join(dir, AUDIO_DELETED))) return null;
    const st = JSON.parse(readFileSync(path.join(dir, "transcript.status.json"), "utf8")) as { status?: string; finished?: string; updated?: string };
    if (st.status !== "done" || !existsSync(path.join(dir, `${o.slug}.transcript.json`))) return null;
    const done = Date.parse(st.finished ?? st.updated ?? "") || statSync(path.join(dir, "transcript.status.json")).mtimeMs;
    if ((o.now ?? Date.now()) - done < o.days * 86_400_000) return null;
    let freed = 0;
    const rm = (f: string) => { try { freed += statSync(f).size; unlinkSync(f); } catch { /* not there */ } };
    for (const f of readdirSync(dir)) if (PART_RE.test(f) || /\.fixed\.mkv$/.test(f)) rm(path.join(dir, f));
    if (typeof m.output === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.output)) rm(path.join(dir, m.output));
    rmSync(path.join(dir, ".live"), { recursive: true, force: true });
    writeFileSync(path.join(dir, AUDIO_DELETED), new Date(o.now ?? Date.now()).toISOString() + "\n");
    log.info(`${o.slug}: sound deleted after its transcript, ${(freed / 1e6).toFixed(0)} MB`);
    return freed;
  } catch { return null; }
}
