/**
 * Granicus MediaManager video (stream method): the player page of an archived
 * clip (`/player/clip/<id>`) or an event (`/player/event/<id>`) on a city's
 * own Granicus site (saanich.ca.granicus.com, ...). The page carries the
 * HLS playlist URL (`video_url="..."`), which ffmpeg records into MKV parts
 * like any other stream, so stitching, the transcriber and the public page
 * are unchanged.
 *
 * Clips are ARCHIVES: the meeting is over and its video is published, so
 * the capture is an import. It starts at once whatever the meeting's date
 * (Platform.isArchive), records the whole video and ends when it's read
 * (RecorderInput.once). That path is verified against a real Saanich clip:
 * the page's playlist records as h264 720p + aac.
 *
 * Events are the live path and are NOT verified live (no meeting was
 * streaming when this was built). The page of a live event is expected to
 * carry a playlist that isn't under /OnDemand/; before it starts, none. An
 * event whose playlist IS under /OnDemand/ has been archived and is treated
 * like a clip. Check this against the first real live Granicus meeting.
 *
 * Granicus's CDN refuses requests whose User-Agent looks like a tool (curl,
 * ffmpeg's own): it returns 403. The conventional "Mozilla/5.0 (compatible;
 * name; +url)" form, which says who we are, is accepted, so that is what the
 * page fetch and ffmpeg send. The playlist URL from the page must be https on
 * a granicus.com host before ffmpeg is given it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RecorderInput } from "../recorder.js";
import { logger } from "../util.js";
import { State, type CaptureSession, type Platform, type SessionOpts } from "./types.js";

const log = logger("granicus");

export const UA = "Mozilla/5.0 (compatible; minutes/0.2; +https://github.com/LangfordOGSociety/minutes)";
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.granicus\.com$/i;

export interface Ref { host: string; kind: "clip" | "event"; id: string }

/** The site, kind and id of a Granicus player or MediaPlayer link, or null. Strict: https, no credentials or port, a city's own subdomain. */
export function refOf(link: string): Ref | null {
  let u: URL;
  try { u = new URL(link.trim().replace(/^\/\//, "https://")); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOST_RE.test(host) || host === "granicus.com" || host.split(".").length < 3) return null;
  const pm = /^\/player\/(clip|event)\/(\d{1,9})\/?$/.exec(u.pathname);
  if (pm) return { host, kind: pm[1] as Ref["kind"], id: pm[2] };
  if (/^\/MediaPlayer\.php$/i.test(u.pathname)) {
    const clip = /^\d{1,9}$/.test(u.searchParams.get("clip_id") ?? "") ? u.searchParams.get("clip_id")! : null;
    const event = /^\d{1,9}$/.test(u.searchParams.get("event_id") ?? "") ? u.searchParams.get("event_id")! : null;
    if (clip && !event) return { host, kind: "clip", id: clip };
    if (event && !clip) return { host, kind: "event", id: event };
  }
  return null;
}

const canonical = (r: Ref) => `https://${r.host}/player/${r.kind}/${r.id}`;

/** The HLS playlist the player page plays, if it names one. */
export function playlistOf(html: string): string | null {
  const direct = /\bvideo_url\s*=\s*"([^"]+)"/.exec(html)?.[1];
  const any = direct ?? /https?:(?:\\?\/){2}[^"'\s<>\\]+(?:\\\/[^"'\s<>\\]*)*?\.m3u8[^"'\s<>]*/.exec(html)?.[0]?.replace(/\\\//g, "/");
  return any && /^https?:\/\//.test(any) ? any : null;
}

/** May ffmpeg be given this? https on a granicus.com host. */
export const safePlaylist = (url: string): boolean => { try { const u = new URL(url); return u.protocol === "https:" && HOST_RE.test(u.hostname) && !u.username && !u.password; } catch { return false; } };

const isArchiveUrl = (url: string) => /\/OnDemand\//i.test(url);

export type Fetched = { status: number; url: string; body: string };
export type FetchPage = (url: string) => Promise<Fetched>;

const fetchPage: FetchPage = async (url) => {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  const text = (await r.text()).slice(0, 6_000_000);
  return { status: r.status, url: r.url || url, body: text };
};

const POLL_WAITING_MS = 30_000, POLL_LIVE_MS = 60_000, POLL_OTHER_MS = 10_000;

export class GranicusSession implements CaptureSession {
  needsEmail = false;
  onChange: (state: string) => void = () => {};
  onSpeaker: (name: string) => void = () => {};
  onCaption: (text: string) => void = () => {};

  private st: State = State.LOADING;
  private playlist: string | null = null;
  private lastAt = -Infinity;
  private closed = false;

  constructor(private ref: Ref, private o: { fetchPage?: FetchPage; now?: () => number } = {}) {}

  private now() { return this.o.now?.() ?? Date.now(); }

  async open(): Promise<void> { await this.refresh(true); }
  async close(): Promise<void> { this.closed = true; }
  async state(): Promise<State> { await this.refresh(false); return this.st; }
  async advance(): Promise<void> { /* nothing to click */ }

  private async refresh(force: boolean): Promise<void> {
    if (this.closed) return;
    // A clip is read once: its playlist doesn't change. Events are polled.
    const every = this.st === State.IN_MEETING ? (this.ref.kind === "clip" || (this.playlist && isArchiveUrl(this.playlist)) ? Infinity : POLL_LIVE_MS)
      : this.st === State.WAITING ? POLL_WAITING_MS : POLL_OTHER_MS;
    if (!force && this.now() - this.lastAt < every) return;
    this.lastAt = this.now();
    const before = this.st;
    try {
      const page = await (this.o.fetchPage ?? fetchPage)(canonical(this.ref));
      if (page.status === 404 || page.status === 410) this.st = State.INVALID;
      else if (page.status >= 400) { if (this.st !== State.IN_MEETING) this.st = State.LOADING; }
      else {
        let host = ""; try { host = new URL(page.url).hostname.toLowerCase(); } catch { /* keep "" */ }
        const url = playlistOf(page.body);
        if (!HOST_RE.test(host)) this.st = State.INVALID;                                  // redirected off Granicus
        else if (url && safePlaylist(url)) { this.playlist = url; this.st = State.IN_MEETING; }
        else if (url) this.st = State.INVALID;                                             // a playlist we won't hand to ffmpeg
        else this.st = this.ref.kind === "event" ? State.WAITING : State.INVALID;          // an event that hasn't started; a clip with no video
      }
    } catch (e) {
      log.warn(`${this.ref.host} ${this.ref.kind} ${this.ref.id}: ${(e as Error).message}`);
      if (this.st !== State.IN_MEETING) this.st = State.LOADING;
    }
    if (this.st !== before) this.onChange(this.st);
  }

  input(): RecorderInput {
    if (!this.playlist) throw new Error("no video to record yet");
    return {
      kind: "stream", copy: true, once: isArchiveUrl(this.playlist),
      args: ["-user_agent", UA, "-headers", `Referer: https://${this.ref.host}/\r\n`, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10", "-i", this.playlist],
    };
  }

  async dump(dir: string, label: string): Promise<void> {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${label}.granicus.json`), JSON.stringify({ state: this.st, ref: this.ref, hasPlaylist: !!this.playlist, archive: this.playlist ? isArchiveUrl(this.playlist) : null }, null, 2));
    } catch { /* a debug aid */ }
  }
}

export const granicus: Platform = {
  id: "granicus",
  label: "Granicus",
  methods: ["stream"],
  savedLogin: false,
  match: (link) => refOf(link) !== null,
  normalize(link) {
    const r = refOf(link);
    if (!r) throw new Error("not a Granicus video link (https://<city>.granicus.com/player/clip/<id>, or the MediaPlayer.php link with clip_id or event_id)");
    return canonical(r);
  },
  publicId: (link) => { const r = refOf(link); return r ? `${r.host.split(".")[0]} ${r.kind} ${r.id}` : "?"; },
  publicUrl: (link) => { const r = refOf(link); return r ? canonical(r) : undefined; },
  isArchive: (link) => refOf(link)?.kind === "clip",
  extractLink(text) {
    for (const m of text.matchAll(/(?:https:)?\/\/[a-z0-9.-]+\.granicus\.com\/(?:MediaPlayer\.php\?[^\s"'<>]*|player\/(?:clip|event)\/\d+[^\s"'<>]*)/gi)) {
      const r = refOf(m[0].replace(/&amp;/g, "&"));
      if (r) return canonical(r);
    }
    return undefined;
  },
  create(link: string, _o: SessionOpts): CaptureSession {
    const r = refOf(link);
    if (!r) throw new Error("not a Granicus video link");
    return new GranicusSession(r);
  },
};
