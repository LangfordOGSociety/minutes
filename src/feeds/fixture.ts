/**
 * Offline fixtures for running a parser without its network (#23): the same
 * FeedContext, but every request is answered from saved files. Used by
 * `minutes feed test` and handy in tests. A request with no fixture is an
 * error that says which one is missing, never a silent real fetch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Fixture { body: string; type: string }
export type Resolver = (url: string, method: string) => Fixture | null;

const TYPES: Record<string, string> = { ".json": "application/json", ".ics": "text/calendar", ".xml": "application/xml", ".rss": "application/rss+xml",
  ".atom": "application/atom+xml", ".txt": "text/plain", ".html": "text/html", ".htm": "text/html" };

const read = (file: string): Fixture => ({ body: readFileSync(file, "utf8"), type: TYPES[path.extname(file).toLowerCase()] ?? "text/html" });

/**
 * `routes`: "<substring>=<file>", the first whose substring is in
 * "<METHOD> <url>" answers (so "POST=x.json" or "GetCalendar=cal.json"
 * work); `fallback`: the file for everything else.
 */
export function fixtureResolver(o: { fallback?: string; routes?: string[] }): Resolver {
  const routes = (o.routes ?? []).map((r) => {
    const i = r.lastIndexOf("=");
    if (i <= 0 || i === r.length - 1) throw new Error(`--route wants <substring>=<file>, got "${r}"`);
    return { match: r.slice(0, i), file: r.slice(i + 1) };
  });
  return (url, method) => {
    const line = `${method} ${url}`;
    const hit = routes.find((r) => line.includes(r.match));
    const file = hit?.file ?? o.fallback;
    return file ? read(file) : null;
  };
}
