/**
 * Scheduler behind the web interface.
 *
 * Each submitted meeting is a Job, persisted in the `jobs` table of
 * <out>/minutes.db (src/db.ts); the old <out>/jobs.json is imported once and
 * kept as jobs.json.migrated. Running and stopping captures are also written
 * to <out>/active.json (atomic tmp + rename) for the transcriber, which
 * doesn't open the database. Shortly before the job's start time the
 * scheduler launches the normal CLI capture as a child process, so the
 * runner's recovery logic is exactly what's been tested live.
 *
 * Every running capture gets its own Xvfb display and its own PulseAudio
 * null sink (zoom_<n>), passed to the child as DISPLAY / CAPTURE_SINK /
 * PULSE_SINK, so overlapping meetings don't share a screen or mix audio.
 * The default PulseAudio *source* is never touched: it stays
 * silence.monitor (see entrypoint.sh), so nothing reaches any meeting.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tx, type DB } from "./db.js";
import path from "node:path";
import { promisify } from "node:util";
import { SLUG_RE, TIMEOUT, defaultSlug, logger, withTimeout } from "./util.js";

const log = logger("jobs");
const execFileP = promisify(execFile);

export type JobStatus =
  | "scheduled"   // waiting for its launch time
  | "queued"      // launch time passed, waiting for a free slot
  | "running"
  | "stopping"    // SIGTERM sent, closing the part and stitching
  | "done"        // capture exited 0 (a stitched video exists)
  | "failed"      // capture exited non-zero on its own
  | "stopped"     // stopped from the web UI before anything was stitched
  | "cancelled"   // cancelled before it launched
  | "interrupted"; // the server went away while it was running

export interface Job {
  id: string;
  link: string;
  start: string;        // ISO, UTC
  slug: string;
  name: string;
  email?: string;       // typed only if the host requires one; never sent to the browser
  status: JobStatus;
  createdAt: string;
  launchedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  outcome?: string;     // runner outcome from manifest.json
  error?: string;
}

export interface NewJob { link?: unknown; start?: unknown; slug?: unknown; name?: unknown; email?: unknown; clearEmail?: unknown }

export interface SchedulerOpts {
  out: string;
  entry: string;          // absolute path to dist/index.js
  auth: string | null;
  defaultName: string;
  leadMs: number;         // child joins this early (passed as --lead-min)
  noShowMs: number;       // reject starts further in the past than this
  maxConcurrent: number;
  width: number;
  height: number;
}

interface Running {
  proc: ChildProcess;
  display: number;
  xvfb: ChildProcess;
  sinkModule: string | null;
  exited: Promise<void>;
  stopRequested: boolean;
}

export class BadRequest extends Error {
  constructor(msg: string, readonly status = 400) { super(msg); }
}

/** Zoom invite link or bare meeting ID. Anything else is refused, so the
 *  web form can't be used to point the signed-in browser at arbitrary sites. */
function checkLink(link: string): string {
  const s = link.trim();
  if (/^[\d\s-]{9,15}$/.test(s) && s.replace(/\D/g, "").length >= 9) return s.replace(/[\s-]/g, "");
  let u: URL;
  try { u = new URL(s); } catch { throw new BadRequest("link must be a Zoom invite URL or a meeting ID"); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !(host === "zoom.us" || host.endsWith(".zoom.us"))) {
    throw new BadRequest("link must be an https://...zoom.us/ URL");
  }
  if (!/\/(j|w|wc\/join|wc)\/\d{9,12}/.test(u.pathname)) throw new BadRequest("couldn't find a meeting ID in that link");
  return u.toString();
}

export class Scheduler {
  private jobs: Job[] = [];
  private running = new Map<string, Running>();
  private launching = new Set<string>();
  private activeFile: string;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private o: SchedulerOpts, private db: DB) {
    mkdirSync(o.out, { recursive: true });
    this.activeFile = path.join(o.out, "active.json");
    importJobsJson(db, o.out);
    this.jobs = (db.prepare("SELECT * FROM jobs ORDER BY created_at, rowid").all() as unknown as JobRow[]).map(fromRow);
    // A capture that was running when the server died is gone with it.
    // Don't relaunch into the same folder: part numbering would restart
    // at 1 and overwrite what's there.
    const lost = this.jobs.filter((j) => j.status === "running" || j.status === "stopping");
    for (const j of lost) {
      j.status = "interrupted";
      j.endedAt ??= new Date().toISOString();
      j.error = "the server stopped while this capture was running";
    }
    this.save(...lost);
  }

  /** Write these jobs to the database (one transaction), then refresh
   *  active.json. Call after every change to a job. */
  private save(...jobs: Job[]): void {
    if (jobs.length) {
      const st = this.db.prepare(UPSERT);
      tx(this.db, () => { for (const j of jobs) st.run(toRow(j)); });
    }
    const active = this.jobs.filter((j) => j.status === "running" || j.status === "stopping")
      .map((j) => ({ id: j.id, slug: j.slug, status: j.status }));
    const tmp = `${this.activeFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(active, null, 1));
    renameSync(tmp, this.activeFile);
  }

  list(): Job[] { return this.jobs.map((j) => ({ ...j })); }
  get(id: string): Job | undefined { return this.jobs.find((j) => j.id === id); }
  displayOf(id: string): string | null {
    const r = this.running.get(id);
    return r ? `:${r.display}` : null;
  }
  isActive(slug: string): boolean {
    return this.jobs.some((j) => j.slug === slug && ["scheduled", "queued", "running", "stopping"].includes(j.status));
  }

  private parseStart(v: string): Date {
    // A bare "2026-11-16T19:00" is local time in the server's TZ, same as the CLI.
    const start = new Date(v.trim());
    if (Number.isNaN(start.getTime())) throw new BadRequest(`can't parse start time: ${v}`);
    if (start.getTime() < Date.now() - this.o.noShowMs) throw new BadRequest("that start time is too far in the past");
    return start;
  }

  private checkSlug(slug: string, selfId?: string): string {
    if (!SLUG_RE.test(slug)) throw new BadRequest("name must be letters, digits, '.', '_' or '-' (max 80)");
    if (this.jobs.some((j) => j.id !== selfId && j.slug === slug && j.status !== "cancelled") ||
        existsSync(path.join(this.o.out, slug))) {
      throw new BadRequest(`a capture named "${slug}" already exists`, 409);
    }
    return slug;
  }

  private static cleanName(v: string): string {
    return v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  }

  private static given(v: unknown): v is string { return typeof v === "string" && v.trim() !== ""; }

  private static checkEmail(v: string): string {
    const e = v.trim();
    if (e.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) throw new BadRequest("that email address doesn't look right");
    return e;
  }

  add(input: NewJob): Job {
    if (!Scheduler.given(input.link)) throw new BadRequest("link is required");
    const link = checkLink(input.link);
    if (!Scheduler.given(input.start)) throw new BadRequest("start is required");
    const start = this.parseStart(input.start);
    const slug = this.checkSlug(Scheduler.given(input.slug) ? input.slug.trim() : defaultSlug(start));
    const name = Scheduler.given(input.name) ? Scheduler.cleanName(input.name) || this.o.defaultName : this.o.defaultName;
    const email = Scheduler.given(input.email) ? Scheduler.checkEmail(input.email) : undefined;

    const job: Job = {
      id: randomUUID(), link, start: start.toISOString(), slug, name,
      ...(email ? { email } : {}),
      status: "scheduled", createdAt: new Date().toISOString(),
    };
    this.jobs.push(job);
    this.save(job);
    log.info(`scheduled ${slug} for ${job.start}`);
    void this.tick();
    return { ...job };
  }

  /** Edit a job that hasn't launched. Fields left out or blank keep their
   *  current value (the link is never sent to the browser, so a blank link
   *  must mean "unchanged"). All fields are checked before any is applied. */
  update(id: string, input: NewJob): Job {
    const j = this.get(id);
    if (!j) throw new BadRequest("no such job", 404);
    if ((j.status !== "scheduled" && j.status !== "queued") || this.launching.has(id)) {
      throw new BadRequest(`only scheduled captures can be edited (this one is ${this.launching.has(id) ? "starting" : j.status})`, 409);
    }
    const link = Scheduler.given(input.link) ? checkLink(input.link) : j.link;
    const start = Scheduler.given(input.start) ? this.parseStart(input.start).toISOString() : j.start;
    const slug = Scheduler.given(input.slug) && input.slug.trim() !== j.slug ? this.checkSlug(input.slug.trim(), id) : j.slug;
    const name = Scheduler.given(input.name) ? Scheduler.cleanName(input.name) || j.name : j.name;
    // Like the link, the email never reaches the page: blank keeps it,
    // clearEmail removes it.
    const email = Scheduler.given(input.email) ? Scheduler.checkEmail(input.email)
      : input.clearEmail === true ? undefined : j.email;
    const changed = [link !== j.link && "link", start !== j.start && "start", slug !== j.slug && "slug", name !== j.name && "name",
      email !== j.email && "email"].filter(Boolean);
    Object.assign(j, { link, start, slug, name });
    if (email) j.email = email; else delete j.email;
    // A queued job that moved later goes back to waiting for its time.
    if (j.status === "queued") j.status = "scheduled";
    this.save(j);
    log.info(`edited ${j.slug}: ${changed.join(", ") || "no changes"}`);
    void this.tick();
    return { ...j };
  }

  /** Cancel a job that hasn't launched, or stop one that's running (the
   *  capture closes its part and stitches what it has, like docker stop). */
  cancel(id: string): Job {
    const j = this.get(id);
    if (!j) throw new BadRequest("no such job", 404);
    if (j.status === "scheduled" || j.status === "queued") {
      j.status = "cancelled";
      j.endedAt = new Date().toISOString();
      this.save(j);
    } else if (j.status === "running") {
      const r = this.running.get(id);
      if (r) {
        r.stopRequested = true;
        r.proc.kill("SIGTERM");
      }
      j.status = "stopping";
      this.save(j);
    } else if (j.status !== "stopping") {
      throw new BadRequest(`job is already ${j.status}`, 409);
    }
    return { ...j };
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  /** SIGTERM every running capture and wait for them to stitch. */
  async shutdown(timeoutMs = 120_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const all = [...this.running.values()];
    for (const r of all) { r.stopRequested = true; r.proc.kill("SIGTERM"); }
    const stopping = this.jobs.filter((j) => j.status === "running");
    for (const j of stopping) j.status = "stopping";
    this.save(...stopping);
    if ((await withTimeout(Promise.all(all.map((r) => r.exited)), timeoutMs)) === TIMEOUT) {
      log.warn("captures didn't finish stitching in time");
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const due = this.jobs
        .filter((j) => (j.status === "scheduled" || j.status === "queued") &&
          new Date(j.start).getTime() - this.o.leadMs - 60_000 <= now)
        .sort((a, b) => a.start.localeCompare(b.start));
      for (const j of due) {
        if (this.running.size >= this.o.maxConcurrent) {
          if (j.status !== "queued") {
            j.status = "queued";
            log.warn(`${j.slug} is due but ${this.running.size} capture(s) are already running`);
            this.save(j);
          }
          continue;
        }
        await this.launch(j);
      }
    } finally {
      this.ticking = false;
    }
  }

  private freeDisplay(): number {
    const used = new Set([...this.running.values()].map((r) => r.display));
    let n = 100;
    while (used.has(n) || existsSync(`/tmp/.X${n}-lock`)) n++;
    return n;
  }

  private async launch(j: Job): Promise<void> {
    // Status only becomes "running" after the awaits below; block edits
    // (slug, link) in between so the child gets what was set up for it.
    this.launching.add(j.id);
    try { await this.launchInner(j); } finally { this.launching.delete(j.id); }
  }

  private async launchInner(j: Job): Promise<void> {
    const n = this.freeDisplay();
    const display = `:${n}`;
    const sink = `zoom_${n}`;
    const dir = path.join(this.o.out, j.slug);
    mkdirSync(dir, { recursive: true });
    const capLog = createWriteStream(path.join(dir, "capture.log"), { flags: "a" });

    let xvfb: ChildProcess | undefined;
    let sinkModule: string | null = null;
    try {
      xvfb = spawn("Xvfb", [display, "-screen", "0", `${this.o.width}x${this.o.height}x24`, "-nolisten", "tcp"],
        { stdio: "ignore" });
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        up = await execFileP("xdpyinfo", ["-display", display]).then(() => true, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      if (!up) throw new Error(`Xvfb ${display} didn't start`);

      const { stdout } = await execFileP("pactl", ["load-module", "module-null-sink",
        `sink_name=${sink}`, `sink_properties=device.description=${sink}`]);
      sinkModule = stdout.trim() || null;
    } catch (e) {
      xvfb?.kill();
      j.status = "failed";
      j.error = `couldn't set up display/audio: ${String(e).slice(0, 200)}`;
      j.endedAt = new Date().toISOString();
      this.save(j);
      log.error(`${j.slug}: ${j.error}`);
      capLog.end();
      return;
    }

    const args = [
      this.o.entry,
      "--link", j.link, "--start", j.start, "--slug", j.slug, "--name", j.name,
      "--out", this.o.out, "--lead-min", String(this.o.leadMs / 60_000),
      ...(this.o.auth ? ["--auth", this.o.auth] : []),
    ];
    const proc = spawn(process.execPath, args, {
      // The job's own email overrides the server-wide CAPTURE_EMAIL.
      env: { ...process.env, DISPLAY: display, CAPTURE_SINK: sink, PULSE_SINK: sink,
             ...(j.email ? { CAPTURE_EMAIL: j.email } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.pipe(capLog, { end: false });
    proc.stderr?.pipe(capLog, { end: false });

    const run: Running = { proc, display: n, xvfb, sinkModule, stopRequested: false, exited: Promise.resolve() };
    // Seen 2026-11-09 (twice): the VM ran out of memory and the kernel
    // killed the job's Xvfb mid-meeting, taking Chromium with it; the
    // runner's rejoin then failed with "Missing X server" until the display
    // came back. Bring it straight back on the same display: the runner's
    // next session (and ffmpeg's next part) pick it up.
    const keepDisplay = (x: ChildProcess) => {
      x.once("exit", (code, signal) => {
        if (this.running.get(j.id) !== run || run.stopRequested) return;
        log.error(`${j.slug}: Xvfb ${display} exited on its own (code ${code}, signal ${signal}); restarting it`);
        capLog.write(`${new Date().toISOString()} ERROR jobs     Xvfb ${display} died (code ${code}, signal ${signal}); restarting it\n`);
        setTimeout(() => {
          if (this.running.get(j.id) !== run) return;
          run.xvfb = spawn("Xvfb", [display, "-screen", "0", `${this.o.width}x${this.o.height}x24`, "-nolisten", "tcp"],
            { stdio: "ignore" });
          keepDisplay(run.xvfb);
        }, 500);
      });
    };
    keepDisplay(xvfb);
    run.exited = new Promise<void>((resolve) => {
      proc.once("exit", async (code, signal) => {
        this.running.delete(j.id);
        run.xvfb.kill();
        if (sinkModule) await execFileP("pactl", ["unload-module", sinkModule]).catch(() => {});
        capLog.end();
        j.exitCode = code ?? null;
        j.endedAt = new Date().toISOString();
        j.outcome = readOutcome(dir);
        j.status = code === 0 ? "done" : run.stopRequested ? "stopped" : "failed";
        if (j.status === "failed" && !j.error) j.error = signal ? `capture killed by ${signal}` : `capture exited ${code}`;
        this.save(j);
        log.info(`${j.slug} finished: ${j.status} (outcome ${j.outcome ?? "?"})`);
        resolve();
        void this.tick(); // a queued job may be waiting for this slot
      });
    });
    this.running.set(j.id, run);

    j.status = "running";
    j.launchedAt = new Date().toISOString();
    delete j.error;
    this.save(j);
    log.info(`launched ${j.slug} on display ${display}, sink ${sink}`);
  }
}

function readOutcome(dir: string): string | undefined {
  try { return JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).outcome; } catch { return undefined; }
}

// --- database rows ---------------------------------------------------------

type JobRow = {
  id: string; link: string; start: string; slug: string; name: string; email: string | null;
  status: string; created_at: string; launched_at: string | null; ended_at: string | null;
  exit_code: number | null; outcome: string | null; error: string | null;
};

const UPSERT = `INSERT INTO jobs (id, link, start, slug, name, email, status, created_at, launched_at, ended_at, exit_code, outcome, error)
  VALUES (:id, :link, :start, :slug, :name, :email, :status, :created_at, :launched_at, :ended_at, :exit_code, :outcome, :error)
  ON CONFLICT (id) DO UPDATE SET link = excluded.link, start = excluded.start, slug = excluded.slug, name = excluded.name,
    email = excluded.email, status = excluded.status, launched_at = excluded.launched_at, ended_at = excluded.ended_at,
    exit_code = excluded.exit_code, outcome = excluded.outcome, error = excluded.error`;

function toRow(j: Job): JobRow {
  return {
    id: j.id, link: j.link, start: j.start, slug: j.slug, name: j.name, email: j.email ?? null,
    status: j.status, created_at: j.createdAt, launched_at: j.launchedAt ?? null, ended_at: j.endedAt ?? null,
    exit_code: j.exitCode === undefined ? null : j.exitCode, outcome: j.outcome ?? null, error: j.error ?? null,
  };
}

/** Optional fields stay absent (not null) so the API's JSON is unchanged.
 *  exitCode keeps null once the job has ended (killed by a signal). */
function fromRow(r: JobRow): Job {
  const j: Job = { id: r.id, link: r.link, start: r.start, slug: r.slug, name: r.name,
    status: r.status as JobStatus, createdAt: r.created_at };
  if (r.email !== null) j.email = r.email;
  if (r.launched_at !== null) j.launchedAt = r.launched_at;
  if (r.ended_at !== null) j.endedAt = r.ended_at;
  if (r.exit_code !== null || r.ended_at !== null && r.launched_at !== null) j.exitCode = r.exit_code;
  if (r.outcome !== null) j.outcome = r.outcome;
  if (r.error !== null) j.error = r.error;
  return j;
}

/** First start on the database: bring over <out>/jobs.json once, then
 *  rename it so it's never imported twice (and stays as a backup). */
function importJobsJson(db: DB, out: string): void {
  const file = path.join(out, "jobs.json");
  if (!existsSync(file)) return;
  let jobs: Job[];
  try {
    jobs = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(jobs)) throw new Error("not a list");
  } catch (e) {
    log.error("jobs.json is unreadable; not importing it (left in place)", e);
    return;
  }
  const st = db.prepare(UPSERT);
  tx(db, () => {
    for (const j of jobs) {
      if (!j || typeof j.id !== "string" || typeof j.slug !== "string") continue;
      st.run(toRow(j));
    }
  });
  renameSync(file, `${file}.migrated`);
  log.info(`imported ${jobs.length} job(s) from jobs.json (kept as jobs.json.migrated)`);
}
