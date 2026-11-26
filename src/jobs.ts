/**
 * Scheduler behind the web interface.
 *
 * Each capture attempt is a Job, an attempt to record one Meeting
 * (src/meetings.ts; scheduling by hand creates both). Jobs are in the `jobs` table of
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
import { Meetings, type Meeting } from "./meetings.js";
import { checkLink as checkPlatformLink, platformFor } from "./platforms/registry.js";
import type { CaptureMethod } from "./platforms/types.js";
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
  meetingRef: string;
  link: string;         // copied from the meeting until the job launches
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

/** What happened to a capture, for whoever wants to tell the operator (ops.ts). */
export type JobEvent = { kind: "started" | "finished" | "overdue"; job: Job };

export interface NewJob { link?: unknown; start?: unknown; slug?: unknown; name?: unknown; email?: unknown; clearEmail?: unknown }

/** A capture still not started this long after its meeting's start is worth a message. */
const OVERDUE_MS = 10 * 60_000;

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
  display: number | null;      // null for stream jobs: no Xvfb, no sink
  xvfb: ChildProcess | null;
  sinkModule: string | null;
  exited: Promise<void>;
  stopRequested: boolean;
}

export class BadRequest extends Error {
  constructor(msg: string, readonly status = 400) { super(msg); }
}

/** A link some platform handles, in its canonical form. Anything else is
 *  refused, so the web form can't point the signed-in browser at arbitrary
 *  sites. */
function checkLink(link: string): { platform: string; link: string } {
  try {
    const r = checkPlatformLink(link);
    return { platform: r.platform.id, link: r.link };
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
}

export class Scheduler {
  private jobs: Job[] = [];
  readonly meetings: Meetings;
  private running = new Map<string, Running>();
  private launching = new Set<string>();
  private activeFile: string;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Called for a capture starting, finishing, or not starting when it should have. Must not throw (errors are logged). */
  onEvent: (e: JobEvent) => void = () => {};
  private overdueSeen = new Set<string>();
  private emit(kind: JobEvent["kind"], j: Job): void {
    try { this.onEvent({ kind, job: { ...j } }); } catch (e) { log.warn(`job event ${kind} for ${j.slug} failed`, e); }
  }

  constructor(private o: SchedulerOpts, private db: DB) {
    mkdirSync(o.out, { recursive: true });
    this.activeFile = path.join(o.out, "active.json");
    this.meetings = new Meetings(db);
    importJobsJson(db, o.out);
    this.jobs = (db.prepare("SELECT * FROM jobs ORDER BY created_at, rowid").all() as unknown as JobRow[]).map(fromRow);
    // Jobs from jobs.json (imported after the migrations ran) have no
    // meeting yet: each becomes the only attempt of its own meeting.
    const orphans = this.jobs.filter((j) => !j.meetingRef);
    if (orphans.length) {
      tx(db, () => {
        for (const j of orphans) {
          j.meetingRef = this.meetings.create({ title: j.slug, platform: platformFor(j.link)?.id ?? "zoom", link: j.link, start: j.start, slug: j.slug },
            j.createdAt).id;
        }
        this.save(...orphans);
      });
    }
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
    this.writeActive();
  }

  private writeActive(): void {
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
    return r && r.display !== null ? `:${r.display}` : null;
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
    const { platform, link } = checkLink(input.link);
    if (!Scheduler.given(input.start)) throw new BadRequest("start is required");
    const start = this.parseStart(input.start);
    const slug = this.checkSlug(Scheduler.given(input.slug) ? input.slug.trim() : defaultSlug(start));
    const name = Scheduler.given(input.name) ? Scheduler.cleanName(input.name) || this.o.defaultName : this.o.defaultName;
    const email = Scheduler.given(input.email) ? Scheduler.checkEmail(input.email) : undefined;

    const createdAt = new Date().toISOString();
    const job = tx(this.db, () => {
      const m = this.meetings.create({ title: slug, platform, link, start: start.toISOString(), slug }, createdAt);
      const job: Job = {
        id: randomUUID(), meetingRef: m.id, link, start: m.start, slug, name,
        ...(email ? { email } : {}),
        status: "scheduled", createdAt,
      };
      this.save(job);
      return job;
    });
    this.jobs.push(job);
    this.writeActive();
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
    const m0 = this.meetings.get(j.meetingRef);
    const newLink = Scheduler.given(input.link) ? checkLink(input.link) : null;
    if (newLink && m0 && newLink.platform !== m0.platform) throw new BadRequest(`that's a ${newLink.platform} link; this meeting is on ${m0.platform}`);
    const link = newLink ? newLink.link : j.link;
    const start = Scheduler.given(input.start) ? this.parseStart(input.start).toISOString() : j.start;
    const slug = Scheduler.given(input.slug) && input.slug.trim() !== j.slug ? this.checkSlug(input.slug.trim(), id) : j.slug;
    const name = Scheduler.given(input.name) ? Scheduler.cleanName(input.name) || j.name : j.name;
    // Like the link, the email never reaches the page: blank keeps it,
    // clearEmail removes it.
    const email = Scheduler.given(input.email) ? Scheduler.checkEmail(input.email)
      : input.clearEmail === true ? undefined : j.email;
    const changed = [link !== j.link && "link", start !== j.start && "start", slug !== j.slug && "slug", name !== j.name && "name",
      email !== j.email && "email"].filter(Boolean);
    tx(this.db, () => {
      // Link and start belong to the meeting; updateMeeting copies them to
      // this job and to any other attempt that hasn't launched.
      const m = this.meetings.get(j.meetingRef);
      if (m && m.slug === j.slug && slug !== j.slug) { m.slug = slug; if (m.title === j.slug) m.title = slug; this.meetings.save(m); }
      Object.assign(j, { slug, name });
      if (email) j.email = email; else delete j.email;
      this.save(j);
      if (link !== j.link || start !== j.start) this.updateMeeting(j.meetingRef, { link, start });
    });
    log.info(`edited ${j.slug}: ${changed.join(", ") || "no changes"}`);
    void this.tick();
    return { ...j };
  }

  /** Change a meeting's details. A new start or link is copied to every
   *  attempt that hasn't launched (a queued one goes back to waiting for its
   *  time); launched attempts keep what they started with. */
  updateMeeting(id: string, ch: Partial<Pick<Meeting, "link" | "start" | "title" | "body" | "endEst" | "agendaUrl">>): Meeting {
    const m = this.meetings.get(id);
    if (!m) throw new BadRequest("no such meeting", 404);
    return tx(this.db, () => {
      Object.assign(m, Object.fromEntries(Object.entries(ch).filter(([, v]) => v !== undefined)));
      if (ch.link !== undefined) m.platform = platformFor(m.link)?.id ?? "";
      this.meetings.save(m);
      const pending = this.jobs.filter((j) => j.meetingRef === id && (j.status === "scheduled" || j.status === "queued") &&
        !this.launching.has(j.id) && (j.link !== m.link || j.start !== m.start));
      for (const j of pending) {
        j.link = m.link;
        j.start = m.start;
        if (j.status === "queued") j.status = "scheduled";
      }
      this.save(...pending);
      return m;
    });
  }

  /** Another attempt at the same meeting, e.g. after a failed or stopped
   *  one. Starts at the meeting's time, or now if that has passed; gets its
   *  own folder (<meeting slug>-2, -3, ...) so nothing is overwritten. */
  retry(jobId: string): Job {
    const prev = this.get(jobId);
    if (!prev) throw new BadRequest("no such job", 404);
    if (["scheduled", "queued", "running", "stopping"].includes(prev.status) || this.launching.has(jobId)) {
      throw new BadRequest(`this capture is ${this.launching.has(jobId) ? "starting" : prev.status}; only a finished one can be tried again`, 409);
    }
    const m = this.meetings.get(prev.meetingRef);
    if (!m) throw new BadRequest("this capture has no meeting", 409);
    const other = this.jobs.find((j) => j.meetingRef === m.id && ["scheduled", "queued", "running", "stopping"].includes(j.status));
    if (other) throw new BadRequest(`${other.slug} is already ${other.status} for this meeting`, 409);
    let n = 2, slug = `${m.slug}-${n}`;
    const taken = (s: string) => this.jobs.some((j) => j.slug === s) || existsSync(path.join(this.o.out, s));
    while (taken(slug)) slug = `${m.slug}-${++n}`;
    if (!SLUG_RE.test(slug)) throw new BadRequest("couldn't make a folder name for another attempt", 409);
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(), meetingRef: m.id, link: m.link, start: m.start > now ? m.start : now, slug, name: prev.name,
      ...(prev.email ? { email: prev.email } : {}),
      status: "scheduled", createdAt: now,
    };
    this.save(job);
    this.jobs.push(job);
    this.writeActive();
    log.info(`another attempt at ${m.slug}: ${slug} for ${job.start}`);
    void this.tick();
    return { ...job };
  }

  /** The meeting's capture that's scheduled, queued, running or stopping. */
  activeJobFor(meetingId: string): Job | undefined {
    return this.jobs.find((j) => j.meetingRef === meetingId && ["scheduled", "queued", "running", "stopping"].includes(j.status));
  }

  /** A capture for an existing meeting (from a feed, or approved from the
   *  review queue). Its folder is the meeting's slug, or slug-2, -3, ... if
   *  that's taken. Refused without a link, when the meeting is already
   *  being captured, or when its start is too far in the past. */
  scheduleMeeting(meetingId: string, name = this.o.defaultName): Job {
    const m = this.meetings.get(meetingId);
    if (!m) throw new BadRequest("no such meeting", 404);
    if (!m.link) throw new BadRequest("this meeting has no supported link yet", 409);
    if (m.status === "cancelled") throw new BadRequest("this meeting is cancelled", 409);
    if (m.duplicateOf) throw new BadRequest("this meeting is a duplicate; capture the other one", 409);
    const other = this.activeJobFor(m.id);
    if (other) throw new BadRequest(`${other.slug} is already ${other.status} for this meeting`, 409);
    if (Date.parse(m.start) < Date.now() - this.o.noShowMs) throw new BadRequest("this meeting started too long ago", 409);
    const taken = (s: string) => this.jobs.some((j) => j.slug === s) || existsSync(path.join(this.o.out, s));
    let n = 1, slug = m.slug;
    while (taken(slug)) slug = `${m.slug}-${++n}`;
    if (!SLUG_RE.test(slug)) throw new BadRequest("couldn't make a folder name for this meeting", 409);
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), meetingRef: m.id, link: m.link, start: m.start, slug, name, status: "scheduled", createdAt: now };
    this.save(job);
    this.jobs.push(job);
    this.writeActive();
    log.info(`scheduled ${slug} for ${job.start} (meeting ${m.title})`);
    void this.tick();
    return { ...job };
  }

  /** Cancel the meeting's captures that haven't launched. Running ones are
   *  left alone. Returns how many were cancelled. */
  cancelMeetingJobs(meetingId: string): number {
    const pending = this.jobs.filter((j) => j.meetingRef === meetingId && (j.status === "scheduled" || j.status === "queued") && !this.launching.has(j.id));
    const at = new Date().toISOString();
    for (const j of pending) { j.status = "cancelled"; j.endedAt = at; }
    if (pending.length) this.save(...pending);
    return pending.length;
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
        if (now > new Date(j.start).getTime() + OVERDUE_MS && !this.overdueSeen.has(j.id)) { this.overdueSeen.add(j.id); this.emit("overdue", j); }
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
    const used = new Set([...this.running.values()].map((r) => r.display).filter((d) => d !== null));
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

  /** The meeting's capture method, else its platform's default. */
  private methodOf(j: Job): CaptureMethod {
    const m = this.meetings.get(j.meetingRef);
    const p = platformFor(j.link);
    const want = m?.method as CaptureMethod | undefined;
    return want && p?.methods.includes(want) ? want : p?.methods[0] ?? "screen";
  }

  private async launchInner(j: Job): Promise<void> {
    const method = this.methodOf(j);
    const screen = method === "screen";
    // Stream jobs get no display or sink (nothing to show or hear).
    const n = screen ? this.freeDisplay() : null;
    const display = n === null ? "" : `:${n}`;
    const sink = n === null ? "" : `zoom_${n}`;
    const dir = path.join(this.o.out, j.slug);
    mkdirSync(dir, { recursive: true });
    const capLog = createWriteStream(path.join(dir, "capture.log"), { flags: "a" });

    let xvfb: ChildProcess | undefined;
    let sinkModule: string | null = null;
    if (screen) try {
      xvfb = spawn("Xvfb", [display, "-screen", "0", `${this.o.width}x${this.o.height}x24`, "-nolisten", "tcp"],
        { stdio: "ignore" });
      // A spawn failure (no Xvfb binary) is an 'error' event: unhandled, it
      // takes the whole server down. The xdpyinfo wait below reports it.
      xvfb.on("error", (e) => log.error(`${j.slug}: Xvfb ${display}: ${e.message}`));
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
      this.emit("finished", j);
      return;
    }

    const args = [
      this.o.entry,
      "--link", j.link, "--start", j.start, "--slug", j.slug, "--name", j.name,
      "--out", this.o.out, "--lead-min", String(this.o.leadMs / 60_000), "--method", method,
      ...(this.o.auth ? ["--auth", this.o.auth] : []),
    ];
    const proc = spawn(process.execPath, args, {
      // The job's own email overrides the server-wide CAPTURE_EMAIL.
      env: { ...process.env, ...(screen ? { DISPLAY: display, CAPTURE_SINK: sink, PULSE_SINK: sink } : {}),
             ...(j.email ? { CAPTURE_EMAIL: j.email } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.pipe(capLog, { end: false });
    proc.stderr?.pipe(capLog, { end: false });

    const run: Running = { proc, display: n, xvfb: xvfb ?? null, sinkModule, stopRequested: false, exited: Promise.resolve() };
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
          run.xvfb.on("error", (e) => log.error(`${j.slug}: Xvfb ${display}: ${e.message}`));
          keepDisplay(run.xvfb);
        }, 500);
      });
    };
    if (xvfb) keepDisplay(xvfb);
    run.exited = new Promise<void>((resolve) => {
      proc.once("exit", async (code, signal) => {
        this.running.delete(j.id);
        run.xvfb?.kill();
        if (sinkModule) await execFileP("pactl", ["unload-module", sinkModule]).catch(() => {});
        capLog.end();
        j.exitCode = code ?? null;
        j.endedAt = new Date().toISOString();
        j.outcome = readOutcome(dir);
        j.status = code === 0 ? "done" : run.stopRequested ? "stopped" : "failed";
        if (j.status === "failed" && !j.error) j.error = signal ? `capture killed by ${signal}` : `capture exited ${code}`;
        this.save(j);
        log.info(`${j.slug} finished: ${j.status} (outcome ${j.outcome ?? "?"})`);
        this.emit("finished", j);
        resolve();
        void this.tick(); // a queued job may be waiting for this slot
      });
    });
    this.running.set(j.id, run);

    j.status = "running";
    j.launchedAt = new Date().toISOString();
    delete j.error;
    this.save(j);
    log.info(screen ? `launched ${j.slug} on display ${display}, sink ${sink}` : `launched ${j.slug} (${method}, no display)`);
    this.emit("started", j);
  }
}

function readOutcome(dir: string): string | undefined {
  try { return JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).outcome; } catch { return undefined; }
}

// --- database rows ---------------------------------------------------------

type JobRow = {
  id: string; meeting_id: string | null; link: string; start: string; slug: string; name: string; email: string | null;
  status: string; created_at: string; launched_at: string | null; ended_at: string | null;
  exit_code: number | null; outcome: string | null; error: string | null;
};

const UPSERT = `INSERT INTO jobs (id, meeting_id, link, start, slug, name, email, status, created_at, launched_at, ended_at, exit_code, outcome, error)
  VALUES (:id, :meeting_id, :link, :start, :slug, :name, :email, :status, :created_at, :launched_at, :ended_at, :exit_code, :outcome, :error)
  ON CONFLICT (id) DO UPDATE SET meeting_id = excluded.meeting_id, link = excluded.link, start = excluded.start, slug = excluded.slug, name = excluded.name,
    email = excluded.email, status = excluded.status, launched_at = excluded.launched_at, ended_at = excluded.ended_at,
    exit_code = excluded.exit_code, outcome = excluded.outcome, error = excluded.error`;

function toRow(j: Job): JobRow {
  return {
    id: j.id, meeting_id: j.meetingRef || null, link: j.link, start: j.start, slug: j.slug, name: j.name, email: j.email ?? null,
    status: j.status, created_at: j.createdAt, launched_at: j.launchedAt ?? null, ended_at: j.endedAt ?? null,
    exit_code: j.exitCode === undefined ? null : j.exitCode, outcome: j.outcome ?? null, error: j.error ?? null,
  };
}

/** Optional fields stay absent (not null) so the API's JSON is unchanged.
 *  exitCode keeps null once the job has ended (killed by a signal). */
function fromRow(r: JobRow): Job {
  const j: Job = { id: r.id, meetingRef: r.meeting_id ?? "", link: r.link, start: r.start, slug: r.slug, name: r.name,
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
