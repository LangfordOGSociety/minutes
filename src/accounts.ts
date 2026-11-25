/**
 * Accounts (#5): users, roles, password hashing, sessions, login limits.
 *
 * - Passwords: scrypt from node:crypto, async (never blocks the event loop
 *   that runs capture timers), parameters stored with each hash so they can
 *   be raised later without a migration.
 * - Sessions: 32 random bytes in an HttpOnly cookie; only their sha256 is
 *   stored, so a copy of the database (a backup) can't be used to sign in.
 *   14-day sliding expiry.
 * - Roles map to capabilities (ROLE_CAPS). Routes check capabilities, never
 *   role names, so a new role is one more row in that table.
 */
import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { tx, type DB } from "./db.js";

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, o, (e, k) => (e ? reject(e) : resolve(k))));

// --- roles ---------------------------------------------------------------

export type Capability =
  | "watch"           // list meetings, watch, read transcripts, live status
  | "tokens.own"      // create/revoke own API tokens, see own usage (#16)
  | "api.download"    // download files via the API with a token (#17)
  | "admin.view"      // join links (meeting IDs), live screen, logs, Zoom login status
  | "admin.manage";   // change captures, meetings, feeds, users, all tokens

/** "public" is everyone without a session. */
export const ROLE_CAPS: Record<string, readonly Capability[]> = {
  public: ["watch"],
  user: ["watch", "tokens.own", "api.download"],
  admin: ["watch", "tokens.own", "api.download", "admin.view", "admin.manage"],
};
export const ROLES = Object.keys(ROLE_CAPS).filter((r) => r !== "public");

export function can(role: string | null, cap: Capability): boolean {
  return (ROLE_CAPS[role ?? "public"] ?? ROLE_CAPS.public).includes(cap);
}

/** Need a verified email on top of the role (#32). */
const NEEDS_VERIFIED: readonly Capability[] = ["tokens.own", "api.download"];

/** What this signed-in user may do right now: nothing beyond public until
 *  a one-time password is changed; no tokens until the email is verified. */
export function capsFor(u: { role: string; mustChangePassword: boolean; emailVerifiedAt: string | null } | null): readonly Capability[] {
  if (!u || u.mustChangePassword) return ROLE_CAPS.public;
  const caps = ROLE_CAPS[u.role] ?? ROLE_CAPS.public;
  return u.emailVerifiedAt ? caps : caps.filter((c) => !NEEDS_VERIFIED.includes(c));
}

// --- passwords -----------------------------------------------------------

// N=2^15, r=8: ~32 MB and ~50-100 ms per hash.
const N = 1 << 15, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;
export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 256;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  // Unknown user or no password: still spend the time, so timing doesn't
  // tell which emails have accounts.
  const parts = (stored ?? DUMMY).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const want = Buffer.from(parts[5], "base64");
  const got = await scrypt(pw.slice(0, MAX_PASSWORD), salt, want.length, { N: n, r, p, maxmem: 128 * n * r * 2 });
  return stored !== null && got.length === want.length && timingSafeEqual(got, want);
}
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(KEYLEN).toString("base64")}`;

export function checkNewPassword(pw: unknown): string {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) throw new AccountError(`password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > MAX_PASSWORD) throw new AccountError(`password must be at most ${MAX_PASSWORD} characters`);
  return pw;
}

/** A one-time password for the CLI to print: 16 characters, no look-alikes. */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(32);
  let out = "";
  for (const b of bytes) {
    if (b >= 256 - (256 % alphabet.length)) continue;   // no modulo bias
    out += alphabet[b % alphabet.length];
    if (out.length === 16) break;
  }
  return out.length === 16 ? out : generatePassword();
}

// --- users ---------------------------------------------------------------

export class AccountError extends Error {
  constructor(msg: string, readonly status = 400) { super(msg); }
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  mustChangePassword: boolean;
  emailVerifiedAt: string | null;
  disabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

type UserRow = {
  id: string; email: string; name: string; role: string; password_hash: string | null; must_change_password: number;
  email_verified_at: string | null; disabled_at: string | null; last_login_at: string | null; created_at: string; updated_at: string;
};

const fromRow = (r: UserRow): User => ({
  id: r.id, email: r.email, name: r.name, role: r.role, mustChangePassword: r.must_change_password === 1,
  emailVerifiedAt: r.email_verified_at, disabledAt: r.disabled_at, lastLoginAt: r.last_login_at, createdAt: r.created_at,
});

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export function checkEmail(v: unknown): string {
  const e = typeof v === "string" ? v.trim() : "";
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new AccountError("that email address doesn't look right");
  return e;
}

function checkRole(role: string): string {
  if (!ROLES.includes(role)) throw new AccountError(`role must be one of: ${ROLES.join(", ")}`);
  return role;
}

const SESSION_DAYS = 14;
const SESSION_MS = SESSION_DAYS * 86_400_000;
/** Sliding expiry is written at most this often per session. */
const TOUCH_MS = 10 * 60_000;
export const SESSION_MAX_AGE_S = SESSION_MS / 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class Accounts {
  constructor(private db: DB) {}

  private row(where: string, v: string): UserRow | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE ${where}`).get(v) as UserRow | undefined;
  }

  get(id: string): User | undefined { const r = this.row("id = ?", id); return r && fromRow(r); }
  byEmail(email: string): User | undefined { const r = this.row("email = ?", email.trim()); return r && fromRow(r); }
  list(): User[] { return (this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[]).map(fromRow); }
  count(role?: string): number {
    const r = role
      ? this.db.prepare("SELECT count(*) AS n FROM users WHERE role = ? AND disabled_at IS NULL").get(role)
      : this.db.prepare("SELECT count(*) AS n FROM users").get();
    return (r as { n: number }).n;
  }

  private mustGet(email: string): UserRow {
    const r = this.row("email = ?", email.trim());
    if (!r) throw new AccountError(`no account for ${email}`, 404);
    return r;
  }

  /** Create an account. `password` null: no password until one is set. */
  async create(o: { email: string; name?: string; role: string; password: string | null; mustChange?: boolean; verified?: boolean }): Promise<User> {
    const email = checkEmail(o.email);
    checkRole(o.role);
    if (this.byEmail(email)) throw new AccountError(`${email} already has an account`, 409);
    const hash = o.password === null ? null : await hashPassword(checkNewPassword(o.password));
    const now = new Date().toISOString();
    const row: UserRow = {
      id: randomUUID(), email, name: (o.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80), role: o.role,
      password_hash: hash, must_change_password: o.mustChange ? 1 : 0, email_verified_at: o.verified ? now : null,
      disabled_at: null, last_login_at: null, created_at: now, updated_at: now,
    };
    this.db.prepare(`INSERT INTO users (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => ":" + k).join(", ")})`).run(row);
    return fromRow(row);
  }

  /** Set a password. Signs out every session except `keepSession`. */
  async setPassword(userId: string, pw: string, o: { mustChange: boolean; keepSession?: string }): Promise<void> {
    const hash = await hashPassword(checkNewPassword(pw));
    tx(this.db, () => {
      this.db.prepare("UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?")
        .run(hash, o.mustChange ? 1 : 0, new Date().toISOString(), userId);
      if (o.keepSession) this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, sha256(o.keepSession));
      else this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    });
  }

  setRole(email: string, role: string): User {
    const u = this.mustGet(email);
    checkRole(role);
    if (u.role === "admin" && role !== "admin" && !u.disabled_at && this.count("admin") <= 1) {
      throw new AccountError("that's the last admin; make someone else admin first", 409);
    }
    this.db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, new Date().toISOString(), u.id);
    return this.get(u.id)!;
  }

  /** Disable (signs out everywhere) or re-enable an account. */
  setDisabled(email: string, disabled: boolean): User {
    const u = this.mustGet(email);
    if (disabled && u.role === "admin" && !u.disabled_at && this.count("admin") <= 1) {
      throw new AccountError("that's the last admin; make someone else admin first", 409);
    }
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare("UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?").run(disabled ? (u.disabled_at ?? now) : null, now, u.id);
      if (disabled) this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    });
    return this.get(u.id)!;
  }

  /** Check an email + password. Disabled accounts never pass. */
  async authenticate(email: string, pw: string): Promise<User | null> {
    const r = typeof email === "string" ? this.row("email = ?", email.trim()) : undefined;
    const ok = await verifyPassword(typeof pw === "string" ? pw : "", r?.password_hash ?? null);
    if (!ok || !r || r.disabled_at) return null;
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
    return fromRow({ ...r });
  }

  // --- sessions ---

  /** Start a session; returns the cookie value (never stored). */
  createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}, now = new Date()): string {
    const token = randomBytes(32).toString("base64url");
    const iso = now.toISOString();
    this.db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sha256(token), userId, iso, iso, new Date(now.getTime() + SESSION_MS).toISOString(),
      meta.ip ?? null, (meta.userAgent ?? "").slice(0, 200) || null);
    return token;
  }

  /** The signed-in user for a cookie value, or null. `renewed` is true when
   *  the expiry was pushed out (send the cookie again). */
  session(token: string | undefined, now = new Date()): { user: User; renewed: boolean } | null {
    if (!token || token.length > 100) return null;
    const h = sha256(token);
    const r = this.db.prepare(`SELECT u.*, s.last_seen_at AS s_seen, s.expires_at AS s_expires FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(h) as (UserRow & { s_seen: string; s_expires: string }) | undefined;
    if (!r) return null;
    if (r.s_expires <= now.toISOString() || r.disabled_at) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(h);
      return null;
    }
    let renewed = false;
    if (now.getTime() - Date.parse(r.s_seen) >= TOUCH_MS) {
      this.db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
        .run(now.toISOString(), new Date(now.getTime() + SESSION_MS).toISOString(), h);
      renewed = true;
    }
    return { user: fromRow(r), renewed };
  }

  endSession(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  pruneSessions(now = new Date()): number {
    return Number(this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString()).changes);
  }

  // --- emailed codes (#32) ---

  /** A new 6-digit code for this user and purpose (replaces any earlier
   *  one). Returned once, to be emailed; only its hash is kept. */
  issueCode(userId: string, purpose: CodePurpose, now = new Date()): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.db.prepare(`INSERT OR REPLACE INTO email_codes (user_id, purpose, code_hash, expires_at, attempts, created_at)
      VALUES (?, ?, ?, ?, 0, ?)`).run(userId, purpose, codeHash(userId, purpose, code),
      new Date(now.getTime() + CODE_TTL_MS[purpose]).toISOString(), now.toISOString());
    return code;
  }

  /** Check a code. Single use: gone after a match, after CODE_ATTEMPTS
   *  wrong tries, or once expired. */
  useCode(userId: string, purpose: CodePurpose, code: unknown, now = new Date()): boolean {
    const r = this.db.prepare("SELECT code_hash, expires_at, attempts FROM email_codes WHERE user_id = ? AND purpose = ?")
      .get(userId, purpose) as { code_hash: string; expires_at: string; attempts: number } | undefined;
    if (!r) return false;
    const del = () => this.db.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = ?").run(userId, purpose);
    if (r.expires_at <= now.toISOString()) { del(); return false; }
    const given = typeof code === "string" ? code.replace(/\s/g, "") : "";
    const want = Buffer.from(r.code_hash, "hex"), got = Buffer.from(codeHash(userId, purpose, given), "hex");
    if (/^\d{6}$/.test(given) && timingSafeEqual(want, got)) { del(); return true; }
    if (r.attempts + 1 >= CODE_ATTEMPTS) del();
    else this.db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?").run(userId, purpose);
    return false;
  }

  markVerified(userId: string, now = new Date()): void {
    this.db.prepare("UPDATE users SET email_verified_at = coalesce(email_verified_at, ?), updated_at = ? WHERE id = ?")
      .run(now.toISOString(), now.toISOString(), userId);
  }

  /** Self-registered accounts never verified within `days` are deleted.
   *  Returns their emails (for the audit log). Admin-made accounts are
   *  created verified, and admins are never touched. */
  deleteUnverified(days: number, now = new Date()): string[] {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const rows = this.db.prepare(`SELECT id, email FROM users WHERE email_verified_at IS NULL AND role = 'user' AND created_at < ?`)
      .all(cutoff) as { id: string; email: string }[];
    for (const r of rows) this.db.prepare("DELETE FROM users WHERE id = ?").run(r.id);
    return rows.map((r) => r.email);
  }
}

export type CodePurpose = "verify" | "reset";
export const CODE_TTL_MS: Record<CodePurpose, number> = { verify: 24 * 3_600_000, reset: 15 * 60_000 };
export const CODE_ATTEMPTS = 5;
const codeHash = (userId: string, purpose: string, code: string) => sha256(`${userId}:${purpose}:${code}`);

// --- login rate limits ---------------------------------------------------

/** Failures per key in a sliding window, in memory (one server process).
 *  Bounded: the oldest keys go first past maxKeys. */
export class FailureLimiter {
  private hits = new Map<string, number[]>();

  constructor(readonly max: number, readonly windowMs: number, private maxKeys = 10_000) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }

  /** Milliseconds until another attempt is allowed; 0 = allowed now. */
  blockedFor(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    return list.length >= this.max ? list[list.length - this.max] + this.windowMs - now : 0;
  }

  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
  }

  reset(key: string): void { this.hits.delete(key); }
}
