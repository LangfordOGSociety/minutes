/** Feeds and their runs in the database (migration 6). */
import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { SLUG_RE } from "../util.js";
import { parserById } from "./registry.js";
import { ConfigError } from "./types.js";

export type Policy = "auto" | "review" | "list_only";
export const POLICIES: readonly Policy[] = ["auto", "review", "list_only"];

export interface Feed {
  id: string;
  name: string;
  parser: string;
  config: Record<string, unknown>;
  slugPrefix: string;
  policy: Policy;
  intervalMin: number;
  enabled: boolean;
  httpCache: Record<string, { etag?: string; lastModified?: string }>;
  lastHash: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  nextRunAt: string | null;
  failures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedRun {
  id: number;
  feedId: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "unchanged" | "not_modified" | "error" | "suspect";
  items: number | null;
  hash: string | null;
  changes: number | null;
  error: string | null;
}

export class FeedError extends Error {
  constructor(msg: string, readonly status = 400) { super(msg); }
}

type Row = {
  id: string; name: string; parser: string; config: string; slug_prefix: string; policy: string; interval_min: number;
  enabled: number; http_cache: string | null; last_hash: string | null; last_run_at: string | null; last_ok_at: string | null;
  next_run_at: string | null; failures: number; last_error: string | null; created_at: string; updated_at: string;
};

const parse = <T>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };

const fromRow = (r: Row): Feed => ({
  id: r.id, name: r.name, parser: r.parser, config: parse(r.config, {}), slugPrefix: r.slug_prefix,
  policy: r.policy as Policy, intervalMin: r.interval_min, enabled: r.enabled === 1, httpCache: parse(r.http_cache, {}),
  lastHash: r.last_hash, lastRunAt: r.last_run_at, lastOkAt: r.last_ok_at, nextRunAt: r.next_run_at,
  failures: r.failures, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
});

const toRow = (f: Feed): Row => ({
  id: f.id, name: f.name, parser: f.parser, config: JSON.stringify(f.config), slug_prefix: f.slugPrefix, policy: f.policy,
  interval_min: f.intervalMin, enabled: f.enabled ? 1 : 0, http_cache: JSON.stringify(f.httpCache), last_hash: f.lastHash,
  last_run_at: f.lastRunAt, last_ok_at: f.lastOkAt, next_run_at: f.nextRunAt, failures: f.failures, last_error: f.lastError,
  created_at: f.createdAt, updated_at: f.updatedAt,
});

const COLS = Object.keys(toRow({ config: {}, httpCache: {} } as unknown as Feed));

/** What an admin may set; everything checked, nothing applied on error. */
export interface FeedInput { name?: unknown; parser?: unknown; config?: unknown; slugPrefix?: unknown; policy?: unknown; intervalMin?: unknown; enabled?: unknown }

export const RUNS_KEPT = 200;

export class Feeds {
  constructor(private db: DB) {}

  list(): Feed[] { return (this.db.prepare("SELECT * FROM feeds ORDER BY name").all() as Row[]).map(fromRow); }
  get(id: string): Feed | undefined { const r = this.db.prepare("SELECT * FROM feeds WHERE id = ?").get(id) as Row | undefined; return r && fromRow(r); }

  private check(input: FeedInput, base?: Feed): Omit<Feed, "id" | "createdAt" | "updatedAt" | "httpCache" | "lastHash" | "lastRunAt" | "lastOkAt" | "nextRunAt" | "failures" | "lastError"> {
    const str = (v: unknown) => typeof v === "string" ? v.trim() : undefined;
    const name = str(input.name) ?? base?.name;
    if (!name || name.length > 100) throw new FeedError("name is required (at most 100 characters)");
    const parserId = str(input.parser) ?? base?.parser;
    const parser = parserId ? parserById(parserId) : undefined;
    if (!parser) throw new FeedError(`unknown parser: ${parserId ?? "(none)"}`);
    let config: Record<string, unknown>;
    try { config = parser.validate(input.config ?? base?.config ?? {}) as Record<string, unknown>; }
    catch (e) { throw new FeedError(e instanceof ConfigError ? e.message : `config: ${(e as Error).message}`); }
    const slugPrefix = (str(input.slugPrefix) ?? base?.slugPrefix ?? "").toLowerCase();
    if (!SLUG_RE.test(slugPrefix) || slugPrefix.length > 40) throw new FeedError("folder prefix must be letters, digits, '.', '_' or '-' (at most 40), e.g. langford");
    const policy = (str(input.policy) ?? base?.policy ?? "review") as Policy;
    if (!POLICIES.includes(policy)) throw new FeedError(`policy must be one of ${POLICIES.join(", ")}`);
    const intervalMin = input.intervalMin === undefined || input.intervalMin === "" ? base?.intervalMin ?? 60 : Number(input.intervalMin);
    if (!Number.isInteger(intervalMin) || intervalMin < 5 || intervalMin > 1440) throw new FeedError("interval must be 5 to 1440 minutes");
    const enabled = input.enabled === undefined ? base?.enabled ?? true : input.enabled === true;
    return { name, parser: parser.id, config, slugPrefix, policy, intervalMin, enabled };
  }

  create(input: FeedInput, now = new Date()): Feed {
    const iso = now.toISOString();
    const f: Feed = { ...this.check(input), id: randomUUID(), httpCache: {}, lastHash: null, lastRunAt: null, lastOkAt: null,
      nextRunAt: iso, failures: 0, lastError: null, createdAt: iso, updatedAt: iso };
    this.db.prepare(`INSERT INTO feeds (${COLS.join(", ")}) VALUES (${COLS.map((c) => ":" + c).join(", ")})`).run(toRow(f));
    return f;
  }

  update(id: string, input: FeedInput, now = new Date()): Feed {
    const f = this.get(id);
    if (!f) throw new FeedError("no such feed", 404);
    const c = this.check(input, f);
    const changedSource = c.parser !== f.parser || JSON.stringify(c.config) !== JSON.stringify(f.config);
    // A new source starts fresh: no cached validators, poll now.
    const next: Feed = { ...f, ...c, updatedAt: now.toISOString(),
      ...(changedSource ? { httpCache: {}, lastHash: null, nextRunAt: now.toISOString() } : {}),
      ...(c.enabled && !f.enabled ? { nextRunAt: now.toISOString(), failures: 0 } : {}) };
    this.save(next);
    return next;
  }

  save(f: Feed): void {
    const sets = COLS.filter((c) => c !== "id").map((c) => `${c} = :${c}`).join(", ");
    this.db.prepare(`UPDATE feeds SET ${sets} WHERE id = :id`).run(toRow(f));
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
  }

  // --- runs ---

  startRun(feedId: string, trigger: FeedRun["trigger"], now = new Date()): number {
    const r = this.db.prepare("INSERT INTO feed_runs (feed_id, trigger, started_at, status) VALUES (?, ?, ?, 'running')")
      .run(feedId, trigger, now.toISOString());
    return Number(r.lastInsertRowid);
  }

  finishRun(id: number, r: Pick<FeedRun, "status"> & Partial<Pick<FeedRun, "items" | "hash" | "changes" | "error">>, now = new Date()): void {
    this.db.prepare(`UPDATE feed_runs SET finished_at = ?, status = ?, items = ?, hash = ?, changes = ?, error = ? WHERE id = ?`)
      .run(now.toISOString(), r.status, r.items ?? null, r.hash ?? null, r.changes ?? null, r.error?.slice(0, 1000) ?? null, id);
    const feedId = (this.db.prepare("SELECT feed_id FROM feed_runs WHERE id = ?").get(id) as { feed_id: string } | undefined)?.feed_id;
    if (feedId) {
      this.db.prepare(`DELETE FROM feed_runs WHERE feed_id = ? AND id NOT IN
        (SELECT id FROM feed_runs WHERE feed_id = ? ORDER BY id DESC LIMIT ${RUNS_KEPT})`).run(feedId, feedId);
    }
  }

  runs(feedId: string, limit = 20): FeedRun[] {
    return (this.db.prepare("SELECT * FROM feed_runs WHERE feed_id = ? ORDER BY id DESC LIMIT ?").all(feedId, limit) as Record<string, unknown>[])
      .map((r) => ({ id: r.id as number, feedId: r.feed_id as string, trigger: r.trigger as FeedRun["trigger"], startedAt: r.started_at as string,
        finishedAt: r.finished_at as string | null, status: r.status as FeedRun["status"], items: r.items as number | null,
        hash: r.hash as string | null, changes: r.changes as number | null, error: r.error as string | null }));
  }

  /** Runs left "running" by a server that died mid-run. */
  closeStaleRuns(now = new Date()): void {
    this.db.prepare("UPDATE feed_runs SET status = 'error', finished_at = ?, error = 'the server stopped during this run' WHERE status = 'running'")
      .run(now.toISOString());
  }
}
