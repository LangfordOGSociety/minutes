/**
 * Granicus MediaManager sites (#34): Saanich (saanich.ca.granicus.com,
 * view 1) and many others, by base URL and view id.
 *
 * Reads ViewPublisher.php?view_id=N (a static page, conditional GET) and
 * its "Upcoming Events" table. Templates differ between sites, so rows are
 * read by content, not by column: the first cell is the name, the date is
 * the visible date text ("November 30, 2026 - 02:30 PM") in the site's
 * timezone (config; default the server's), and links are recognized by
 * target: AgendaViewer.php (agenda), MediaPlayer.php / ViewEvent (the
 * live stream page). Not the hidden Unix timestamp most templates carry:
 * on Pittsburgh's site it's 3 hours off (2:30 PM Eastern as 22:30Z), it
 * seems to be computed in Granicus's own Pacific time.
 *
 * The externalId is a hash of the name and start: Granicus only adds an
 * event_id link once an agenda or stream exists, so it can't be the id.
 * Past meetings move to the archive tables and aren't read (they're past,
 * so the sync doesn't count them as removed).
 *
 * Saanich streams on Granicus itself, which isn't a capture platform yet:
 * its meetings come with no join link (the stream page is pageUrl), so use
 * the list_only policy until there is one. A join link in an HTML agenda
 * (a Zoom ID, say) is picked up for meetings that have one.
 */
import { createHash } from "node:crypto";
import { findLink } from "../../platforms/registry.js";
import { registerParser } from "../registry.js";
import { decodeEntities, textOf } from "./escribe.js";
import { parseLooseDate } from "./html.js";
import { zonedTime } from "../time.js";
import { ConfigError, cfg, type DetectedMeeting, type FeedParser } from "../types.js";

interface Config { baseUrl: string; viewId: number; timezone?: string; agendas: boolean }

/** The upcoming-events table's rows, or [] when the page has none listed. */
export function upcomingRows(html: string): string[] {
  let i = html.indexOf("upcoming-events-heading");
  if (i < 0) i = html.search(/upcoming\s+events/i);
  if (i < 0) return [];
  const start = html.indexOf("<table", i);
  const end = start < 0 ? -1 : html.indexOf("</table>", start);
  if (start < 0 || end < 0) return [];
  return [...html.slice(start, end).matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((m) => m[0]).filter((r) => /<td\b/i.test(r));
}

export function rowsToMeetings(rows: string[], o: { baseUrl: string; tz: string }): (DetectedMeeting & { agendaHtml?: string })[] {
  const out: (DetectedMeeting & { agendaHtml?: string })[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue;   // "Currently there are no Upcoming Events"
    const name = textOf(cells[0]).replace(/\s+/g, " ").trim();
    // Visible text only: drop the hidden timestamp span first.
    const d = parseLooseDate(textOf(cells.slice(1).join(" ").replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, " ")));
    const start = d ? zonedTime(o.tz, d.y, d.mo, d.d, d.h, d.mi) : undefined;
    if (!name || !start) continue;
    const hrefs = [...row.matchAll(/href="([^"]+)"/gi)].map((m) => new URL(decodeEntities(m[1]).replace(/^\/\//, "https://"), o.baseUrl).toString());
    const agenda = hrefs.find((h) => /AgendaViewer\.php/i.test(h));
    const watch = hrefs.find((h) => /MediaPlayer\.php|ViewEvent|event_id=/i.test(h) && !/AgendaViewer/i.test(h));
    const title = name.replace(/\s+on \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}\s*[AP]M\b\s*(-\s*)?/i, (m, dash) => (dash ? ": " : "")).trim();
    out.push({
      externalId: createHash("sha1").update(`${name.toLowerCase()}|${start.toISOString()}`).digest("hex").slice(0, 16),
      title, start, agendaUrl: agenda, pageUrl: watch ?? agenda, streamUrl: watch,
      link: findLink(hrefs.join("\n")),
      cancelled: /\bcancell?ed\b/i.test(name) || undefined,
      documents: agenda ? [{ title: "Agenda", type: "Agenda", url: agenda }] : [],
      agendaHtml: agenda,
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export const granicus: FeedParser<Config> = {
  id: "granicus",
  label: "Granicus (MediaManager)",
  description: "Granicus ViewPublisher pages, e.g. https://saanich.ca.granicus.com with view 1. Upcoming events only.",
  fields: [
    { name: "baseUrl", label: "Site URL", type: "url", required: true, placeholder: "https://saanich.ca.granicus.com" },
    { name: "viewId", label: "View id", type: "number", placeholder: "1", help: "The view_id in ViewPublisher.php?view_id=..." },
    { name: "timezone", label: "Timezone", type: "text", placeholder: "America/Vancouver", help: "The site's local time. Blank: the server's." },
  ],
  validate(c) {
    const o = cfg.obj(c);
    const u = new URL(cfg.url(o, "baseUrl"));
    if (!/\.granicus\.com$/i.test(u.hostname) && o.allowOtherHost !== true) throw new ConfigError("baseUrl", "must be a Granicus site (*.granicus.com)");
    const fromUrl = Number(u.searchParams.get("view_id"));
    const timezone = cfg.text(o, "timezone", false, 64);
    if (timezone) { try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new ConfigError("timezone", "isn't a timezone (e.g. America/Vancouver)"); } }
    return { baseUrl: `${u.protocol}//${u.host}/`, viewId: cfg.int(o, "viewId", Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : 1, 1, 100000),
      timezone, agendas: o.agendas !== false };
  },
  host(c) { return c.baseUrl; },
  async fetch(c, ctx) {
    const r = await ctx.http(new URL(`ViewPublisher.php?view_id=${c.viewId}`, c.baseUrl).toString(), { conditional: true });
    if (r.notModified) return { notModified: true };
    if (!/ViewPublisher|granicus/i.test(r.body)) throw new Error("that doesn't look like a Granicus ViewPublisher page");
    const ms = rowsToMeetings(upcomingRows(r.body), { baseUrl: c.baseUrl, tz: c.timezone ?? ctx.tz });
    for (const m of ms) {
      if (!c.agendas || !m.agendaHtml || m.link || m.cancelled) continue;
      try {
        const a = await ctx.http(m.agendaHtml);
        if (/html/i.test(a.headers.get("content-type") ?? "")) m.link = findLink(textOf(a.body));
      } catch (e) { ctx.log(`agenda for ${m.title}: ${(e as Error).message}`); }
    }
    ctx.log(`${ms.length} upcoming meeting(s)`);
    return { meetings: ms.map(({ agendaHtml: _, ...m }) => m) };
  },
};

registerParser(granicus);
