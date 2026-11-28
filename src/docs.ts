/**
 * The document mirror: every document a feed lists for a meeting (agenda
 * and notice PDFs, the dial-in instructions, minutes) is fetched once and
 * stored here, so it stays available if the city moves or pulls it, and its
 * text is read for the meeting's join link ("Special Council Meeting ID:
 * 886 0437 7392" is only in the Dial-in PDF).
 *
 * - Source: meetings.documents, as the feed last listed them (feeds/sync).
 *   A document is a row in meeting_documents (migration 15), mirrored once
 *   per url; a document the feed later drops keeps its stored copy and is
 *   marked gone.
 * - Fetching: docfetch.ts (headed browser, the site's own origin only).
 *   Failures are retried with a growing wait, five times.
 * - Kept: PDF, Word/Excel/PowerPoint, PNG, JPEG, by their first bytes;
 *   anything else (a web page, a bot check) is a failure, not stored.
 *   25 MB at most. Files under <dir>/<meeting id>/<doc id>-<name>.<ext>.
 * - Join link: the text of each stored PDF (poppler's pdftotext, when
 *   installed) goes through the platforms' findLink. What it finds is
 *   written to the change log every time it differs from the last result
 *   (link_detected, or link_removed when the documents stop naming one),
 *   and sets the meeting's link when it has none or when its link was
 *   itself taken from a document (Sync.documentLink). A link the feed gave
 *   is never replaced.
 * - Public: a stored copy is offered as /doc/<id>/<name> next to the city's
 *   own link, for visible meetings only, always as a download-safe type
 *   (nosniff, sandboxed).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { MAX_DOC_BYTES, sniff, type DocFetcher } from "./docfetch.js";
import type { Sync } from "./feeds/sync.js";
import type { Feed } from "./feeds/store.js";
import type { Meeting, Meetings } from "./meetings.js";
import { findLink } from "./platforms/registry.js";
import { logger } from "./util.js";

const log = logger("docs");

const MAX_TRIES = 5;
const BATCH = 25;
/** Meetings older than this aren't mirrored (history is already past). */
const WINDOW_DAYS = 120;

export interface DocRow {
  id: number; meetingId: string; url: string; title: string; type: string | null;
  status: "pending" | "stored" | "failed"; file: string | null; name: string | null; contentType: string | null;
  bytes: number | null; sha256: string | null; link: string | null; error: string | null;
  tries: number; triedAt: string | null; fetchedAt: string | null; goneAt: string | null;
}

type Raw = Record<string, unknown>;
const toRow = (r: Raw): DocRow => ({
  id: r.id as number, meetingId: r.meeting_id as string, url: r.url as string, title: r.title as string, type: (r.type as string) ?? null,
  status: r.status as DocRow["status"], file: (r.file as string) ?? null, name: (r.name as string) ?? null, contentType: (r.content_type as string) ?? null,
  bytes: (r.bytes as number) ?? null, sha256: (r.sha256 as string) ?? null, link: (r.link as string) ?? null, error: (r.error as string) ?? null,
  tries: r.tries as number, triedAt: (r.tried_at as string) ?? null, fetchedAt: (r.fetched_at as string) ?? null, goneAt: (r.gone_at as string) ?? null,
});

/** The text of a PDF, or null when it can't be read (pdftotext missing, or not text). */
export function pdfText(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("pdftotext", ["-q", "-layout", file, "-"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (err, out) => resolve(err ? null : out));
  });
}

const OOXML: [string, string, string][] = [["word/", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xl/", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["ppt/", "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]];

/** What a fetched body is, or why it isn't a document worth keeping. */
export function kindOf(b: Buffer): { ext: string; type: string } | string {
  if (b.length === 0) return "empty";
  const s = sniff(b);
  if (!s) return /^\s*</.test(b.subarray(0, 64).toString("latin1")) ? "a web page, not a document (the site's bot check?)" : "not a kind of document we keep";
  if (s.ext !== "zip") return s;
  const head = b.subarray(0, 65536).toString("latin1");
  const o = OOXML.find(([k]) => head.includes(k));
  return o ? { ext: o[1], type: o[2] } : "a zip archive";
}

const safeName = (title: string) => title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._ -]+/g, " ").trim().replace(/\s+/g, " ").slice(0, 80) || "document";

export interface MirrorOpts {
  db: DB; dir: string; meetings: Meetings; sync: Sync; feedOf: (id: string) => Feed | undefined;
  fetcher: DocFetcher; textOf?: (file: string) => Promise<string | null>; now?: () => Date;
}

export class DocMirror {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private o: MirrorOpts) {}

  private now() { return (this.o.now ?? (() => new Date()))(); }

  start(everyMs = 10 * 60_000): void {
    this.timer = setInterval(() => void this.run(), everyMs);
    this.timer.unref();
    setTimeout(() => void this.run(), 20_000).unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  list(meetingId: string): DocRow[] {
    return (this.o.db.prepare("SELECT * FROM meeting_documents WHERE meeting_id = ? ORDER BY id").all(meetingId) as Raw[]).map(toRow);
  }

  get(id: number): DocRow | undefined {
    const r = this.o.db.prepare("SELECT * FROM meeting_documents WHERE id = ?").get(id) as Raw | undefined;
    return r && toRow(r);
  }

  /** url -> its public path, for the meeting's stored documents. */
  copiesOf(meetingId: string): Map<string, string> {
    return new Map(this.list(meetingId).filter((d) => d.status === "stored" && d.name).map((d) => [d.url, `/doc/${d.id}/${encodeURIComponent(d.name!)}`]));
  }

  filePath(d: DocRow): string | null {
    return d.file ? path.join(this.o.dir, d.file) : null;
  }

  /** Make the table match what the feeds list, for meetings in the window. */
  private sync(now: Date): void {
    const since = now.getTime() - WINDOW_DAYS * 86_400_000;
    const db = this.o.db;
    const ins = db.prepare("INSERT OR IGNORE INTO meeting_documents (meeting_id, url, title, type) VALUES (?, ?, ?, ?)");
    for (const m of this.o.meetings.list()) {
      if (!m.documents || Date.parse(m.start) < since) continue;
      const listed = new Set<string>();
      for (const d of m.documents) {
        if (!/^https?:\/\//i.test(d.url) || d.type === "Join link") continue;   // a join link is a web page to open, not a file to keep
        listed.add(d.url);
        ins.run(m.id, d.url, d.title, d.type ?? null);
        db.prepare("UPDATE meeting_documents SET title = ?, type = ?, gone_at = NULL WHERE meeting_id = ? AND url = ?").run(d.title, d.type ?? null, m.id, d.url);
      }
      for (const r of this.list(m.id)) {
        if (!listed.has(r.url) && !r.goneAt) db.prepare("UPDATE meeting_documents SET gone_at = ? WHERE id = ?").run(now.toISOString(), r.id);
      }
    }
  }

  /** One pass: fetch what is due, store it, read it, settle the meetings' links. Never overlaps itself. */
  async run(): Promise<{ stored: number; failed: number }> {
    if (this.running) return { stored: 0, failed: 0 };
    this.running = true;
    const res = { stored: 0, failed: 0 };
    try {
      const now = this.now();
      this.sync(now);
      const due = (this.o.db.prepare("SELECT * FROM meeting_documents WHERE status != 'stored' AND gone_at IS NULL AND tries < ? ORDER BY id").all(MAX_TRIES) as Raw[])
        .map(toRow).filter((d) => !d.triedAt || now.getTime() - Date.parse(d.triedAt) >= 600_000 * 2 ** d.tries).slice(0, BATCH);
      const touched = new Set<string>();
      const byOrigin = new Map<string, DocRow[]>();
      for (const d of due) {
        let origin: string;
        try { origin = new URL(d.url).origin; } catch { continue; }
        byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), d]);
      }
      for (const [origin, docs] of byOrigin) {
        const got = await this.o.fetcher.fetchAll(origin, docs.map((d) => d.url));
        for (const d of docs) {
          touched.add(d.meetingId);
          const r = got.get(d.url) ?? new Error("not fetched");
          const error = r instanceof Error ? r.message : await this.store(d, r.bytes, now);
          if (error === null) { res.stored++; continue; }
          res.failed++;
          // A web page (a player or agenda page listed as a "document") won't become a file: don't keep trying.
          const hopeless = /^a web page, not a document/.test(error) ? MAX_TRIES : 1;
          this.o.db.prepare("UPDATE meeting_documents SET status = 'failed', error = ?, tries = tries + ?, tried_at = ? WHERE id = ?").run(error.slice(0, 300), hopeless, now.toISOString(), d.id);
          log.warn(`document ${d.title} (${d.url}): ${error}`);
        }
      }
      // A document that left the feed can change what the meeting's documents say too.
      for (const r of this.o.db.prepare("SELECT DISTINCT meeting_id FROM meeting_documents").all() as { meeting_id: string }[]) touched.add(r.meeting_id);
      for (const id of touched) this.reconcile(id);
      if (res.stored || res.failed) log.info(`documents: ${res.stored} stored, ${res.failed} failed`);
    } catch (e) {
      log.error("document mirror pass failed", e);
    } finally {
      this.running = false;
    }
    return res;
  }

  /** Save one fetched body. Returns an error text, or null when stored. */
  private async store(d: DocRow, bytes: Buffer, now: Date): Promise<string | null> {
    if (bytes.length > MAX_DOC_BYTES) return `larger than ${MAX_DOC_BYTES} bytes`;
    const k = kindOf(bytes);
    if (typeof k === "string") return k;
    const name = `${safeName(d.title).replace(/\.[A-Za-z0-9]{1,5}$/, "")}.${k.ext}`;
    const rel = path.join(d.meetingId, `${d.id}-${name}`);
    const abs = path.join(this.o.dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs + ".part", bytes);
    renameSync(abs + ".part", abs);
    let link: string | null = null;
    if (k.ext === "pdf") {
      const text = await (this.o.textOf ?? pdfText)(abs);
      link = (text && findLink(text)) || null;
    }
    this.o.db.prepare(`UPDATE meeting_documents SET status = 'stored', file = ?, name = ?, content_type = ?, bytes = ?, sha256 = ?, link = ?, error = NULL,
      tries = tries + 1, tried_at = ?, fetched_at = ? WHERE id = ?`)
      .run(rel, name, k.type, bytes.length, createHash("sha256").update(bytes).digest("hex"), link, now.toISOString(), now.toISOString(), d.id);
    return null;
  }

  /** Decide the meeting's detected link from its documents and record a change when it differs from the last result. */
  reconcile(meetingId: string): void {
    const m = this.o.meetings.get(meetingId);
    if (!m) return;
    const withLink = this.list(meetingId).filter((d) => d.status === "stored" && d.link && !d.goneAt).sort((a, b) => (b.fetchedAt ?? "").localeCompare(a.fetchedAt ?? ""));
    this.o.sync.documentLink(m, withLink[0]?.link ?? null, withLink[0]?.title, this.feedFor(m));
  }

  private feedFor(m: Meeting): Feed | undefined { return m.feedId ? this.o.feedOf(m.feedId) : undefined; }

  /** Exists on disk? (for serving) */
  has(d: DocRow): boolean { const f = this.filePath(d); return !!f && existsSync(f); }
}
