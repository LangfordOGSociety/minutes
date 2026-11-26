/** The FeedContext a parser runs with: careful HTTP, and a headless page when needed. */
import type { Browser, Page } from "playwright";
import { logger } from "../util.js";
import type { Resolver } from "./fixture.js";
import type { FeedContext, HttpOptions, HttpResponse } from "./types.js";

const log = logger("feeds");

export const USER_AGENT = "minutes/0.2 (meeting recorder; +https://github.com/LangfordOGSociety/minutes)";
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 8 * 1024 * 1024;

export interface RunContext extends FeedContext {
  /** Validators seen this run, to save on success. */
  cache: Record<string, { etag?: string; lastModified?: string }>;
  close(): Promise<void>;
  lines: string[];
}

export function feedContext(o: { tz: string; now?: Date; cache?: Record<string, { etag?: string; lastModified?: string }>;
    label: string; fetchImpl?: typeof fetch;
    /** Answer every request (and page load) from saved files instead of the network (fixture.ts). */
    fixtures?: Resolver }): RunContext {
  const cache = { ...(o.cache ?? {}) };
  const lines: string[] = [];
  let browser: Browser | null = null;
  const pages: Page[] = [];
  const fx = o.fixtures;
  const missing = (method: string, url: string) => new Error(`no fixture for ${method} ${url} (give --fixture <file> or --route <part of the url>=<file>)`);
  const doFetch: typeof fetch = fx
    ? async (url, init) => {
        const method = init?.method ?? "GET", f = fx(String(url), method);
        if (!f) throw missing(method, String(url));
        return new Response(f.body, { status: 200, headers: { "content-type": f.type } });
      }
    : o.fetchImpl ?? fetch;

  async function http(url: string, h: HttpOptions = {}): Promise<HttpResponse> {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`not http(s): ${url}`);
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "*/*", ...h.headers };
    const v = h.conditional ? cache[url] : undefined;
    if (v?.etag) headers["If-None-Match"] = v.etag;
    if (v?.lastModified) headers["If-Modified-Since"] = v.lastModified;
    const r = await doFetch(url, { method: h.method ?? "GET", headers, body: h.body, redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 304 && v) return { status: 304, url: r.url || url, notModified: true, headers: r.headers, body: "" };
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes`);
    // Read with a cap, in case there's no Content-Length.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = r.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error(`${url} is larger than ${MAX_BYTES} bytes`); }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (h.conditional) {
      const etag = r.headers.get("etag") ?? undefined, lastModified = r.headers.get("last-modified") ?? undefined;
      if (etag || lastModified) cache[url] = { etag, lastModified };
    }
    return { status: r.status, url: r.url || url, notModified: false, headers: r.headers, body };
  }

  async function page(url: string): Promise<Page> {
    if (!browser) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    }
    const p = await browser.newPage({ userAgent: USER_AGENT });
    pages.push(p);
    if (fx) {
      // Documents come from the fixtures; scripts the page asks for have none, so they're refused.
      await p.route("**/*", (route) => {
        const req = route.request(), f = req.resourceType() === "document" ? fx(req.url(), req.method()) : null;
        return f ? route.fulfill({ body: f.body, contentType: f.type }) : route.abort();
      });
    }
    await p.goto(url, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
    return p;
  }

  return {
    http, page, tz: o.tz, now: o.now ?? new Date(), cache, lines,
    log: (m: string) => { lines.push(m); log.info(`${o.label}: ${m}`); },
    async close() {
      for (const p of pages) await p.close().catch(() => {});
      await (browser as Browser | null)?.close().catch(() => {});
      browser = null;
    },
  };
}
