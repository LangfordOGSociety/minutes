/**
 * Audit log of admin actions (#7): who, when, from where, what, and the
 * fields that changed. Written by serve.ts for admin writes and password
 * changes, and by the `minutes user` CLI (actor "cli"). Feeds, meetings,
 * tokens and publishing record here too as they arrive.
 *
 * Everything stored goes through redact() first: meeting links keep only
 * the meeting number (the passcode never lands here), the email typed into
 * Zoom shows only whether it was set or changed, and passwords, hashes and
 * tokens are never stored. Account emails do appear, as actor and as the
 * target of user actions: that's who did what to whom.
 */
import type { DB } from "./db.js";
import { platformFor } from "./platforms/registry.js";

export interface AuditEntry {
  id: number;
  at: string;
  actorId: string | null;
  actor: string;
  ip: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface Actor { id: string | null; label: string; ip?: string | null }
export const CLI: Actor = { id: null, label: "cli" };

const SECRET_KEY = /^(password|passcode|pwd|pw_?hash|password_?hash|token|\w*_?token|secret|cookie)$/i;
const EMAIL_KEY = /^e-?mail$/i;

/** A link as the log may show it: the meeting number only. */
function redactLink(v: string): string {
  const p = platformFor(v);
  return p ? `${p.id} meeting ${p.publicId(v)}` : "[link]";
}

/** Deep copy with secrets replaced. */
export function redact(v: unknown, key = ""): unknown {
  if (v === null || v === undefined) return v;
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (EMAIL_KEY.test(key)) return typeof v === "string" && v ? "[set]" : v;
  if (typeof v === "string") {
    if (/link$/i.test(key)) return redactLink(v);
    // Belt and braces: any passcode in any string.
    return v.replace(/([?&]pwd=)[^&\s"]*/gi, "$1[redacted]");
  }
  if (Array.isArray(v)) return v.map((x) => redact(x));
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redact(x, k)]));
  }
  return v;
}

/** The fields that differ, before and after (redacted). For a create or
 *  delete pass null on one side and every field is shown. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null):
    { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (!before || !after) return { before: before && redact(before) as Record<string, unknown>, after: after && redact(after) as Record<string, unknown> };
  const b: Record<string, unknown> = {}, a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    // A changed email shows as [set] -> [set]: say it changed, not to what.
    const rb = redact(before[k], k), ra = redact(after[k], k);
    b[k] = rb; a[k] = EMAIL_KEY.test(k) && rb === ra ? "[changed]" : ra;
  }
  return { before: b, after: a };
}

type Row = { id: number; at: string; actor_id: string | null; actor: string; ip: string | null; action: string;
  target_type: string; target_id: string | null; target_label: string | null; before: string | null; after: string | null };

const parse = (s: string | null) => { try { return s ? JSON.parse(s) as Record<string, unknown> : null; } catch { return null; } };

export class Audit {
  constructor(private db: DB) {}

  record(actor: Actor, action: string, target: { type: string; id?: string | null; label?: string | null },
      before: Record<string, unknown> | null = null, after: Record<string, unknown> | null = null, at = new Date()): void {
    const d = diff(before, after);
    // An update that changed nothing isn't worth a row.
    if (before && after && !Object.keys(d.after ?? {}).length) return;
    this.db.prepare(`INSERT INTO audit_log (at, actor_id, actor, ip, action, target_type, target_id, target_label, before, after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(at.toISOString(), actor.id, actor.label.slice(0, 254), actor.ip ?? null,
      action, target.type, target.id ?? null, target.label?.slice(0, 200) ?? null,
      d.before ? JSON.stringify(d.before) : null, d.after ? JSON.stringify(d.after) : null);
  }

  /** Newest first. Filters: action prefix ("job" or "job.update"), actor
   *  substring, target (id or label substring); page with beforeId. */
  list(f: { action?: string; actor?: string; target?: string; beforeId?: number; limit?: number } = {}): AuditEntry[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (f.action) { where.push("(action = ? OR action LIKE ? ESCAPE '\\')"); args.push(f.action, like(f.action) + ".%"); }
    if (f.actor) { where.push("actor LIKE ? ESCAPE '\\'"); args.push(`%${like(f.actor)}%`); }
    if (f.target) { where.push("(target_id = ? OR target_label LIKE ? ESCAPE '\\')"); args.push(f.target, `%${like(f.target)}%`); }
    if (f.beforeId) { where.push("id < ?"); args.push(f.beforeId); }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const rows = this.db.prepare(`SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`)
      .all(...args) as Row[];
    return rows.map((r) => ({
      id: r.id, at: r.at, actorId: r.actor_id, actor: r.actor, ip: r.ip, action: r.action, targetType: r.target_type,
      targetId: r.target_id, targetLabel: r.target_label, before: parse(r.before), after: parse(r.after),
    }));
  }

  actions(): string[] {
    return (this.db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all() as { action: string }[]).map((r) => r.action);
  }
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
