/**
 * Web interface: the public site, the capture admin, sign-in.
 *
 * node:http only (no runtime deps beyond playwright). Routes:
 *
 * Public (anyone; capability "watch"):
 *   GET    /                         published recordings, live transcripts (pages/public.ts)
 *   GET    /api/recordings           published recordings, public fields only
 *   GET    /media/:slug/:file        a published recording's video, subtitles, transcript, live draft
 *   GET    /api/status?within=45     busy: a capture running or due (the deploy guard); counts only
 *
 * Accounts:
 *   GET    /login, /account          sign in, change password (pages/login.ts)
 *   GET    /api/me                   who is signed in, and what they may do
 *   POST   /api/login                {email, password}; sets the session cookie
 *   POST   /api/logout
 *   POST   /api/account/password     {current, password}
 *
 * Admin (admin.view to read, admin.manage to change). All under /admin and
 * /api/admin, so a proxy can keep them off the internet by path:
 *   GET    /admin                    the capture page (pages/admin.ts)
 *   GET    /admin/media/:slug/:file  any recording's files, incl. manifest.json and parts
 *   GET    /api/admin/info           timezone, tzdata, lead time
 *   GET    /api/admin/recordings     every recording, incl. failed attempts
 *   GET    /api/admin/jobs           scheduled / running / finished captures
 *   POST   /api/admin/jobs           {link, start, slug?, name?, email?}
 *   PATCH  /api/admin/jobs/:id       edit a scheduled capture
 *   DELETE /api/admin/jobs/:id       cancel, or stop a running capture
 *   POST   /api/admin/jobs/:id/retry another attempt at a finished capture's meeting
 *   GET    /api/admin/jobs/:id/screen  PNG of what the bot's display shows now
 *   GET    /api/admin/jobs/:id/log   tail of that capture's log
 *   GET    /api/admin/session        saved Zoom login state
 *   POST   /api/admin/session/check  check (and refresh) the saved login now
 *   GET    /api/admin/audit          audit log, newest first (?action, actor, target, before, limit)
 *
 * Every admin write, and every password change, is recorded in the audit
 * log (audit.ts) with the fields it changed, redacted.
 *
 * Hardening: security headers on everything, a CSP with the pages' script
 * hashes, writes only from this origin with a JSON body, X-Forwarded-* only
 * from TRUSTED_PROXIES, caps on URL, header and body size and on how long a
 * request may take to arrive.
 */
import { execFile } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Accounts, AccountError, FailureLimiter, ROLE_CAPS, SESSION_MAX_AGE_S, can, type Capability, type User } from "./accounts.js";
import { Audit, type Actor } from "./audit.js";
import { NightlyBackup, type NightlyOpts } from "./backup.js";
import { openDb } from "./db.js";
import { BadRequest, Scheduler, type Job, type SchedulerOpts } from "./jobs.js";
import { Proxies, SECURITY_HEADERS, pageCsp } from "./net.js";
import { ADMIN_PAGE } from "./pages/admin.js";
import { LOGIN_PAGE } from "./pages/login.js";
import { PUBLIC_PAGE } from "./pages/public.js";
import { platformFor } from "./platforms/registry.js";
import { FILE_RE, listRecordings, publicFiles, toPublic } from "./recordings.js";
import { SessionKeeper, type KeeperOpts } from "./session.js";
import { SLUG_RE, logger, notify } from "./util.js";

const log = logger("web");

export interface ServeOpts extends Omit<SchedulerOpts, "entry"> {
  host: string;
  port: number;
  tz: string;
  /** Mark the session cookie Secure (and use the __Host- prefix). Off only
   *  for plain-http development. */
  secureCookie: boolean;
  /** Comma-separated IPs/CIDRs whose X-Forwarded-For/-Proto are believed. */
  trustedProxies?: string;
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
const MAX_URL = 2048;

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof body === "string" || Buffer.isBuffer(body);
  const data = isText ? body as string | Buffer : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) { reject(new BadRequest("request too large", 413)); return; }
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

/** A job as the admin page sees it: never the link (it can hold the
 *  passcode) or the email, only the meeting ID and whether an email is set. */
function adminJob(j: Job) {
  const { link, email, ...rest } = j;
  return { ...rest, meetingId: platformFor(link)?.publicId(link) ?? "?", hasEmail: !!email };
}

/** What the audit log keeps of a job (redacted on the way in). */
function jobSnap(j: Job): Record<string, unknown> {
  return { slug: j.slug, link: j.link, start: j.start, name: j.name, email: j.email ?? null, status: j.status };
}

/** Writes must come from our own pages: a cross-site form or fetch can't
 *  set a JSON content type without a preflight we never answer, and the
 *  Origin, when present, has to be us. */
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
  audit: Audit;
  /** Stop timers and captures, close the database. */
  close(): Promise<void>;
}

/** Everything but listening and signal handling (tests use this). */
export function createApp(o: ServeOpts, entry: string): App {
  const db = openDb(path.join(o.out, "minutes.db"));
  const accounts = new Accounts(db);
  const audit = new Audit(db);
  const proxies = new Proxies(o.trustedProxies);
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

  const pages = Object.fromEntries(Object.entries({ public: PUBLIC_PAGE, admin: ADMIN_PAGE, login: LOGIN_PAGE }).map(([k, html]) => {
    const body = html.replace("__TZ__", JSON.stringify(o.tz));
    return [k, { body, csp: pageCsp(body) }];
  })) as Record<"public" | "admin" | "login", { body: string; csp: string }>;
  const sendPage = (res: http.ServerResponse, p: { body: string; csp: string }) =>
    send(res, 200, p.body, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": p.csp });

  const publicRecordings = () => listRecordings(o.out, sched, o.tz).filter((r) => r.public).map(toPublic);

  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 }, async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if ((req.url ?? "").length > MAX_URL) return send(res, 414, "URL too long");
      if (proxies.https(req)) res.setHeader("Strict-Transport-Security", "max-age=15552000");
      const url = new URL(req.url ?? "/", "http://x");
      let parts: string[];
      try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { return send(res, 400, "bad URL"); }
      const method = req.method ?? "GET";
      const read = method === "GET" || method === "HEAD";
      const ip = proxies.clientIp(req);

      // Who's asking. A user who must change their password can do nothing
      // else until they have.
      const token = cookies(req)[cookieName];
      const sess = accounts.session(token);
      const user: User | null = sess?.user ?? null;
      const role = user && !user.mustChangePassword ? user.role : null;
      const actor: Actor = { id: user?.id ?? null, label: user?.email ?? "anonymous", ip };
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
      const media = (slug: string, file: string, allowed: (slug: string, file: string) => boolean) => {
        if (!read || !SLUG_RE.test(slug) || !FILE_RE.test(file) || !allowed(slug, file)) return send(res, 404, "not found");
        return serveFile(req, res, path.join(o.out, slug, file));
      };

      // --- pages ---
      if (read && url.pathname === "/") return sendPage(res, pages.public);
      if (read && (url.pathname === "/login" || url.pathname === "/account")) return sendPage(res, pages.login);
      if (read && (url.pathname === "/admin" || url.pathname === "/admin/")) {
        return allow("admin.view", true) ? sendPage(res, pages.admin) : undefined;
      }

      // --- public ---
      if (parts[0] === "media" && parts.length === 3) {
        if (!allow("watch")) return;
        const r = publicRecordings().find((x) => x.slug === parts[1]);
        return media(parts[1], parts[2], (_, f) => !!r && publicFiles(r).has(f));
      }
      if (parts[0] === "api" && parts[1] === "recordings" && parts.length === 2 && read) {
        if (!allow("watch")) return;
        return send(res, 200, publicRecordings());
      }
      if (parts[0] === "api" && parts[1] === "status" && parts.length === 2 && read) {
        // For the deploy guard (scripts/deploy-guard.sh): is a capture
        // running, queued, or starting within ?within= minutes? Counts and
        // a start time only: no names, links or IDs.
        const within = Math.min(Math.max(Number(url.searchParams.get("within") ?? 45) || 0, 0), 1440) * 60_000;
        const now = Date.now();
        const jobs = sched.list();
        const running = jobs.filter((j) => j.status === "running" || j.status === "stopping" || j.status === "queued").length;
        const due = jobs.filter((j) => j.status === "scheduled" && Date.parse(j.start) - now < within).map((j) => j.start).sort();
        return send(res, 200, { busy: running > 0 || due.length > 0, running, nextStart: due[0] ?? null });
      }

      // --- accounts ---
      if (parts[0] === "api" && parts[1] === "me" && parts.length === 2 && read) {
        return send(res, 200, { user: me(), setupNeeded: accounts.count("admin") === 0 });
      }
      if (parts[0] === "api" && parts[1] === "login" && parts.length === 2 && method === "POST") {
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
      if (parts[0] === "api" && parts[1] === "logout" && parts.length === 2 && method === "POST") {
        accounts.endSession(token);
        return send(res, 200, { user: null }, { "Set-Cookie": `${cookieName}=; ${cookieAttrs}; Max-Age=0` });
      }
      if (parts[0] === "api" && parts[1] === "account" && parts[2] === "password" && parts.length === 3 && method === "POST") {
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
        audit.record(actor, "account.password", { type: "user", id: user.id, label: user.email },
          { mustChangePassword: user.mustChangePassword }, { mustChangePassword: false, otherSessions: "signed out" });
        log.info(`${user.email} changed their password`);
        return send(res, 200, { user: { ...me(), mustChangePassword: false, caps: ROLE_CAPS[user.role] } });
      }

      // --- admin ---
      if (parts[0] === "admin" && parts[1] === "media" && parts.length === 4) {
        if (!allow("admin.view")) return;
        return media(parts[2], parts[3], () => true);
      }
      if (parts[0] === "api" && parts[1] === "admin") {
        if (!allow(read ? "admin.view" : "admin.manage")) return;
        const [, , what, id, sub] = parts;
        if (what === "info" && parts.length === 3 && read) {
          return send(res, 200, { tz: o.tz, tzdata: process.versions.tz ?? null, leadMinutes: o.leadMs / 60_000, maxConcurrent: o.maxConcurrent });
        }
        if (what === "recordings" && parts.length === 3 && read) return send(res, 200, listRecordings(o.out, sched, o.tz));
        if (what === "audit" && parts.length === 3 && read) {
          const q = url.searchParams;
          const num = (k: string) => { const n = Number(q.get(k)); return Number.isInteger(n) && n > 0 ? n : undefined; };
          return send(res, 200, {
            entries: audit.list({ action: q.get("action") || undefined, actor: q.get("actor") || undefined,
              target: q.get("target") || undefined, beforeId: num("before"), limit: num("limit") }),
            actions: audit.actions(),
          });
        }
        if (what === "session") {
          if (parts.length === 3 && read) return send(res, 200, keeper.get());
          if (id === "check" && parts.length === 4 && method === "POST") {
            if (sched.list().some((j) => j.status === "running" || j.status === "stopping")) {
              return send(res, 409, { error: "a capture is running; the login is checked after it ends" });
            }
            const s = await keeper.check("checked from the web page");
            audit.record(actor, "login.check", { type: "zoom-login" }, null, { state: s.state, detail: s.detail });
            return send(res, 200, s);
          }
        }
        if (what === "jobs") {
          if (parts.length === 3 && read) return send(res, 200, sched.list().map(adminJob));
          if (parts.length === 3 && method === "POST") {
            const body = await jsonBody();
            if (!body) return;
            const j = sched.add(body);
            audit.record(actor, "job.create", { type: "job", id: j.id, label: j.slug }, null, jobSnap(j));
            return send(res, 201, adminJob(j));
          }
          const job = id ? sched.get(id) : undefined;
          if (!job) return send(res, 404, { error: "no such job" });
          if (parts.length === 4 && method === "PATCH") {
            const body = await jsonBody();
            if (!body) return;
            const before = jobSnap(job);
            const j = sched.update(job.id, body);
            audit.record(actor, "job.update", { type: "job", id: j.id, label: j.slug }, before, jobSnap(j));
            return send(res, 200, adminJob(j));
          }
          if (parts.length === 4 && method === "DELETE") {
            const before = jobSnap(job);
            const j = sched.cancel(job.id);
            audit.record(actor, before.status === "running" ? "job.stop" : "job.cancel", { type: "job", id: j.id, label: j.slug }, before, jobSnap(j));
            return send(res, 200, adminJob(j));
          }
          if (parts.length === 5 && sub === "retry" && method === "POST") {
            const j = sched.retry(job.id);
            audit.record(actor, "job.retry", { type: "job", id: j.id, label: j.slug }, null, { ...jobSnap(j), previousAttempt: job.slug });
            return send(res, 201, adminJob(j));
          }
          if (parts.length === 5 && sub === "log" && read) return send(res, 200, tail(path.join(o.out, job.slug, "capture.log")));
          if (parts.length === 5 && sub === "screen" && read) {
            const d = sched.displayOf(job.id);
            if (!d) return send(res, 409, "not running");
            return send(res, 200, await screenshot(d, o.width, o.height), { "Content-Type": "image/png" });
          }
        }
      }
      return send(res, 404, parts[0] === "api" ? { error: "not found" } : "not found");
    } catch (e) {
      if (e instanceof BadRequest || e instanceof AccountError) return send(res, e.status, { error: e.message });
      log.error("request failed", e);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });

  return {
    server, accounts, sched, audit,
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
  log.info(`web interface on http://${o.host}:${o.port}/ (admin at /admin; \`minutes user add --admin\` makes an account)`);

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
