/**
 * Speaker names, added by hand. The transcriber labels voices "Speaker 1",
 * "Speaker 2"... (and sometimes a Zoom name); an admin can say who they
 * are. The names live beside the recording in speaker-names.json (a map
 * from the transcriber's label to a name) and are APPLIED WHEN SERVING, not
 * written into the transcript files, so the originals stay as the
 * transcriber made them, a re-run of the transcriber loses nothing, and
 * undoing a name is deleting one line. Two labels given the same name are
 * merged (one person split into several voices).
 *
 * Applied to what people read: `<slug>.transcript.json` (segment `label`,
 * and `names_applied: true`), `<slug>.vtt` (`<v Label>`), `<slug>.srt`
 * (`Label: ` at the start of a cue's text) and `<slug>.txt` (the
 * `[hh:mm:ss] Label:` headers), anchored to where the transcriber puts
 * labels so a name that is also spoken in the talk isn't touched. The
 * search index is built from the named segments too (search.ts).
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const NAMES_FILE = "speaker-names.json";
export type Names = Record<string, string>;
export type NameKind = "json" | "vtt" | "srt" | "txt";

/** Which readable transcript file this is, if it is one. */
export function kindOf(slug: string, file: string): NameKind | null {
  if (file === `${slug}.transcript.json`) return "json";
  if (file === `${slug}.vtt`) return "vtt";
  if (file === `${slug}.srt`) return "srt";
  if (file === `${slug}.txt`) return "txt";
  return null;
}

export function readNames(dir: string): Names {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, NAMES_FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => typeof v === "string" && v.trim() && k).map(([k, v]) => [k, String(v)]));
  } catch { return {}; }
}

export function writeNames(dir: string, names: Names): void {
  const f = path.join(dir, NAMES_FILE), tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(names, null, 1));
  renameSync(tmp, f);
}

export class NamesError extends Error {}

/** A names map from what an admin sent: only labels the transcript has, tidy values; an empty value removes a name. */
export function cleanNames(input: unknown, validLabels: Set<string>): Names {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new NamesError("names must be an object of label: name");
  const out: Names = {};
  for (const [label, v] of Object.entries(input as Record<string, unknown>)) {
    if (!validLabels.has(label)) throw new NamesError(`"${label.slice(0, 40)}" isn't a speaker in this transcript`);
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string") throw new NamesError(`the name for ${label} must be text`);
    const name = v.replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (name.length > 60) throw new NamesError(`the name for ${label} is over 60 characters`);
    if (/[<>&\u0000-\u001f\u007f]/.test(name)) throw new NamesError(`the name for ${label} can't contain < > & or control characters`);
    out[label] = name;
  }
  return out;
}

interface Seg { start?: number; end?: number; text?: string; label?: string; zoom_speaker?: string }
const labelOf = (s: Seg) => String(s.label || s.zoom_speaker || "");

/** The labels in a transcript, in order of first appearance, with how much each speaks and a first line. */
export function labelsOf(transcript: unknown): { label: string; segments: number; seconds: number; first: { t: number; text: string } }[] {
  const segs = ((transcript as { segments?: Seg[] } | null)?.segments ?? []).filter((s) => Number.isFinite(Number(s.start)));
  const by = new Map<string, { label: string; segments: number; seconds: number; first: { t: number; text: string } }>();
  for (const s of segs) {
    const label = labelOf(s);
    if (!label) continue;
    const e = by.get(label) ?? { label, segments: 0, seconds: 0, first: { t: Number(s.start), text: String(s.text ?? "").trim().slice(0, 140) } };
    e.segments++;
    e.seconds += Math.max(0, Number(s.end) - Number(s.start)) || 0;
    by.set(label, e);
  }
  return [...by.values()].map((e) => ({ ...e, seconds: Math.round(e.seconds) }));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One of the readable files with the names put in. Unchanged when there are none. */
export function applyNames(kind: NameKind, text: string, names: Names): string {
  const keys = Object.keys(names).sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  const alt = keys.map(esc).join("|");
  const swap = (m: string) => names[m] ?? m;
  switch (kind) {
    case "json": {
      const t = JSON.parse(text) as { segments?: Seg[]; names_applied?: boolean };
      let any = false;
      for (const s of t.segments ?? []) { const n = names[labelOf(s)]; if (n) { s.label = n; any = true; } }
      if (any) t.names_applied = true;
      return JSON.stringify(t, null, 1);
    }
    case "vtt": return text.replace(new RegExp(`^<v (${alt})>`, "gm"), (_m, l: string) => `<v ${swap(l)}>`);
    case "srt": return text.replace(new RegExp(`^(${alt}): `, "gm"), (_m, l: string) => `${swap(l)}: `);
    case "txt": return text.replace(new RegExp(`^(\\[\\d\\d:\\d\\d:\\d\\d\\] )(${alt}):$`, "gm"), (_m, t: string, l: string) => `${t}${swap(l)}:`);
  }
}

/** Segments with names put in, for the search index. */
export function nameSegments<T extends Seg>(segs: T[], names: Names): T[] {
  if (!Object.keys(names).length) return segs;
  return segs.map((s) => { const n = names[labelOf(s)]; return n ? { ...s, label: n } : s; });
}

/** Read and apply for one file; null if there's nothing to apply (serve the file itself). */
export function namedFile(dir: string, slug: string, file: string, cache: Map<string, string>): string | null {
  const kind = kindOf(slug, file);
  if (!kind) return null;
  const names = readNames(dir);
  if (!Object.keys(names).length) return null;
  const full = path.join(dir, file), nf = path.join(dir, NAMES_FILE);
  if (!existsSync(full)) return null;
  const key = `${full}|${statKey(full)}|${statKey(nf)}`;
  let out = cache.get(key);
  if (out === undefined) {
    try { out = applyNames(kind, readFileSync(full, "utf8"), names); } catch { return null; }
    if (cache.size > 24) cache.delete(cache.keys().next().value as string);
    cache.set(key, out);
  }
  return out;
}

function statKey(f: string): string { try { const s = statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return "0"; } }
