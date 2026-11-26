/**
 * eScribe meeting portals (#13): Langford (pub-langford.escribemeetings.com)
 * and many other municipalities; only the base URL is needed.
 *
 * - The calendar page's own JSON endpoint,
 *   POST /MeetingsCalendarView.aspx/GetCalendarMeetings
 *   {calendarStartDate, calendarEndDate}, gives every meeting in a window:
 *   ID (the externalId), name, type (the body), local start and end
 *   ("2026/12/08 17:30:00", in the server's timezone), and its documents.
 * - Join link: upcoming meetings' HTML agenda (Meeting.aspx?...Agenda=Agenda)
 *   is read for a Zoom link or, as Langford prints it, "Meeting ID: 843
 *   4290 9811" (+ passcode if any). Only meetings not yet over, so a run
 *   reads a handful of agendas.
 * - Cancelled: a document titled "... Cancellation Notice" (seen on
 *   Langford), or "cancelled" in the meeting's name. A "Postponement
 *   Notice" is not a cancellation (the 2026-11-24 council meeting had one
 *   and went ahead).
 * - Stream page: the portal's live stream (VideoStream.aspx) while it says
 *   there's live video, else the recorded video's player once there is
 *   one. Every meeting carries a VideoStream link, streamed or not, so the
 *   link alone doesn't count.
 * - Documents: every item the portal lists for the meeting (agenda PDF and
 *   HTML, cover page, revised agendas, addenda, notices, minutes, video),
 *   so the sync can log what's posted or pulled.
 * - Optional meeting types: only those (Langford has ~20: Council Meeting,
 *   Committee of the Whole Meeting, Special Council Meeting, ...). One per
 *   line; an entry that's no type itself is also read as a comma-separated
 *   list (types can contain commas: "Parks, Recreation, Culture and
 *   Beautification Committee"). When the filter leaves nothing, the log
 *   lists the portal's types.
 */
import { findLink } from "../../platforms/registry.js";
import { registerParser } from "../registry.js";
import { localDate, zonedTime } from "../time.js";
import { ConfigError, cfg, type DetectedMeeting, type FeedParser } from "../types.js";

interface Config { baseUrl: string; meetingTypes: string[]; daysBack: number; daysAhead: number; agendas: boolean }

interface EscribeDoc { Type?: string; Format?: string; Title?: string; Url?: string }
interface EscribeMeeting {
  ID: string; MeetingName: string; MeetingType?: string; StartDate: string; EndDate?: string;
  Description?: string; Location?: string; MeetingDocumentLink?: EscribeDoc[];
  HasLiveVideo?: boolean; HasVideo?: boolean; LiveVideoStandAloneLink?: string;
}

/** The few entities eScribe puts in names and descriptions. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[k] ?? m;
  });
}

/** Visible text of an HTML page (scripts and styles dropped). */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n");
}

function localTime(s: string | undefined, tz: string): Date | undefined {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(s ?? "");
  return m ? zonedTime(tz, +m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)) : undefined;
}

/** The portal's document list, deduplicated by URL, titles tidied. */
function docsOf(docs: EscribeDoc[], abs: (u: string) => string): { title: string; type?: string; url: string }[] {
  const out = new Map<string, { title: string; type?: string; url: string }>();
  for (const d of docs) {
    if (!d.Url) continue;
    const url = abs(d.Url);
    if (!out.has(url)) out.set(url, { title: decodeEntities(d.Title ?? "").replace(/\s+/g, " ").trim() || "(untitled)", ...(d.Type ? { type: d.Type } : {}), url });
  }
  return [...out.values()];
}

function streamOf(r: EscribeMeeting, docs: EscribeDoc[], abs: (u: string) => string): string | undefined {
  const live = /href=['"]([^'"]*VideoStream\.aspx[^'"]*)['"]/i.exec(r.LiveVideoStandAloneLink ?? "")?.[1];
  if (r.HasLiveVideo && live) return abs(decodeEntities(live));
  const rec = docs.find((d) => d.Type === "Video" && d.Url)?.Url;
  return r.HasVideo && rec ? abs(rec) : undefined;
}

const CANCELLED_DOC = /\bcancell?ation notice\b|\bnotice of cancell?ation\b|\bmeeting cancell?ed\b/i;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The wanted types: entries as given, plus the comma-separated parts of
 *  any entry that isn't itself one of the portal's types. */
export function typeFilter(entries: string[], portalTypes: string[]): Set<string> {
  const known = new Set(portalTypes.map(norm));
  const out = new Set<string>();
  for (const e of entries) {
    out.add(norm(e));
    if (!known.has(norm(e))) for (const part of e.split(",")) if (part.trim()) out.add(norm(part));
  }
  return out;
}

/** Calendar rows -> meetings, before any agenda is read. */
export function calendarToMeetings(rows: EscribeMeeting[], o: { baseUrl: string; tz: string; meetingTypes: string[] }): (DetectedMeeting & { agendaHtml?: string })[] {
  const types = typeFilter(o.meetingTypes, rows.map((r) => decodeEntities(r.MeetingType ?? r.MeetingName ?? "")));
  const abs = (u: string) => new URL(u.replace(/^\.\//, "/"), o.baseUrl).toString();
  const out: (DetectedMeeting & { agendaHtml?: string })[] = [];
  for (const r of rows) {
    const body = decodeEntities(r.MeetingType ?? r.MeetingName ?? "").trim();
    if (types.size && !types.has(norm(body))) continue;
    const start = localTime(r.StartDate, o.tz);
    if (!r.ID || !start) continue;
    const docs = r.MeetingDocumentLink ?? [];
    const html = docs.find((d) => d.Type === "Agenda" && d.Format === "HTML")?.Url;
    const pdf = docs.find((d) => d.Type === "Agenda" && d.Format === ".pdf")?.Url;
    const name = decodeEntities(r.MeetingName ?? "").trim();
    out.push({
      externalId: r.ID, title: name || body, body: body || undefined, start, end: localTime(r.EndDate, o.tz),
      agendaUrl: html ? abs(html) : pdf ? abs(pdf) : undefined,
      pageUrl: html ? abs(html) : abs(`/Meeting.aspx?Id=${encodeURIComponent(r.ID)}&lang=English`),   // the meeting on the portal, agenda or not
      cancelled: /\bcancell?ed\b/i.test(name) || docs.some((d) => CANCELLED_DOC.test(d.Title ?? "")) || undefined,
      link: findLink(textOf(`${r.Description ?? ""}\n${r.Location ?? ""}`)),
      documents: docsOf(docs, abs),
      streamUrl: streamOf(r, docs, abs),
      agendaHtml: html ? abs(html) : undefined,
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const ymd = (d: Date, tz: string) => localDate(d, tz);

export const escribe: FeedParser<Config> = {
  id: "escribe",
  label: "eScribe meetings portal",
  description: "Municipal eScribe portals (e.g. https://pub-langford.escribemeetings.com). Only the base URL is needed.",
  fields: [
    { name: "baseUrl", label: "Portal URL", type: "url", required: true, placeholder: "https://pub-langford.escribemeetings.com" },
    { name: "meetingTypes", label: "Meeting types", type: "list", help: "One per line, as the portal names them (e.g. Council Meeting). Blank: all." },
    { name: "daysAhead", label: "Days ahead", type: "number", placeholder: "120" },
    { name: "daysBack", label: "Days back", type: "number", placeholder: "14" },
  ],
  validate(c) {
    const o = cfg.obj(c);
    const u = new URL(cfg.url(o, "baseUrl"));
    if (!/\.escribemeetings\.com$/i.test(u.hostname) && o.allowOtherHost !== true) {
      throw new ConfigError("baseUrl", "must be an eScribe portal (*.escribemeetings.com)");
    }
    return { baseUrl: `${u.protocol}//${u.host}/`, meetingTypes: cfg.list(o, "meetingTypes"),
      daysAhead: cfg.int(o, "daysAhead", 120, 1, 730), daysBack: cfg.int(o, "daysBack", 14, 0, 365), agendas: o.agendas !== false };
  },
  host(c) { return c.baseUrl; },
  async fetch(c, ctx) {
    const from = new Date(ctx.now.getTime() - c.daysBack * 86_400_000), to = new Date(ctx.now.getTime() + c.daysAhead * 86_400_000);
    const r = await ctx.http(new URL("MeetingsCalendarView.aspx/GetCalendarMeetings", c.baseUrl).toString(), {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
      body: JSON.stringify({ calendarStartDate: ymd(from, ctx.tz), calendarEndDate: ymd(to, ctx.tz) }),
    });
    let rows: EscribeMeeting[];
    try { rows = (JSON.parse(r.body) as { d: EscribeMeeting[] }).d; } catch { throw new Error("the portal didn't return its calendar JSON"); }
    if (!Array.isArray(rows)) throw new Error("the portal's calendar JSON has no meeting list");
    const ms = calendarToMeetings(rows, { baseUrl: c.baseUrl, tz: ctx.tz, meetingTypes: c.meetingTypes });
    if (!ms.length && rows.length && c.meetingTypes.length) {
      const have = [...new Set(rows.map((x) => decodeEntities(x.MeetingType ?? "").trim()).filter(Boolean))].sort();
      ctx.log(`none of the ${rows.length} meeting(s) in this window are of the chosen types; types here: ${have.join(" | ")}`);
    }
    // Join links from the agendas of meetings that haven't happened yet.
    let read = 0;
    for (const m of ms) {
      if (!c.agendas || !m.agendaHtml || m.link || m.cancelled || m.start.getTime() < ctx.now.getTime() - 3_600_000) continue;
      try {
        m.link = findLink(textOf((await ctx.http(m.agendaHtml)).body));
        read++;
      } catch (e) {
        ctx.log(`agenda for ${m.title} ${ymd(m.start, ctx.tz)}: ${(e as Error).message}`);
      }
    }
    ctx.log(`${ms.length} meeting(s)${c.meetingTypes.length ? " of the chosen types" : ""}, ${read} agenda(s) read`);
    return { meetings: ms.map(({ agendaHtml: _, ...m }) => m) };
  },
};

registerParser(escribe);
