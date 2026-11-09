/**
 * Keeps the saved Zoom login (auth/zoom-auth.json) alive and says when it
 * isn't, so an expired login is a warning hours ahead instead of a missed
 * meeting.
 *
 * A check opens https://zoom.us/profile with the saved session in the same
 * headed Chromium the captures use (on the server's own Xvfb display, never a
 * capture's). Signed in: the refreshed cookies are written back. Sent to the
 * sign-in page: "expired", and the file is left alone. It never types a
 * password: re-signing in stays `zoom-capture login`, done by a human.
 *
 * When: once a day, once in the PREFLIGHT window before each scheduled
 * capture launches, again soon after a failed check (network errors), and
 * right after the auth file changes following a failed check (a fresh
 * `zoom-capture login`). Never while a capture is running.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import type { Job } from "./jobs.js";
import { SIGNED_IN, saveStorageState } from "./login.js";
import { TIMEOUT, logger, withTimeout } from "./util.js";

const log = logger("session");

export type LoginState = "ok" | "expired" | "missing" | "error";

export interface CheckResult { state: LoginState; detail: string }

export interface SessionStatus {
  state: LoginState | "unchecked";
  detail: string;
  checkedAt: string | null;
  lastOkAt: string | null;
  reason: string | null;   // what triggered the last check
  checking: boolean;
}

/** One check. Exported for `zoom-capture check-login`. */
export async function checkLogin(authFile: string): Promise<CheckResult> {
  if (!existsSync(authFile)) return { state: "missing", detail: `no saved login at ${authFile}: run zoom-capture login` };
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      // Headed on the server's display, like a capture; headless only when
      // there's no display (running outside the image).
      headless: !process.env.DISPLAY,
      args: ["--no-first-run", "--disable-dev-shm-usage", "--window-size=1280,800"],
    });
    const ctx = await browser.newContext({ storageState: authFile, viewport: null });
    const page = await ctx.newPage();
    await page.goto("https://zoom.us/profile", { waitUntil: "domcontentloaded", timeout: 45_000 });
    // The redirect to sign-in can be client-side.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const u = new URL(page.url());
    if (!SIGNED_IN.test(page.url())) {
      return { state: "expired", detail: `zoom.us sent the saved login to ${u.host}${u.pathname}: run zoom-capture login` };
    }
    const st = await withTimeout(ctx.storageState(), 10_000);
    if (st === TIMEOUT) return { state: "ok", detail: "signed in (couldn't read refreshed cookies to save them)" };
    saveStorageState(authFile, st);
    return { state: "ok", detail: "signed in; refreshed session saved" };
  } catch (e) {
    return { state: "error", detail: `check failed: ${String(e).split("\n")[0].slice(0, 200)}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export interface KeeperOpts {
  auth: string | null;
  out: string;
  leadMs: number;          // captures launch this long before their start
  refreshMs: number;       // routine check interval (default 24h)
  preflightMs: number;     // check this long before a capture launches (default 2h)
  notifyUrl: string | null; // POST text/plain on trouble (ntfy-style), optional
}

const RETRY_ERROR_MS = 30 * 60_000;
const TICK_MS = 60_000;

export class SessionKeeper {
  private status: SessionStatus = { state: "unchecked", detail: "not checked yet", checkedAt: null, lastOkAt: null, reason: null, checking: false };
  private file: string;
  private running: Promise<SessionStatus> | null = null;
  private preflighted = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private o: KeeperOpts, private jobs: () => Job[]) {
    this.file = path.join(o.out, "session.json");
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      this.status = { ...this.status, ...s, checking: false };
    } catch { /* first run */ }
  }

  start(): void {
    if (!this.o.auth) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  get(): SessionStatus { return { ...this.status }; }

  private captureRunning(): boolean {
    return this.jobs().some((j) => j.status === "running" || j.status === "stopping");
  }

  /** Run a check now (deduplicated). Refused while a capture is running. */
  check(reason: string): Promise<SessionStatus> {
    if (this.running) return this.running;
    if (!this.o.auth) {
      return Promise.resolve(this.record({ state: "missing", detail: "server started without --auth" }, reason));
    }
    if (this.captureRunning()) return Promise.resolve(this.get());
    this.status.checking = true;
    log.info(`checking Zoom login (${reason})`);
    this.running = checkLogin(this.o.auth)
      .then((r) => this.record(r, reason))
      .finally(() => { this.running = null; this.status.checking = false; });
    return this.running;
  }

  private record(r: CheckResult, reason: string): SessionStatus {
    const before = this.status.state;
    const now = new Date().toISOString();
    this.status = { ...this.status, state: r.state, detail: r.detail, checkedAt: now, reason, checking: false };
    if (r.state === "ok") this.status.lastOkAt = now;
    (r.state === "ok" ? log.info : log.warn)(`Zoom login ${r.state}: ${r.detail}`);
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.status, null, 2));
      renameSync(tmp, this.file);
    } catch (e) { log.warn("couldn't save session.json", e); }
    if (r.state !== before) {
      if (r.state === "expired" || r.state === "missing") void this.notify(`Zoom login ${r.state}. Run zoom-capture login before the next capture.`);
      else if (r.state === "ok" && before !== "unchecked") void this.notify("Zoom login OK again.");
    }
    return this.get();
  }

  private async notify(text: string): Promise<void> {
    if (!this.o.notifyUrl) return;
    try {
      await fetch(this.o.notifyUrl, {
        method: "POST", body: text, headers: { "Content-Type": "text/plain", Title: "zoom-capture" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) { log.warn("notification failed", e); }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.running || this.captureRunning()) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const last = this.status.checkedAt ? Date.parse(this.status.checkedAt) : 0;
      const ok = this.status.state === "ok";

      // Before each scheduled capture: one check when it enters the window.
      for (const j of this.jobs()) {
        if (j.status !== "scheduled") continue;
        const launchAt = Date.parse(j.start) - this.o.leadMs;
        const key = `${j.id}@${j.start}`;
        if (now < launchAt - this.o.preflightMs || now >= launchAt || this.preflighted.has(key)) continue;
        this.preflighted.add(key);
        const s = ok && now - last < 10 * 60_000 ? this.status : await this.check(`before ${j.slug}`);
        if (s.state !== "ok") {
          await this.notify(`Zoom login ${s.state} and ${j.slug} launches at ${new Date(launchAt).toISOString()}. ${s.detail}`);
        }
        return;
      }

      // Re-signed in after a failure: check the new file straight away.
      if (!ok && last && this.o.auth && existsSync(this.o.auth) && statSync(this.o.auth).mtimeMs > last) {
        await this.check("login file changed");
        return;
      }
      const due = this.status.state === "error" ? RETRY_ERROR_MS : this.o.refreshMs;
      if (now - last >= due) await this.check(last ? "daily refresh" : "first check");
    } catch (e) {
      log.warn("session tick failed", e);
    } finally {
      this.ticking = false;
    }
  }
}
