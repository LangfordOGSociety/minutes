/**
 * Fetching meeting documents with a real, headed browser (docs.ts decides
 * what to fetch).
 *
 * Some city sites (Langford's eScribe file server) put a bot check in front
 * of their PDFs: plain HTTP and headless Chromium get a "Just a moment..."
 * page. A headed Chromium (the Xvfb display `minutes serve` already runs
 * for the saved Zoom login) that first opens one of the site's own pages
 * is let through, and the file is then fetched from inside that page. That
 * is what a person's browser does; nothing is forged (the browser's own
 * user agent, no cookies copied, no challenge solved by us). If the site
 * shows its check anyway the result is a failure with that said, retried
 * later, never a workaround.
 *
 * Only the site's own origin is fetched, one file at a time, with a pause
 * between them, and a size cap.
 */
import { logger } from "./util.js";

const log = logger("docs");

export const MAX_DOC_BYTES = 25 * 1024 * 1024;
const PAUSE_MS = 1000;

export interface Fetched { bytes: Buffer; contentType: string }

export interface DocFetcher {
  /** Every url must be on `origin`. A failure is an Error for that url, never a throw. */
  fetchAll(origin: string, urls: string[]): Promise<Map<string, Fetched | Error>>;
}

export interface BrowserOpts {
  /** Headed needs a display; without one the browser is headless (and may be refused). */
  display?: string;
  /** A page on the site to open first (default: the origin's front page). */
  warmup?: string;
}

/** The kinds of file worth keeping, by their first bytes. */
export function sniff(b: Buffer): { ext: string; type: string } | null {
  const head = b.subarray(0, 8);
  const is = (s: string, at = 0) => b.subarray(at, at + s.length).toString("latin1") === s;
  if (is("%PDF-")) return { ext: "pdf", type: "application/pdf" };
  if (is("PK\x03\x04")) return { ext: "zip", type: "application/zip" };            // docx / xlsx / pptx (refined by name)
  if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { ext: "doc", type: "application/msword" };
  if (is("\x89PNG")) return { ext: "png", type: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8) return { ext: "jpg", type: "image/jpeg" };
  return null;
}

export function browserFetcher(o: BrowserOpts = {}): DocFetcher {
  return {
    async fetchAll(origin, urls) {
      const out = new Map<string, Fetched | Error>();
      const fail = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
      let browser: import("playwright").Browser | null = null;
      try {
        const { chromium } = await import("playwright");
        const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
        if (o.display) env.DISPLAY = o.display;
        browser = await chromium.launch({ headless: !o.display, env });
        const page = await (await browser.newContext()).newPage();
        await page.goto(o.warmup ?? origin + "/", { waitUntil: "load", timeout: 45_000 });
        // The site may show its own "checking your browser" page first; a real browser just waits for it to finish.
        let title = await page.title();
        for (let i = 0; i < 20 && /just a moment|verifying your browser|checking your browser/i.test(title); i++) {
          await new Promise((r) => setTimeout(r, 1000));
          title = await page.title().catch(() => title);
        }
        await new Promise((r) => setTimeout(r, 2000));
        for (const url of urls) {
          try {
            if (new URL(url).origin !== origin) throw new Error("not on the site's own origin");
            const get = () => page.evaluate(async ({ u, max }) => {
              const x = await fetch(u, { credentials: "same-origin" });
              const len = Number(x.headers.get("content-length") ?? 0);
              if (len > max) return { status: x.status, type: x.headers.get("content-type") ?? "", tooBig: true as const };
              const a = new Uint8Array(await x.arrayBuffer());
              if (a.length > max) return { status: x.status, type: x.headers.get("content-type") ?? "", tooBig: true as const };
              let s = "";
              for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
              return { status: x.status, type: x.headers.get("content-type") ?? "", b64: btoa(s) };
            }, { u: url, max: MAX_DOC_BYTES });
            let r = await get();
            if (!("tooBig" in r) && r.status === 403) { await new Promise((x) => setTimeout(x, 5000)); r = await get(); }   // once more, after the check had time to finish
            if ("tooBig" in r) throw new Error(`larger than ${MAX_DOC_BYTES} bytes`);
            if (r.status !== 200) throw new Error(`HTTP ${r.status}${/html/i.test(r.type) ? ` (the site's bot check, or an error page; the front page said "${title.slice(0, 40)}")` : ""}`);
            out.set(url, { bytes: Buffer.from(r.b64, "base64"), contentType: r.type });
          } catch (e) {
            out.set(url, fail(e));
          }
          await new Promise((r) => setTimeout(r, PAUSE_MS));
        }
      } catch (e) {
        log.warn(`browser fetch from ${origin}: ${fail(e).message}`);
        for (const u of urls) if (!out.has(u)) out.set(u, fail(e));
      } finally {
        await browser?.close().catch(() => {});
      }
      return out;
    },
  };
}
