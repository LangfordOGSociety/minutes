/**
 * Feeds (#8): where meetings are found. A parser turns one source (an
 * agenda site, an .ics calendar, a web page) into a list of meetings.
 *
 * Parsers fetch and parse only. No database, no scheduling, no files:
 * everything after fetch() (diffing, policy, scheduling) is core code, so a
 * parser bug can't cancel a capture except through what it returns, and
 * the diff step guards that too (sync.ts: removals are only flagged, and a
 * run that would remove most of a feed's future meetings applies nothing).
 */
import type { Page } from "playwright";

/** One field of a parser's config, which also drives the admin form. */
export interface FieldSpec {
  name: string;
  label: string;
  type: "text" | "url" | "number" | "textarea" | "list";   // list: one value per line
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface HttpResponse {
  status: number;
  url: string;              // after redirects
  /** True when a conditional GET came back 304: `body` is empty. */
  notModified: boolean;
  headers: Headers;
  body: string;
}

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Send If-None-Match / If-Modified-Since from the last fetch of this URL. */
  conditional?: boolean;
}

export interface FeedContext {
  /** fetch with the feed's User-Agent, a timeout, a size cap and only
   *  http(s). Non-2xx (other than a conditional 304) throws. */
  http(url: string, o?: HttpOptions): Promise<HttpResponse>;
  /** A headless Chromium page at `url`, for pages that need JavaScript.
   *  Closed when the run ends. */
  page(url: string): Promise<Page>;
  tz: string;               // the server's timezone, for local times
  now: Date;
  log(msg: string): void;
}

export interface DetectedMeeting {
  externalId: string;       // stable across polls: agenda id, UID, event id
  title: string;
  body?: string;            // "Council", "Committee of the Whole"
  start: Date;
  end?: Date;
  /** Join link for a supported platform, if published. Secret once stored. */
  link?: string;
  /** The meeting's page on the source site (public). */
  pageUrl?: string;
  /** Its public stream page, live or recorded (Granicus player, eScribe
   *  live stream), once the source says there is one. Not a join link. */
  streamUrl?: string;
  agendaUrl?: string;
  cancelled?: boolean;
  /** Everything the source lists for the meeting (agenda, revised agenda,
   *  addenda, notices, minutes, video). Undefined = this parser doesn't
   *  report documents (then nothing about documents is logged). */
  documents?: MeetingDocument[];
}

export interface MeetingDocument {
  title: string;
  type?: string;            // the source's own kind: Agenda, PostMinutes, AdditionalDocuments, ...
  url: string;              // the identity: same URL = same document
}

export type FeedResult = { notModified: true } | { meetings: DetectedMeeting[] };

export interface FeedParser<C = Record<string, unknown>> {
  id: string;
  label: string;
  description: string;
  fields: FieldSpec[];
  /** Checked config. Throw a ConfigError naming the field. */
  validate(config: unknown): C;
  /** The URL whose host this feed polls (per-host concurrency of 1). */
  host(config: C): string;
  fetch(config: C, ctx: FeedContext): Promise<FeedResult>;
}

export class ConfigError extends Error {
  constructor(readonly field: string, msg: string) { super(`${field}: ${msg}`); }
}

/** Config helpers for validate(). */
export const cfg = {
  obj(v: unknown): Record<string, unknown> {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigError("config", "must be an object");
    return v as Record<string, unknown>;
  },
  url(o: Record<string, unknown>, field: string): string {
    const v = typeof o[field] === "string" ? (o[field] as string).trim() : "";
    let u: URL;
    try { u = new URL(v); } catch { throw new ConfigError(field, "must be a URL"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError(field, "must be http(s)");
    return u.toString();
  },
  text(o: Record<string, unknown>, field: string, required = false, max = 500): string | undefined {
    const v = typeof o[field] === "string" ? (o[field] as string).trim() : "";
    if (!v) { if (required) throw new ConfigError(field, "is required"); return undefined; }
    if (v.length > max) throw new ConfigError(field, `must be at most ${max} characters`);
    return v;
  },
  list(o: Record<string, unknown>, field: string): string[] {
    const v = o[field];
    const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
    return items.map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
  },
  int(o: Record<string, unknown>, field: string, dflt: number, min: number, max: number): number {
    if (o[field] === undefined || o[field] === "") return dflt;
    const n = Number(o[field]);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(field, `must be a whole number from ${min} to ${max}`);
    return n;
  },
};
