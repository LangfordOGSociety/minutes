/**
 * Recordings on disk (<out>/<slug>/manifest.json), as the admin sees them
 * and as the public sees them.
 *
 * Public = a capture job made this folder, its meeting is public and not
 * cancelled, and there's a video or it's being recorded now. Folders no job
 * points at (made by the CLI, or whose job was deleted) are admin only.
 * The public view has no link, outcome, parts or event log, and its `files`
 * are the only files /media will serve for it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { RENDITION_RE } from "./renditions.js";
import path from "node:path";
import type { Scheduler } from "./jobs.js";
import { SLUG_RE } from "./util.js";

export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface Recording {
  slug: string;
  title: string;
  public: boolean;
  scheduledStart: string | null;
  outcome: string;
  active: boolean;
  video: string | null;
  videoBytes: number | null;
  duration: number | null;          // seconds, from the stitch offsets
  parts: { index: number; started: string; ended: string | null }[];
  chapters: { title: string; at: number }[];
  /** From the transcriber's transcript.status.json, if it has seen this one. */
  transcript: { status: string; stage: string | null; progress: number | null; error: string | null; started: string | null; finished: string | null; updated: string | null } | null;
  /** Side files that exist: subtitles, transcript, Zoom captions, speakers, live draft. */
  /** Smaller copies of the video for slow connections, biggest first (`<slug>.720p.mp4`); see renditions.ts. */
  renditions: { height: number; file: string; bytes: number }[];
  files: { vtt?: string; srt?: string; txt?: string; transcript?: string; zoomCaptions?: string; speakers?: string; live?: string; thumb?: string };
}

export type PublicRecording = Pick<Recording, "slug" | "title" | "scheduledStart" | "active" | "video" | "videoBytes" |
  "duration" | "chapters" | "transcript" | "renditions"> & { files: Omit<Recording["files"], "speakers"> };

/** What the folder itself says (manifest, status, which files exist): the part of a Recording that doesn't depend on the scheduler. */
interface Disk { sig: string; rec: Omit<Recording, "title" | "public" | "active"> }

/** Per recordings folder (and timezone): what was read from each slug's folder, kept while its signature (the mtimes of the folder,
 *  its manifest and its transcript status) is unchanged. A pass over thousands of recordings is then three stat calls each,
 *  and only a folder that changed is read again. The files stay the source of truth: the capture and the transcriber (other
 *  processes) write them, and a manifest, a new file in the folder, or a status update each move one of the three mtimes. */
const diskCache = new Map<string, Map<string, Disk>>();
const mtime = (f: string): string => { try { const s = statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };

function readFolder(out: string, slug: string, clock: Intl.DateTimeFormat): Omit<Recording, "title" | "public" | "active"> | null {
  const dir = path.join(out, slug);
  let m: any;
  try { m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return null; }
  const video = typeof m.output === "string" && FILE_RE.test(m.output) && existsSync(path.join(dir, m.output)) ? m.output : null;
  const parts = Array.isArray(m.parts) ? m.parts.map((p: any) => ({ index: p.index, started: p.started, ended: p.ended })) : [];
  // Chapter offsets: part 1 at 0, then each gap's offset (same as the MP4's chapters).
  const gaps: any[] = Array.isArray(m.gaps) ? m.gaps : [];
  const chapters = parts.length ? [{ title: `Part 1 (${clock.format(new Date(parts[0].started))})`, at: 0 }] : [];
  for (const g of gaps) {
    const p = parts.find((x: any) => x.index === g.beforePart);
    const when = p ? clock.format(new Date(p.started)) : "?";
    chapters.push({ title: `Part ${g.beforePart} (${when}, after ${Math.round(g.seconds)}s gap)`, at: g.atOffsetSeconds });
  }
  const offsets: any[] = Array.isArray(m.offsets) ? m.offsets : [];
  const duration = offsets.length ? offsets.reduce((s, o) => s + (Number(o.dur) || 0), 0) : null;
  const has = (f: string) => existsSync(path.join(dir, f)) ? f : undefined;
  const st = (() => { try { return JSON.parse(readFileSync(path.join(dir, "transcript.status.json"), "utf8")); } catch { return null; } })();
  const files = {
    vtt: has(`${slug}.vtt`), srt: has(`${slug}.srt`), txt: has(`${slug}.txt`),
    transcript: has(`${slug}.transcript.json`), zoomCaptions: has(`${slug}.zoom-captions.vtt`),
    speakers: has(`${slug}.speakers.json`), thumb: video ? has(`${slug}.jpg`) : undefined,
  };
  // Smaller copies, found by name: this runs only for a folder that changed (its mtime moves when one appears).
  const renditions: Recording["renditions"] = [];
  if (video) {
    try {
      for (const f of readdirSync(dir)) {
        const r = RENDITION_RE.exec(f);
        if (r && r[1] === slug) renditions.push({ height: Number(r[2]), file: f, bytes: statSync(path.join(dir, f)).size });
      }
    } catch { /* unreadable folder: none */ }
    renditions.sort((a, b) => b.height - a.height);
  }
  return {
    slug, renditions,
    transcript: st ? { status: String(st.status ?? "unknown"), stage: st.stage ?? null,
      progress: typeof st.progress === "number" ? st.progress : null, error: st.error ?? null,
      started: typeof st.started === "string" ? st.started : null, finished: typeof st.finished === "string" ? st.finished : null,
      updated: typeof st.updated === "string" ? st.updated : null } : null,
    files: Object.fromEntries(Object.entries(files).filter(([, v]) => v)) as Recording["files"],
    scheduledStart: m.scheduledStart ?? null,
    outcome: m.outcome ?? "unknown",
    video,
    videoBytes: video ? statSync(path.join(dir, video)).size : null,
    duration: duration && Number.isFinite(duration) ? Math.round(duration) : null,
    parts,
    chapters,
  };
}

export function listRecordings(out: string, sched: Scheduler, tz: string): Recording[] {
  const clock = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let names: string[] = [];
  try { names = readdirSync(out); } catch { return []; }
  const key = `${out}|${tz}`;
  const old = diskCache.get(key) ?? new Map<string, Disk>(), fresh = new Map<string, Disk>();
  const active = sched.activeSlugs();
  const meetings = new Map(sched.meetings.list().map((m) => [m.id, m]));
  const recs: Recording[] = [];
  for (const slug of names) {
    if (!SLUG_RE.test(slug)) continue;
    const dir = path.join(out, slug);
    const sig = `${mtime(dir)}|${mtime(path.join(dir, "manifest.json"))}|${mtime(path.join(dir, "transcript.status.json"))}`;
    let d = old.get(slug);
    if (!d || d.sig !== sig) {
      const rec = readFolder(out, slug, clock);
      if (!rec) continue;   // no manifest (or unreadable): not a recording
      d = { sig, rec };
    }
    fresh.set(slug, d);
    const job = sched.jobBySlug(slug);
    const meeting = job ? meetings.get(job.meetingRef) : undefined;
    const isActive = active.has(slug);
    const files = isActive && existsSync(path.join(dir, "live.json")) ? { ...d.rec.files, live: "live.json" } : d.rec.files;
    recs.push({
      ...d.rec, files,
      title: meeting && meeting.title !== slug ? meeting.title : slug,
      public: !!meeting && meeting.visibility === "public" && meeting.status !== "cancelled" && (!!d.rec.video || isActive),
      active: isActive,
    });
  }
  diskCache.set(key, fresh);   // folders that went away are forgotten
  return recs.sort((a, b) => (b.scheduledStart ?? "").localeCompare(a.scheduledStart ?? ""));
}

export function toPublic(r: Recording): PublicRecording {
  const { speakers: _, ...files } = r.files;
  return { slug: r.slug, title: r.title, scheduledStart: r.scheduledStart, active: r.active, video: r.video,
    videoBytes: r.videoBytes, duration: r.duration, chapters: r.chapters, transcript: r.transcript, renditions: r.renditions, files };
}

/** The files /media may serve for a public recording. */
export function publicFiles(r: PublicRecording): Set<string> {
  const s = new Set<string>(Object.values(r.files).filter((v): v is string => typeof v === "string"));
  if (r.video) s.add(r.video);
  for (const x of r.renditions) s.add(x.file);
  return s;
}
