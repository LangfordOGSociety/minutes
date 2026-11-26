/**
 * What a feed's result means for meetings and captures (#10, #11).
 *
 * Each run is diffed against the feed's meetings by externalId:
 *
 *   added            new meeting (announced); the feed's policy decides (below)
 *   date_changed     start moved to another day: captures that haven't launched move too
 *   time_changed     start moved within the same day: the same
 *   link_changed     join link added or changed: copied to waiting captures
 *                    (and, under auto/approved, a capture is scheduled)
 *   cancelled        captures that haven't launched are cancelled
 *   reinstated       a cancelled meeting is back
 *   removed          missing from the feed: ONLY flagged, never cancels
 *   returned         a removed meeting is back
 *   details_changed  title, body, agenda, page, stream page, end: recorded
 *   document_added / document_removed / document_changed
 *                    the source posted, pulled or retitled a document
 *                    (agenda, revised agenda, addendum, notice, minutes):
 *                    recorded, one per document. A meeting's first list
 *                    is stored without entries (it isn't news).
 *
 * Safety valve: a run that would remove more than half of the feed's
 * upcoming meetings (and at least 2) is `suspect` and applies nothing; a
 * parser that breaks and returns nothing can't touch anything.
 *
 * Policies for new upcoming meetings: `auto` schedules a capture as soon
 * as there's a supported link; `review` waits in the review queue
 * (approve -> capture, reject -> never); `list_only` never captures.
 *
 * Dedup: a new meeting that's the same as one already known (another feed,
 * or entered by hand) is linked to it (`duplicateOf`) and never captured:
 * same join link within 12h, or same body within 15 min.
 *
 * Meeting rows and the change log are written in one transaction; captures
 * are then scheduled, moved or cancelled through the Scheduler (which owns
 * jobs), and each change records what that did (`effect`).
 */
import { tx, type DB } from "../db.js";
import type { Scheduler } from "../jobs.js";
import type { Meeting } from "../meetings.js";
import { checkLink, platformFor } from "../platforms/registry.js";
import { logger, notify } from "../util.js";
import type { Applier, ApplyResult } from "./poller.js";
import type { Feed } from "./store.js";
import { localDate, localDateTime } from "./time.js";
import type { DetectedMeeting, MeetingDocument } from "./types.js";

const log = logger("feeds");

export type ChangeKind = "added" | "date_changed" | "time_changed" | "link_changed" | "cancelled" | "reinstated" | "removed" | "returned" |
  "details_changed" | "document_added" | "document_removed" | "document_changed" | "approved" | "rejected" | "merged" | "split";

/** Same documents, by URL, in the same order? */
function sameDocs(a: MeetingDocument[] | undefined, b: MeetingDocument[] | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const docRec = (d: MeetingDocument): Rec => ({ title: d.title, ...(d.type ? { type: d.type } : {}), url: d.url });

type Rec = Record<string, unknown>;

/** What to do about captures after the rows are written. */
type Action = "schedule" | "update" | "cancel" | "none";

interface Planned {
  kind: ChangeKind;
  meeting?: Meeting;            // existing
  detected?: DetectedMeeting;
  before?: Rec;
  after?: Rec;
  action: Action;
  effect: string;
  // for added:
  dupOf?: Meeting;
  review?: Meeting["review"];
}

export interface MeetingChange {
  id: number; meetingId: string; feedId: string | null; runId: number | null; at: string; kind: ChangeKind;
  before: Rec | null; after: Rec | null; effect: string | null;
}

export const SUSPECT_MIN = 2;
const DEDUP_BODY_MS = 15 * 60_000;
const DEDUP_LINK_MS = 12 * 3_600_000;
const TIME_EPS_MS = 60_000;
/** A meeting this far in the past is history: listed, never captured. */
const PAST_MS = 60 * 60_000;

export function slugify(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "") || "meeting";
}

/** A link as the log and the admin may see it: platform + meeting number. */
export function shownLink(link: string | undefined): string | null {
  if (!link) return null;
  const p = platformFor(link);
  return p ? `${p.label} ${p.publicId(link)}` : "unsupported link";
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export class Sync implements Applier {
  constructor(private db: DB, private sched: Scheduler, private tz: string, private notifyUrl: string | null = null) {}

  private get meetings() { return this.sched.meetings; }

  /** The normalized supported link, or "" (unsupported links aren't kept). */
  private linkOf(d: DetectedMeeting): string {
    if (!d.link) return "";
    try { return checkLink(d.link).link; } catch { return ""; }
  }

  /** May a capture be scheduled for this meeting under this feed's policy? */
  private wantsCapture(feed: Feed, m: { review?: Meeting["review"]; duplicateOf?: string; status: string; start: string }, now: Date): boolean {
    if (m.duplicateOf || m.status === "cancelled" || Date.parse(m.start) < now.getTime() - PAST_MS) return false;
    return feed.policy === "auto" || m.review === "approved";
  }

  private dupCandidate(feed: Feed, d: DetectedMeeting, link: string): Meeting | undefined {
    const t = d.start.getTime();
    const near = this.meetings.between(new Date(t - DEDUP_LINK_MS).toISOString(), new Date(t + DEDUP_LINK_MS).toISOString())
      .filter((m) => m.feedId !== feed.id && !m.duplicateOf && m.status !== "cancelled");
    return near.find((m) => link && m.link === link)
      ?? near.find((m) => d.body && m.body && norm(m.body) === norm(d.body) && Math.abs(Date.parse(m.start) - t) <= DEDUP_BODY_MS);
  }

  plan(feed: Feed, detected: DetectedMeeting[], now: Date): { changes: Planned[]; suspect: boolean; note?: string } {
    const existing = this.meetings.byFeed(feed.id);
    const byExt = new Map(existing.map((m) => [m.externalId ?? "", m]));
    const seen = new Set<string>();
    const changes: Planned[] = [];
    for (const d of detected) {
      if (!d.externalId || seen.has(d.externalId)) continue;
      seen.add(d.externalId);
      const link = this.linkOf(d);
      const ex = byExt.get(d.externalId);
      if (!ex) {
        const past = d.start.getTime() < now.getTime() - PAST_MS;
        const dupOf = past ? undefined : this.dupCandidate(feed, d, link);
        const review = !past && !dupOf && !d.cancelled && feed.policy === "review" ? "pending" as const : undefined;
        const p: Planned = { kind: "added", detected: d, dupOf, review, action: "none", effect: "",
          after: { title: d.title, body: d.body, start: d.start.toISOString(), local: localDateTime(d.start, this.tz),
            link: shownLink(link || d.link), cancelled: d.cancelled || undefined, documents: d.documents?.length || undefined } };
        if (past) p.effect = "in the past: listed only";
        else if (d.cancelled) p.effect = "cancelled: listed only";
        else if (dupOf) p.effect = `same meeting as ${dupOf.title} (${dupOf.slug}): not captured twice`;
        else if (feed.policy === "list_only") p.effect = "listed only (feed policy)";
        else if (feed.policy === "review") p.effect = "waiting for review";
        else if (link) { p.action = "schedule"; p.effect = "capture scheduled"; }
        else p.effect = d.link ? "link isn't a supported platform: not captured" : "capture scheduled once a link is published";
        changes.push(p);
        continue;
      }
      // Known meeting: what changed?
      const exT = Date.parse(ex.start), dT = d.start.getTime();
      const capture = this.wantsCapture(feed, ex, now);
      const active = this.sched.activeJobFor(ex.id);
      if (ex.removedAt) changes.push({ kind: "returned", meeting: ex, action: "none", effect: "back in the feed", before: { removedAt: ex.removedAt } });
      if (Math.abs(exT - dT) > TIME_EPS_MS) {
        const kind = localDate(new Date(exT), this.tz) !== localDate(d.start, this.tz) ? "date_changed" : "time_changed";
        changes.push({ kind, meeting: ex, detected: d, action: "update",
          before: { start: ex.start, local: localDateTime(new Date(exT), this.tz) }, after: { start: d.start.toISOString(), local: localDateTime(d.start, this.tz) },
          effect: !active ? "no capture to move" : active.status === "scheduled" || active.status === "queued" ? `capture ${active.slug} moved` : `already ${active.status}: unchanged` });
      }
      if (link && link !== ex.link) {
        const p: Planned = { kind: "link_changed", meeting: ex, detected: d, action: "update", before: { link: shownLink(ex.link) }, after: { link: shownLink(link) },
          effect: active ? (active.status === "scheduled" || active.status === "queued" ? `capture ${active.slug} uses the new link` : `already ${active.status}: unchanged`) : "no capture" };
        if (!active && capture && !d.cancelled) { p.action = "schedule"; p.effect = "capture scheduled"; }
        changes.push(p);
      }
      if (d.cancelled && ex.status !== "cancelled") {
        changes.push({ kind: "cancelled", meeting: ex, detected: d, action: "cancel", before: { status: ex.status }, after: { status: "cancelled" },
          effect: active ? (active.status === "scheduled" || active.status === "queued" ? `capture ${active.slug} cancelled` : `already ${active.status}: left running`) : "no capture" });
      } else if (!d.cancelled && ex.status === "cancelled") {
        const p: Planned = { kind: "reinstated", meeting: ex, detected: d, action: "none", before: { status: "cancelled" }, after: { status: "scheduled" }, effect: "listed again" };
        if ((link || ex.link) && this.wantsCapture(feed, { ...ex, status: "scheduled" }, now) && !active) { p.action = "schedule"; p.effect = "capture scheduled"; }
        changes.push(p);
      }
      const det: [string, unknown, unknown][] = [["title", ex.title, d.title], ["body", ex.body, d.body], ["agendaUrl", ex.agendaUrl, d.agendaUrl],
        ["pageUrl", ex.pageUrl, d.pageUrl], ["streamUrl", ex.streamUrl, d.streamUrl], ["end", ex.endEst, d.end?.toISOString()]];
      const diff = det.filter(([, a, b]) => b !== undefined && (a ?? null) !== b);
      if (diff.length) {
        changes.push({ kind: "details_changed", meeting: ex, detected: d, action: "none", effect: "recorded",
          before: Object.fromEntries(diff.map(([k, a]) => [k, a ?? null])), after: Object.fromEntries(diff.map(([k, , b]) => [k, b])) });
      }
      // Documents: only against a list seen before (the first isn't news).
      if (d.documents && ex.documents) {
        const old = new Map(ex.documents.map((x) => [x.url, x])), now_ = new Map(d.documents.map((x) => [x.url, x]));
        for (const [url, x] of now_) {
          const o = old.get(url);
          if (!o) changes.push({ kind: "document_added", meeting: ex, detected: d, action: "none", effect: "recorded", after: docRec(x) });
          else if (o.title !== x.title || (o.type ?? null) !== (x.type ?? null)) {
            changes.push({ kind: "document_changed", meeting: ex, detected: d, action: "none", effect: "recorded", before: docRec(o), after: docRec(x) });
          }
        }
        for (const [url, o] of old) {
          if (!now_.has(url)) changes.push({ kind: "document_removed", meeting: ex, detected: d, action: "none", effect: "recorded", before: docRec(o) });
        }
      }
    }
    // Upcoming meetings the feed no longer lists: flagged only.
    const upcoming = existing.filter((m) => !m.removedAt && m.status !== "cancelled" && Date.parse(m.start) > now.getTime());
    const gone = upcoming.filter((m) => !seen.has(m.externalId ?? ""));
    for (const m of gone) {
      const active = this.sched.activeJobFor(m.id);
      changes.push({ kind: "removed", meeting: m, action: "none", after: { removedAt: now.toISOString() },
        effect: active ? `flagged; capture ${active.slug} unchanged` : "flagged" });
    }
    if (gone.length >= SUSPECT_MIN && gone.length > upcoming.length / 2) {
      return { changes, suspect: true, note: `would remove ${gone.length} of ${upcoming.length} upcoming meetings; nothing applied` };
    }
    return { changes, suspect: false };
  }

  private uniqueSlug(base: string): string {
    const b = base.slice(0, 76);
    let s = b, n = 1;
    while (this.meetings.slugTaken(s)) s = `${b}-${++n}`;
    return s;
  }

  private logChange(c: { meetingId: string; feedId: string | null; runId: number | null; kind: ChangeKind; before?: Rec | null; after?: Rec | null; effect: string }, now: Date): number {
    const r = this.db.prepare(`INSERT INTO meeting_changes (meeting_id, feed_id, run_id, at, kind, before, after, effect) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.meetingId, c.feedId, c.runId, now.toISOString(), c.kind, c.before ? JSON.stringify(c.before) : null, c.after ? JSON.stringify(c.after) : null, c.effect);
    return Number(r.lastInsertRowid);
  }

  private setEffect(id: number, effect: string): void {
    this.db.prepare("UPDATE meeting_changes SET effect = ? WHERE id = ?").run(effect, id);
  }

  apply(feed: Feed, detected: DetectedMeeting[], runId: number, now: Date): ApplyResult {
    const { changes, suspect, note } = this.plan(feed, detected, now);
    if (suspect) {
      log.warn(`${feed.name}: suspect run: ${note}`);
      void notify(this.notifyUrl, `minutes feed ${feed.name}: ${note}. Check the feed.`);
      return { changes: 0, suspect: true, note };
    }
    const iso = now.toISOString();
    const jobsTodo: { change: number; p: Planned; meetingId: string }[] = [];
    let pendingReviews = 0;
    tx(this.db, () => {
      for (const p of changes) {
        let m = p.meeting;
        const d = p.detected;
        if (p.kind === "added" && d) {
          const link = this.linkOf(d);
          m = this.meetings.create({
            feedId: feed.id, externalId: d.externalId, title: d.title.slice(0, 300), body: d.body?.slice(0, 200),
            platform: platformFor(link)?.id ?? "", link, start: d.start.toISOString(), endEst: d.end?.toISOString(),
            agendaUrl: d.agendaUrl, pageUrl: d.pageUrl, streamUrl: d.streamUrl, slug: this.uniqueSlug(`${feed.slugPrefix}-${slugify(d.body || d.title)}-${localDate(d.start, this.tz)}`),
            status: d.cancelled ? "cancelled" : "scheduled", review: p.review, duplicateOf: p.dupOf?.id, lastSeenAt: iso,
            documents: d.documents,
          }, iso);
          if (p.review === "pending") pendingReviews++;
        } else if (m) {
          const cur = this.meetings.get(m.id)!;   // earlier changes this run may have touched it
          if (p.kind === "returned") cur.removedAt = undefined;
          if (p.kind === "removed") cur.removedAt = iso;
          if (p.kind === "cancelled") cur.status = "cancelled";
          if (p.kind === "reinstated") cur.status = "scheduled";
          if (p.kind === "details_changed" && d) {
            cur.title = d.title.slice(0, 300);
            if (d.body !== undefined) cur.body = d.body.slice(0, 200);
            if (d.agendaUrl !== undefined) cur.agendaUrl = d.agendaUrl;
            if (d.pageUrl !== undefined) cur.pageUrl = d.pageUrl;
            if (d.streamUrl !== undefined) cur.streamUrl = d.streamUrl;
            if (d.end) cur.endEst = d.end.toISOString();
          }
          if (p.kind !== "removed") cur.lastSeenAt = iso;
          this.meetings.save(cur);
        }
        const id = this.logChange({ meetingId: m!.id, feedId: feed.id, runId, kind: p.kind, before: p.before, after: p.after, effect: p.effect }, now);
        if (p.action !== "none") jobsTodo.push({ change: id, p, meetingId: m!.id });
      }
      // Everything still in the feed was seen now; keep its document list.
      const byExt = new Map(detected.map((d) => [d.externalId, d]));
      for (const m of this.meetings.byFeed(feed.id)) {
        const d = m.externalId ? byExt.get(m.externalId) : undefined;
        if (!d) continue;
        const docs = d.documents ?? m.documents;
        if (m.lastSeenAt !== iso || !sameDocs(m.documents, docs)) { m.lastSeenAt = iso; m.documents = docs; this.meetings.save(m); }
      }
    });
    // Captures, through the Scheduler.
    for (const { change, p, meetingId } of jobsTodo) {
      try {
        if (p.action === "update" && p.detected) {
          const ch: { start?: string; link?: string } = {};
          if (p.kind === "time_changed" || p.kind === "date_changed") ch.start = p.detected.start.toISOString();
          if (p.kind === "link_changed") ch.link = this.linkOf(p.detected);
          this.sched.updateMeeting(meetingId, ch);
        }
        if (p.kind === "link_changed" && p.action === "schedule" && p.detected) this.sched.updateMeeting(meetingId, { link: this.linkOf(p.detected) });
        if (p.action === "schedule") {
          const j = this.sched.scheduleMeeting(meetingId);
          this.setEffect(change, `capture ${j.slug} scheduled`);
        }
        if (p.action === "cancel") {
          const n = this.sched.cancelMeetingJobs(meetingId);
          if (!n) this.setEffect(change, p.effect.includes("left running") ? p.effect : "no capture");
        }
      } catch (e) {
        this.setEffect(change, `${p.effect}, but failed: ${(e as Error).message}`.slice(0, 300));
        log.warn(`${feed.name}: ${p.kind} for ${meetingId}: ${(e as Error).message}`);
      }
    }
    if (pendingReviews) void notify(this.notifyUrl, `minutes: ${pendingReviews} new meeting(s) from ${feed.name} to review.`);
    return { changes: changes.length, suspect: false };
  }

  preview(feed: Feed, detected: DetectedMeeting[], now: Date) {
    const { changes, suspect, note } = this.plan(feed, detected, now);
    return {
      suspect, note,
      changes: changes.map((p) => ({ kind: p.kind, title: p.detected?.title ?? p.meeting?.title, start: (p.detected?.start.toISOString() ?? p.meeting?.start),
        before: p.before ?? null, after: p.after ?? null, effect: p.effect })),
    };
  }

  meetingToday(feed: Feed, now: Date): boolean {
    const today = localDate(now, this.tz);
    return this.meetings.byFeed(feed.id).some((m) => m.status !== "cancelled" && !m.removedAt && localDate(new Date(m.start), this.tz) === today);
  }

  // --- the review queue and dedup, by an admin ---

  review(meetingId: string, decision: "approved" | "rejected"): { meeting: Meeting; effect: string } {
    const m = this.meetings.get(meetingId);
    if (!m) throw new Error("no such meeting");
    const before = m.review ?? null;
    m.review = decision;
    let effect = decision === "approved" ? "approved" : "rejected: never captured";
    this.meetings.save(m);
    if (decision === "approved") {
      if (!this.sched.activeJobFor(m.id) && m.link && m.status !== "cancelled" && !m.duplicateOf && Date.parse(m.start) > Date.now() - PAST_MS) {
        effect = `capture ${this.sched.scheduleMeeting(m.id).slug} scheduled`;
      } else if (!m.link) effect = "approved; capture scheduled once a link is published";
    } else {
      const n = this.sched.cancelMeetingJobs(m.id);
      if (n) effect += `, ${n} capture(s) cancelled`;
    }
    this.logChange({ meetingId: m.id, feedId: m.feedId ?? null, runId: null, kind: decision, before: { review: before }, after: { review: decision }, effect }, new Date());
    return { meeting: this.meetings.get(m.id)!, effect };
  }

  /** This meeting is the same as `intoId`: never captured itself. */
  merge(meetingId: string, intoId: string): { meeting: Meeting; effect: string } {
    if (meetingId === intoId) throw new Error("can't merge a meeting into itself");
    const m = this.meetings.get(meetingId), into = this.meetings.get(intoId);
    if (!m || !into) throw new Error("no such meeting");
    const target = into.duplicateOf ? this.meetings.get(into.duplicateOf) ?? into : into;
    if (target.id === m.id) throw new Error("that meeting is already a duplicate of this one");
    m.duplicateOf = target.id;
    this.meetings.save(m);
    // Anything that was a duplicate of m now points at the target.
    for (const x of this.meetings.list()) if (x.duplicateOf === m.id) { x.duplicateOf = target.id; this.meetings.save(x); }
    const n = this.sched.cancelMeetingJobs(m.id);
    const effect = `same meeting as ${target.title} (${target.slug})` + (n ? `, ${n} capture(s) cancelled` : "");
    this.logChange({ meetingId: m.id, feedId: m.feedId ?? null, runId: null, kind: "merged", before: null, after: { duplicateOf: target.slug }, effect }, new Date());
    return { meeting: this.meetings.get(m.id)!, effect };
  }

  split(meetingId: string, feed: Feed | undefined): { meeting: Meeting; effect: string } {
    const m = this.meetings.get(meetingId);
    if (!m) throw new Error("no such meeting");
    if (!m.duplicateOf) throw new Error("this meeting isn't linked to another");
    const was = this.meetings.get(m.duplicateOf);
    m.duplicateOf = undefined;
    if (feed?.policy === "review" && !m.review) m.review = "pending";
    this.meetings.save(m);
    let effect = "a separate meeting again";
    if (feed && this.wantsCapture(feed, m, new Date()) && m.link && !this.sched.activeJobFor(m.id)) {
      effect += `; capture ${this.sched.scheduleMeeting(m.id).slug} scheduled`;
    } else if (m.review === "pending") effect += "; waiting for review";
    this.logChange({ meetingId: m.id, feedId: m.feedId ?? null, runId: null, kind: "split", before: { duplicateOf: was?.slug ?? null }, after: null, effect }, new Date());
    return { meeting: this.meetings.get(m.id)!, effect };
  }

  changes(f: { meetingId?: string; feedId?: string; kinds?: ChangeKind[]; limit?: number }): MeetingChange[] {
    const args: (string | number)[] = [];
    const where: string[] = [];
    if (f.meetingId) { where.push("meeting_id = ?"); args.push(f.meetingId); }
    else if (f.feedId) { where.push("feed_id = ?"); args.push(f.feedId); }
    if (f.kinds?.length) { where.push(`kind IN (${f.kinds.map(() => "?").join(",")})`); args.push(...f.kinds); }
    const rows = this.db.prepare(`SELECT * FROM meeting_changes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(f.limit ?? 100, 1000)) as Record<string, unknown>[];
    const p = (s: unknown) => { try { return s ? JSON.parse(String(s)) as Rec : null; } catch { return null; } };
    return rows.map((r) => ({ id: r.id as number, meetingId: r.meeting_id as string, feedId: r.feed_id as string | null, runId: r.run_id as number | null,
      at: r.at as string, kind: r.kind as ChangeKind, before: p(r.before), after: p(r.after), effect: r.effect as string | null }));
  }
}
