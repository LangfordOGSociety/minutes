/**
 * Full-text search over transcripts: "what did council say about X".
 *
 * Each `<slug>.transcript.json` is cut into passages (up to ~45 s or 450
 * characters, never across a change of speaker) and put in an FTS5 table
 * with the speaker, the meeting and the passage's start in seconds, so a
 * hit links to /m/<slug>?t=<start>. The index is rebuildable from the files
 * (transcript_index remembers each file's size and mtime and re-indexes
 * what changed). Everything is indexed; WHO may see a hit is decided at
 * query time by the meeting ids the caller passes, so hiding a meeting
 * hides its transcript at once.
 *
 * User text never reaches FTS5 as syntax: words and "quoted phrases" are
 * pulled out and each is quoted, so AND / OR / NOT / NEAR / column filters
 * are just words.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { tx, type DB } from "./db.js";
import { nameSegments, readNames } from "./speakers.js";
import { logger } from "./util.js";

const log = logger("search");

export interface Seg { start?: number; end?: number; text?: string; label?: string; zoom_speaker?: string }
export interface Passage { start: number; speaker: string; text: string }

const MAX_SECONDS = 45, MAX_CHARS = 450;

/** Cut segments into passages of one speaker each. */
export function passages(segs: Seg[]): Passage[] {
  const out: Passage[] = [];
  let cur: Passage | null = null, curEnd = 0;
  for (const s of segs) {
    const text = String(s.text ?? "").replace(/\s+/g, " ").trim();
    const start = Number(s.start);
    if (!text || !Number.isFinite(start)) continue;
    const speaker = String(s.label || s.zoom_speaker || "").trim();
    if (cur && cur.speaker === speaker && start - cur.start < MAX_SECONDS && cur.text.length + text.length < MAX_CHARS) {
      cur.text += " " + text;
      curEnd = Number(s.end) || start;
    } else {
      if (cur) out.push(cur);
      cur = { start: Math.round(start * 10) / 10, speaker, text };
      curEnd = Number(s.end) || start;
    }
  }
  void curEnd;
  if (cur) out.push(cur);
  return out;
}

/** An FTS5 MATCH expression from what a person typed, or null if there's nothing to search for. */
export function parseQuery(q: string): { match: string; terms: string[] } | null {
  const text = String(q ?? "").slice(0, 200);
  const terms: string[] = [];
  const word = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  // "quoted phrases" first, then the rest as words.
  const rest = text.replace(/"([^"]*)"/g, (_m, p: string) => {
    const ws = p.match(word);
    if (ws?.length) terms.push(`"${ws.join(" ").replace(/['’]/g, " ")}"`);
    return " ";
  });
  const bare = rest.match(word) ?? [];
  bare.forEach((w, i) => {
    const t = w.replace(/['’]/g, " ");
    // As-you-type feel: the last word also matches longer words (budg -> budget).
    terms.push(`"${t}"${i === bare.length - 1 && w.length >= 3 && !/\s/.test(t) ? "*" : ""}`);
  });
  const used = terms.slice(0, 8);
  return used.length ? { match: used.join(" "), terms: used.map((t) => t.replace(/["*]/g, "")) } : null;
}

export interface Hit { meetingId: string; recSlug: string; start: number; speaker: string; parts: { text: string; hit: boolean }[] }

const HI = "\u0002", LO = "\u0003";

export class Search {
  constructor(private db: DB) {}

  /**
   * Bring the index in step with these transcripts: index new or changed
   * files, drop what's no longer there. `items` are every recording that
   * has a transcript on disk. With a budget, stops after the first indexed transcript that takes it past
   * the budget (more = true: call again; nothing is dropped until a pass has seen every transcript).
   */
  sync(items: { recSlug: string; meetingId: string; file: string; namesFile?: string }[], now = new Date(), budgetMs = Infinity): { indexed: number; removed: number; more: boolean } {
    let indexed = 0, removed = 0;
    const t0 = performance.now();
    const have = new Map((this.db.prepare("SELECT rec_slug, meeting_id, size, mtime_ms, names_mtime_ms FROM transcript_index").all() as { rec_slug: string; meeting_id: string; size: number; mtime_ms: number; names_mtime_ms: number }[])
      .map((r) => [r.rec_slug, r]));
    const live = new Set<string>();
    for (const it of items) {
      if (!existsSync(it.file)) continue;
      live.add(it.recSlug);
      const st = statSync(it.file), was = have.get(it.recSlug);
      const namesStamp = it.namesFile && existsSync(it.namesFile) ? Math.round(statSync(it.namesFile).mtimeMs) : 0;
      if (was && was.size === st.size && was.mtime_ms === Math.round(st.mtimeMs) && was.meeting_id === it.meetingId && was.names_mtime_ms === namesStamp) continue;
      let segs: Seg[];
      try { segs = (JSON.parse(readFileSync(it.file, "utf8")) as { segments?: Seg[] }).segments ?? []; }
      catch (e) { log.warn(`can't read ${it.recSlug}'s transcript for the index: ${(e as Error).message}`); continue; }   // half-written: next time
      const ps = passages(nameSegments(Array.isArray(segs) ? segs : [], it.namesFile ? readNames(path.dirname(it.namesFile)) : {}));
      tx(this.db, () => {
        this.db.prepare("DELETE FROM transcript_search WHERE rec_slug = ?").run(it.recSlug);
        const ins = this.db.prepare("INSERT INTO transcript_search (text, speaker, meeting_id, rec_slug, start) VALUES (?, ?, ?, ?, ?)");
        for (const p of ps) ins.run(p.text, p.speaker, it.meetingId, it.recSlug, p.start);
        this.db.prepare(`INSERT INTO transcript_index (rec_slug, meeting_id, size, mtime_ms, passages, indexed_at, names_mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (rec_slug) DO UPDATE SET meeting_id = excluded.meeting_id, size = excluded.size, mtime_ms = excluded.mtime_ms, passages = excluded.passages, indexed_at = excluded.indexed_at, names_mtime_ms = excluded.names_mtime_ms`)
          .run(it.recSlug, it.meetingId, st.size, Math.round(st.mtimeMs), ps.length, now.toISOString(), namesStamp);
      });
      indexed++;
      // Out of time for this slice (a first pass over thousands of transcripts): the caller comes back for the rest.
      if (performance.now() - t0 > budgetMs) return { indexed, removed, more: true };
    }
    for (const slug of have.keys()) {
      if (live.has(slug)) continue;
      tx(this.db, () => {
        this.db.prepare("DELETE FROM transcript_search WHERE rec_slug = ?").run(slug);
        this.db.prepare("DELETE FROM transcript_index WHERE rec_slug = ?").run(slug);
      });
      removed++;
    }
    return { indexed, removed, more: false };
  }

  /** Passages matching `q`, best first, only in the given meetings. */
  search(q: string, o: { meetingIds: string[]; limit?: number; offset?: number }): { total: number; hits: Hit[]; terms: string[] } {
    const parsed = parseQuery(q);
    if (!parsed || !o.meetingIds.length) return { total: 0, hits: [], terms: parsed?.terms ?? [] };
    const ids = JSON.stringify(o.meetingIds);
    const limit = Math.min(Math.max(Math.floor(o.limit ?? 20), 1), 100), offset = Math.max(Math.floor(o.offset ?? 0), 0);
    const where = "transcript_search MATCH ? AND meeting_id IN (SELECT value FROM json_each(?))";
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM transcript_search WHERE ${where}`).get(parsed.match, ids) as { n: number }).n);
    const rows = this.db.prepare(`SELECT meeting_id, rec_slug, start, speaker, snippet(transcript_search, 0, '${HI}', '${LO}', '…', 24) AS snip
      FROM transcript_search WHERE ${where} ORDER BY bm25(transcript_search, 1.0, 0.5), meeting_id, CAST(start AS REAL) LIMIT ? OFFSET ?`)
      .all(parsed.match, ids, limit, offset) as { meeting_id: string; rec_slug: string; start: number; speaker: string; snip: string }[];
    return { total, terms: parsed.terms, hits: rows.map((r) => ({ meetingId: r.meeting_id, recSlug: r.rec_slug, start: Number(r.start), speaker: r.speaker, parts: split(r.snip) })) };
  }

  stats(): { recordings: number; passages: number } {
    const r = this.db.prepare("SELECT count(*) AS n, COALESCE(sum(passages), 0) AS p FROM transcript_index").get() as { n: number; p: number };
    return { recordings: Number(r.n), passages: Number(r.p) };
  }
}

/** A snippet with \u0002 ... \u0003 around hits -> alternating plain and highlighted parts. */
function split(snip: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  for (const piece of snip.split(HI)) {
    const [hit, rest] = piece.includes(LO) ? piece.split(LO) : [null, piece];
    if (hit) out.push({ text: hit, hit: true });
    if (rest) out.push({ text: rest, hit: false });
  }
  return out;
}
