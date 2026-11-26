/**
 * Web interface: the public site, the capture admin, sign-in.
 *
 * node:http only (no runtime deps beyond playwright). Routes:
 *
 * Public (anyone; capability "watch"):
 *   GET    /                         upcoming and past meetings, recent changes (pages/public.ts)
 *   GET    /m/:slug                  one meeting: status, video, transcript, history (pages/meeting.ts)
 *   GET    /api/meetings             ?scope=upcoming|past &body &from &to &q &limit &offset
 *   GET    /api/meetings/:slug       detail + recording + public history; /status is polled
 *   GET    /api/changes              recent announcements, moves, cancellations, documents
 *   GET    /search                   search every public transcript (pages/search.ts)
 *   GET    /api/search               ?q= &body &from &to &limit &offset: passages with highlighted snippets and a link at the second
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
 *   POST   /api/signup               {email, password, name?} -> emails a code (only with mail set up)
 *   POST   /api/signup/verify        {email, code} -> verified and signed in
 *   POST   /api/account/verify       {code}  (signed in, not yet verified)
 *   POST   /api/account/verify/resend
 *   POST   /api/password/forgot      {email} -> emails a reset code (if the account exists)
 *   POST   /api/password/reset       {email, code, password}
 *
 * Admin (admin.view to read, admin.manage to change). All under /admin and
 * /api/admin, so a proxy can keep them off the internet by path:
 *   GET    /admin                    the capture page (pages/admin.ts)
 *   GET    /admin/media/:slug/:file  any recording's files, incl. manifest.json and parts
 *   GET    /api/admin/info           timezone, tzdata, lead time
 *   GET    /api/admin/recordings     every recording, incl. failed attempts
 *   GET    /api/admin/recordings/:slug/speakers  the transcript's speaker labels (first line, time spoken) and their names
 *   PUT    /api/admin/recordings/:slug/speakers  {names: {"Speaker 4": "Mayor Smith"}}: replaces the set; shown on every transcript view
 *   GET    /api/admin/jobs           scheduled / running / finished captures
 *   POST   /api/admin/jobs           {link, start, slug?, name?, email?}
 *   PATCH  /api/admin/jobs/:id       edit a scheduled capture
 *   DELETE /api/admin/jobs/:id       cancel, or stop a running capture
 *   POST   /api/admin/jobs/:id/retry another attempt at a finished capture's meeting
 *   GET    /api/admin/jobs/:id/screen  PNG of what the bot's display shows now
 *   GET    /api/admin/jobs/:id/log   tail of that capture's log
 *   GET    /api/admin/session        saved Zoom login state
 *   POST   /api/admin/session/check  check (and refresh) the saved login now
 *   GET    /api/account/tokens       your API tokens (tokens.own: needs a confirmed email)
 *   POST   /api/account/tokens       {label, scopes?, expiresInDays?} -> {token (shown once), record}
 *   DELETE /api/account/tokens/:id   revoke
 *   GET    /api/account/usage        your API usage (?days=30)
 *   GET    /api/account/alerts       your saved searches (alerts.own: confirmed email; needs mail set up)
 *   POST   /api/account/alerts       {query, body?} -> emails you when a new meeting's transcript matches
 *   DELETE /api/account/alerts/:id
 *   GET    /alerts/:token/stop       the email's link: a page that asks (POST /api/alerts/stop {token} stops it)
 *   GET    /api/admin/tokens         everyone's tokens;  DELETE /api/admin/tokens/:id  revoke
 *   PATCH  /api/admin/tokens/:id     {downloadBps}: that token's own download speed cap (0 = the default)
 *   GET    /api/admin/usage          per day, token, user, top files (?days, ?user)
 *   GET    /api/v1/openapi.json, /api/docs   the API's description
 *   GET    /api/v1/meetings[/:id[/status|/files[/:name]]], /changes, /me   the API; downloads need a bearer token
 *   GET    /api/admin/audit          audit log, newest first (?action, actor, target, before, limit)
 *   GET    /admin/feeds              feeds: where meetings are found (pages/feeds.ts)
 *   GET    /api/admin/feeds          parsers and feeds, with health and recent runs
 *   POST   /api/admin/feeds          {name, parser, config, slugPrefix, policy, intervalMin, enabled}
 *   PATCH  /api/admin/feeds/:id      same fields, all optional
 *   DELETE /api/admin/feeds/:id
 *   POST   /api/admin/feeds/:id/run  poll now
 *   POST   /api/admin/feeds/preview  {parser, config, feedId?}: fetch + parse (+ diff), nothing saved
 *   GET    /api/admin/feeds/:id/changes  what its runs changed
 *   GET    /api/admin/meetings?view=review|upcoming|recent
 *   POST   /api/admin/meetings/:id/approve | reject   the review queue
 *   POST   /api/admin/meetings/:id/merge {into} | split   dedup by hand
 *   POST   /api/admin/meetings/:id/hide | show        pull a meeting (and its files) from the public site
 *   GET    /api/admin/meetings/:id/changes            its history
 *   GET    /api/admin/users          accounts
 *   PATCH  /api/admin/users/:id      {role?, disabled?}
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
import { pipeline } from "node:stream";
import { Bucket, Throttle, paced } from "./throttle.js";
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Accounts, AccountError, FailureLimiter, SESSION_MAX_AGE_S, capsFor, checkEmail, checkNewPassword, type Capability, type User } from "./accounts.js";
import { Audit, type Actor } from "./audit.js";
import { NightlyBackup, type NightlyOpts } from "./backup.js";
import { openDb } from "./db.js";
import { BadRequest, Scheduler, type Job, type SchedulerOpts } from "./jobs.js";
import type { Mailer } from "./mail.js";
import { Proxies, SECURITY_HEADERS, embedAncestors, pageCsp } from "./net.js";
import { EMBED_PAGE } from "./pages/embed.js";
import "./feeds/parsers/index.js";
import { Poller, healthOf } from "./feeds/poller.js";
import { parserById, parsers } from "./feeds/registry.js";
import { FeedError, Feeds, type Feed } from "./feeds/store.js";
import { Sync, shownLink } from "./feeds/sync.js";
import { platformFor as platformOf } from "./platforms/registry.js";
import type { Meeting } from "./meetings.js";
import { ConfigError } from "./feeds/types.js";
import { FEEDS_PAGE } from "./pages/feeds.js";
import { ADMIN_PAGE } from "./pages/admin.js";
import { LOGIN_PAGE } from "./pages/login.js";
import { PUBLIC_PAGE } from "./pages/public.js";
import { MEETING_PAGE } from "./pages/meeting.js";
import { OVER_AFTER_MS, PUBLIC_KINDS, filterMeetings, publicChange, recordingOf, toPublicMeeting, visible, type PublicMeeting } from "./site.js";
import type { Recording } from "./recordings.js";
import { zonedTime } from "./feeds/time.js";
import { platformFor } from "./platforms/registry.js";
import { FILE_RE, listRecordings, publicFiles, toPublic } from "./recordings.js";
import { SessionKeeper, type KeeperOpts } from "./session.js";
import { API_DOCS_PAGE, openApi } from "./apidocs.js";
import { Tokens, TokenError, activeToken, type ApiToken } from "./tokens.js";
import { Search } from "./search.js";
import { NAMES_FILE, NamesError, applyNames, cleanNames, kindOf, labelsOf, namedFile, readNames, writeNames } from "./speakers.js";
import { Alerts, AlertError, type Alert } from "./alerts.js";
import { STOP_PAGE } from "./pages/stop.js";
import { Thumbs } from "./thumbs.js";
import { SEARCH_PAGE } from "./pages/search.js";
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
  /** Outgoing mail (mail.ts). Without it, sign-up and password reset are off. */
  mailer?: Mailer | null;
  /** The site's address, for links in emails and in page metadata (canonical, previews, oEmbed). */
  publicUrl?: string;
  /** Download speed caps in bytes/second (#36; throttle.ts): all API downloads together, and each token. 0 or unset = unlimited. */
  downloadBps?: number;
  tokenDownloadBps?: number;
  /** Make poster images for recordings that have a video and none yet (thumbs.ts). Default on; tests turn it off. */
  thumbnails?: boolean;
  /** Searches allowed per minute per client address (default 60; 429 beyond). */
  searchesPerMinute?: number;
  /** Who may frame /embed/<meeting> (net.ts embedAncestors): "*" (default), "none", or origins. */
  embedOrigins?: string;
  session: Omit<KeeperOpts, "auth" | "out" | "leadMs">;
  /** Nightly backups; null = off. */
  backup: Omit<NightlyOpts, "auth" | "notifyUrl"> | null;
  /** Poll feeds on their schedule (off in tests: they use Run now). */
  pollFeeds?: boolean;
}

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const MAX_URL = 2048;

/** Public read-only endpoints other sites may call from a browser (no cookies are involved: tokens go in a header). */
const CORS_EXPOSE = "Content-Length, Content-Range, Accept-Ranges, Retry-After, WWW-Authenticate";
const corsPath = (p: string[]) => (p[0] === "api" && (p[1] === "v1" || p[1] === "meetings" || p[1] === "changes" || p[1] === "search")) || p[0] === "media" || p[0] === "oembed";
function openCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE);
}

/** Count the body bytes written to a response (so Range responses count what they sent, an aborted download what got out). */
function countBytes(res: http.ServerResponse): () => number {
  let n = 0;
  const len = (c: unknown) => (typeof c === "string" ? Buffer.byteLength(c) : c instanceof Uint8Array ? c.byteLength : 0);
  const write = res.write.bind(res) as (...a: unknown[]) => boolean, end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  res.write = ((c: unknown, ...a: unknown[]) => { n += len(c); return write(c, ...a); }) as typeof res.write;
  res.end = ((c?: unknown, ...a: unknown[]) => { n += len(c); return end(c, ...a); }) as typeof res.end;
  return () => n;
}

/** An alert as its owner sees it: never the token that stops it from an email. */
const publicAlert = (a: Alert) => ({ id: a.id, query: a.query, body: a.body, createdAt: a.createdAt, lastSentAt: a.lastSentAt });

/** A token as its owner (or an admin) sees it: never its hash. */
const publicToken = (t: ApiToken) => ({ id: t.id, prefix: t.prefix, label: t.label, scopes: t.scopes, createdAt: t.createdAt, expiresAt: t.expiresAt,
  lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt, active: activeToken(t), downloadBps: t.limits?.downloadBps ?? null });

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

/** A join link as admins may see it: platform + meeting number, a URL
 *  without the passcode, and whether a passcode is on file. Null = none. */
function joinLinkOf(link: string | undefined) {
  if (!link) return null;
  const p = platformOf(link);
  return { label: shownLink(link), url: p?.publicUrl?.(link) ?? null, passcode: /[?&]pwd=/.test(link) };
}

/** A user as the pages see them. */
function meOf(u: User) {
  return { email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword,
    verified: !!u.emailVerifiedAt, caps: capsFor(u) };
}

/** A user as the admin's Users list shows them. */
function adminUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, verified: !!u.emailVerifiedAt, disabled: !!u.disabledAt,
    mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt };
}

const UNVERIFIED_DAYS = 7;

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

/** pace: buckets to throttle this response through (API downloads; see throttle.ts). */
function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, pace: Bucket[] = []): void {
  const stream = (s: NodeJS.ReadableStream) => {
    if (!pace.length) return void s.pipe(res);
    // pipeline ends everything if the client goes away mid-download.
    pipeline(s, paced(pace), res, () => { /* aborts are normal */ });
  };
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
    return stream(createReadStream(file, { start, end }));
  }
  res.writeHead(200, { ...base, "Content-Length": String(size) });
  if (req.method === "HEAD") return void res.end();
  stream(createReadStream(file));
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
  tokens: Tokens;
  search: Search;
  alerts: Alerts;
  /** Email alert matches for meetings not handled yet (it also runs after each search index pass). */
  processAlerts(): Promise<number>;
  /** Re-read transcripts into the search index now (it also runs by itself). */
  syncSearch(force?: boolean): void;
  /** Make any missing poster images now; resolves with how many were made. */
  syncThumbs(): Promise<number>;
  /** Stop timers and captures, close the database. */
  close(): Promise<void>;
}

/** Everything but listening and signal handling (tests use this). */
export function createApp(o: ServeOpts, entry: string): App {
  const db = openDb(path.join(o.out, "minutes.db"));
  const accounts = new Accounts(db);
  const audit = new Audit(db);
  const tokens = new Tokens(db);
  const search = new Search(db);
  const alerts = new Alerts(db);
  const nameCache = new Map<string, string>();
  const throttle = new Throttle({ globalBps: o.downloadBps, tokenBps: o.tokenDownloadBps });
  const proxies = new Proxies(o.trustedProxies);
  const cookieName = o.secureCookie ? "__Host-minutes_session" : "minutes_session";
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${o.secureCookie ? "; Secure" : ""}`;
  const failsByIp = new FailureLimiter(30, 15 * 60_000);
  const failsByAccount = new FailureLimiter(10, 15 * 60_000);
  // Counted on every attempt, not only failures: these send mail.
  const signupsByIp = new FailureLimiter(5, 3_600_000);
  const mailsByIp = new FailureLimiter(10, 3_600_000);
  const mailsByAccount = new FailureLimiter(3, 3_600_000);
  // Full-text search is the one public endpoint that does real work per request: 60 a minute per client.
  const searchesByIp = new FailureLimiter(o.searchesPerMinute ?? 60, 60_000);
  const codeFailsByIp = new FailureLimiter(30, 15 * 60_000);
  const mailer = o.mailer ?? null;
  const site = (o.publicUrl ?? "").replace(/\/$/, "");
  const frameAncestors = embedAncestors(o.embedOrigins);
  const prune = () => {
    try {
      accounts.pruneSessions();
      tokens.prune();
      for (const email of accounts.deleteUnverified(UNVERIFIED_DAYS)) {
        audit.record({ id: null, label: "system" }, "user.expire", { type: "user", label: email }, { verified: false }, null);
        log.info(`deleted an account never verified in ${UNVERIFIED_DAYS} days`);
      }
    } catch (e) { log.warn("pruning accounts failed", e); }
  };
  const pruneTimer = setInterval(prune, 3_600_000);
  pruneTimer.unref();
  log.info(mailer ? `mail from ${mailer.from}: sign-up and password reset are on` : "no SMTP_URL: sign-up and password reset are off");
  /** Send without failing the request; mail problems go to the log. */
  const mail = (to: string, subject: string, text: string) =>
    mailer!.send({ to, subject, text: text + `\n\n-- \nminutes${site ? " · " + site : ""}\nAn automatic message; replies aren't read.\n` })
      .catch((e) => log.error("sending mail failed", e));
  if (!accounts.count("admin")) {
    log.warn("no admin account yet: run `minutes user add --admin <email>` on the server to create one");
  }

  const sched = new Scheduler({ ...o, entry }, db);
  sched.start();
  const feeds = new Feeds(db);
  const sync = new Sync(db, sched, o.tz, o.session.notifyUrl);
  const poller = new Poller(feeds, { tz: o.tz }, sync);
  if (o.pollFeeds !== false) poller.start();
  /** A feed as the admin page sees it. */
  const adminFeed = (f: Feed) => ({ ...f, httpCache: undefined, health: healthOf(f), running: poller.isRunning(f.id),
    parserLabel: parserById(f.parser)?.label ?? f.parser, runs: feeds.runs(f.id, 10) });
  /** A meeting as the admin sees it: the link only as platform + number. */
  const adminMeeting = (m: Meeting) => {
    const job = sched.activeJobFor(m.id) ?? sched.list().filter((j) => j.meetingRef === m.id).at(-1);
    const dup = m.duplicateOf ? sched.meetings.get(m.duplicateOf) : undefined;
    return { id: m.id, title: m.title, body: m.body ?? null, start: m.start, slug: m.slug, status: m.status, review: m.review ?? null,
      removedAt: m.removedAt ?? null, visibility: m.visibility, link: shownLink(m.link), joinLink: joinLinkOf(m.link), streamUrl: m.streamUrl ?? null,
      agendaUrl: m.agendaUrl ?? null, pageUrl: m.pageUrl ?? null,
      feedId: m.feedId ?? null, feedName: m.feedId ? feeds.get(m.feedId)?.name ?? "(deleted feed)" : null,
      duplicateOf: dup ? { id: dup.id, title: dup.title, slug: dup.slug, start: dup.start } : null,
      capture: job ? { id: job.id, slug: job.slug, status: job.status } : null };
  };
  const feedSnap = (f: Feed) => ({ name: f.name, parser: f.parser, config: f.config, slugPrefix: f.slugPrefix, policy: f.policy,
    intervalMin: f.intervalMin, enabled: f.enabled });
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

  const pages = Object.fromEntries(Object.entries({ public: PUBLIC_PAGE, admin: ADMIN_PAGE, login: LOGIN_PAGE, feeds: FEEDS_PAGE, meeting: MEETING_PAGE, embed: EMBED_PAGE, search: SEARCH_PAGE, stop: STOP_PAGE }).map(([k, html]) => {
    const body = html.replace("__TZ__", JSON.stringify(o.tz));
    return [k, { body, csp: pageCsp(body) }];
  })) as Record<"public" | "admin" | "login" | "feeds" | "meeting" | "embed" | "search" | "stop", { body: string; csp: string }>;
  const sendPage = (res: http.ServerResponse, p: { body: string; csp: string }) =>
    send(res, 200, p.body, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": p.csp });

  const publicRecordings = () => listRecordings(o.out, sched, o.tz).filter((r) => r.public).map(toPublic);

  /** Bring the transcript search index in step with the files on disk (cheap when nothing changed). */
  let searchSyncedAt = 0, closed = false;
  const syncSearch = (force = false) => {
    if (closed || (!force && Date.now() - searchSyncedAt < 30_000)) return;
    searchSyncedAt = Date.now();
    try {
      const items = sched.list().map((j) => ({ recSlug: j.slug, meetingId: j.meetingRef, file: path.join(o.out, j.slug, `${j.slug}.transcript.json`), namesFile: path.join(o.out, j.slug, NAMES_FILE) }))
        .filter((i) => existsSync(i.file));
      const r = search.sync(items);
      if (r.indexed || r.removed) log.info(`transcript search: indexed ${r.indexed}, dropped ${r.removed}`);
      void processAlerts();
    } catch (e) { log.warn("indexing transcripts for search failed", e); }
  };
  /** Email people whose alerts match meetings that got transcripts (alerts.ts). Needs mail; harmless without. */
  let alertsBusy = false;
  const processAlerts = async (): Promise<number> => {
    if (!mailer || closed || alertsBusy) return 0;
    alertsBusy = true;
    try {
      const meetings = publicSite().entries.filter((e) => e.rec?.public && e.rec.files.transcript)
        .map((e) => ({ id: e.m.id, slug: e.m.slug, title: e.m.title, body: e.m.body ?? null, start: e.m.start }));
      return await alerts.process({
        meetings, search, site, tz: o.tz,
        recipient: (id) => { const u = accounts.get(id); return u && !u.disabledAt && u.emailVerifiedAt && !u.mustChangePassword ? { id: u.id, email: u.email, name: u.name } : null; },
        send: (to, subject, text) => mailer.send({ to: to.email, subject, text: text + `\n\n-- \nminutes${site ? " · " + site : ""}\nAn automatic message; replies aren't read.\n` }),
      });
    } catch (e) { log.warn("processing alerts failed", e); return 0; }
    finally { alertsBusy = false; }
  };
  const searchTimer = setInterval(() => syncSearch(true), 120_000);
  searchTimer.unref();
  setImmediate(() => syncSearch(true));

  /** Poster images: a frame of each recording's video, made one at a time in the background. */
  const thumbs = new Thumbs();
  const syncThumbs = (): Promise<number> => {
    const todo = listRecordings(o.out, sched, o.tz).filter((r) => r.video && !r.files.thumb)
      .map((r) => ({ slug: r.slug, video: path.join(o.out, r.slug, r.video!), dest: path.join(o.out, r.slug, `${r.slug}.jpg`), duration: r.duration }));
    return todo.length ? thumbs.run(todo).catch((e) => { log.warn("making posters failed", e); return 0; }) : Promise.resolve(0);
  };
  const thumbTimer = setInterval(() => { if (o.thumbnails !== false) void syncThumbs(); }, 120_000);
  thumbTimer.unref();
  if (o.thumbnails !== false) setImmediate(() => void syncThumbs());

  /** Every meeting the public may see, with what became of it (see site.ts). */
  const publicSite = (now = Date.now()) => {
    const recs = new Map<string, Recording>(listRecordings(o.out, sched, o.tz).map((r) => [r.slug, r]));
    const jobsBy = new Map<string, Job[]>();
    for (const j of sched.list()) jobsBy.set(j.meetingRef, [...(jobsBy.get(j.meetingRef) ?? []), j]);
    const entries: { m: Meeting; p: PublicMeeting; rec: Recording | undefined; jobs: Job[] }[] = [];
    for (const m of sched.meetings.list()) {
      if (!visible(m)) continue;
      const jobs = jobsBy.get(m.id) ?? [], rec = recordingOf(jobs, recs);
      // Gone from its feed before it happened: nothing to show (a recording keeps it).
      if (m.removedAt && !rec?.video && Date.parse(m.start) > now - OVER_AFTER_MS) continue;
      entries.push({ m, p: toPublicMeeting(m, jobs, rec, now), rec, jobs });
    }
    // A shared link may carry a capture's folder name (slug-2, or an old recording link).
    const find = (slug: string) => entries.find((e) => e.m.slug === slug)
      ?? entries.find((e) => e.jobs.some((j) => j.slug === slug));
    return { entries, find, now };
  };

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
      const caps = capsFor(user);
      const actor: Actor = { id: user?.id ?? null, label: user?.email ?? "anonymous", ip };
      if (sess?.renewed) res.setHeader("Set-Cookie", `${cookieName}=${token}; ${cookieAttrs}; Max-Age=${SESSION_MAX_AGE_S}`);
      const signIn = (u: User) => {
        accounts.endSession(token);
        const t = accounts.createSession(u.id, { ip, userAgent: req.headers["user-agent"] });
        return { "Set-Cookie": `${cookieName}=${t}; ${cookieAttrs}; Max-Age=${SESSION_MAX_AGE_S}` };
      };
      /** False (and the response sent) if this request may not do `cap`. */
      const allow = (cap: Capability, page = false): boolean => {
        if (caps.includes(cap)) return true;
        if (page) {
          const to = user ? "/account?denied=1" : "/login?next=" + encodeURIComponent(url.pathname + url.search);
          res.writeHead(302, { Location: to, "Cache-Control": "no-store" }).end();
        } else {
          send(res, user ? 403 : 401, { error: user ? (user.mustChangePassword ? "change your password first" : "your account can't do that") : "sign in first" });
        }
        return false;
      };
      if (method === "OPTIONS" && corsPath(parts)) {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Range, Content-Type", "Access-Control-Max-Age": "86400" });
        return void res.end();
      }
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
      /** A readable transcript file with the recording's speaker names put in (speakers.ts); false if there's nothing to apply. */
      const serveWithNames = (slug: string, file: string): boolean => {
        const text = namedFile(path.join(o.out, slug), slug, file, nameCache);
        if (text === null) return false;
        const buf = Buffer.from(text, "utf8");
        res.writeHead(200, { "Content-Type": MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "text/plain", "Content-Length": String(buf.length), "Cache-Control": "no-cache" });
        if (req.method === "HEAD") res.end(); else res.end(buf);
        return true;
      };
      const media = (slug: string, file: string, allowed: (slug: string, file: string) => boolean) => {
        if (!read || !SLUG_RE.test(slug) || !FILE_RE.test(file) || !allowed(slug, file)) return send(res, 404, "not found");
        if (serveWithNames(slug, file)) return;
        return serveFile(req, res, path.join(o.out, slug, file));
      };

      // The site's own address: PUBLIC_URL, else what the request says (a plausible Host only).
      const base = () => {
        if (site) return site;
        const host = String(req.headers.host ?? "");
        return /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(host) ? `${proxies.https(req) ? "https" : "http"}://${host}` : "";
      };
      const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      // --- the API (/api/v1): public reads need nothing; downloads need a bearer token ---
      // /api/v1/meetings and /changes are the public endpoints below, reached as `rp`.
      const v1 = parts[0] === "api" && parts[1] === "v1";
      const rp = v1 ? ["api", ...parts.slice(2)] : parts;
      let tokenAuth: { t: ApiToken; user: User } | null = null;
      let usageFile: string | null = null;
      if (v1) {
        openCors(res);
        const seg = parts.slice(2);
        const route = "/" + seg.map((x, i) => (seg[0] === "meetings" && i === 1 ? ":id" : seg[0] === "meetings" && i === 3 ? ":name" : x)).join("/");
        const authz = req.headers.authorization;
        if (authz !== undefined) {
          const m = /^Bearer +(\S{1,200})$/i.exec(authz);
          const t = m ? tokens.authenticate(m[1]) : null;
          const u = t ? accounts.get(t.userId) : undefined;
          if (!t || !u || u.disabledAt || u.mustChangePassword) {
            return send(res, 401, { error: "invalid, expired or revoked token" }, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
          }
          tokenAuth = { t, user: u };
          const sent = countBytes(res);
          res.on("close", () => {
            try { tokens.record({ tokenId: t.id, userId: u.id, route, file: usageFile, status: res.statusCode, bytes: sent(), ip }); }
            catch (e) { log.warn("recording API usage failed", e); }
          });
          const verdict = tokens.limiter(t, route);
          if (!verdict.allow) return send(res, 429, { error: "rate limit reached" }, { "Retry-After": String(Math.max(1, Math.ceil(verdict.retryAfterS))) });
        }
        if (!read) return send(res, 405, { error: "the API is read-only" }, { Allow: "GET, HEAD, OPTIONS" });
        if (seg[0] === "openapi.json" && seg.length === 1) return send(res, 200, openApi(base()), { "Cache-Control": "public, max-age=300" });
        if (seg[0] === "me" && seg.length === 1) {
          if (!tokenAuth) return send(res, 401, { error: "send Authorization: Bearer <token>" }, { "WWW-Authenticate": "Bearer" });
          const t = tokenAuth.t;
          return send(res, 200, { prefix: t.prefix, label: t.label, scopes: t.scopes, createdAt: t.createdAt, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt,
            canDownload: t.scopes.includes("download") && capsFor(tokenAuth.user).includes("api.download") });
        }
        if (seg[0] === "meetings" && seg[2] === "files" && (seg.length === 3 || seg.length === 4)) {
          const e = publicSite().find(seg[1]);
          const rec = e?.rec?.public ? toPublic(e.rec) : null;
          if (!e || !e.rec || !rec) return send(res, 404, { error: "no recording for that meeting" });
          const listed = ([["video", rec.video], ["subtitles", rec.files.vtt], ["subtitles-srt", rec.files.srt], ["transcript-text", rec.files.txt],
            ["transcript-json", rec.files.transcript], ["zoom-captions", rec.files.zoomCaptions], ["thumbnail", rec.files.thumb]] as [string, string | null | undefined][])
            .filter((x): x is [string, string] => !!x[1]);
          if (seg.length === 3) {
            return send(res, 200, listed.map(([kind, name]) => ({ name, kind, bytes: statSync(path.join(o.out, e.rec!.slug, name)).size,
              url: `/api/v1/meetings/${encodeURIComponent(e.m.slug)}/files/${encodeURIComponent(name)}` })));
          }
          // A download: needs a token with the download scope whose owner may still download.
          if (!tokenAuth) return send(res, 401, { error: "downloads need an API token: send Authorization: Bearer <token>" }, { "WWW-Authenticate": "Bearer" });
          if (!tokenAuth.t.scopes.includes("download")) return send(res, 403, { error: "this token doesn't have the download scope" });
          if (!capsFor(tokenAuth.user).includes("api.download")) return send(res, 403, { error: "confirm your email address before downloading" });
          const name = seg[3];
          if (!FILE_RE.test(name) || !listed.some((x) => x[1] === name)) return send(res, 404, { error: "no such file" });
          usageFile = `${e.m.slug}/${name}`;
          res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
          if (serveWithNames(e.rec.slug, name)) return;
          return serveFile(req, res, path.join(o.out, e.rec.slug, name), throttle.buckets(tokenAuth.t.id, tokenAuth.t.limits?.downloadBps));
        }
        if (!((seg[0] === "meetings" && seg.length >= 1 && seg.length <= 3) || (seg[0] === "changes" && seg.length === 1) || (seg[0] === "search" && seg.length === 1))) return send(res, 404, { error: "no such endpoint" });
      }

      // --- for search engines ---
      if (read && url.pathname === "/robots.txt") {
        const b = base();
        return send(res, 200, ["User-agent: *", "Disallow: /admin", "Disallow: /api/", "Allow: /api/docs", "Disallow: /login", "Disallow: /account", "Disallow: /embed/", "Disallow: /oembed",
          ...(b ? [`Sitemap: ${b}/sitemap.xml`] : [])].join("\n") + "\n", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      }
      if (read && url.pathname === "/sitemap.xml") {
        const b = base();
        if (!b) return send(res, 404, "not found");
        const urls = [{ loc: `${b}/` }, { loc: `${b}/search` }, { loc: `${b}/api/docs` },
          ...publicSite().entries.slice(0, 40_000).map((e) => ({ loc: `${b}/m/${encodeURIComponent(e.m.slug)}`, lastmod: e.m.updatedAt }))];
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          urls.map((u) => `<url><loc>${esc(u.loc)}</loc>${"lastmod" in u && u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ""}</url>`).join("\n") + "\n</urlset>\n";
        return send(res, 200, xml, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      }

      // --- pages ---
      if (read && url.pathname === "/api/docs") {
        const page = API_DOCS_PAGE.replace(/https:\/\/YOUR-SITE/g, () => esc(base() || "https://YOUR-SITE"));
        return send(res, 200, page, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": pageCsp(page), "Cache-Control": "no-cache" });
      }
      if (read && url.pathname === "/") return sendPage(res, pages.public);
      if (read && url.pathname === "/search") return sendPage(res, pages.search);
      if (read && (url.pathname === "/login" || url.pathname === "/account")) return sendPage(res, pages.login);
      if (read && url.pathname === "/admin/feeds") {
        return allow("admin.view", true) ? sendPage(res, pages.feeds) : undefined;
      }
      if (read && (url.pathname === "/admin" || url.pathname === "/admin/")) {
        return allow("admin.view", true) ? sendPage(res, pages.admin) : undefined;
      }

      // --- public ---
      if (parts[0] === "media" && parts.length === 3) {
        if (!allow("watch")) return;
        openCors(res);
        const r = publicRecordings().find((x) => x.slug === parts[1]);
        return media(parts[1], parts[2], (_, f) => !!r && publicFiles(r).has(f));
      }
      if (parts[0] === "api" && parts[1] === "recordings" && parts.length === 2 && read) {
        if (!allow("watch")) return;
        return send(res, 200, publicRecordings());
      }
      if (rp[0] === "api" && rp[1] === "search" && rp.length === 2 && read) {
        // "What did council say about X": transcripts of the meetings the public can see (search.ts).
        if (!allow("watch")) return;
        openCors(res);
        const wait = searchesByIp.blockedFor(ip);
        if (wait > 0) return send(res, 429, { error: "too many searches; try again in a moment" }, { "Retry-After": String(Math.ceil(wait / 1000)) });
        searchesByIp.fail(ip);
        const sp = url.searchParams;
        const q = (sp.get("q") ?? "").slice(0, 200);
        const day = (s: string | null, plus = 0) => {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
          return m ? zonedTime(o.tz, +m[1], +m[2], +m[3] + plus) : undefined;
        };
        const from = day(sp.get("from")), to = day(sp.get("to"), 1), body = sp.get("body")?.slice(0, 100).toLowerCase();
        const int = (s: string | null, d: number, lo: number, hi: number) => Math.min(Math.max(Number.parseInt(s ?? "", 10) || d, lo), hi);
        syncSearch();
        const site = publicSite();
        const eligible = site.entries.filter((e) => e.rec?.public && e.rec.files.transcript
          && (!body || (e.m.body ?? "").toLowerCase() === body) && (!from || Date.parse(e.m.start) >= from.getTime()) && (!to || Date.parse(e.m.start) < to.getTime()));
        const byId = new Map(eligible.map((e) => [e.m.id, e]));
        const r = search.search(q, { meetingIds: [...byId.keys()], limit: int(sp.get("limit"), 20, 1, 50), offset: Math.max(Number.parseInt(sp.get("offset") ?? "", 10) || 0, 0) });
        return send(res, 200, { query: q, terms: r.terms, total: r.total, hits: r.hits.flatMap((h) => {
          const e = byId.get(h.meetingId);
          return e ? [{ meeting: { id: e.p.id, title: e.p.title, body: e.p.body, start: e.p.start }, t: Math.floor(h.start), speaker: h.speaker || null, parts: h.parts,
            url: `/m/${encodeURIComponent(e.p.id)}?t=${Math.floor(h.start)}` }] : [];
        }) });
      }
      if (rp[0] === "api" && rp[1] === "meetings" && read && rp.length >= 2 && rp.length <= 4) {
        if (!allow("watch")) return;
        openCors(res);
        const site = publicSite();
        if (rp.length === 2) {
          const sp = url.searchParams;
          const day = (s: string | null, plus = 0) => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
            return m ? zonedTime(o.tz, +m[1], +m[2], +m[3] + plus) : undefined;
          };
          const int = (s: string | null, d: number, lo: number, hi: number) => Math.min(Math.max(Number.parseInt(s ?? "", 10) || d, lo), hi);
          const all = site.entries.map((e) => e.p);
          const r = filterMeetings(all, {
            scope: sp.get("scope") === "past" ? "past" : "upcoming", body: sp.get("body")?.slice(0, 100) || undefined,
            from: day(sp.get("from")), to: day(sp.get("to"), 1), q: sp.get("q")?.slice(0, 100) || undefined,
            limit: int(sp.get("limit"), 50, 1, 200), offset: Math.max(Number.parseInt(sp.get("offset") ?? "", 10) || 0, 0),
          }, site.now);
          const bodies = [...new Set(all.map((p) => p.body).filter((b): b is string => !!b))].sort((a, b) => a.localeCompare(b));
          return send(res, 200, { ...r, bodies });
        }
        const e = site.find(rp[2]);
        if (!e) return send(res, 404, { error: "no such meeting" });
        if (rp.length === 4) {
          if (rp[3] !== "status") return send(res, 404, { error: "not found" });
          // Small, polled while the page waits for something to finish.
          const t = e.rec?.transcript;
          return send(res, 200, { stage: e.p.stage, hasVideo: e.p.hasVideo, hasTranscript: e.p.hasTranscript, live: e.p.live,
            transcript: t ? { status: t.status, stage: t.stage, progress: t.progress } : null });
        }
        const live = e.jobs.find((j) => j.status === "running" || j.status === "stopping");
        const history = sync.changes({ meetingId: e.m.id, kinds: PUBLIC_KINDS, limit: 100 })
          .flatMap((c) => publicChange(c, e.m) ?? []);
        return send(res, 200, { ...e.p, recording: e.rec?.public ? toPublic(e.rec) : null, startedAt: live?.launchedAt ?? null, history });
      }
      if (rp[0] === "api" && rp[1] === "changes" && rp.length === 2 && read) {
        // What changed lately across the public meetings: announcements, moves, cancellations, new documents.
        if (!allow("watch")) return;
        openCors(res);
        const site = publicSite();
        const byId = new Map(site.entries.map((e) => [e.m.id, e.m]));
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 30, 1), 100);
        const list = sync.changes({ kinds: PUBLIC_KINDS, limit: 1000 }).flatMap((c) => {
          const m = byId.get(c.meetingId);
          const pc = m && publicChange(c, m);
          // Meetings listed after the fact (history imports) aren't news.
          if (!pc || (pc.kind === "added" && Date.parse(pc.to ?? "") < Date.parse(pc.at))) return [];
          return [pc];
        });
        return send(res, 200, list.slice(0, limit));
      }
      if (parts[0] === "m" && parts.length === 2 && read) {
        const e = publicSite().find(parts[1]);
        if (!e) return send(res, 404, "not found");
        // The shell is the same for every meeting; its title, description and
        // link-preview / permalink / oEmbed tags are filled in per meeting.
        const when = new Intl.DateTimeFormat("en-CA", { timeZone: o.tz, dateStyle: "long" }).format(new Date(e.m.start));
        const title = `${e.m.title} (${when})`, desc = `${e.m.title}, ${when}: video, transcript and documents.`;
        const b = base(), self = `${b}/m/${encodeURIComponent(e.m.slug)}`;
        const rec = e.rec?.public ? e.rec : undefined;
        const img = b && rec?.files.thumb ? `${b}/media/${encodeURIComponent(rec.slug)}/${encodeURIComponent(rec.files.thumb)}` : "";
        // Structured data (schema.org) so search engines can show the video or the event.
        const isoDur = (s: number) => `PT${s >= 3600 ? `${Math.floor(s / 3600)}H` : ""}${Math.floor((s % 3600) / 60)}M${s % 60}S`;
        const ld = !b ? null : e.p.hasVideo && rec?.video
          ? { "@context": "https://schema.org", "@type": "VideoObject", name: e.m.title, description: desc, uploadDate: e.m.start, inLanguage: "en",
              ...(rec.duration ? { duration: isoDur(rec.duration) } : {}), embedUrl: `${b}/embed/${encodeURIComponent(e.m.slug)}`,
              contentUrl: `${b}/media/${encodeURIComponent(rec.slug)}/${encodeURIComponent(rec.video)}`, ...(img ? { thumbnailUrl: img } : {}) }
          : { "@context": "https://schema.org", "@type": "Event", name: e.m.title, description: desc, startDate: e.m.start, ...(e.m.endEst ? { endDate: e.m.endEst } : {}),
              eventStatus: e.m.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
              eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode", location: { "@type": "VirtualLocation", url: self }, url: self };
        const head = [
          `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="${esc(desc)}">`, `<meta property="og:type" content="video.other">`,
          ...(img ? [`<meta property="og:image" content="${esc(img)}">`, `<meta name="twitter:card" content="summary_large_image">`] : []),
          ...(b ? [`<link rel="canonical" href="${esc(self)}">`, `<meta property="og:url" content="${esc(self)}">`,
            `<link rel="alternate" type="application/json+oembed" href="${esc(`${b}/oembed?format=json&url=${encodeURIComponent(self)}`)}" title="${esc(title)}">`] : []),
          ...(ld ? [`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`] : []),
        ].join("\n");
        const body = pages.meeting.body.replace("__TITLE__", () => esc(title)).replace("__DESC__", () => esc(desc)).replace("__HEAD__", () => head);
        return send(res, 200, body, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": pageCsp(body) });
      }
      if (parts[0] === "embed" && parts.length === 2 && read) {
        // The video on its own, for other sites' iframes (embed.ts). The one page that may be framed.
        const e = publicSite().find(parts[1]);
        if (!e) return send(res, 404, "not found");
        res.removeHeader("X-Frame-Options");
        const body = pages.embed.body.replace("__TITLE__", () => esc(e.m.title)).replace("__SLUG__", () => JSON.stringify(e.m.slug).replace(/</g, "\\u003c"));
        return send(res, 200, body, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": pageCsp(body, frameAncestors) });
      }
      if (parts[0] === "oembed" && parts.length === 1 && read) {
        // oEmbed (JSON): paste a meeting's link into a site that supports it and get the player.
        const m = /^\/(?:m|embed)\/([^/]+)\/?$/.exec((() => { try { return new URL(url.searchParams.get("url") ?? "", "http://x").pathname; } catch { return ""; } })());
        let slug = "";
        try { slug = m ? decodeURIComponent(m[1]) : ""; } catch { /* bad escape */ }
        const e = slug ? publicSite().find(slug) : undefined;
        if (!e) return send(res, 404, { error: "no such meeting" });
        if ((url.searchParams.get("format") ?? "json") !== "json") return send(res, 501, { error: "only format=json" });
        const w = Math.min(Math.max(Number.parseInt(url.searchParams.get("maxwidth") ?? "", 10) || 640, 240), 1920);
        const h = Math.round(w * 9 / 16);
        const b = base();
        return send(res, 200, { version: "1.0", type: "video", provider_name: "minutes", provider_url: b, title: e.m.title, width: w, height: h,
          html: `<iframe src="${esc(`${b}/embed/${encodeURIComponent(e.m.slug)}`)}" width="${w}" height="${h}" frameborder="0" allow="fullscreen" allowfullscreen title="${esc(e.m.title)}"></iframe>` },
          { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
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

      // --- alerts: saved searches that email their owner (alerts.ts) ---
      if (parts[0] === "api" && parts[1] === "account" && parts[2] === "alerts" && parts.length <= 4) {
        if (!allow("alerts.own")) return;
        if (!mailer) return send(res, 503, { error: "email isn't set up on this server, so alerts can't be sent" });
        if (parts.length === 3 && read) return send(res, 200, alerts.list(user!.id).map(publicAlert));
        if (parts.length === 3 && method === "POST") {
          const body = await jsonBody();
          if (!body) return;
          try {
            const a = alerts.create(user!.id, body);
            audit.record(actor, "alert.create", { type: "alert", id: a.id, label: a.query }, null, { query: a.query, body: a.body });
            return send(res, 201, publicAlert(a));
          } catch (e) {
            if (e instanceof AlertError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (parts.length === 4 && method === "DELETE") {
          const a = alerts.get(parts[3]);
          if (!a || a.userId !== user!.id) return send(res, 404, { error: "no such alert" });
          alerts.delete(a.id);
          audit.record(actor, "alert.delete", { type: "alert", id: a.id, label: a.query }, { query: a.query }, null);
          return send(res, 200, { deleted: true });
        }
      }
      // The link in an alert email: a page that asks, and the token is the only credential (no sign-in).
      if (parts[0] === "api" && parts[1] === "alerts" && parts.length === 3) {
        if (parts[2] === "stop" && method === "POST") {
          const body = await jsonBody();
          if (!body) return;
          const a = typeof body.token === "string" ? alerts.byToken(body.token) : undefined;
          if (!a) return send(res, 404, { error: "that alert is already stopped, or the link isn't right" });
          alerts.delete(a.id);
          audit.record({ id: null, label: "email link", ip }, "alert.stop", { type: "alert", id: a.id, label: a.query }, { query: a.query }, null);
          return send(res, 200, { stopped: true, query: a.query });
        }
        if (read && parts[2] !== "stop") {
          const a = alerts.byToken(parts[2]);
          return a ? send(res, 200, { query: a.query, body: a.body }) : send(res, 404, { error: "no such alert" });
        }
      }
      if (read && parts[0] === "alerts" && parts.length === 3 && parts[2] === "stop") {
        const p = pages.stop;
        return send(res, 200, p.body, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": p.csp, "Referrer-Policy": "no-referrer" });
      }

      // --- API tokens and usage: the signed-in user's own (#16, #18) ---
      if (parts[0] === "api" && parts[1] === "account" && parts[2] === "tokens" && parts.length <= 4) {
        if (!allow("tokens.own")) return;
        if (parts.length === 3 && read) return send(res, 200, tokens.list(user!.id).map(publicToken));
        if (parts.length === 3 && method === "POST") {
          const body = await jsonBody();
          if (!body) return;
          try {
            const r = tokens.create(user!.id, body);
            audit.record(actor, "token.create", { type: "token", id: r.record.id, label: `${r.record.prefix} ${r.record.label}` }, null,
              { label: r.record.label, scopes: r.record.scopes, expiresAt: r.record.expiresAt });
            return send(res, 201, { token: r.token, record: publicToken(r.record) });   // the only time it's shown
          } catch (e) {
            if (e instanceof TokenError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (parts.length === 4 && method === "DELETE") {
          const t = tokens.get(parts[3]);
          if (!t || t.userId !== user!.id) return send(res, 404, { error: "no such token" });
          tokens.revoke(t.id);
          audit.record(actor, "token.revoke", { type: "token", id: t.id, label: `${t.prefix} ${t.label}` }, { revoked: false }, { revoked: true });
          return send(res, 200, { revoked: true });
        }
      }
      if (parts[0] === "api" && parts[1] === "account" && parts[2] === "usage" && parts.length === 3 && read) {
        if (!allow("tokens.own")) return;
        return send(res, 200, tokens.usage({ userId: user!.id, days: Number(url.searchParams.get("days") ?? 30) || 30 }));
      }

      // --- accounts ---
      if (parts[0] === "api" && parts[1] === "me" && parts.length === 2 && read) {
        return send(res, 200, { user: user && meOf(user), setupNeeded: accounts.count("admin") === 0, signup: !!mailer });
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
        log.info(`${u.email} signed in from ${ip}`);
        return send(res, 200, { user: meOf(u) }, signIn(u));
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
        return send(res, 200, { user: meOf(accounts.get(user.id)!) });
      }

      // --- sign-up, verification, password reset (#32; need mail) ---
      const mailRoute = parts[0] === "api" && method === "POST" && (
        (parts[1] === "signup" && (parts.length === 2 || (parts.length === 3 && parts[2] === "verify"))) ||
        (parts[1] === "account" && parts[2] === "verify" && (parts.length === 3 || (parts.length === 4 && parts[3] === "resend"))) ||
        (parts[1] === "password" && parts.length === 3 && (parts[2] === "forgot" || parts[2] === "reset")));
      if (mailRoute && !mailer) return send(res, 404, { error: "email isn't set up on this server, so accounts are made by an admin" });
      if (mailRoute) {
        const body = await jsonBody();
        if (!body) return;
        const str = (k: string) => typeof body[k] === "string" ? (body[k] as string) : "";
        const codeWait = () => {
          const w = codeFailsByIp.blockedFor(ip);
          return w > 0 ? send(res, 429, { error: `too many wrong codes; try again in ${Math.ceil(w / 60_000)} min` }, { "Retry-After": String(Math.ceil(w / 1000)) }) : null;
        };
        const sendVerify = (u: User) => mail(u.email, `Your minutes code: ${accounts.issueCode(u.id, "verify")}`,
          `Enter this code to confirm your email for minutes${site ? " (" + site + ")" : ""}. It works for 24 hours.\n\n` +
          "If you didn't sign up, ignore this message: the account is deleted unless it's confirmed within 7 days.");

        if (parts[1] === "signup" && parts.length === 2) {
          const w = signupsByIp.blockedFor(ip);
          if (w > 0) return send(res, 429, { error: `too many sign-ups from here; try again in ${Math.ceil(w / 60_000)} min` });
          signupsByIp.fail(ip);
          const email = checkEmail(str("email"));
          checkNewPassword(body.password);
          const done = () => send(res, 202, { ok: true, email });
          // A bot filled the field people never see: look the same, do nothing.
          if (str("website")) { log.warn(`sign-up honeypot from ${ip}`); return done(); }
          // Same answer whether or not the address has an account; the
          // owner of an existing one gets a note instead of a code.
          const existing = accounts.byEmail(email);
          if (existing) {
            if (!existing.disabledAt && mailsByAccount.blockedFor(existing.email.toLowerCase()) === 0) {
              mailsByAccount.fail(existing.email.toLowerCase());
              void mail(existing.email, "You already have a minutes account",
                "Someone (hopefully you) tried to sign up for minutes with this email, which already has an account. " +
                `Sign in${site ? " at " + site + "/login" : ""}; if you've forgotten the password, use "Forgot password?" there.\n\n` +
                "If it wasn't you, you can ignore this message: nothing changed.");
            }
            return done();
          }
          const u = await accounts.create({ email, name: str("name"), role: "user", password: str("password") });
          audit.record(actor, "user.signup", { type: "user", id: u.id, label: u.email }, null, { role: u.role, name: u.name });
          void sendVerify(u);
          return done();
        }
        if (parts[1] === "signup" && parts[2] === "verify") {
          if (codeWait()) return;
          const u = accounts.byEmail(str("email"));
          if (!u || u.disabledAt || u.emailVerifiedAt || !accounts.useCode(u.id, "verify", body.code)) {
            codeFailsByIp.fail(ip);
            return send(res, 400, { error: "that code is wrong or has expired" });
          }
          accounts.markVerified(u.id);
          audit.record({ ...actor, id: u.id, label: u.email }, "user.verify", { type: "user", id: u.id, label: u.email }, { verified: false }, { verified: true });
          const v = accounts.get(u.id)!;
          return send(res, 200, { user: meOf(v) }, signIn(v));
        }
        if (parts[1] === "account" && parts[2] === "verify") {
          if (!user) return send(res, 401, { error: "sign in first" });
          if (user.emailVerifiedAt) return send(res, 200, { user: meOf(user) });
          if (parts[3] === "resend") {
            const key = user.email.toLowerCase();
            const w = mailsByAccount.blockedFor(key);
            if (w > 0) return send(res, 429, { error: `a code was sent recently; try again in ${Math.ceil(w / 60_000)} min` });
            mailsByAccount.fail(key);
            void sendVerify(user);
            return send(res, 202, { ok: true });
          }
          if (codeWait()) return;
          if (!accounts.useCode(user.id, "verify", body.code)) {
            codeFailsByIp.fail(ip);
            return send(res, 400, { error: "that code is wrong or has expired" });
          }
          accounts.markVerified(user.id);
          audit.record(actor, "user.verify", { type: "user", id: user.id, label: user.email }, { verified: false }, { verified: true });
          return send(res, 200, { user: meOf(accounts.get(user.id)!) });
        }
        if (parts[1] === "password" && parts[2] === "forgot") {
          const email = checkEmail(str("email"));
          // Always the same answer; mail only goes to an account that exists.
          const w = mailsByIp.blockedFor(ip);
          if (w > 0) return send(res, 429, { error: `too many requests from here; try again in ${Math.ceil(w / 60_000)} min` });
          mailsByIp.fail(ip);
          const u = accounts.byEmail(email);
          if (u && !u.disabledAt && mailsByAccount.blockedFor(u.email.toLowerCase()) === 0) {
            mailsByAccount.fail(u.email.toLowerCase());
            void mail(u.email, `Your minutes password reset code: ${accounts.issueCode(u.id, "reset")}`,
              "Enter this code to choose a new password for minutes. It works for 15 minutes, once.\n\n" +
              "If you didn't ask for this, ignore this message: your password hasn't changed.");
          }
          return send(res, 202, { ok: true });
        }
        if (parts[1] === "password" && parts[2] === "reset") {
          if (codeWait()) return;
          const pw = checkNewPassword(body.password);
          const u = accounts.byEmail(str("email"));
          if (!u || u.disabledAt || !accounts.useCode(u.id, "reset", body.code)) {
            codeFailsByIp.fail(ip);
            return send(res, 400, { error: "that code is wrong or has expired" });
          }
          await accounts.setPassword(u.id, pw, { mustChange: false });
          accounts.markVerified(u.id);   // they read mail sent to that address
          failsByAccount.reset(u.email.toLowerCase());
          audit.record({ ...actor, id: u.id, label: u.email }, "account.reset", { type: "user", id: u.id, label: u.email },
            null, { password: "reset by emailed code", sessions: "signed out" });
          log.info(`${u.email} reset their password`);
          return send(res, 200, { ok: true });
        }
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
        if (what === "recordings" && parts.length === 5 && sub === "speakers" && id && SLUG_RE.test(id)) {
          // Who the transcriber's "Speaker N" labels are, added by hand (speakers.ts). Shown to everyone once saved.
          const dir = path.join(o.out, id), tf = path.join(dir, `${id}.transcript.json`);
          if (!existsSync(tf)) return send(res, 404, { error: "that recording has no transcript" });
          let transcript: unknown;
          try { transcript = JSON.parse(readFileSync(tf, "utf8")); } catch { return send(res, 409, { error: "the transcript can't be read right now; try again in a moment" }); }
          const labels = labelsOf(transcript), before = readNames(dir);
          if (read) return send(res, 200, { labels: labels.map((l) => ({ ...l, name: before[l.label] ?? null })), names: before });
          if (method === "PUT") {
            const body = await jsonBody();
            if (!body) return;
            let names;
            try { names = cleanNames(body.names, new Set(labels.map((l) => l.label))); }
            catch (e) { if (e instanceof NamesError) return send(res, 400, { error: e.message }); throw e; }
            writeNames(dir, names);
            audit.record(actor, "speakers.update", { type: "recording", id, label: id }, before, names);
            syncSearch(true);
            return send(res, 200, { names });
          }
        }
        if (what === "feeds") {
          if (parts.length === 3 && read) {
            return send(res, 200, {
              parsers: parsers().map((p) => ({ id: p.id, label: p.label, description: p.description, fields: p.fields })),
              feeds: feeds.list().map(adminFeed),
            });
          }
          if (parts.length === 3 && method === "POST") {
            const body = await jsonBody();
            if (!body) return;
            const f = feeds.create(body);
            audit.record(actor, "feed.create", { type: "feed", id: f.id, label: f.name }, null, feedSnap(f));
            return send(res, 201, adminFeed(f));
          }
          if (id === "preview" && parts.length === 4 && method === "POST") {
            const body = await jsonBody();
            if (!body) return;
            const parser = typeof body.parser === "string" ? parserById(body.parser) : undefined;
            if (!parser) return send(res, 400, { error: "unknown parser" });
            let config: Record<string, unknown>;
            try { config = parser.validate(body.config ?? {}); }
            catch (e) { return send(res, 400, { error: e instanceof ConfigError ? e.message : String(e) }); }
            const feed = typeof body.feedId === "string" ? feeds.get(body.feedId) ?? null : null;
            try {
              return send(res, 200, await poller.preview({ parser: parser.id, config }, feed));
            } catch (e) {
              if (e instanceof FeedError) throw e;
              return send(res, 502, { error: `fetching the feed failed: ${(e as Error).message}`.slice(0, 500) });
            }
          }
          const f = id ? feeds.get(id) : undefined;
          if (!f) return send(res, 404, { error: "no such feed" });
          if (parts.length === 4 && method === "PATCH") {
            const body = await jsonBody();
            if (!body) return;
            const g = feeds.update(f.id, body);
            audit.record(actor, "feed.update", { type: "feed", id: f.id, label: g.name }, feedSnap(f), feedSnap(g));
            return send(res, 200, adminFeed(g));
          }
          if (parts.length === 4 && method === "DELETE") {
            if (poller.isRunning(f.id)) return send(res, 409, { error: "a run is in progress; try again shortly" });
            feeds.delete(f.id);
            audit.record(actor, "feed.delete", { type: "feed", id: f.id, label: f.name }, feedSnap(f), null);
            return send(res, 200, { ok: true });
          }
          if (parts.length === 5 && sub === "run" && method === "POST") {
            audit.record(actor, "feed.run", { type: "feed", id: f.id, label: f.name }, null, { trigger: "manual" });
            const out = await poller.run(f.id, "manual");
            return send(res, 200, { outcome: out, feed: adminFeed(feeds.get(f.id)!) });
          }
          if (parts.length === 5 && sub === "runs" && read) return send(res, 200, feeds.runs(f.id, 50));
          if (parts.length === 5 && sub === "changes" && read) return send(res, 200, sync.changes({ feedId: f.id, limit: 200 }));
        }
        if (what === "meetings") {
          if (parts.length === 3 && read) {
            const view = url.searchParams.get("view") ?? "upcoming";
            const now = Date.now(), all = sched.meetings.list();
            const list = view === "review" ? all.filter((m) => m.review === "pending" && m.status !== "cancelled" && Date.parse(m.start) > now - 3_600_000)
              : view === "recent" ? all.filter((m) => Date.parse(m.start) <= now).slice(-50).reverse()
              : all.filter((m) => Date.parse(m.start) > now - 3_600_000);
            return send(res, 200, list.map(adminMeeting));
          }
          const m = id ? sched.meetings.get(id) : undefined;
          if (!m) return send(res, 404, { error: "no such meeting" });
          if (parts.length === 5 && sub === "changes" && read) return send(res, 200, sync.changes({ meetingId: m.id }));
          if (parts.length === 5 && method === "POST" && ["approve", "reject", "merge", "split", "hide", "show"].includes(sub)) {
            const body = await jsonBody();
            if (!body) return;
            let r: { meeting: Meeting; effect: string };
            try {
              if (sub === "hide" || sub === "show") {
                // The admin-only override: a hidden meeting's page, listing and files all 404.
                const was = m.visibility;
                m.visibility = sub === "hide" ? "hidden" : "public";
                sched.meetings.save(m);
                audit.record(actor, `meeting.${sub}`, { type: "meeting", id: m.id, label: m.slug }, { visibility: was }, { visibility: m.visibility });
                return send(res, 200, { meeting: adminMeeting(m), effect: sub === "hide" ? "hidden from the public site" : "shown on the public site" });
              }
              if (sub === "approve" || sub === "reject") r = sync.review(m.id, sub === "approve" ? "approved" : "rejected");
              else if (sub === "merge") r = sync.merge(m.id, String(body.into ?? ""));
              else r = sync.split(m.id, m.feedId ? feeds.get(m.feedId) : undefined);
            } catch (e) {
              if (e instanceof BadRequest) throw e;
              return send(res, 409, { error: (e as Error).message });
            }
            audit.record(actor, `meeting.${sub}`, { type: "meeting", id: m.id, label: m.slug }, null, { effect: r.effect,
              ...(sub === "merge" ? { into: r.meeting.duplicateOf } : {}) });
            return send(res, 200, { meeting: adminMeeting(r.meeting), effect: r.effect });
          }
        }
        if (what === "tokens") {
          if (parts.length === 3 && read) {
            return send(res, 200, tokens.list().map((t) => ({ ...publicToken(t), userId: t.userId, userEmail: accounts.get(t.userId)?.email ?? "(deleted)" })));
          }
          if (parts.length === 4 && method === "PATCH") {
            // A per-token download speed cap (#36): {downloadBps: bytes/second, 0 = the default}.
            const t = id ? tokens.get(id) : undefined;
            if (!t) return send(res, 404, { error: "no such token" });
            const body = await jsonBody();
            if (!body) return;
            try {
              const bps = body.downloadBps === null ? 0 : Number(body.downloadBps);
              if (body.downloadBps === undefined || !Number.isFinite(bps)) return send(res, 400, { error: "send {downloadBps: bytes per second, or 0 for the default}" });
              tokens.setDownloadLimit(t.id, bps);
            } catch (e) {
              if (e instanceof TokenError) return send(res, e.status, { error: e.message });
              throw e;
            }
            const after = tokens.get(t.id)!;
            audit.record(actor, "token.limit", { type: "token", id: t.id, label: `${t.prefix} ${t.label}` }, { downloadBps: t.limits?.downloadBps ?? null }, { downloadBps: after.limits?.downloadBps ?? null });
            return send(res, 200, { ...publicToken(after), userId: after.userId });
          }
          if (parts.length === 4 && method === "DELETE") {
            const t = id ? tokens.get(id) : undefined;
            if (!t) return send(res, 404, { error: "no such token" });
            tokens.revoke(t.id);
            audit.record(actor, "token.revoke", { type: "token", id: t.id, label: `${t.prefix} ${t.label} (${accounts.get(t.userId)?.email ?? "?"})` }, { revoked: false }, { revoked: true });
            return send(res, 200, { revoked: true });
          }
        }
        if (what === "usage" && parts.length === 3 && read) {
          return send(res, 200, tokens.usage({ userId: url.searchParams.get("user") || undefined, days: Number(url.searchParams.get("days") ?? 30) || 30 }));
        }
        if (what === "users") {
          if (parts.length === 3 && read) return send(res, 200, accounts.list().map((u) => ({ ...adminUser(u), self: u.id === user!.id })));
          if (parts.length === 4 && method === "PATCH") {
            const u = id ? accounts.get(id) : undefined;
            if (!u) return send(res, 404, { error: "no such user" });
            const body = await jsonBody();
            if (!body) return;
            if (body.role !== undefined && typeof body.role !== "string") return send(res, 400, { error: "role must be a string" });
            if (body.disabled !== undefined && typeof body.disabled !== "boolean") return send(res, 400, { error: "disabled must be true or false" });
            if (u.id === user!.id && (body.disabled === true || (body.role !== undefined && body.role !== u.role))) {
              return send(res, 409, { error: "you can't disable or demote yourself here; use the CLI or another admin" });
            }
            const before = { role: u.role, disabled: !!u.disabledAt };
            if (typeof body.role === "string") accounts.setRole(u.email, body.role);
            if (typeof body.disabled === "boolean") accounts.setDisabled(u.email, body.disabled);
            const after = accounts.get(u.id)!;
            audit.record(actor, "user.update", { type: "user", id: u.id, label: u.email }, before, { role: after.role, disabled: !!after.disabledAt });
            return send(res, 200, adminUser(after));
          }
        }
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
      if (e instanceof BadRequest || e instanceof AccountError || e instanceof FeedError) return send(res, e.status, { error: e.message });
      log.error("request failed", e);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });

  return {
    server, accounts, sched, audit, tokens, search, syncSearch, syncThumbs, alerts, processAlerts,
    async close() {
      server.close();
      server.closeAllConnections();
      clearInterval(pruneTimer);
      closed = true;
      clearInterval(searchTimer);
      clearInterval(thumbTimer);
      keeper.stop();
      backups?.stop();
      poller.stop();
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
