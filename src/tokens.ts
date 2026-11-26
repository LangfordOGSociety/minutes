/**
 * API tokens (#16) and what they're used for (#18).
 *
 * A token is `mnt_<8 hex>_<43 base64url>` (32 random bytes). The prefix finds
 * the row and shows in the UI and logs; only a sha256 of the whole token is
 * stored, so a copy of the database (a backup) can't be used as one. The
 * token is shown once, when it's made. Each belongs to a user; scopes are
 * `read` (always) and `download` (file downloads). A token never gives a
 * browser session's powers: serve.ts accepts it on /api/v1 only, and
 * checks the owner's capabilities on every request, so disabling the user,
 * or an unverified email, switches it off at once.
 *
 * Usage: one api_usage row per token request (route, status, bytes sent,
 * ip, and for a download the file), kept 90 days, plus a per-day total per
 * token in api_usage_daily that stays. `limiter` is called for every token
 * request and allows everything for now; a later version can return
 * `{ allow: false, retryAfterS }` from per-token or per-user limits (the
 * `limits` column) and the server answers 429 with Retry-After.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { tx, type DB } from "./db.js";

export type Scope = "read" | "download";
export const SCOPES: readonly Scope[] = ["read", "download"];
export const MAX_ACTIVE_TOKENS = 5;
export const USAGE_KEEP_DAYS = 90;
const TOKEN_RE = /^mnt_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const TOUCH_EVERY_MS = 60_000;

export class TokenError extends Error {
  constructor(msg: string, readonly status = 400) { super(msg); }
}

export interface ApiToken {
  id: string;
  userId: string;
  prefix: string;
  label: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Per-token overrides (api_tokens.limits JSON): downloadBps caps this token's download speed (#36). */
  limits: { downloadBps?: number } | null;
}

export type Verdict = { allow: true } | { allow: false; retryAfterS: number };
export type Limiter = (token: ApiToken, route: string) => Verdict;

type Row = {
  id: string; user_id: string; prefix: string; hash: string; label: string; scopes: string;
  created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; limits: string | null;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function fromRow(r: Row): ApiToken {
  let scopes: Scope[] = ["read"];
  try { scopes = (JSON.parse(r.scopes) as string[]).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)); } catch { /* keep read */ }
  let limits: ApiToken["limits"] = null;
  try {
    const l = r.limits ? JSON.parse(r.limits) as { downloadBps?: unknown } : null;
    if (l && Number.isFinite(l.downloadBps) && (l.downloadBps as number) > 0) limits = { downloadBps: Math.floor(l.downloadBps as number) };
  } catch { /* ignore a bad value */ }
  return { id: r.id, userId: r.user_id, prefix: r.prefix, label: r.label, scopes, createdAt: r.created_at, expiresAt: r.expires_at,
    revokedAt: r.revoked_at, lastUsedAt: r.last_used_at, limits };
}

export const activeToken = (t: ApiToken, now = new Date()) => !t.revokedAt && (!t.expiresAt || Date.parse(t.expiresAt) > now.getTime());

export interface UsageEvent { tokenId: string; userId: string; route: string; file?: string | null; status: number; bytes: number; ip?: string | null }

export interface UsageReport {
  days: { day: string; requests: number; bytes: number }[];
  tokens: { id: string; label: string; prefix: string; userId: string; userEmail: string; requests: number; bytes: number; lastUsedAt: string | null; revoked: boolean }[];
  users: { id: string; email: string; requests: number; bytes: number }[];
  files: { file: string; requests: number; bytes: number }[];
}

export class Tokens {
  /** Called for every token request; allow everything until limits exist. */
  limiter: Limiter = () => ({ allow: true });

  constructor(private db: DB) {}

  /** Make a token. Returns it once: only its hash is kept. */
  create(userId: string, o: { label?: unknown; scopes?: unknown; expiresInDays?: unknown }, now = new Date()): { token: string; record: ApiToken } {
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (!label || label.length > 60) throw new TokenError("give the token a label of 1-60 characters (what it's for)");
    let scopes: Scope[] = ["read", "download"];
    if (o.scopes !== undefined) {
      if (!Array.isArray(o.scopes) || o.scopes.some((s) => !(SCOPES as readonly unknown[]).includes(s))) throw new TokenError(`scopes can be: ${SCOPES.join(", ")}`);
      scopes = [...new Set<Scope>(["read", ...(o.scopes as Scope[])])];
    }
    let expiresAt: string | null = null;
    if (o.expiresInDays !== undefined && o.expiresInDays !== null && o.expiresInDays !== "") {
      const d = Number(o.expiresInDays);
      if (!Number.isInteger(d) || d < 1 || d > 730) throw new TokenError("expiry must be 1 to 730 days, or never");
      expiresAt = new Date(now.getTime() + d * 86_400_000).toISOString();
    }
    return tx(this.db, () => {
      if (this.list(userId).filter((t) => activeToken(t, now)).length >= MAX_ACTIVE_TOKENS) {
        throw new TokenError(`you can have up to ${MAX_ACTIVE_TOKENS} active tokens; revoke one first`, 409);
      }
      const prefix = randomBytes(4).toString("hex");
      const token = `mnt_${prefix}_${randomBytes(32).toString("base64url")}`;
      const id = randomBytes(8).toString("hex");
      this.db.prepare(`INSERT INTO api_tokens (id, user_id, prefix, hash, label, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, userId, prefix, sha256(token), label, JSON.stringify(scopes), now.toISOString(), expiresAt);
      return { token, record: this.get(id)! };
    });
  }

  get(id: string): ApiToken | undefined {
    const r = this.db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as Row | undefined;
    return r && fromRow(r);
  }

  /** A user's tokens, newest first (all of them, with the owner's email, when no user is given). */
  list(userId?: string): ApiToken[] {
    const rows = (userId
      ? this.db.prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id").all(userId)
      : this.db.prepare("SELECT * FROM api_tokens ORDER BY created_at DESC, id").all()) as Row[];
    return rows.map(fromRow);
  }

  /** The token for a presented secret, or null (unknown, revoked, expired, malformed). */
  authenticate(presented: string, now = new Date()): ApiToken | null {
    const m = TOKEN_RE.exec(presented);
    if (!m) return null;
    const r = this.db.prepare("SELECT * FROM api_tokens WHERE prefix = ?").get(m[1]) as Row | undefined;
    // Compare in constant time; an unknown prefix still does one compare.
    const want = Buffer.from(r?.hash ?? sha256("-"), "hex"), got = Buffer.from(sha256(presented), "hex");
    if (!timingSafeEqual(want, got) || !r) return null;
    const t = fromRow(r);
    if (!activeToken(t, now)) return null;
    if (!t.lastUsedAt || now.getTime() - Date.parse(t.lastUsedAt) > TOUCH_EVERY_MS) {
      this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), t.id);
      t.lastUsedAt = now.toISOString();
    }
    return t;
  }

  /** Revoke one (idempotent). False if there's no such token. */
  revoke(id: string, now = new Date()): boolean {
    const t = this.get(id);
    if (!t) return false;
    this.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), id);
    return true;
  }

  /** Set (or with bps 0 / null clear) a token's own download speed cap. False if there's no such token. */
  setDownloadLimit(id: string, bps: number | null): boolean {
    const t = this.get(id);
    if (!t) return false;
    if (bps !== null && (!Number.isInteger(bps) || bps < 0)) throw new TokenError("downloadBps must be a whole number of bytes per second, or 0 for the default");
    const limits = { ...(t.limits ?? {}), downloadBps: bps || undefined };
    const empty = !limits.downloadBps;
    this.db.prepare("UPDATE api_tokens SET limits = ? WHERE id = ?").run(empty ? null : JSON.stringify(limits), id);
    return true;
  }

  // --- usage -------------------------------------------------------------

  record(e: UsageEvent, now = new Date()): void {
    const at = now.toISOString(), day = at.slice(0, 10), bytes = Math.max(0, Math.round(e.bytes));
    tx(this.db, () => {
      this.db.prepare("INSERT INTO api_usage (at, token_id, user_id, route, file, status, bytes, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(at, e.tokenId, e.userId, e.route, e.file ?? null, e.status, bytes, e.ip ?? null);
      this.db.prepare(`INSERT INTO api_usage_daily (day, token_id, user_id, requests, bytes) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT (day, token_id) DO UPDATE SET requests = requests + 1, bytes = bytes + excluded.bytes`).run(day, e.tokenId, e.userId, bytes);
    });
  }

  /** Drop raw usage rows past their 90 days (the daily totals stay). */
  prune(now = new Date()): number {
    const cutoff = new Date(now.getTime() - USAGE_KEEP_DAYS * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM api_usage WHERE at < ?").run(cutoff).changes);
  }

  /** Usage over the last `days` (UTC days), for one user or for everyone. */
  usage(o: { userId?: string; days?: number }, now = new Date()): UsageReport {
    const days = Math.min(Math.max(Math.round(o.days ?? 30), 1), 365);
    const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const u = o.userId ? " AND d.user_id = ?" : "";
    const args = (...a: (string | number)[]) => (o.userId ? [...a, o.userId] : a);
    const num = (v: unknown) => Number(v ?? 0);
    const perDay = this.db.prepare(`SELECT d.day AS day, SUM(d.requests) AS requests, SUM(d.bytes) AS bytes FROM api_usage_daily d
      WHERE d.day >= ?${u} GROUP BY d.day ORDER BY d.day`).all(...args(since)) as { day: string; requests: number; bytes: number }[];
    const tokens = this.db.prepare(`SELECT t.id AS id, t.label AS label, t.prefix AS prefix, t.user_id AS user_id, us.email AS email, t.last_used_at AS last_used_at,
        t.revoked_at AS revoked_at, COALESCE(SUM(d.requests), 0) AS requests, COALESCE(SUM(d.bytes), 0) AS bytes
      FROM api_tokens t JOIN users us ON us.id = t.user_id LEFT JOIN api_usage_daily d ON d.token_id = t.id AND d.day >= ?
      ${o.userId ? "WHERE t.user_id = ?" : ""} GROUP BY t.id ORDER BY bytes DESC, t.created_at DESC`).all(...(o.userId ? [since, o.userId] : [since])) as Record<string, unknown>[];
    const users = o.userId ? [] : this.db.prepare(`SELECT us.id AS id, us.email AS email, SUM(d.requests) AS requests, SUM(d.bytes) AS bytes
      FROM api_usage_daily d JOIN users us ON us.id = d.user_id WHERE d.day >= ? GROUP BY us.id ORDER BY bytes DESC`).all(since) as Record<string, unknown>[];
    const files = this.db.prepare(`SELECT file, COUNT(*) AS requests, SUM(bytes) AS bytes FROM api_usage
      WHERE file IS NOT NULL AND at >= ?${o.userId ? " AND user_id = ?" : ""} GROUP BY file ORDER BY bytes DESC, requests DESC LIMIT 10`)
      .all(...(o.userId ? [since, o.userId] : [since])) as { file: string; requests: number; bytes: number }[];
    return {
      days: perDay.map((d) => ({ day: d.day, requests: num(d.requests), bytes: num(d.bytes) })),
      tokens: tokens.map((t) => ({ id: String(t.id), label: String(t.label), prefix: String(t.prefix), userId: String(t.user_id), userEmail: String(t.email),
        requests: num(t.requests), bytes: num(t.bytes), lastUsedAt: (t.last_used_at as string | null) ?? null, revoked: !!t.revoked_at })),
      users: users.map((x) => ({ id: String(x.id), email: String(x.email), requests: num(x.requests), bytes: num(x.bytes) })),
      files: files.map((f) => ({ file: f.file, requests: num(f.requests), bytes: num(f.bytes) })),
    };
  }
}
