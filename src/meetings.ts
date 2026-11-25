/**
 * Meetings: one row per real-world meeting, separate from capture jobs.
 *
 * A meeting is what the public sees and what a feed reports (title, body,
 * start, link). A job is one attempt to record it: a meeting can have none
 * (listed only), one, or several (a failed attempt plus a retry). The
 * meeting's link is the secret invite and is never sent to the browser.
 *
 * Changes to a meeting's start or link are copied to its jobs that haven't
 * launched yet (Scheduler.updateMeeting); launched jobs keep what they
 * started with.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";

export type MeetingStatus = "scheduled" | "cancelled";
export type Visibility = "public" | "hidden";

export interface Meeting {
  id: string;
  feedId?: string;        // null for meetings entered by hand
  externalId?: string;    // the feed's stable id for it
  title: string;
  body?: string;          // "Council", "Committee of the Whole"
  platform: string;       // "zoom" for now
  method?: string;        // capture method, when the platform has several
  link: string;           // secret: invite link with passcode
  start: string;          // ISO UTC
  endEst?: string;        // ISO UTC, estimated end
  agendaUrl?: string;
  status: MeetingStatus;
  visibility: Visibility;
  slug: string;           // base name for its jobs' folders
  createdAt: string;
  updatedAt: string;
}

export type NewMeeting = Omit<Meeting, "id" | "createdAt" | "updatedAt" | "status" | "visibility"> &
  Partial<Pick<Meeting, "status" | "visibility">>;

type Row = {
  id: string; feed_id: string | null; external_id: string | null; title: string; body: string | null;
  platform: string; method: string | null; link: string; start: string; end_est: string | null;
  agenda_url: string | null; status: string; visibility: string; slug: string; created_at: string; updated_at: string;
};

const COLS = "id, feed_id, external_id, title, body, platform, method, link, start, end_est, agenda_url, status, visibility, slug, created_at, updated_at";

function toRow(m: Meeting): Row {
  return {
    id: m.id, feed_id: m.feedId ?? null, external_id: m.externalId ?? null, title: m.title, body: m.body ?? null,
    platform: m.platform, method: m.method ?? null, link: m.link, start: m.start, end_est: m.endEst ?? null,
    agenda_url: m.agendaUrl ?? null, status: m.status, visibility: m.visibility, slug: m.slug,
    created_at: m.createdAt, updated_at: m.updatedAt,
  };
}

function fromRow(r: Row): Meeting {
  const m: Meeting = {
    id: r.id, title: r.title, platform: r.platform, link: r.link, start: r.start,
    status: r.status as MeetingStatus, visibility: r.visibility as Visibility, slug: r.slug,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (r.feed_id !== null) m.feedId = r.feed_id;
  if (r.external_id !== null) m.externalId = r.external_id;
  if (r.body !== null) m.body = r.body;
  if (r.method !== null) m.method = r.method;
  if (r.end_est !== null) m.endEst = r.end_est;
  if (r.agenda_url !== null) m.agendaUrl = r.agenda_url;
  return m;
}

export class Meetings {
  constructor(private db: DB) {}

  get(id: string): Meeting | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM meetings WHERE id = ?`).get(id) as Row | undefined;
    return r && fromRow(r);
  }

  list(): Meeting[] {
    return (this.db.prepare(`SELECT ${COLS} FROM meetings ORDER BY start`).all() as Row[]).map(fromRow);
  }

  create(input: NewMeeting, at = new Date().toISOString()): Meeting {
    const m: Meeting = { status: "scheduled", visibility: "public", ...input, id: randomUUID(), createdAt: at, updatedAt: at };
    this.db.prepare(`INSERT INTO meetings (${COLS}) VALUES (${COLS.split(", ").map((c) => ":" + c).join(", ")})`).run(toRow(m));
    return m;
  }

  /** Write back a changed meeting; bumps updatedAt. */
  save(m: Meeting): void {
    m.updatedAt = new Date().toISOString();
    const sets = COLS.split(", ").filter((c) => c !== "id" && c !== "created_at").map((c) => `${c} = :${c}`).join(", ");
    const { created_at: _, ...row } = toRow(m);
    this.db.prepare(`UPDATE meetings SET ${sets} WHERE id = :id`).run(row);
  }
}
