/**
 * Agenda-aware transcription: the names and places on a meeting's agenda
 * (a delegation's speaker, a street, a developer) are exactly what Whisper
 * gets wrong, and exactly what it can be told in advance. The agenda's
 * proper nouns are written to `<slug>/transcribe.json` as `vocab_extra`;
 * the transcriber appends them to its prompt AFTER the standing vocabulary
 * (Whisper keeps only the last ~220 tokens of a prompt, so the last words are
 * the ones that survive). Best effort and cheap: no agenda, a PDF agenda or
 * a failed fetch just means the standing vocabulary is used.
 *
 * Terms: runs of capitalized words (2-3 words, "Walfred Road") and single
 * capitalized words that are not just a sentence's first word, minus
 * agenda boilerplate ("Council", "Minutes", months, titles). Ranked by how
 * often they appear and how specific they are, capped so they don't push the
 * prompt past what Whisper keeps.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { textOf } from "./feeds/parsers/escribe.js";
import { logger } from "./util.js";

const log = logger("agenda-vocab");

export const MAX_TERMS = 28;
const MAX_CHARS = 380;

const STOP = new Set(`a an the and or of to in on at for by with from as is are be this that these those it its we you our your their his her not no yes
agenda minutes meeting meetings council committee board commission report reports item items motion moved seconded carried opposed bylaw bylaws
adoption adopted approval approve approved receive received presentation delegation delegations public hearing hearings notice notices correspondence
information purposes recommendation recommendations background discussion summary attachment attachments appendix schedule section sections
call order adjournment adjourn closed open session sessions regular special annual city district town village municipality corporation staff
january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday
mayor councillor councillors deputy director manager chief officer chair vice acting administrative planning development services department
whereas therefore resolved resolution please also all any each every may will shall should would could can has have had was were been being
page pages number no yes none nil new old first second third fourth fifth subject date time location zoom webinar telephone phone email
question questions comment comments input participation speaker speakers requirements amendment amendments application applications permit permits
official community plan zoning rezoning variance appendices attached following above below general business reports unfinished consent
video window join star type participate dial details canada toll free instructions electronic chambers protection privacy freedom vote result results
software ltd inc limited society directors board territorial acknowledgement conduct rules correspondence consideration removed matters readings reading
third fourth litigation solicitor privilege resolution charter pursuant camera community unmute raise hand technical difficulties delay line stay
download click link links website web site home contact phone fax tel planner engineer coordinator administrator supervisor clerk`.split(/\s+/));

const TITLES = new Set(["mayor", "councillor", "councillors", "deputy", "director", "manager", "chief", "officer", "chair", "vice", "acting", "dr", "mr", "mrs", "ms"]);

/** Proper-noun terms from an agenda's text, best first. */
export function agendaTerms(text: string, o: { max?: number; maxChars?: number } = {}): string[] {
  const counts = new Map<string, { n: number; mid: number; words: number; titled: number }>();
  const add = (term: string, mid: boolean, words: number, titled: boolean) => {
    const e = counts.get(term) ?? { n: 0, mid: 0, words, titled: 0 };
    e.n++; if (mid) e.mid++; if (titled) e.titled++;
    counts.set(term, e);
  };
  const word = /[A-ZÀ-Þ][A-Za-zÀ-ſ'’-]{2,}/;
  for (const raw of text.split(/\r?\n/)) {
    // File names and web addresses (20261124 - Council Minutes.pdf, Zoom.us) are not names.
    const line = raw.replace(/\S*\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|us|com|ca|org|net)\b\S*/gi, " ").replace(/\s+/g, " ").trim();
    if (line.length < 3 || line.length > 600) continue;
    const toks = line.split(" ");
    let run: { w: string; mid: boolean }[] = [];
    const flush = () => {
      // Titles and boilerplate are trimmed off the ends of a run: "Councillor Harder" -> "Harder".
      let titled = false;
      while (run.length && (STOP.has(run[0].w.toLowerCase().replace(/[^a-z]/g, "")) || TITLES.has(run[0].w.toLowerCase()))) { if (TITLES.has(run[0].w.toLowerCase())) titled = true; run.shift(); }
      while (run.length && STOP.has(run[run.length - 1].w.toLowerCase().replace(/[^a-z]/g, ""))) run.pop();
      if (run.length && run.length <= 3 && run.every((r) => r.w.length >= 3)) add(run.map((r) => r.w).join(" "), run.some((r) => r.mid), run.length, titled);
      run = [];
    };
    toks.forEach((t, i) => {
      const clean = t.replace(/^[("'“‘\[]+|[)"'”’,;:.!?\]]+$/g, "");
      const isWord = word.test(clean) && /^[A-ZÀ-Þ]/.test(clean) && !/^[A-Z]{2,}$/.test(clean.replace(/[^A-Za-z]/g, "")) && !/\d/.test(clean);
      if (isWord) {
        const prev = toks[i - 1] ?? "";
        const sentenceStart = i === 0 || /[.!?:]$/.test(prev) || /^[(\d]/.test(prev);
        run.push({ w: clean.replace(/[’]/g, "'"), mid: !sentenceStart });
        if (/[,;:.!?)]$/.test(t)) flush();   // punctuation ends a name
      } else flush();
    });
    flush();
  }
  const scored = [...counts.entries()].filter(([term, e]) => {
    if (e.words > 1) return true;                                   // "Walfred Road": specific enough
    // A lone capitalized word is a name only with evidence: it follows a title ("Councillor Harder"), or it's seen mid-sentence
    // twice and doesn't look like an ordinary word (Inaugural, Procedure, Amending, Recreation are headings, not names).
    if (STOP.has(term.toLowerCase()) || term.length < 4) return false;
    if (e.titled > 0) return true;
    return e.mid >= 2 && !/(ing|ed|ive|ous|ary|tion|sion|ment|ness|ure|ity|al|ular|able|ible|ant|ent|ful|less)$/i.test(term);
  }).map(([term, e]) => ({ term, score: e.n * (1 + 0.6 * (e.words - 1)) + e.mid * 0.5 + Math.min(term.length, 12) / 40 }));
  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  // A single word that's part of a kept phrase adds nothing.
  const out: string[] = [];
  let chars = 0;
  for (const { term } of scored) {
    if (out.length >= (o.max ?? MAX_TERMS)) break;
    if (out.some((x) => x.toLowerCase().includes(term.toLowerCase()))) continue;
    if (chars + term.length + 2 > (o.maxChars ?? MAX_CHARS)) continue;
    out.push(term); chars += term.length + 2;
  }
  return out;
}

export function agendaTermsFromHtml(html: string, o?: { max?: number; maxChars?: number }): string[] { return agendaTerms(textOf(html), o); }

// --- writing it for the transcriber ---

/** Merge `vocab_extra` into <dir>/transcribe.json, keeping whatever else is there (speaker counts, a vocab name). Never overwrites one set by hand. */
export function writeVocabExtra(dir: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const f = path.join(dir, "transcribe.json");
  let cur: Record<string, unknown> = {};
  try { const j = JSON.parse(readFileSync(f, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) cur = j as Record<string, unknown>; } catch { /* none yet */ }
  if (cur.vocab_extra_by_hand === true) return false;
  const text = `${terms.join(", ")}.`;
  if (cur.vocab_extra === text) return false;
  mkdirSync(dir, { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...cur, vocab_extra: text }, null, 1));
  renameSync(tmp, f);
  return true;
}

export const hasVocabExtra = (dir: string): boolean => {
  try { return typeof JSON.parse(readFileSync(path.join(dir, "transcribe.json"), "utf8")).vocab_extra === "string"; } catch { return false; }
};

// --- fetching the agenda ---

/** An address a public web page is served from: not loopback, private, link-local or unspecified. */
export function isPublicAddress(a: string): boolean {
  if (net.isIPv4(a)) {
    const [x, y] = a.split(".").map(Number);
    return !(x === 10 || x === 127 || x === 0 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || x >= 224);
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    return !(l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("::ffff:"));
  }
  return false;
}

export type FetchText = (url: string) => Promise<{ type: string; body: string } | null>;

/** The agenda page as text, or null: only public http(s) hosts, HTML only, 3 MB, 20 s. */
export const fetchAgenda: FetchText = async (url) => {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
  try {
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) return null;
    const r = await fetch(u, { headers: { "User-Agent": "minutes/0.2 (meeting recorder; +https://github.com/LangfordOGSociety/minutes)", Accept: "text/html" },
      redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (!/html/i.test(type) || Number(r.headers.get("content-length") ?? 0) > 3_000_000) return null;
    return { type, body: (await r.text()).slice(0, 3_000_000) };
  } catch (e) { log.debug(`agenda ${u.host}: ${(e as Error).message}`); return null; }
};

/** Read the meeting's agenda and leave its names for the transcriber. True if something was written. */
export async function prepareVocab(o: { dir: string; agendaUrl: string | undefined; fetchText?: FetchText }): Promise<boolean> {
  if (!o.agendaUrl) return false;
  const page = await (o.fetchText ?? fetchAgenda)(o.agendaUrl);
  if (!page) return false;
  const terms = agendaTermsFromHtml(page.body);
  const wrote = writeVocabExtra(o.dir, terms);
  if (wrote) log.info(`${path.basename(o.dir)}: ${terms.length} agenda term(s) for the transcriber: ${terms.slice(0, 8).join(", ")}...`);
  return wrote;
}

export const dirExists = (d: string) => existsSync(d);
