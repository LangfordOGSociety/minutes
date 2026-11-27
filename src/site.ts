/**
 * The public site's model: meetings as the public sees them (/, /m/:slug).
 *
 * A public meeting is a meeting row plus what became of it: its capture jobs
 * (is it live, did it fail), its recording folder (is there a video, a
 * transcript, how far is the transcriber) and its history. The public id is
 * the meeting's slug. Nothing here carries a join link, a meeting number,
 * the feed, an error text, the log or the bot's display: those fields don't
 * exist on these types.
 *
 * Visible = not hidden, not a duplicate of another meeting, and not waiting
 * for (or refused at) review. A meeting that disappeared from its feed
 * before it happened is not shown; one that has a recording always is.
 */
import type { Job } from "./jobs.js";
import { isArchive, platformFor } from "./platforms/registry.js";
import type { Meeting } from "./meetings.js";
import type { PublicRecording, Recording } from "./recordings.js";
import { toPublic } from "./recordings.js";
import type { ChangeKind, MeetingChange } from "./feeds/sync.js";

export type Stage = "upcoming" | "live" | "stitching" | "video_ready" | "ready" | "failed" | "not_recorded" | "cancelled";

/** A meeting that is neither over nor recorded this long after its start is "not recorded". */
export const OVER_AFTER_MS = 4 * 3_600_000;
/** A finished capture with no video yet is "processing" this long, then "failed". */
export const STITCH_WAIT_MS = 6 * 3_600_000;

export interface PublicDoc { title: string; type: string | null; url: string; copy: string | null }

/** How to join a meeting that is about to happen or happening, from its Zoom meeting number only: never the passcode (Zoom asks for that itself). */
export interface PublicJoin { platform: string; id: string; url: string }

export interface PublicMeeting {
  id: string;                    // the slug
  title: string;
  body: string | null;
  start: string;
  end: string | null;
  stage: Stage;
  cancelled: boolean;
  agendaUrl: string | null;
  pageUrl: string | null;        // the meeting on the city's own site
  streamUrl: string | null;      // the city's own live/recorded video page
  documents: PublicDoc[];
  join: PublicJoin | null;
  hasVideo: boolean;
  hasTranscript: boolean;
  /** A poster frame of the recording, as a path on this site (/media/...), when there is one. */
  poster: string | null;
  duration: number | null;
  live: boolean;
}

export type PublicChangeKind = "added" | "date_changed" | "time_changed" | "cancelled" | "reinstated" |
  "document_added" | "document_changed" | "document_removed";

/** The kinds of change the public sees. Not link changes, review decisions, merges, feed removals. */
export const PUBLIC_KINDS: ChangeKind[] = ["added", "date_changed", "time_changed", "cancelled", "reinstated",
  "document_added", "document_changed", "document_removed"];

export interface PublicChange {
  at: string;
  kind: PublicChangeKind;
  meeting: { id: string; title: string };
  from: string | null;           // start before (date/time changes)
  to: string | null;             // start after (added, date/time changes)
  doc: { title: string; type: string | null; url: string | null } | null;
}

const httpUrl = (u: string | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

export function visible(m: Meeting): boolean {
  return m.visibility === "public" && !m.duplicateOf && m.review !== "pending" && m.review !== "rejected";
}

/** Where a meeting is, for the page's "stage". */
export function stageOf(m: Meeting, jobs: Job[], rec: Recording | undefined, now: number): Stage {
  if (m.status === "cancelled") return "cancelled";
  // A finished video being imported (a Granicus clip) isn't a meeting in progress, whatever its date: it is being processed.
  const running = jobs.filter((j) => j.status === "running" || j.status === "stopping");
  if (running.length) return running.every((j) => isArchive(j.link)) ? "stitching" : "live";
  if (rec?.video) return rec.files.transcript ? "ready" : "video_ready";
  const last = jobs.at(-1);
  const start = Date.parse(m.start);
  if (last && (last.status === "scheduled" || last.status === "queued")) return now < start + OVER_AFTER_MS ? "upcoming" : "not_recorded";
  if (last?.status === "done") {
    const ended = Date.parse(last.endedAt ?? "") || start;
    return now - ended < STITCH_WAIT_MS ? "stitching" : "failed";
  }
  if (last && ["failed", "interrupted", "stopped"].includes(last.status)) return "failed";
  // No capture at all (listed only, or its job was cancelled).
  const end = m.endEst ? Date.parse(m.endEst) : start + OVER_AFTER_MS;
  return now < Math.max(end, start + 2 * 3_600_000) ? "upcoming" : "not_recorded";
}

/** Upcoming section: not over, or live. A cancelled meeting stays there until its time passes. */
export function isUpcoming(p: PublicMeeting, now: number): boolean {
  if (p.stage === "upcoming" || p.stage === "live") return true;
  return p.stage === "cancelled" && Date.parse(p.start) + 2 * 3_600_000 > now;
}

/** A Zoom join link for an upcoming or live meeting that a feed (or its documents) published; hand-entered links stay private. */
export function joinOf(m: Meeting, stage: Stage): PublicJoin | null {
  if (!m.link || !m.feedId || (stage !== "upcoming" && stage !== "live")) return null;
  const p = platformFor(m.link);
  if (!p || p.id !== "zoom") return null;
  const url = p.publicUrl?.(m.link), id = p.publicId(m.link);
  if (!url || !/^\d{9,12}$/.test(id)) return null;
  const spaced = id.length === 11 ? `${id.slice(0, 3)} ${id.slice(3, 7)} ${id.slice(7)}` : id;
  return { platform: p.label, id: spaced, url };
}

export function toPublicMeeting(m: Meeting, jobs: Job[], rec: Recording | undefined, now: number, copies?: Map<string, string>): PublicMeeting {
  const stage = stageOf(m, jobs, rec, now);
  return {
    id: m.slug, title: m.title, body: m.body ?? null, start: m.start, end: m.endEst ?? null, stage,
    cancelled: m.status === "cancelled",
    agendaUrl: httpUrl(m.agendaUrl), pageUrl: httpUrl(m.pageUrl), streamUrl: httpUrl(m.streamUrl),
    documents: (m.documents ?? []).flatMap((d) => { const url = httpUrl(d.url); return url ? [{ title: d.title, type: d.type ?? null, url, copy: copies?.get(d.url) ?? null }] : []; }),
    join: joinOf(m, stage),
    hasVideo: !!rec?.video && stage !== "cancelled", hasTranscript: !!rec?.files.transcript && stage !== "cancelled",
    poster: rec?.public && rec.files.thumb && stage !== "cancelled" ? `/media/${encodeURIComponent(rec.slug)}/${encodeURIComponent(rec.files.thumb)}` : null,
    duration: rec?.duration ?? null, live: stage === "live",
  };
}

/** The recording to show for a meeting: the latest capture with a video, else the latest with a folder. */
export function recordingOf(jobs: Job[], recs: Map<string, Recording>): Recording | undefined {
  const mine = jobs.map((j) => recs.get(j.slug)).filter((r): r is Recording => !!r);
  return [...mine].reverse().find((r) => r.video) ?? mine.at(-1);
}

export function publicChange(c: MeetingChange, m: { slug: string; title: string }): PublicChange | null {
  if (!PUBLIC_KINDS.includes(c.kind)) return null;
  const s = (r: Record<string, unknown> | null, k: string): string | null => (typeof r?.[k] === "string" ? r[k] as string : null);
  const d = c.kind.startsWith("document_") ? (c.after ?? c.before) : null;
  return {
    at: c.at, kind: c.kind as PublicChangeKind, meeting: { id: m.slug, title: m.title },
    from: s(c.before, "start"), to: s(c.after, "start"),
    doc: d && typeof d.title === "string" ? { title: d.title, type: typeof d.type === "string" ? d.type : null,
      url: c.kind === "document_removed" ? null : httpUrl(typeof d.url === "string" ? d.url : undefined) } : null,
  };
}

/** One recording as /api/recordings gives it (public fields only). */
export const recordingView = (r: Recording | undefined): PublicRecording | null => (r ? toPublic(r) : null);

export interface ListQuery { scope: "upcoming" | "past"; body?: string; from?: Date; to?: Date; q?: string; limit: number; offset: number }

export function filterMeetings(all: PublicMeeting[], q: ListQuery, now: number): { meetings: PublicMeeting[]; total: number } {
  const needle = q.q?.trim().toLowerCase();
  let list = all.filter((p) => (q.scope === "upcoming") === isUpcoming(p, now));
  if (q.body) list = list.filter((p) => (p.body ?? "").toLowerCase() === q.body!.toLowerCase());
  if (q.from) list = list.filter((p) => Date.parse(p.start) >= q.from!.getTime());
  if (q.to) list = list.filter((p) => Date.parse(p.start) < q.to!.getTime());
  if (needle) list = list.filter((p) => p.title.toLowerCase().includes(needle) || (p.body ?? "").toLowerCase().includes(needle));
  list.sort((a, b) => q.scope === "upcoming" ? a.start.localeCompare(b.start) : b.start.localeCompare(a.start));
  return { meetings: list.slice(q.offset, q.offset + q.limit), total: list.length };
}
