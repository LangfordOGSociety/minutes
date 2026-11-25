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
  transcript: { status: string; stage: string | null; progress: number | null; error: string | null } | null;
  /** Side files that exist: subtitles, transcript, Zoom captions, speakers, live draft. */
  files: { vtt?: string; srt?: string; txt?: string; transcript?: string; zoomCaptions?: string; speakers?: string; live?: string };
}

export type PublicRecording = Pick<Recording, "slug" | "title" | "scheduledStart" | "active" | "video" | "videoBytes" |
  "duration" | "chapters" | "transcript"> & { files: Omit<Recording["files"], "speakers"> };

export function listRecordings(out: string, sched: Scheduler, tz: string): Recording[] {
  const clock = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const recs: Recording[] = [];
  let names: string[] = [];
  try { names = readdirSync(out); } catch { return recs; }
  const jobs = sched.list();
  for (const slug of names) {
    if (!SLUG_RE.test(slug)) continue;
    const mf = path.join(out, slug, "manifest.json");
    if (!existsSync(mf)) continue;
    let m: any;
    try { m = JSON.parse(readFileSync(mf, "utf8")); } catch { continue; }
    const video = typeof m.output === "string" && FILE_RE.test(m.output) && existsSync(path.join(out, slug, m.output))
      ? m.output : null;
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
    const has = (f: string) => existsSync(path.join(out, slug, f)) ? f : undefined;
    const st = (() => { try { return JSON.parse(readFileSync(path.join(out, slug, "transcript.status.json"), "utf8")); } catch { return null; } })();
    const active = sched.isActive(slug);
    const files = {
      vtt: has(`${slug}.vtt`), srt: has(`${slug}.srt`), txt: has(`${slug}.txt`),
      transcript: has(`${slug}.transcript.json`), zoomCaptions: has(`${slug}.zoom-captions.vtt`),
      speakers: has(`${slug}.speakers.json`), live: active ? has("live.json") : undefined,
    };
    const job = jobs.filter((j) => j.slug === slug).at(-1);
    const meeting = job ? sched.meetings.get(job.meetingRef) : undefined;
    recs.push({
      slug,
      title: meeting && meeting.title !== slug ? meeting.title : slug,
      public: !!meeting && meeting.visibility === "public" && meeting.status !== "cancelled" && (!!video || active),
      transcript: st ? { status: String(st.status ?? "unknown"), stage: st.stage ?? null,
        progress: typeof st.progress === "number" ? st.progress : null, error: st.error ?? null } : null,
      files: Object.fromEntries(Object.entries(files).filter(([, v]) => v)) as Recording["files"],
      scheduledStart: m.scheduledStart ?? null,
      outcome: m.outcome ?? "unknown",
      active,
      video,
      videoBytes: video ? statSync(path.join(out, slug, video)).size : null,
      duration: duration && Number.isFinite(duration) ? Math.round(duration) : null,
      parts,
      chapters,
    });
  }
  return recs.sort((a, b) => (b.scheduledStart ?? "").localeCompare(a.scheduledStart ?? ""));
}

export function toPublic(r: Recording): PublicRecording {
  const { speakers: _, ...files } = r.files;
  return { slug: r.slug, title: r.title, scheduledStart: r.scheduledStart, active: r.active, video: r.video,
    videoBytes: r.videoBytes, duration: r.duration, chapters: r.chapters, transcript: r.transcript, files };
}

/** The files /media may serve for a public recording. */
export function publicFiles(r: PublicRecording): Set<string> {
  const s = new Set<string>(Object.values(r.files).filter((v): v is string => typeof v === "string"));
  if (r.video) s.add(r.video);
  return s;
}
