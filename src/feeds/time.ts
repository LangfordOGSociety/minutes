/**
 * Local wall-clock times -> UTC instants, for feeds that publish times
 * without an offset ("2026/12/08 17:30:00" on an eScribe site in BC).
 * Uses Intl, so it follows the image's tz data, including BC's move to
 * permanent UTC-7 in November 2026.
 */

/** Offset of `tz` at instant `t`, in minutes (UTC-7 -> -420). */
function offsetMin(t: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60_000;
}

/** The instant when the clock in `tz` reads y-mo-d h:mi:s (mo 1-12). In a
 *  DST gap the later offset wins; in an overlap, the first occurrence. */
export function zonedTime(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = asUtc - offsetMin(asUtc, tz) * 60_000;
  // A second pass settles times near an offset change.
  t = asUtc - offsetMin(t, tz) * 60_000;
  return new Date(t);
}

/** The local calendar date in `tz` of an instant, as YYYY-MM-DD. */
export function localDate(t: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Month number (1-12) from a name or abbreviation, or 0. */
export function monthOf(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}
