/**
 * PrimeGov public portals: Saanich (saanichca.primegov.com) and other
 * municipalities on *.primegov.com, by base URL.
 *
 * - The portal's own JSON API: api/v2/PublicPortal/ListUpcomingMeetings
 *   (every upcoming meeting) and ListArchivedMeetings?year=YYYY (for the
 *   days-back window). Each meeting: id (the externalId), title, local
 *   dateTime ("2026-11-30T18:30:00", read in the configured timezone),
 *   documents, isZoomMeeting / zoomMeetingLink, videoUrl.
 * - endDateTime is often earlier than the start (seen on Saanich), so the
 *   end is used only when it's after the start and within a day.
 * - Documents: each template's HTML agenda (/Portal/Meeting?
 *   meetingTemplateId=N) and PDF (/Public/CompiledDocument?
 *   meetingTemplateId=N&compileOutputType=1), plus the video: posted,
 *   retitled and pulled ones show in the meeting's history.
 * - Join link: zoomMeetingLink when the meeting says it's on Zoom, else a
 *   link found in the HTML agenda of an upcoming meeting. Saanich meets in
 *   person and streams on Granicus (videoUrl), so its meetings have none:
 *   run it list-only until there's a Granicus stream platform.
 * - Optional titles: keep meetings whose title contains one of them
 *   ("Council Meeting" keeps "Special Council Meeting and In-camera
 *   Meeting Notice" too).
 */
import { findLink } from "../../platforms/registry.js";
import { registerParser } from "../registry.js";
import { localDate, zonedTime } from "../time.js";
import { ConfigError, cfg, type DetectedMeeting, type FeedParser, type MeetingDocument } from "../types.js";
import { textOf } from "./escribe.js";

interface Config { baseUrl: string; titles: string[]; timezone?: string; daysBack: number; agendas: boolean }

interface PgDoc { id: number; templateId: number; templateName?: string; compileOutputType?: number; publishStatus?: number }
export interface PgMeeting {
  id: number; title?: string; dateTime?: string; endDateTime?: string; documentList?: PgDoc[];
  isZoomMeeting?: boolean; zoomMeetingLink?: string | null; videoUrl?: string | null; location?: string;
}

const OUTPUT: Record<number, string> = { 1: "PDF", 3: "HTML" };

function local(s: string | undefined, tz: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s ?? "");
  return m ? zonedTime(tz, +m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)) : undefined;
}

export function toMeetings(rows: PgMeeting[], o: { baseUrl: string; tz: string; titles: string[] }): (DetectedMeeting & { agendaHtml?: string })[] {
  const wanted = o.titles.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const abs = (u: string) => new URL(u.replace(/^\/\//, "https://"), o.baseUrl).toString();
  const seen = new Set<number>();
  const out: (DetectedMeeting & { agendaHtml?: string })[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const title = (r.title ?? "").replace(/\s+/g, " ").trim();
    if (!title || (wanted.length && !wanted.some((w) => title.toLowerCase().includes(w)))) continue;
    const start = local(r.dateTime, o.tz);
    if (!start) continue;
    const endAt = local(r.endDateTime, o.tz);
    const end = endAt && endAt > start && endAt.getTime() - start.getTime() < 86_400_000 ? endAt : undefined;
    const docs: MeetingDocument[] = [];
    let agendaHtml: string | undefined;
    for (const d of r.documentList ?? []) {
      if (d.publishStatus !== undefined && d.publishStatus !== 1) continue;   // only published
      const kind = OUTPUT[d.compileOutputType ?? 0];
      const url = d.compileOutputType === 3
        ? abs(`/Portal/Meeting?meetingTemplateId=${d.templateId}`)
        : abs(`/Public/CompiledDocument?meetingTemplateId=${d.templateId}&compileOutputType=${d.compileOutputType ?? 1}`);
      const name = (d.templateName ?? "Document").trim();
      docs.push({ title: kind && !name.toUpperCase().includes(kind) ? `${name} (${kind})` : name, type: name, url });
      if (d.compileOutputType === 3 && !agendaHtml && /agenda/i.test(name)) agendaHtml = url;
    }
    if (r.videoUrl) docs.push({ title: "Video", type: "Video", url: abs(r.videoUrl) });
    const zoom = r.isZoomMeeting && r.zoomMeetingLink ? findLink(r.zoomMeetingLink) : undefined;
    out.push({
      externalId: String(r.id), title, body: title, start, end, link: zoom,
      agendaUrl: agendaHtml ?? docs.find((d) => /agenda/i.test(d.type ?? ""))?.url,
      pageUrl: agendaHtml ?? (r.videoUrl ? abs(r.videoUrl) : undefined),
      cancelled: /\bcancell?ed\b/i.test(title) || undefined,
      documents: docs, agendaHtml,
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export const primegov: FeedParser<Config> = {
  id: "primegov",
  label: "PrimeGov public portal",
  description: "PrimeGov portals, e.g. https://saanichca.primegov.com/public/portal. Only the site URL is needed.",
  fields: [
    { name: "baseUrl", label: "Portal URL", type: "url", required: true, placeholder: "https://saanichca.primegov.com" },
    { name: "titles", label: "Meeting titles", type: "list", help: "One per line; keeps meetings whose title contains it (e.g. Council Meeting). Blank: all." },
    { name: "timezone", label: "Timezone", type: "text", placeholder: "America/Vancouver", help: "The portal's local time. Blank: the server's." },
    { name: "daysBack", label: "Days back", type: "number", placeholder: "14" },
  ],
  validate(c) {
    const o = cfg.obj(c);
    const u = new URL(cfg.url(o, "baseUrl"));
    if (!/\.primegov\.com$/i.test(u.hostname) && o.allowOtherHost !== true) throw new ConfigError("baseUrl", "must be a PrimeGov portal (*.primegov.com)");
    const timezone = cfg.text(o, "timezone", false, 64);
    if (timezone) { try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new ConfigError("timezone", "isn't a timezone (e.g. America/Vancouver)"); } }
    return { baseUrl: `${u.protocol}//${u.host}/`, titles: cfg.list(o, "titles"), timezone, daysBack: cfg.int(o, "daysBack", 14, 0, 365), agendas: o.agendas !== false };
  },
  host(c) { return c.baseUrl; },
  async fetch(c, ctx) {
    const tz = c.timezone ?? ctx.tz;
    const api = (p: string) => new URL(`api/v2/PublicPortal/${p}`, c.baseUrl).toString();
    const json = async (p: string): Promise<PgMeeting[]> => {
      const r = await ctx.http(api(p), { headers: { Accept: "application/json" } });
      let v: unknown;
      try { v = JSON.parse(r.body); } catch { throw new Error(`${p}: not JSON (is this a PrimeGov portal?)`); }
      if (!Array.isArray(v)) throw new Error(`${p}: no meeting list`);
      return v as PgMeeting[];
    };
    const rows = await json("ListUpcomingMeetings");
    const from = new Date(ctx.now.getTime() - c.daysBack * 86_400_000);
    if (c.daysBack > 0) {
      const years = new Set([Number(localDate(from, tz).slice(0, 4)), Number(localDate(ctx.now, tz).slice(0, 4))]);
      for (const y of years) {
        const past = (await json(`ListArchivedMeetings?year=${y}`)).filter((m) => (local(m.dateTime, tz)?.getTime() ?? 0) >= from.getTime());
        rows.push(...past);
      }
    }
    const ms = toMeetings(rows, { baseUrl: c.baseUrl, tz, titles: c.titles });
    let read = 0;
    for (const m of ms) {
      if (!c.agendas || m.link || m.cancelled || !m.agendaHtml || m.start.getTime() < ctx.now.getTime() - 3_600_000) continue;
      try { m.link = findLink(textOf((await ctx.http(m.agendaHtml)).body)); read++; }
      catch (e) { ctx.log(`agenda for ${m.title}: ${(e as Error).message}`); }
    }
    ctx.log(`${ms.length} meeting(s), ${read} agenda(s) read`);
    return { meetings: ms.map(({ agendaHtml: _, ...m }) => m) };
  },
};

registerParser(primegov);
