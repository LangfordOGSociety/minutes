/**
 * iCalendar (.ics) feeds (#12). Many municipal calendars publish one.
 *
 * - UID is the externalId; a recurring event's instances are UID@local
 *   start (e.g. "abc@2026-12-08T17:30"), and RECURRENCE-ID overrides
 *   replace their instance.
 * - Times: TZID is used as an IANA zone through Intl (Windows names like
 *   "Pacific Standard Time" are mapped), so the image's tz data decides
 *   offsets. VTIMEZONE blocks are ignored on purpose: a calendar exported
 *   before BC's 2026 move to permanent UTC-7 still carries the old PST/PDT
 *   rules. UTC ("...Z") and floating times (server timezone) work too.
 *   All-day entries (VALUE=DATE) aren't meetings and are skipped.
 * - RRULE: DAILY / WEEKLY / MONTHLY with INTERVAL, COUNT, UNTIL, BYDAY
 *   (incl. 2TU / -1MO for monthly), BYMONTHDAY, and EXDATE. Others are
 *   skipped with a log line.
 * - STATUS:CANCELLED -> cancelled. A join link is looked for in LOCATION,
 *   DESCRIPTION and URL; URL is also the meeting's page.
 */
import { findLink } from "../../platforms/registry.js";
import { registerParser } from "../registry.js";
import { localDate, zonedTime } from "../time.js";
import { cfg, type DetectedMeeting, type FeedParser } from "../types.js";

interface Config { url: string; body?: string; daysBack: number; daysAhead: number }

interface Prop { name: string; params: Record<string, string>; value: string }

/** Unfolded, parsed content lines. */
export function contentLines(text: string): Prop[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: Prop[] = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    // name;param=value;param="v:al":value  (colons may appear inside quoted params)
    let i = 0, inQ = false;
    for (; i < line.length; i++) {
      if (line[i] === '"') inQ = !inQ;
      else if (line[i] === ":" && !inQ) break;
    }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.split(";");
    const params: Record<string, string> = {};
    for (const p of ps) {
      const j = p.indexOf("=");
      if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, "");
    }
    out.push({ name: name.toUpperCase(), params, value });
  }
  return out;
}

const unescape = (s: string) => s.replace(/\\[nN]/g, "\n").replace(/\\([\\;,])/g, "$1");

// Common Windows zone names (Outlook / Exchange exports).
const WINDOWS_TZ: Record<string, string> = {
  "pacific standard time": "America/Vancouver", "mountain standard time": "America/Edmonton",
  "central standard time": "America/Winnipeg", "eastern standard time": "America/Toronto",
  "atlantic standard time": "America/Halifax", "newfoundland standard time": "America/St_Johns",
  "us mountain standard time": "America/Phoenix", "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu", "gmt standard time": "Europe/London", "utc": "UTC",
};

function zoneOf(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback;
  const t = tzid.replace(/^\/+/, "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: t }); return t; } catch { /* not IANA */ }
  return WINDOWS_TZ[t.toLowerCase()] ?? fallback;
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** A DATE-TIME (not DATE) as an instant and its wall time in its zone. */
function parseDateTime(p: Prop | undefined, fallbackTz: string): { at: Date; wall: Wall; tz: string } | "date" | undefined {
  if (!p) return undefined;
  if (p.params.VALUE === "DATE" || /^\d{8}$/.test(p.value)) return "date";
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(p.value.trim());
  if (!m) return undefined;
  const wall: Wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  if (m[7] === "Z") return { at: new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s)), wall, tz: "UTC" };
  const tz = zoneOf(p.params.TZID, fallbackTz);
  return { at: zonedTime(tz, wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s), wall, tz };
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const pad = (n: number) => String(n).padStart(2, "0");
const wallKey = (w: Wall) => `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;

/** Instances of an RRULE as wall times (in the event's zone), within [from, to]. */
function expand(rule: string, start: Wall, tz: string, from: Date, to: Date, log: (m: string) => void): Wall[] | null {
  const r: Record<string, string> = {};
  for (const kv of rule.split(";")) { const [k, v] = kv.split("="); if (k && v) r[k.toUpperCase()] = v.toUpperCase(); }
  const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL ?? 1)), count = r.COUNT ? Number(r.COUNT) : Infinity;
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) { log(`skipped an RRULE with FREQ=${freq}`); return null; }
  let until = Infinity;
  if (r.UNTIL) {
    const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(r.UNTIL);
    if (u) until = u[4] ? Date.UTC(+u[1], +u[2] - 1, +u[3], +u[4], +u[5], +u[6]) : zonedTime(tz, +u[1], +u[2], +u[3], 23, 59, 59).getTime();
  }
  const byDay = (r.BYDAY ?? "").split(",").filter(Boolean).map((x) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
    return m ? { n: m[1] ? Number(m[1]) : 0, wd: DAYS.indexOf(m[2]) } : null;
  }).filter((x): x is { n: number; wd: number } => !!x);
  const byMonthDay = (r.BYMONTHDAY ?? "").split(",").filter(Boolean).map(Number);
  const out: Wall[] = [];
  let made = 0;
  const day0 = Date.UTC(start.y, start.mo - 1, start.d);
  const at = (y: number, mo: number, d: number): Wall => ({ ...start, y, mo, d });
  const consider = (w: Wall): boolean => {   // false = stop
    const t = zonedTime(tz, w.y, w.mo, w.d, w.h, w.mi, w.s).getTime();
    if (t < zonedTime(tz, start.y, start.mo, start.d, start.h, start.mi, start.s).getTime()) return true;
    if (t > until || made >= count) return false;
    made++;
    if (t >= from.getTime() && t <= to.getTime()) out.push(w);
    return t <= to.getTime();
  };
  const stopAt = to.getTime() + 86_400_000;
  if (freq === "DAILY") {
    for (let i = 0; ; i += interval) {
      const dt = new Date(day0 + i * 86_400_000);
      if (dt.getTime() > stopAt || !consider(at(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()))) break;
    }
  } else if (freq === "WEEKLY") {
    const days = byDay.length ? byDay.map((x) => x.wd).sort() : [new Date(day0).getUTCDay()];
    const week0 = day0 - new Date(day0).getUTCDay() * 86_400_000;   // that week's Sunday
    outer: for (let w = 0; ; w += interval) {
      for (const wd of days) {
        const dt = new Date(week0 + (w * 7 + wd) * 86_400_000);
        if (dt.getTime() > stopAt) break outer;
        if (!consider(at(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()))) break outer;
      }
    }
  } else {
    outer: for (let k = 0; ; k += interval) {
      const y = start.y + Math.floor((start.mo - 1 + k) / 12), mo = ((start.mo - 1 + k) % 12) + 1;
      if (Date.UTC(y, mo - 1, 1) > stopAt) break;
      const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      let ds: number[] = [];
      if (byDay.length) {
        for (const { n, wd } of byDay) {
          const all = Array.from({ length: dim }, (_, i) => i + 1).filter((d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd);
          if (!n) ds.push(...all); else { const d = n > 0 ? all[n - 1] : all[all.length + n]; if (d) ds.push(d); }
        }
      } else ds = (byMonthDay.length ? byMonthDay : [start.d]).map((d) => (d < 0 ? dim + d + 1 : d)).filter((d) => d >= 1 && d <= dim);
      for (const d of [...new Set(ds)].sort((a, b) => a - b)) if (!consider(at(y, mo, d))) break outer;
    }
  }
  return out;
}

export function parseIcs(text: string, o: { tz: string; from: Date; to: Date; body?: string; log?: (m: string) => void }): DetectedMeeting[] {
  const log = o.log ?? (() => {});
  const lines = contentLines(text);
  const events: Prop[][] = [];
  let cur: Prop[] | null = null, depth = 0;
  for (const p of lines) {
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") { cur = []; depth = 0; continue; }
    if (cur && p.name === "BEGIN") { depth++; continue; }            // VALARM etc.
    if (cur && p.name === "END" && depth > 0) { depth--; continue; }
    if (p.name === "END" && p.value.toUpperCase() === "VEVENT" && cur) { events.push(cur); cur = null; continue; }
    if (cur && depth === 0) cur.push(p);
  }
  const masters: DetectedMeeting[] = [], overrides = new Map<string, DetectedMeeting>();
  for (const ev of events) {
    const get = (n: string) => ev.find((p) => p.name === n);
    const uid = get("UID")?.value.trim();
    const st = parseDateTime(get("DTSTART"), o.tz);
    if (!uid || st === undefined) continue;
    if (st === "date") continue;   // all-day: not a meeting
    const en = parseDateTime(get("DTEND"), o.tz);
    const text = ["LOCATION", "DESCRIPTION", "URL"].map((n) => unescape(get(n)?.value ?? "")).join("\n");
    const url = get("URL")?.value.trim();
    const base: DetectedMeeting = {
      externalId: uid, title: unescape(get("SUMMARY")?.value ?? "(untitled)").trim(), body: o.body,
      start: st.at, end: en && en !== "date" ? en.at : undefined, link: findLink(text),
      pageUrl: url && /^https?:\/\//i.test(url) ? url : undefined, cancelled: (get("STATUS")?.value ?? "").toUpperCase() === "CANCELLED" || undefined,
    };
    const rid = parseDateTime(get("RECURRENCE-ID"), o.tz);
    if (rid && rid !== "date") {
      // An override of one instance: keyed by the instance's wall time in the master's zone.
      const key = `${uid}@${wallKey(rid.wall)}`;
      overrides.set(key, { ...base, externalId: key });
      continue;
    }
    const rrule = get("RRULE")?.value;
    if (!rrule) {
      if (st.at >= o.from && st.at <= o.to) masters.push(base);
      continue;
    }
    const ex = new Set(ev.filter((p) => p.name === "EXDATE").flatMap((p) => p.value.split(",").map((v) => {
      const d = parseDateTime({ ...p, value: v }, o.tz);
      return d && d !== "date" ? wallKey(d.wall) : v.slice(0, 8);
    })));
    const walls = expand(rrule, st.wall, st.tz, o.from, o.to, log);
    if (!walls) continue;
    const dur = base.end ? base.end.getTime() - base.start.getTime() : 0;
    for (const w of walls) {
      const k = wallKey(w);
      if (ex.has(k) || ex.has(k.slice(0, 10).replace(/-/g, ""))) continue;
      const at = zonedTime(st.tz, w.y, w.mo, w.d, w.h, w.mi, w.s);
      masters.push({ ...base, externalId: `${uid}@${k}`, start: at, end: dur ? new Date(at.getTime() + dur) : undefined });
    }
  }
  // Overrides replace their instance (and can move it into or out of the window).
  const out = masters.filter((m) => !overrides.has(m.externalId));
  for (const ov of overrides.values()) if (ov.start >= o.from && ov.start <= o.to) out.push(ov);
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export const ical: FeedParser<Config> = {
  id: "ical",
  label: "iCalendar (.ics)",
  description: "A calendar feed (.ics URL). Join links are looked for in each event's location and description.",
  fields: [
    { name: "url", label: "Calendar URL (.ics)", type: "url", required: true, placeholder: "https://example.ca/calendar.ics" },
    { name: "body", label: "Body", type: "text", help: "Name for every meeting's body, e.g. Council (helps dedup). Blank: none." },
    { name: "daysAhead", label: "Days ahead", type: "number", placeholder: "120" },
    { name: "daysBack", label: "Days back", type: "number", placeholder: "14" },
  ],
  validate(c) {
    const o = cfg.obj(c);
    return { url: cfg.url(o, "url"), body: cfg.text(o, "body", false, 100), daysAhead: cfg.int(o, "daysAhead", 120, 1, 730), daysBack: cfg.int(o, "daysBack", 14, 0, 365) };
  },
  host(c) { return c.url; },
  async fetch(c, ctx) {
    const r = await ctx.http(c.url, { conditional: true, headers: { Accept: "text/calendar, */*" } });
    if (r.notModified) return { notModified: true };
    if (!/BEGIN:VCALENDAR/i.test(r.body)) throw new Error("that URL didn't return an iCalendar file");
    const from = new Date(ctx.now.getTime() - c.daysBack * 86_400_000), to = new Date(ctx.now.getTime() + c.daysAhead * 86_400_000);
    const meetings = parseIcs(r.body, { tz: ctx.tz, from, to, body: c.body, log: ctx.log });
    ctx.log(`${meetings.length} meeting(s) from ${localDate(from, ctx.tz)} to ${localDate(to, ctx.tz)}`);
    return { meetings };
  },
};

registerParser(ical);
