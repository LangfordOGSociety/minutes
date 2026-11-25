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
 *   GET    /login, /account        sign in, change password (src/pages/login.ts)
 *   GET    /api/me                 who is signed in, and what they may do
 *   POST   /api/login              {email, password}; sets the session cookie
 *   POST   /api/logout
 *   POST   /api/account/password   {current, password}
 *
 * Every route needs a capability (accounts.ts ROLE_CAPS): the capture page
 * and job/session APIs are admin only; recordings and media are "watch",
 * which everyone has. Accounts are made with `minutes user add`.
 */
import { execFile } from "node:child_process";
import { createReadStream, existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Accounts, AccountError, FailureLimiter, ROLE_CAPS, SESSION_MAX_AGE_S, can, type Capability, type User } from "./accounts.js";
import { LOGIN_PAGE } from "./pages/login.js";
import { openDb } from "./db.js";
import { platformFor } from "./platforms/registry.js";
import { BadRequest, Scheduler, type Job, type SchedulerOpts } from "./jobs.js";
import { SessionKeeper, type KeeperOpts } from "./session.js";
import { SLUG_RE, logger, notify } from "./util.js";
import { NightlyBackup, type NightlyOpts } from "./backup.js";
import { PAGE } from "./webui.js";

const log = logger("web");

export interface ServeOpts extends Omit<SchedulerOpts, "entry"> {
  host: string;
  port: number;
  tz: string;
  /** Mark the session cookie Secure (and use the __Host- prefix). Off only
   *  for plain-http development on a non-localhost address. */
  secureCookie: boolean;
  session: Omit<KeeperOpts, "auth" | "out" | "leadMs">;
  /** Nightly backups; null = off. */
  backup: Omit<NightlyOpts, "auth" | "notifyUrl"> | null;
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

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Where to go after signing in: a path on this site only. */
export function safeNext(v: string | null): string {
  return v && /^\/(?![/\\])[^\s]*$/.test(v) ? v : "/";
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

export interface App {
  server: http.Server;
  accounts: Accounts;
  sched: Scheduler;
  /** Stop timers and captures, close the database. */
  close(): Promise<void>;
}

/** Everything but listening and signal handling (tests use this). */
export function createApp(o: ServeOpts, entry: string): App {
  const db = openDb(path.join(o.out, "minutes.db"));
  const accounts = new Accounts(db);
  const cookieName = o.secureCookie ? "__Host-minutes_session" : "minutes_session";
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${o.secureCookie ? "; Secure" : ""}`;
  const failsByIp = new FailureLimiter(30, 15 * 60_000);
  const failsByAccount = new FailureLimiter(10, 15 * 60_000);
  const pruneTimer = setInterval(() => accounts.pruneSessions(), 3_600_000);
  pruneTimer.unref();
  if (!accounts.count("admin")) {
    log.warn("no admin account yet: run `minutes user add --admin <email>` on the server to create one");
  }
  const sched = new Scheduler({ ...o, entry }, db);
  sched.start();
  const keeper = new SessionKeeper({ ...o.session, auth: o.auth, out: o.out, leadMs: o.leadMs }, () => sched.list());
  keeper.start();
  const backups = o.backup
    ? new NightlyBackup({ ...o.backup, auth: o.auth, notifyUrl: o.session.notifyUrl }, db, (t) => notify(o.session.notifyUrl, t))
    : null;
  if (backups) {
    backups.start();
    log.info(`nightly backups to ${o.backup!.dir} after ${o.backup!.atHour}:00, kept ${o.backup!.keepDays} days`);
  } else {
    log.warn("no BACKUP_DIR: nightly backups are off");
  }
  const page = PAGE.replace("__TZ__", JSON.stringify(o.tz));
  const loginPage = LOGIN_PAGE;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = req.method ?? "GET";
      const read = method === "GET" || method === "HEAD";
      const ip = req.socket.remoteAddress ?? "?";

      // Who's asking. A user who must change their password can do nothing
      // else until they have.
      const token = cookies(req)[cookieName];
      const sess = accounts.session(token);
      const user: User | null = sess?.user ?? null;
      const role = user && !user.mustChangePassword ? user.role : null;
      if (sess?.renewed) res.setHeader("Set-Cookie", `${cookieName}=${token}; ${cookieAttrs}; Max-Age=${SESSION_MAX_AGE_S}`);
      const me = () => user ? {
        email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword,
        caps: ROLE_CAPS[role ?? "public"],
      } : null;
      /** False (and the response sent) if this request may not do `cap`. */
      const allow = (cap: Capability, page = false): boolean => {
        if (can(role, cap)) return true;
        if (page) {
          const to = user ? "/account?denied=1" : "/login?next=" + encodeURIComponent(url.pathname + url.search);
          res.writeHead(302, { Location: to, "Cache-Control": "no-store" }).end();
        } else {
          send(res, user ? 403 : 401, { error: user ? (user.mustChangePassword ? "change your password first" : "your account can't do that") : "sign in first" });
        }
        return false;
      };

      if ((url.pathname === "/login" || url.pathname === "/account") && read) {
        return send(res, 200, loginPage, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:",
        });
      }
      if (url.pathname === "/" && read) {
        if (!allow("admin.view", true)) return;
        return send(res, 200, page, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'",
        });
      }
      if (parts[0] === "api") {
        if (!read && !sameOrigin(req)) return send(res, 403, "cross-origin request refused");
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

        if (parts[1] === "me" && parts.length === 2 && read) {
          return send(res, 200, { user: me(), setupNeeded: accounts.count("admin") === 0 });
        }
        if (parts[1] === "login" && parts.length === 2 && method === "POST") {
          const body = await jsonBody();
          if (!body) return;
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
          const wait = Math.max(failsByIp.blockedFor(ip), failsByAccount.blockedFor(email));
          if (wait > 0) {
            return send(res, 429, { error: `too many failed sign-ins; try again in ${Math.ceil(wait / 60_000)} min` },
              { "Retry-After": String(Math.ceil(wait / 1000)) });
          }
          const u = await accounts.authenticate(email, typeof body.password === "string" ? body.password : "");
          if (!u) {
            failsByIp.fail(ip);
            if (email) failsByAccount.fail(email);
            log.warn(`failed sign-in from ${ip}`);
            return send(res, 401, { error: "wrong email or password" });
          }
          failsByAccount.reset(email);
          accounts.endSession(token);
          const t = accounts.createSession(u.id, { ip, userAgent: req.headers["user-agent"] });
          log.info(`${u.email} signed in from ${ip}`);
          const r = u.mustChangePassword ? null : u.role;
          return send(res, 200, { user: { email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword,
            caps: ROLE_CAPS[r ?? "public"] } }, { "Set-Cookie": `${cookieName}=${t}; ${cookieAttrs}; Max-Age=${SESSION_MAX_AGE_S}` });
        }
        if (parts[1] === "logout" && parts.length === 2 && method === "POST") {
          accounts.endSession(token);
          return send(res, 200, { user: null }, { "Set-Cookie": `${cookieName}=; ${cookieAttrs}; Max-Age=0` });
        }
        if (parts[1] === "account" && parts[2] === "password" && parts.length === 3 && method === "POST") {
          if (!user) return send(res, 401, { error: "sign in first" });
          const body = await jsonBody();
          if (!body) return;
          if (failsByAccount.blockedFor(user.email.toLowerCase()) > 0) return send(res, 429, { error: "too many failed attempts; try again later" });
          if (!(await accounts.authenticate(user.email, typeof body.current === "string" ? body.current : ""))) {
            failsByAccount.fail(user.email.toLowerCase());
            return send(res, 403, { error: "current password is wrong" });
          }
          if (body.password === body.current) return send(res, 400, { error: "choose a new password" });
          await accounts.setPassword(user.id, String(body.password ?? ""), { mustChange: false, keepSession: token });
          log.info(`${user.email} changed their password`);
          return send(res, 200, { user: { ...me(), mustChangePassword: false, caps: ROLE_CAPS[user.role] } });
        }

        if (parts[1] === "info" && read) {
          if (!allow("watch")) return;
          return send(res, 200, { tz: o.tz, tzdata: process.versions.tz ?? null, leadMinutes: o.leadMs / 60_000, maxConcurrent: o.maxConcurrent });
        }
        if (parts[1] === "session") {
          if (!allow(read ? "admin.view" : "admin.manage")) return;
          if (parts.length === 2 && read) return send(res, 200, keeper.get());
          if (parts[2] === "check" && parts.length === 3 && method === "POST") {
            if (sched.list().some((j) => j.status === "running" || j.status === "stopping")) {
              return send(res, 409, { error: "a capture is running; the login is checked after it ends" });
            }
            return send(res, 200, await keeper.check("checked from the web page"));
          }
        }
        if (parts[1] === "recordings" && read) {
          if (!allow("watch")) return;
          return send(res, 200, listRecordings(o.out, sched, o.tz));
        }
        if (parts[1] === "jobs") {
          if (!allow(read ? "admin.view" : "admin.manage")) return;
          if (parts.length === 2 && read) {
            // The invite link includes the meeting password; show the ID only.
            return send(res, 200, sched.list().map(publicJob));
          }
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
        if (!allow("watch")) return;
        return serveFile(req, res, path.join(o.out, parts[1], parts[2]));
      }
      return send(res, 404, "not found");
    } catch (e) {
      if (e instanceof BadRequest || e instanceof AccountError) return send(res, e.status, { error: e.message });
      log.error("request failed", e);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });

  return {
    server, accounts, sched,
    async close() {
      server.close();
      server.closeAllConnections();
      clearInterval(pruneTimer);
      keeper.stop();
      backups?.stop();
      await sched.shutdown();
      db.close();
    },
  };
}

export async function serve(o: ServeOpts, entry: string): Promise<number> {
  const app = createApp(o, entry);
  await new Promise<void>((resolve) => app.server.listen(o.port, o.host, resolve));
  log.info(`web interface on http://${o.host}:${o.port}/ (sign in with an account; \`minutes user add\` makes one)`);

  return new Promise<number>((resolve) => {
    let stopping = false;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, async () => {
        if (stopping) process.exit(130);
        stopping = true;
        log.info("shutting down; stopping running captures so they stitch");
        await app.close();
        resolve(0);
      });
    }
  });
}

