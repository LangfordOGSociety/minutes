/**
 * Generic HTML pages (#12): for a site without a feed or a dedicated
 * parser. Config is the page URL plus CSS selectors: one per meeting row,
 * and inside a row its title, date (and time, if separate), and link. The
 * page is rendered in headless Chromium (ctx.page), so JavaScript-built
 * lists work. Dates are read loosely: "Dec 8, 2026 5:30 PM", "8 December
 * 2026 17:30", "2026-12-08 17:30", or numeric in the configured order;
 * a row without a time is skipped (a meeting needs one). A row whose text
 * says "cancelled" is reported cancelled.
 */
import { createHash } from "node:crypto";
import { findLink } from "../../platforms/registry.js";
import { registerParser } from "../registry.js";
import { monthOf, zonedTime } from "../time.js";
import { ConfigError, cfg, type DetectedMeeting, type FeedParser } from "../types.js";

interface Config { url: string; row: string; title: string; date: string; time?: string; link?: string; body?: string; order: "MDY" | "DMY" | "YMD" }

export interface LooseDate { y: number; mo: number; d: number; h: number; mi: number }

const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

/** A date and time from free text, or null (also when there's no time). */
export function parseLooseDate(text: string, order: Config["order"] = "MDY"): LooseDate | null {
  const t = text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  let y = 0, mo = 0, d = 0, m: RegExpExecArray | null;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, "i").exec(t))) { mo = monthOf(m[1]); d = +m[2]; y = +m[3]; }
  else if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})`, "i").exec(t))) { d = +m[1]; mo = monthOf(m[2]); y = +m[3]; }
  else if (order === "YMD" && (m = /\b(\d{4})[/.](\d{1,2})[/.](\d{1,2})\b/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(t))) {
    y = +m[3];
    if (order === "DMY") { d = +m[1]; mo = +m[2]; } else { mo = +m[1]; d = +m[2]; }
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  // The time: after the date if possible (a "2026" or "08" isn't a time).
  const rest = t.slice((m.index ?? 0) + m[0].length) + " " + t.slice(0, m.index ?? 0);
  let h = -1, mi = 0, tm: RegExpExecArray | null;
  if ((tm = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/i.exec(rest))) {
    h = +tm[1] % 12 + (tm[3].toLowerCase() === "p" ? 12 : 0); mi = tm[2] ? +tm[2] : 0;
  } else if ((tm = /\b(?:at\s+)?([01]?\d|2[0-3])[:h]([0-5]\d)\b/i.exec(rest))) { h = +tm[1]; mi = +tm[2]; }
  else if (/\bnoon\b/i.test(rest)) h = 12;
  if (h < 0) return null;
  return { y, mo, d, h, mi };
}

interface Row { title: string; date: string; time: string; href: string; text: string }

export function rowsToMeetings(rows: Row[], o: { tz: string; order: Config["order"]; body?: string; log: (m: string) => void }): DetectedMeeting[] {
  const out: DetectedMeeting[] = [];
  for (const r of rows) {
    const title = r.title.replace(/\s+/g, " ").trim();
    const when = parseLooseDate(`${r.date} ${r.time}`, o.order);
    if (!title || !when) { o.log(`skipped a row without a ${title ? "date and time" : "title"}: ${(title || r.text).slice(0, 80)}`); continue; }
    const start = zonedTime(o.tz, when.y, when.mo, when.d, when.h, when.mi);
    const link = findLink(r.href) ?? findLink(r.text);
    const page = r.href && !findLink(r.href) && /^https?:/i.test(r.href) ? r.href : undefined;
    out.push({
      externalId: page ?? createHash("sha1").update(`${title}|${start.toISOString()}`).digest("hex").slice(0, 16),
      title, body: o.body, start, link, pageUrl: page, cancelled: /\bcancell?ed\b/i.test(r.text) || undefined,
    });
  }
  return out;
}

export const html: FeedParser<Config> = {
  id: "html",
  label: "Web page (CSS selectors)",
  description: "Any page that lists meetings: one CSS selector for each meeting's row, then selectors inside the row. Rendered in a headless browser.",
  fields: [
    { name: "url", label: "Page URL", type: "url", required: true },
    { name: "row", label: "Row selector", type: "text", required: true, placeholder: "table.meetings tbody tr", help: "Matches one element per meeting." },
    { name: "title", label: "Title selector (in a row)", type: "text", required: true, placeholder: "td:nth-child(1)" },
    { name: "date", label: "Date selector (in a row)", type: "text", required: true, placeholder: "td:nth-child(2)", help: "Text like Dec 8, 2026 5:30 PM. Include the time, or set a time selector." },
    { name: "time", label: "Time selector (in a row)", type: "text" },
    { name: "link", label: "Link selector (in a row)", type: "text", placeholder: "a", help: "Its href: a join link, or the meeting's page." },
    { name: "body", label: "Body", type: "text", help: "Name for every meeting's body, e.g. Council." },
    { name: "order", label: "Numeric date order", type: "text", placeholder: "MDY", help: "For dates like 08/12/2026: MDY, DMY or YMD." },
  ],
  validate(c) {
    const o = cfg.obj(c);
    const order = (cfg.text(o, "order") ?? "MDY").toUpperCase();
    if (!["MDY", "DMY", "YMD"].includes(order)) throw new ConfigError("order", "must be MDY, DMY or YMD");
    return { url: cfg.url(o, "url"), row: cfg.text(o, "row", true)!, title: cfg.text(o, "title", true)!, date: cfg.text(o, "date", true)!,
      time: cfg.text(o, "time"), link: cfg.text(o, "link"), body: cfg.text(o, "body", false, 100), order: order as Config["order"] };
  },
  host(c) { return c.url; },
  async fetch(c, ctx) {
    const page = await ctx.page(c.url);
    const rows = await page.$$eval(c.row, (els, s) => els.map((r) => {
      const q = (sel?: string) => (sel ? (r.querySelector(sel) as HTMLElement | null) : null);
      const a = q(s.link);
      return {
        title: q(s.title)?.innerText ?? "", date: q(s.date)?.innerText ?? "", time: q(s.time)?.innerText ?? "",
        href: (a as HTMLAnchorElement | null)?.href ?? "", text: (r as HTMLElement).innerText ?? "",
      };
    }), { title: c.title, date: c.date, time: c.time, link: c.link });
    if (!rows.length) ctx.log(`no rows match ${c.row}`);
    return { meetings: rowsToMeetings(rows, { tz: ctx.tz, order: c.order, body: c.body, log: ctx.log }) };
  },
};

registerParser(html);
