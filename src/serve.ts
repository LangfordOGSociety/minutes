/**
 * Web interface: schedule meetings, watch captures, replay recordings.
 *
 * node:http only (no runtime deps beyond playwright). Routes:
 *   GET    /                       the page (src/webui.ts)
 *   GET    /api/info               server timezone etc. for the form
 *   GET    /api/jobs               scheduled / running / finished captures
 *   POST   /api/jobs               {link, start, slug?, name?}
 *   PATCH  /api/jobs/:id           edit a scheduled capture {link?, start?, slug?, name?}
 *   DELETE /api/jobs/:id           cancel, or stop a running capture
 *   POST   /api/jobs/:id/retry     another attempt at a finished capture's meeting
 *   GET    /api/jobs/:id/screen    PNG of what the bot's display shows now
 *   GET    /api/jobs/:id/log       tail of that capture's log
 *   GET    /api/session            saved Zoom login: ok|expired|missing|error, last check
 *   POST   /api/session/check      check (and refresh) the saved login now
 *   GET    /api/recordings         every <out>/<slug>/manifest.json, summarized
 *   GET    /media/:slug/:file      video and stills, with Range support
 *
 * Anyone who can reach this can make the signed-in Zoom account join
 * meetings and can watch every recording. Set CAPTURE_WEB_TOKEN to require a
 * password (HTTP Basic, any username) and publish the port on 127.0.0.1.
 */
import { execFile } from "node:child_process";
import { createReadStream, existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { openDb } from "./db.js";
import { platformFor } from "./platforms/registry.js";
import { BadRequest, Scheduler, type Job, type SchedulerOpts } from "./jobs.js";
import { SessionKeeper, type KeeperOpts } from "./session.js";
import { SLUG_RE, logger } from "./util.js";
import { PAGE } from "./webui.js";

const log = logger("web");

export interface ServeOpts extends Omit<SchedulerOpts, "entry"> {
  host: string;
  port: number;
  token: string | null;
  tz: string;
  session: Omit<KeeperOpts, "auth" | "out" | "leadMs">;
}

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".json": "application/json",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof body === "string" || Buffer.isBuffer(body);
  const data = isText ? body as string | Buffer : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new BadRequest("request too large", 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req: http.IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Writes must come from this page: a cross-site form or fetch can't set a
 *  JSON content type without a preflight we never answer, and the Origin,
 *  when present, has to be us. */
/** A job as the page sees it: never the link (it can hold the passcode) or
 *  the email, only the meeting ID and whether an email is set. */
function publicJob(j: Job) {
  const { link, email, ...rest } = j;
  return { ...rest, meetingId: platformFor(link)?.publicId(link) ?? "?", hasEmail: !!email };
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function tail(file: string, bytes = 64 * 1024): string {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString("utf8");
    if (start > 0) s = s.slice(s.indexOf("\n") + 1);
    // Agent chatter is noise in a browser log view.
    return s.split("\n").filter((l) => !/agent signal:|_XSERVTrans|dumped \d/.test(l)).join("\n");
  } finally {
    closeSync(fd);
  }
}

interface Recording {
  slug: string;
  scheduledStart: string | null;
  outcome: string;
  active: boolean;
  video: string | null;
  videoBytes: number | null;
  parts: { index: number; started: string; ended: string | null }[];
  chapters: { title: string; at: number }[];
  /** From the transcriber's transcript.status.json, if it has seen this one. */
  transcript: { status: string; stage: string | null; progress: number | null; error: string | null } | null;
  /** Side files that exist: subtitles, transcript, Zoom captions, speakers. */
  files: { vtt?: string; srt?: string; txt?: string; transcript?: string; zoomCaptions?: string; speakers?: string };
}

function listRecordings(out: string, sched: Scheduler, tz: string): Recording[] {
  const clock = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const recs: Recording[] = [];
  let names: string[] = [];
  try { names = readdirSync(out); } catch { return recs; }
  for (const slug of names) {
    if (!SLUG_RE.test(slug)) continue;
    const mf = path.join(out, slug, "manifest.json");
    if (!existsSync(mf)) continue;
    let m: any;
    try { m = JSON.parse(readFileSync(mf, "utf8")); } catch { continue; }
    const video = typeof m.output === "string" && FILE_RE.test(m.output) && existsSync(path.join(out, slug, m.output))
      ? m.output : null;
    const parts = Array.isArray(m.parts) ? m.parts.map((p: any) => ({ index: p.index, started: p.started, ended: p.ended })) : [];
    // Chapter offsets: part 1 at 0, then each gap's offset (same as the MP4's chapters).
    const gaps: any[] = Array.isArray(m.gaps) ? m.gaps : [];
    const chapters = parts.length ? [{ title: `Part 1 (${clock.format(new Date(parts[0].started))})`, at: 0 }] : [];
    for (const g of gaps) {
      const p = parts.find((x: any) => x.index === g.beforePart);
      const when = p ? clock.format(new Date(p.started)) : "?";
      chapters.push({ title: `Part ${g.beforePart} (${when}, after ${Math.round(g.seconds)}s gap)`, at: g.atOffsetSeconds });
    }
    const has = (f: string) => existsSync(path.join(out, slug, f)) ? f : undefined;
    const st = (() => { try { return JSON.parse(readFileSync(path.join(out, slug, "transcript.status.json"), "utf8")); } catch { return null; } })();
    const files = {
      vtt: has(`${slug}.vtt`), srt: has(`${slug}.srt`), txt: has(`${slug}.txt`),
      transcript: has(`${slug}.transcript.json`), zoomCaptions: has(`${slug}.zoom-captions.vtt`),
      speakers: has(`${slug}.speakers.json`),
    };
    recs.push({
      slug,
      transcript: st ? { status: String(st.status ?? "unknown"), stage: st.stage ?? null,
        progress: typeof st.progress === "number" ? st.progress : null, error: st.error ?? null } : null,
      files: Object.fromEntries(Object.entries(files).filter(([, v]) => v)) as Recording["files"],
      scheduledStart: m.scheduledStart ?? null,
      outcome: m.outcome ?? "unknown",
      active: sched.isActive(slug),
      video,
      videoBytes: video ? statSync(path.join(out, slug, video)).size : null,
      parts,
      chapters,
    });
  }
  return recs.sort((a, b) => (b.scheduledStart ?? "").localeCompare(a.scheduledStart ?? ""));
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!type || !existsSync(file)) return send(res, 404, "not found");
  const size = statSync(file).size;
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
    if (req.method === "HEAD") return void res.end();
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, "Content-Length": String(size) });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}

function screenshot(display: string, width: number, height: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${width}x${height}`, "-i", `${display}.0`,
      "-frames:v", "1", "-vf", "scale=960:-1", "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function serve(o: ServeOpts, entry: string): Promise<number> {
  const db = openDb(path.join(o.out, "minutes.db"));
  const sched = new Scheduler({ ...o, entry }, db);
  sched.start();
  const keeper = new SessionKeeper({ ...o.session, auth: o.auth, out: o.out, leadMs: o.leadMs }, () => sched.list());
  keeper.start();
  const page = PAGE.replace("__TZ__", JSON.stringify(o.tz));

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req, o.token)) {
        return send(res, 401, "password required", { "WWW-Authenticate": 'Basic realm="minutes"' });
      }
      const url = new URL(req.url ?? "/", "http://x");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = req.method ?? "GET";
      const read = method === "GET" || method === "HEAD";

      if (url.pathname === "/" && read) {
        return send(res, 200, page, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'",
        });
      }
      if (parts[0] === "api") {
        if (!read && !sameOrigin(req)) return send(res, 403, "cross-origin request refused");
        if (parts[1] === "info" && read) {
          return send(res, 200, { tz: o.tz, tzdata: process.versions.tz ?? null, leadMinutes: o.leadMs / 60_000, maxConcurrent: o.maxConcurrent });
        }
        if (parts[1] === "session") {
          if (parts.length === 2 && read) return send(res, 200, keeper.get());
          if (parts[2] === "check" && parts.length === 3 && method === "POST") {
            if (sched.list().some((j) => j.status === "running" || j.status === "stopping")) {
              return send(res, 409, { error: "a capture is running; the login is checked after it ends" });
            }
            return send(res, 200, await keeper.check("checked from the web page"));
          }
        }
        if (parts[1] === "recordings" && read) return send(res, 200, listRecordings(o.out, sched, o.tz));
        if (parts[1] === "jobs") {
          if (parts.length === 2 && read) {
            // The invite link includes the meeting password; show the ID only.
            return send(res, 200, sched.list().map(publicJob));
          }
          const jsonBody = async (): Promise<Record<string, unknown> | null> => {
            if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) { send(res, 415, "send JSON"); return null; }
            try {
              const b = JSON.parse(await readBody(req));
              if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
            } catch (e) {
              if (e instanceof BadRequest) throw e;
            }
            send(res, 400, { error: "body must be a JSON object" });
            return null;
          };
          if (parts.length === 2 && method === "POST") {
            const body = await jsonBody();
            if (!body) return;
            const job = sched.add(body);
            return send(res, 201, publicJob(job));
          }
          const job = parts[2] ? sched.get(parts[2]) : undefined;
          if (!job) return send(res, 404, { error: "no such job" });
          if (parts.length === 3 && method === "PATCH") {
            const body = await jsonBody();
            if (!body) return;
            const j = sched.update(job.id, body);
            return send(res, 200, publicJob(j));
          }
          if (parts.length === 3 && method === "DELETE") {
            const j = sched.cancel(job.id);
            return send(res, 200, publicJob(j));
          }
          if (parts.length === 4 && parts[3] === "retry" && method === "POST") {
            return send(res, 201, publicJob(sched.retry(job.id)));
          }
          if (parts[3] === "log" && read) return send(res, 200, tail(path.join(o.out, job.slug, "capture.log")));
          if (parts[3] === "screen" && read) {
            const d = sched.displayOf(job.id);
            if (!d) return send(res, 409, "not running");
            return send(res, 200, await screenshot(d, o.width, o.height), { "Content-Type": "image/png" });
          }
        }
        return send(res, 404, { error: "not found" });
      }
      if (parts[0] === "media" && parts.length === 3 && read && SLUG_RE.test(parts[1]) && FILE_RE.test(parts[2])) {
        return serveFile(req, res, path.join(o.out, parts[1], parts[2]));
      }
      return send(res, 404, "not found");
    } catch (e) {
      if (e instanceof BadRequest) return send(res, e.status, { error: e.message });
      log.error("request failed", e);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(o.port, o.host, resolve));
  log.info(`web interface on http://${o.host}:${o.port}/ (${o.token ? "password required" : "NO password: keep the port private"})`);

  return new Promise<number>((resolve) => {
    let stopping = false;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, async () => {
        if (stopping) process.exit(130);
        stopping = true;
        log.info("shutting down; stopping running captures so they stitch");
        server.close();
        keeper.stop();
        await sched.shutdown();
        db.close();
        resolve(0);
      });
    }
  });
}

