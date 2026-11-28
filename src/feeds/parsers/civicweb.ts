/**
 * CivicWeb portals (Diligent Community, "iCompass"): Colwood (colwood.civicweb.net) and other
 * municipalities on *.civicweb.net, by base URL.
 *
 * The portal's calendar page is built by JavaScript from a small JSON service, which is what is read
 * here (no browser needed):
 *
 * - `Services/MeetingsService.svc/meetings?from=YYYY-MM-DD&to=9999-12-31`: every meeting from a date:
 *   Id (the externalId), Name ("Council - 14 Dec 2026"; "CANCELLED - ..." and "POSTPONED - ..." are
 *   the portal's own way to say it is off), local `MeetingDateTime` ("2026-12-14 18:30", read in the
 *   configured timezone: the lists on the pages show only the day), location, Published.
 * - `meetings/{id}/meetingDocuments` (published meetings): the HTML agenda, the agenda package PDF,
 *   minutes. Each is `/document/<id>` (PDF), `/document/<id>/` (HTML) or `/document/<id>?printPdf=true`.
 * - `api/videolink/{id}`: when the city has set up the meeting's video, its YouTube event id. That
 *   is the meeting's stream (a YouTube link, which the YouTube platform can record while it is live)
 *   with no guessing from a channel's stream list. Before the city sets one up there is none.
 *
 * Join link: the YouTube stream when there is one and the meeting is not over; else a join link
 * (Zoom...) found in the agenda text. A meeting that is over keeps the video as its stream page only.
 *
 * "Notice of ..." entries (a notice of a meeting that has its own entry) are dropped when another
 * entry starts within 15 minutes; alone they stay (a notice can be all there is for a while).
 */
import { findLink } from "../../platforms/registry.js";
import { registerParser } from "../registry.js";
import { localDate, zonedTime } from "../time.js";
import { ConfigError, cfg, type DetectedMeeting, type FeedParser, type MeetingDocument } from "../types.js";
import { textOf } from "./escribe.js";

interface Config { baseUrl: string; titles: string[]; timezone?: string; daysBack: number; details: boolean }

export interface CwMeeting { Id: number; Name?: string; MeetingDate?: string; MeetingDateTime?: string; MeetingTime?: string; MeetingLocation?: string; Published?: boolean; TypeId?: number }
export interface CwDoc { Id: number; Type?: number; DocumentType?: number; Name?: string; Html?: string; IsPublic?: boolean }

const OVER_MS = 6 * 3_600_000;

/** "CANCELLED - Council - 25 Nov 2026" -> { title: "Council", cancelled: true }. */
export function cleanName(name: string): { title: string; cancelled: boolean } {
  let t = name.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*[-–]?\s*\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}$/, "").trim();   // the portal appends the day
  const m = /^(CANCELL?ED|POSTPONED)\s*[-:–]?\s*/i.exec(t);
  if (m) t = t.slice(m[0].length);
  return { title: t.replace(/^[-–\s]+|[-–\s]+$/g, ""), cancelled: !!m };
}

function startOf(m: CwMeeting, tz: string): Date | undefined {
  const dt = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(m.MeetingDateTime ?? "");
  return dt ? zonedTime(tz, +dt[1], +dt[2], +dt[3], +dt[4], +dt[5]) : undefined;
}

function youtubeUrl(videoJson: string | undefined): string | undefined {
  if (!videoJson) return undefined;
  try {
    let v: unknown = JSON.parse(videoJson);
    if (typeof v === "string") v = JSON.parse(v);   // the service sends JSON inside a JSON string
    const row = Array.isArray(v) ? v[0] : v;
    const id = row && typeof row === "object" ? (row as { YouTubeEventId?: unknown; YouTube?: unknown }).YouTubeEventId : undefined;
    return typeof id === "string" && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : undefined;
  } catch { return undefined; }
}

export function documentsOf(docs: CwDoc[], abs: (p: string) => string): MeetingDocument[] {
  const out: MeetingDocument[] = [];
  for (const d of docs) {
    const kind = `${d.Type ?? ""}/${d.DocumentType ?? ""}`;
    if (kind === "1/1") {
      out.push({ title: "Agenda (HTML)", type: "Agenda", url: abs(`/document/${d.Id}/`) }, { title: "Agenda (PDF)", type: "Agenda", url: abs(`/document/${d.Id}?printPdf=true`) });
    } else if (kind === "1/4") out.push({ title: "Agenda Package (PDF)", type: "Agenda", url: abs(`/document/${d.Id}`) });
    else if (kind === "2/9") out.push({ title: "Minutes (HTML)", type: "Minutes", url: abs(`/document/${d.Id}/`) });
    else if (kind === "2/10") out.push({ title: "Minutes (PDF)", type: "Minutes", url: abs(`/document/${d.Id}`) });
  }
  return out;
}

export function toMeetings(rows: CwMeeting[], o: { baseUrl: string; tz: string; titles: string[]; now: Date; docs?: Map<number, CwDoc[]>; video?: Map<number, string> }): DetectedMeeting[] {
  const wanted = o.titles.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const abs = (p: string) => new URL(p, o.baseUrl).toString();
  const seen = new Set<number>();
  const parsed: { r: CwMeeting; title: string; cancelled: boolean; start: Date; notice: boolean }[] = [];
  for (const r of rows) {
    if (seen.has(r.Id)) continue;
    seen.add(r.Id);
    const { title, cancelled } = cleanName(r.Name ?? "");
    const start = startOf(r, o.tz);
    if (!title || !start) continue;
    if (wanted.length && !wanted.some((w) => title.toLowerCase().includes(w))) continue;
    parsed.push({ r, title, cancelled, start, notice: /^notice of\b/i.test(title) });
  }
  const out: DetectedMeeting[] = [];
  for (const p of parsed) {
    if (p.notice && parsed.some((q) => !q.notice && Math.abs(q.start.getTime() - p.start.getTime()) <= 15 * 60_000)) continue;
    const id = p.r.Id;
    const docs = o.docs?.get(id) ?? [];
    const documents = documentsOf(docs, abs);
    const video = youtubeUrl(o.video?.get(id));
    if (video) documents.push({ title: "Video", type: "Video", url: video });
    const over = p.start.getTime() < o.now.getTime() - OVER_MS;
    const agendaText = docs.filter((d) => d.Type === 1 && d.DocumentType === 1).map((d) => textOf(d.Html ?? "")).join("\n");
    const link = p.cancelled ? undefined : video && !over ? findLink(video) : !over && agendaText ? findLink(agendaText) : undefined;
    out.push({
      externalId: String(id), title: p.title, body: p.title, start: p.start, link,
      pageUrl: abs(`/Portal/MeetingInformation.aspx?Org=Cal&Id=${id}`),
      streamUrl: video,
      agendaUrl: documents.find((d) => d.title === "Agenda (PDF)")?.url,
      cancelled: p.cancelled || undefined,
      documents,
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export const civicweb: FeedParser<Config> = {
  id: "civicweb",
  label: "CivicWeb portal (Diligent Community)",
  description: "CivicWeb portals, e.g. https://colwood.civicweb.net. Only the site URL is needed; the meeting's YouTube stream is used as its join link when the city sets one up.",
  fields: [
    { name: "baseUrl", label: "Portal URL", type: "url", required: true, placeholder: "https://colwood.civicweb.net" },
    { name: "titles", label: "Meeting titles", type: "list", help: "One per line; keeps meetings whose title contains it (e.g. Council). Blank: all." },
    { name: "timezone", label: "Timezone", type: "text", placeholder: "America/Vancouver", help: "The portal's local time. Blank: the server's." },
    { name: "daysBack", label: "Days back", type: "number", placeholder: "14" },
  ],
  validate(c) {
    const o = cfg.obj(c);
    const u = new URL(cfg.url(o, "baseUrl"));
    if (!/\.civicweb\.net$/i.test(u.hostname) && o.allowOtherHost !== true) throw new ConfigError("baseUrl", "must be a CivicWeb portal (*.civicweb.net)");
    const timezone = cfg.text(o, "timezone", false, 64);
    if (timezone) { try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new ConfigError("timezone", "isn't a timezone (e.g. America/Vancouver)"); } }
    return { baseUrl: `${u.protocol}//${u.host}/`, titles: cfg.list(o, "titles"), timezone, daysBack: cfg.int(o, "daysBack", 14, 0, 365), details: o.details !== false };
  },
  host(c) { return c.baseUrl; },
  async fetch(c, ctx) {
    const tz = c.timezone ?? ctx.tz;
    const url = (p: string) => new URL(p, c.baseUrl).toString();
    const getText = async (p: string): Promise<string> => (await ctx.http(url(p), { headers: { Accept: "application/json" } })).body;
    const from = localDate(new Date(ctx.now.getTime() - c.daysBack * 86_400_000), tz);
    let rows: CwMeeting[];
    try {
      const v: unknown = JSON.parse(await getText(`Services/MeetingsService.svc/meetings?from=${from}&to=9999-12-31`));
      if (!Array.isArray(v)) throw new Error("no meeting list");
      rows = v as CwMeeting[];
    } catch (e) { throw new Error(`meetings: ${(e as Error).message} (is this a CivicWeb portal?)`); }

    const base = toMeetings(rows, { baseUrl: c.baseUrl, tz, titles: c.titles, now: ctx.now });
    const docs = new Map<number, CwDoc[]>(), video = new Map<number, string>();
    let fetched = 0;
    if (c.details) {
      const published = new Set(rows.filter((r) => r.Published).map((r) => String(r.Id)));
      for (const m of base) {
        const id = Number(m.externalId);
        const near = m.start.getTime() < ctx.now.getTime() + 14 * 86_400_000;
        try {
          if (published.has(m.externalId)) docs.set(id, JSON.parse(await getText(`Services/MeetingsService.svc/meetings/${id}/meetingDocuments`)) as CwDoc[]);
          if (near) video.set(id, await getText(`api/videolink/${id}`));
          fetched++;
        } catch (e) { ctx.log(`details of ${m.title} (${id}): ${(e as Error).message}`); }
      }
    }
    const ms = toMeetings(rows, { baseUrl: c.baseUrl, tz, titles: c.titles, now: ctx.now, docs, video });
    ctx.log(`${ms.length} meeting(s), details of ${fetched}, ${ms.filter((m) => m.streamUrl).length} with a YouTube video`);
    return { meetings: ms };
  },
};

registerParser(civicweb);
