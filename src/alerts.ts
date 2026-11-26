/**
 * Alerts: a saved search whose owner gets an email when a NEW meeting's
 * transcript mentions it ("tell me when zoning comes up").
 *
 * A pass looks at every meeting the public can see that has a transcript
 * and hasn't been handled yet (alert_runs). For each, every matching alert
 * is run against just that meeting (search.ts, so the same query rules and
 * the same visibility), and one email per person lists their matches with
 * links at the second. alert_deliveries makes each (alert, meeting) send
 * once even if a pass is retried after a mail failure; a meeting is marked
 * handled only when every send for it succeeded (or after a few tries). A
 * meeting that began over 30 days ago is never alerted: an alert made today
 * shouldn't announce the archive. The first pass after the feature ships
 * therefore just marks existing meetings handled.
 *
 * An alert has its own random token, so the link in the email can stop it
 * without signing in (the page asks first; a link prefetched by a mail
 * scanner changes nothing).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { tx } from "./db.js";
import { parseQuery, type Hit, type Search } from "./search.js";
import { logger } from "./util.js";

const log = logger("alerts");

export const MAX_ALERTS = 10;
const OLD_MS = 30 * 86_400_000;
const GIVE_UP_AFTER = 8;

export class AlertError extends Error {
  constructor(msg: string, readonly status = 400) { super(msg); }
}

export interface Alert { id: string; userId: string; query: string; body: string | null; token: string; createdAt: string; lastSentAt: string | null }
type Row = { id: string; user_id: string; query: string; body: string | null; token: string; created_at: string; last_sent_at: string | null };
const fromRow = (r: Row): Alert => ({ id: r.id, userId: r.user_id, query: r.query, body: r.body, token: r.token, createdAt: r.created_at, lastSentAt: r.last_sent_at });

export interface AlertMeeting { id: string; slug: string; title: string; body: string | null; start: string }
export interface Recipient { id: string; email: string; name: string }

export class Alerts {
  private attempts = new Map<string, number>();

  constructor(private db: DB) {}

  create(userId: string, o: { query?: unknown; body?: unknown }, now = new Date()): Alert {
    const query = typeof o.query === "string" ? o.query.trim().replace(/\s+/g, " ") : "";
    if (!query || query.length > 200) throw new AlertError("type what to watch for (up to 200 characters)");
    if (!parseQuery(query)) throw new AlertError("that has no words to search for");
    const body = typeof o.body === "string" && o.body.trim() ? o.body.trim().slice(0, 100) : null;
    return tx(this.db, () => {
      const mine = this.list(userId);
      if (mine.length >= MAX_ALERTS) throw new AlertError(`you can have up to ${MAX_ALERTS} alerts; delete one first`, 409);
      if (mine.some((a) => a.query.toLowerCase() === query.toLowerCase() && (a.body ?? "").toLowerCase() === (body ?? "").toLowerCase())) throw new AlertError("you already have that alert", 409);
      const a: Alert = { id: randomUUID(), userId, query, body, token: randomBytes(24).toString("base64url"), createdAt: now.toISOString(), lastSentAt: null };
      this.db.prepare("INSERT INTO alerts (id, user_id, query, body, token, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(a.id, userId, query, body, a.token, a.createdAt);
      return a;
    });
  }

  list(userId: string): Alert[] {
    return (this.db.prepare("SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at, id").all(userId) as Row[]).map(fromRow);
  }

  all(): Alert[] { return (this.db.prepare("SELECT * FROM alerts ORDER BY created_at, id").all() as Row[]).map(fromRow); }

  get(id: string): Alert | undefined {
    const r = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as Row | undefined;
    return r && fromRow(r);
  }

  byToken(token: string): Alert | undefined {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    const r = this.db.prepare("SELECT * FROM alerts WHERE token = ?").get(token) as Row | undefined;
    return r && fromRow(r);
  }

  delete(id: string): boolean {
    return tx(this.db, () => {
      const r = this.db.prepare("DELETE FROM alerts WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM alert_deliveries WHERE alert_id = ?").run(id);
      return Number(r.changes) > 0;
    });
  }

  /** Remove a user's alerts (an account that's gone or can't receive mail). */
  deleteFor(userId: string): number {
    const ids = this.list(userId).map((a) => a.id);
    ids.forEach((id) => this.delete(id));
    return ids.length;
  }

  /**
   * Handle the meetings not handled yet. `send` emails one person; `site` is
   * the address for links ("" = none). Returns how many emails went out.
   */
  async process(o: {
    meetings: AlertMeeting[]; search: Search; recipient: (userId: string) => Recipient | null;
    send: (to: Recipient, subject: string, text: string) => Promise<void>; site: string; now?: Date;
  }): Promise<number> {
    const now = o.now ?? new Date();
    const done = new Set((this.db.prepare("SELECT meeting_id FROM alert_runs").all() as { meeting_id: string }[]).map((r) => r.meeting_id));
    let sent = 0;
    for (const m of [...o.meetings].sort((a, b) => a.start.localeCompare(b.start))) {
      if (done.has(m.id)) continue;
      const mark = () => this.db.prepare("INSERT OR IGNORE INTO alert_runs (meeting_id, done_at) VALUES (?, ?)").run(m.id, now.toISOString());
      const alerts = Date.parse(m.start) < now.getTime() - OLD_MS ? [] : this.all();
      // Each person's matches in this meeting, from the alerts that apply to it.
      const byUser = new Map<string, { alert: Alert; total: number; hits: Hit[] }[]>();
      for (const a of alerts) {
        if (a.body && a.body.toLowerCase() !== (m.body ?? "").toLowerCase()) continue;
        if (this.db.prepare("SELECT 1 FROM alert_deliveries WHERE alert_id = ? AND meeting_id = ?").get(a.id, m.id)) continue;
        const r = o.search.search(a.query, { meetingIds: [m.id], limit: 3 });
        if (r.total) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), { alert: a, total: r.total, hits: r.hits }]);
      }
      let failed = false;
      for (const [userId, matches] of byUser) {
        const to = o.recipient(userId);
        if (!to) { matches.forEach((x) => this.delete(x.alert.id)); continue; }          // gone, disabled or unconfirmed: nobody to tell
        try {
          await o.send(to, subjectFor(m, matches.map((x) => x.alert.query)), bodyFor(m, matches, o.site));
          tx(this.db, () => {
            for (const x of matches) {
              this.db.prepare("INSERT OR IGNORE INTO alert_deliveries (alert_id, meeting_id, sent_at) VALUES (?, ?, ?)").run(x.alert.id, m.id, now.toISOString());
              this.db.prepare("UPDATE alerts SET last_sent_at = ? WHERE id = ?").run(now.toISOString(), x.alert.id);
            }
          });
          sent++;
        } catch (e) {
          failed = true;
          log.warn(`alert email to ${to.email} for ${m.slug} failed: ${(e as Error).message}`);
        }
      }
      if (!failed) mark();
      else {
        const n = (this.attempts.get(m.id) ?? 0) + 1;
        this.attempts.set(m.id, n);
        if (n >= GIVE_UP_AFTER) { log.warn(`giving up alerting for ${m.slug} after ${n} tries`); mark(); }
      }
    }
    return sent;
  }
}

const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(new Date(iso));
const clock = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60); return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + `:${String(r).padStart(2, "0")}`; };

export function subjectFor(m: AlertMeeting, queries: string[]): string {
  const q = queries.length === 1 ? `"${queries[0]}"` : `${queries.length} of your alerts`;
  return `${q} came up at ${m.title} (${day(m.start)})`.replace(/[\r\n]+/g, " ").slice(0, 200);
}

export function bodyFor(m: AlertMeeting, matches: { alert: Alert; total: number; hits: Hit[] }[], site: string): string {
  const link = (p: string) => (site ? `${site}${p}` : "");
  const lines = [`${m.title}, ${day(m.start)}`, link(`/m/${encodeURIComponent(m.slug)}`), ""];
  for (const x of matches) {
    lines.push(`Your alert "${x.alert.query}": ${x.total} passage${x.total === 1 ? "" : "s"}`);
    for (const h of x.hits) {
      const text = h.parts.map((p) => (p.hit ? `*${p.text}*` : p.text)).join("").replace(/\s+/g, " ").trim();
      lines.push(`  ${clock(h.start)}${h.speaker ? `  ${h.speaker}` : ""}: ${text}`, `    ${link(`/m/${encodeURIComponent(m.slug)}?t=${Math.floor(h.start)}`)}`.trimEnd());
    }
    if (x.total > x.hits.length) lines.push(`  ...and ${x.total - x.hits.length} more: ${link(`/search?q=${encodeURIComponent(x.alert.query)}`)}`.trimEnd());
    lines.push(`  Stop this alert: ${link(`/alerts/${x.alert.token}/stop`)}`.trimEnd(), "");
  }
  lines.push("Transcripts are machine-made: check the video before quoting.", `Your alerts: ${link("/account")}`.trimEnd());
  return lines.join("\n");
}
