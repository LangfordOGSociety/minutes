/**
 * Timestamped side-channels recorded alongside the video: who Zoom shows as
 * the active speaker, and Zoom's own live captions when the host has them on.
 *
 * While recording, every change is appended to <dir>/<kind>.jsonl as
 * {t, part, partOffset, value}. Append-only, so a hard kill keeps everything
 * up to the last line. After stitching, finalize() maps (part, partOffset)
 * onto the stitched video's clock using the per-part offsets from stitch():
 *
 *   <slug>.speakers.json        [{at, until, name}]       at/until = seconds into the MP4
 *   <slug>.zoom-captions.json   [{at, until, text}]
 *   <slug>.zoom-captions.vtt    WebVTT, loadable as a second subtitle track
 *
 * Zoom captions are a reference only (the Whisper transcript is the primary
 * one); they exist only if the host enabled captions / live transcription.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PartOffset } from "./stitch.js";

export type TimelineKind = "speakers" | "captions";

interface Row { t: string; part: number; partOffset: number; value: string }
interface Span { at: number; until: number; value: string }

export function appendTimeline(dir: string, kind: TimelineKind, row: Row): void {
  appendFileSync(path.join(dir, `${kind}.jsonl`), JSON.stringify(row) + "\n");
}

function readRows(dir: string, kind: TimelineKind): Row[] {
  const f = path.join(dir, `${kind}.jsonl`);
  if (!existsSync(f)) return [];
  const rows: Row[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn last line after a hard kill */ }
  }
  return rows;
}

/** Rows -> spans on the stitched video's clock. A span lasts until the next
 *  change in the same part, or the end of its part. Parts that weren't
 *  stitched (empty/unreadable) drop out. The offset into a part is taken
 *  from the row's wall-clock time against that part's first captured frame
 *  (videoStart), not the stored partOffset, which counts from ffmpeg spawn.
 *  Changes before the first frame clamp to 0; anything after the part's
 *  last stitched frame (lost tail of a killed part) is dropped. */
function toSpans(input: Row[], offsets: PartOffset[], videoStart: Map<number, Date>): Span[] {
  const byPart = new Map(offsets.map((o) => [o.part, o]));
  const rows = input.map((r) => {
    const v = videoStart.get(r.part);
    const off = v ? (new Date(r.t).getTime() - v.getTime()) / 1000 : r.partOffset;
    return { ...r, partOffset: Math.max(0, off) };
  });
  const spans: Span[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const o = byPart.get(r.part);
    if (!o || r.partOffset > o.dur) continue;
    const next = rows[i + 1];
    const end = next && next.part === r.part ? Math.min(next.partOffset, o.dur) : o.dur;
    if (end <= r.partOffset) continue;
    spans.push({ at: +(o.at + r.partOffset).toFixed(2), until: +(o.at + end).toFixed(2), value: r.value });
  }
  return spans;
}

/** Zoom captions grow word by word and roll old lines off the top. Merge a
 *  row into the previous cue when it extends it (or the old text is still
 *  its start), so each cue is one utterance at its final wording. */
function mergeCaptions(spans: Span[]): Span[] {
  const out: Span[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const s of spans) {
    if (!s.value.trim()) continue;
    const prev = out.at(-1);
    const a = prev ? norm(prev.value) : "";
    const b = norm(s.value);
    const contiguous = prev && s.at - prev.until < 1.5;
    if (prev && contiguous && (b.startsWith(a) || a.startsWith(b))) {
      if (b.length >= a.length) prev.value = s.value;
      prev.until = s.until;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

const vttTime = (s: number) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};
const vttEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "->");

function writeAtomic(file: string, data: string): void {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

/** Write the stitched-clock files. Returns what was written, for the manifest. */
export function finalizeTimelines(dir: string, slug: string, offsets: PartOffset[],
    videoStart: Map<number, Date>): Record<string, string> {
  const written: Record<string, string> = {};

  const speakers = toSpans(readRows(dir, "speakers"), offsets, videoStart).filter((s) => s.value);
  if (speakers.length) {
    const f = `${slug}.speakers.json`;
    writeAtomic(path.join(dir, f), JSON.stringify(speakers.map((s) => ({ at: s.at, until: s.until, name: s.value })), null, 1));
    written.speakers = f;
  }

  const captions = mergeCaptions(toSpans(readRows(dir, "captions"), offsets, videoStart));
  if (captions.length) {
    const j = `${slug}.zoom-captions.json`;
    const v = `${slug}.zoom-captions.vtt`;
    writeAtomic(path.join(dir, j), JSON.stringify(captions.map((s) => ({ at: s.at, until: s.until, text: s.value })), null, 1));
    const cues = captions.map((s, i) => `${i + 1}\n${vttTime(s.at)} --> ${vttTime(s.until)}\n${vttEscape(s.value)}\n`);
    writeAtomic(path.join(dir, v), "WEBVTT\n\nNOTE Zoom live captions, as shown to the recorder. Reference only.\n\n" + cues.join("\n"));
    written.zoomCaptions = v;
  }
  return written;
}
