/**
 * Polls feeds (#9). Each feed runs every `intervalMin` minutes (5 on a day
 * it has a meeting, so a late link or time change is caught before the
 * join), with +-10% jitter, one run per host at a time, and exponential
 * backoff on errors (capped at 6h). Unchanged content (a 304 from a
 * conditional GET, or the same parsed result as last time) ends the run
 * before any diffing.
 *
 * What a run's meetings mean for the database is the Applier's job
 * (sync.ts, #10/#11); without one, runs only record what they found.
 */
import { createHash } from "node:crypto";
import { platformFor } from "../platforms/registry.js";
import { logger } from "../util.js";
import { feedContext } from "./context.js";
import { parserById } from "./registry.js";
import { FeedError, type Feed, type FeedRun, type Feeds } from "./store.js";
import { localDate } from "./time.js";
import type { DetectedMeeting } from "./types.js";

const log = logger("feeds");

export const MEETING_DAY_MIN = 5;
export const MAX_BACKOFF_MIN = 6 * 60;
export const UNHEALTHY_MS = 24 * 3_600_000;

export interface ApplyResult { changes: number; suspect: boolean; note?: string }

export interface Applier {
  apply(feed: Feed, meetings: DetectedMeeting[], runId: number, now: Date): ApplyResult;
  /** What apply() would do, saving nothing. */
  preview(feed: Feed, meetings: DetectedMeeting[], now: Date): unknown;
  /** Does this feed have a meeting today (server timezone)? */
  meetingToday(feed: Feed, now: Date): boolean;
}

export interface RunOutcome {
  status: FeedRun["status"];
  items: number | null;
  changes: number | null;
  error: string | null;
  note?: string;
}

export interface PollerOpts {
  tz: string;
  tickMs?: number;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

/** Stable hash of a parsed result: same meetings, same hash. */
export function resultHash(ms: DetectedMeeting[]): string {
  const norm = [...ms].sort((a, b) => a.externalId.localeCompare(b.externalId)).map((m) => ({
    ...m, start: m.start.toISOString(), end: m.end?.toISOString(),
  }));
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

export function healthOf(f: Feed, now = new Date()): "ok" | "failing" | "unhealthy" | "new" | "disabled" {
  if (!f.enabled) return "disabled";
  const okAt = f.lastOkAt ? Date.parse(f.lastOkAt) : null;
  const since = okAt ?? Date.parse(f.createdAt);
  if (f.failures > 0 && now.getTime() - since >= UNHEALTHY_MS) return "unhealthy";
  if (f.failures > 0) return "failing";
  return okAt ? "ok" : "new";
}

export class Poller {
  private timer?: NodeJS.Timeout;
  private busyHosts = new Set<string>();
  private running = new Map<string, Promise<RunOutcome>>();
  /** Starts seen in each feed's last run, when there's no Applier. */
  private lastStarts = new Map<string, Date[]>();

  constructor(private feeds: Feeds, private o: PollerOpts, private applier: Applier | null = null) {}

  start(): void {
    this.feeds.closeStaleRuns();
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? 20_000);
    this.timer.unref();
    this.tick();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** Start every due feed whose host is free. Exposed for tests. */
  tick(now = new Date()): Promise<RunOutcome>[] {
    const started: Promise<RunOutcome>[] = [];
    for (const f of this.feeds.list()) {
      if (!f.enabled || !f.nextRunAt || Date.parse(f.nextRunAt) > now.getTime() || this.running.has(f.id)) continue;
      const host = this.hostOf(f);
      if (host === null || this.busyHosts.has(host)) continue;
      started.push(this.run(f.id, "schedule", now).catch((e) => ({ status: "error" as const, items: null, changes: null, error: String(e) })));
    }
    return started;
  }

  private hostOf(f: Feed): string | null {
    const p = parserById(f.parser);
    try { return p ? new URL(p.host(f.config)).host : null; } catch { return null; }
  }

  isRunning(feedId: string): boolean { return this.running.has(feedId); }

  /** Run one feed now. Refused while it (or another feed on its host) is running. */
  run(feedId: string, trigger: FeedRun["trigger"], now = new Date()): Promise<RunOutcome> {
    const f = this.feeds.get(feedId);
    if (!f) throw new FeedError("no such feed", 404);
    const parser = parserById(f.parser);
    if (!parser) throw new FeedError(`unknown parser ${f.parser}`, 409);
    const host = this.hostOf(f);
    if (this.running.has(f.id) || (host && this.busyHosts.has(host))) throw new FeedError("a run for this site is in progress; try again shortly", 409);
    if (host) this.busyHosts.add(host);
    const p = this.runInner(f, trigger, now).finally(() => {
      if (host) this.busyHosts.delete(host);
      this.running.delete(f.id);
    });
    this.running.set(f.id, p);
    return p;
  }

  private nextRun(f: Feed, now: Date, failures: number, meetingDay: boolean): string {
    const base = failures > 0 ? Math.min(f.intervalMin * 2 ** failures, MAX_BACKOFF_MIN)
      : meetingDay ? Math.min(MEETING_DAY_MIN, f.intervalMin) : f.intervalMin;
    const jitter = 0.9 + 0.2 * (this.o.random ?? Math.random)();
    return new Date(now.getTime() + base * jitter * 60_000).toISOString();
  }

  private meetingToday(f: Feed, now: Date): boolean {
    if (this.applier) return this.applier.meetingToday(f, now);
    const today = localDate(now, this.o.tz);
    return (this.lastStarts.get(f.id) ?? []).some((d) => localDate(d, this.o.tz) === today);
  }

  private async runInner(f: Feed, trigger: FeedRun["trigger"], now: Date): Promise<RunOutcome> {
    const parser = parserById(f.parser)!;
    const runId = this.feeds.startRun(f.id, trigger, now);
    const ctx = feedContext({ tz: this.o.tz, now, cache: f.httpCache, label: f.name, fetchImpl: this.o.fetchImpl });
    let out: RunOutcome;
    let saveHash: string | null = null;
    try {
      const res = await parser.fetch(f.config, ctx);
      if ("notModified" in res) {
        out = { status: "not_modified", items: null, changes: 0, error: null };
      } else {
        const ms = res.meetings;
        this.lastStarts.set(f.id, ms.map((m) => m.start));
        const hash = resultHash(ms);
        if (hash === f.lastHash) {
          out = { status: "unchanged", items: ms.length, changes: 0, error: null };
        } else if (this.applier) {
          const r = this.applier.apply(f, ms, runId, now);
          out = { status: r.suspect ? "suspect" : "ok", items: ms.length, changes: r.changes, error: null, note: r.note };
          // A suspect result is looked at again next time, not accepted.
          if (!r.suspect) saveHash = hash;
        } else {
          out = { status: "ok", items: ms.length, changes: null, error: null };
          saveHash = hash;
        }
      }
    } catch (e) {
      out = { status: "error", items: null, changes: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) };
    } finally {
      await ctx.close();
    }
    const finished = new Date(Math.max(Date.now(), now.getTime()));
    const cur = this.feeds.get(f.id);   // may have been edited meanwhile
    if (cur) {
      const ok = out.status !== "error";
      const failures = ok ? 0 : cur.failures + 1;
      this.feeds.save({
        ...cur,
        lastRunAt: finished.toISOString(),
        ...(ok ? { lastOkAt: finished.toISOString(), lastError: null, httpCache: ctx.cache } : { lastError: out.error }),
        ...(saveHash ? { lastHash: saveHash } : {}),
        failures,
        nextRunAt: this.nextRun(cur, finished, failures, this.meetingToday(cur, finished)),
      });
    }
    this.feeds.finishRun(runId, { status: out.status, items: out.items, hash: saveHash, changes: out.changes, error: out.error ?? out.note ?? null }, finished);
    (out.status === "error" ? log.warn : log.info)(`${f.name}: ${out.status}` +
      (out.items !== null ? `, ${out.items} meeting(s)` : "") + (out.changes ? `, ${out.changes} change(s)` : "") + (out.error ? `: ${out.error}` : ""));
    return out;
  }

  /** Fetch and parse, and what applying would do: nothing saved, no cache used. */
  async preview(input: { parser: string; config: Record<string, unknown> }, feed: Feed | null, now = new Date()) {
    const parser = parserById(input.parser);
    if (!parser) throw new FeedError(`unknown parser ${input.parser}`);
    const ctx = feedContext({ tz: this.o.tz, now, label: `preview ${parser.id}`, fetchImpl: this.o.fetchImpl });
    try {
      const res = await parser.fetch(input.config, ctx);
      const meetings = "notModified" in res ? [] : res.meetings;
      return {
        // The link itself (it can hold a passcode) stays on the server: the
        // admin sees which platform and meeting it points to.
        meetings: meetings.map((m) => {
          const p = m.link ? platformFor(m.link) : undefined;
          return { ...m, start: m.start.toISOString(), end: m.end?.toISOString(),
            link: m.link ? (p ? `${p.label} ${p.publicId(m.link)}` : "unsupported link") : undefined };
        }),
        changes: feed && this.applier ? this.applier.preview(feed, meetings, now) : null,
        log: ctx.lines,
      };
    } finally {
      await ctx.close();
    }
  }
}
