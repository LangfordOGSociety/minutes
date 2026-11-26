/**
 * YouTube, stream method (#20): the meeting is a YouTube live stream, and
 * we pull it with yt-dlp (a pinned binary in the image: YT_DLP, default
 * `yt-dlp`) instead of recording a browser. No Xvfb, no sound sink, no
 * login, original quality, a few percent of a CPU core.
 *
 * yt-dlp only *describes* the video (`--dump-single-json`): its
 * `live_status` becomes our State, and its HLS playlist URLs become ffmpeg
 * inputs, which the normal recorder copies into MKV parts. YouTube serves
 * video and audio as separate playlists, so a part has two inputs and an
 * explicit -map (RecorderInput.map).
 *
 *   is_upcoming        WAITING     (polled every 20 s)
 *   is_live            IN_MEETING  (once there are HLS formats to read)
 *   post_live, was_live, "live stream recording is not available"  ENDED
 *   private, removed, unavailable, bad URL                         INVALID
 *   "confirm you're not a bot", age gate, members only             BLOCKED
 *   anything else (network, YouTube hiccups)                       keeps the last state
 *
 * A late start still gets the beginning: when the stream has been live for
 * more than two minutes when the first part starts, the first part's HLS
 * inputs begin at the start of the playlist (`-live_start_index 0`, the
 * DVR window), then catch up to live. Later parts (after a drop) start at
 * the live edge, so nothing is recorded twice.
 *
 * Not verified live from the homelab: whether YouTube's bot check fires from
 * its IP (the check was only run from a residential one, where it worked
 * without a JavaScript runtime), how far back the DVR window goes, and
 * the "fetch the archived VOD and prefer it if longer" step (not built).
 * Test fixtures are trimmed from a real yt-dlp 2026.10.21 run on a live
 * stream (test/fixtures/youtube).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RecorderInput } from "../recorder.js";
import { logger } from "../util.js";
import { State, type CaptureSession, type Platform, type SessionOpts } from "./types.js";

const log = logger("youtube");

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The video id of a YouTube watch / live / short link, or null. Strict: https(s), no credentials, no port, known hosts only. */
export function videoIdOf(link: string): string | null {
  let u: URL;
  try { u = new URL(link.trim()); } catch { return null; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.port || !HOSTS.has(u.hostname.toLowerCase())) return null;
  let id: string | null = null;
  if (u.hostname.toLowerCase() === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (u.pathname === "/watch") id = u.searchParams.get("v");
  else { const m = /^\/(?:live|embed)\/([^/]+)\/?$/.exec(u.pathname); id = m ? m[1] : null; }
  return id && ID_RE.test(id) ? id : null;
}

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

// --- what yt-dlp says ------------------------------------------------------

export interface YtFormat { url?: string; vcodec?: string | null; acodec?: string | null; height?: number | null; protocol?: string; format_id?: string }
export interface YtInfo {
  id?: string; live_status?: string | null; is_live?: boolean; release_timestamp?: number | null; timestamp?: number | null;
  requested_formats?: YtFormat[]; formats?: YtFormat[]; url?: string; vcodec?: string | null; acodec?: string | null;
}

export type YtProblem = "blocked" | "invalid" | "ended" | "waiting" | "transient";

/** What a yt-dlp error message means for the capture. */
export function classifyError(stderr: string): YtProblem {
  if (/confirm you.?re not a bot|sign in to confirm your age|age[- ]restricted|members[- ]only|join this channel|sign in to confirm/i.test(stderr)) return "blocked";
  if (/live stream recording is not available|live event has ended|stream has ended/i.test(stderr)) return "ended";
  if (/will begin in|premieres in|live event will begin|scheduled for/i.test(stderr)) return "waiting";
  if (/private video|video unavailable|this video is (unavailable|not available)|has been removed|account.*terminated|no longer available|not a valid url|unsupported url|incomplete youtube id|does not exist/i.test(stderr)) return "invalid";
  return "transient";
}

// HLS audio playlists come with vcodec "none" and an acodec of null (seen in a real run): audio-only is "no video codec", not "has an audio codec".
const hasVideo = (f: YtFormat) => !!f.vcodec && f.vcodec !== "none";
const isAudioOnly = (f: YtFormat) => f.vcodec === "none" || (!f.vcodec && !!f.acodec && f.acodec !== "none");
const hasAudio = (f: YtFormat) => !!f.acodec && f.acodec !== "none";

/** The streams to read: yt-dlp's own pick (`requested_formats`, or the one `url`), at most one video and one audio. */
export function streamsOf(info: YtInfo): { video?: string; audio?: string; combined?: string } | null {
  const picked = info.requested_formats?.length ? info.requested_formats : info.url ? [{ url: info.url, vcodec: info.vcodec, acodec: info.acodec }] : [];
  const urls = picked.filter((f): f is YtFormat & { url: string } => typeof f.url === "string" && /^https?:\/\//.test(f.url));
  if (!urls.length) return null;
  const both = urls.find((f) => hasVideo(f) && hasAudio(f));
  if (both) return { combined: both.url };
  const video = urls.find(hasVideo), audio = urls.find(isAudioOnly);
  if (!video && !audio) return { combined: urls[0].url };
  return { video: video?.url, audio: audio?.url };
}

/** State of a described video; null if it's live but has nothing to read yet. */
export function stateOf(info: YtInfo): State | null {
  switch (info.live_status) {
    case "is_upcoming": return State.WAITING;
    case "is_live": return streamsOf(info) ? State.IN_MEETING : null;
    case "post_live": case "was_live": case "not_live": return State.ENDED;
  }
  return info.is_live ? (streamsOf(info) ? State.IN_MEETING : null) : null;
}

/** ffmpeg input arguments for the streams, and the -map that picks them. */
export function recorderInput(info: YtInfo, o: { fromStart: boolean }): RecorderInput {
  const s = streamsOf(info);
  if (!s) throw new Error("no stream to record yet");
  const inputs = [s.combined, s.video, s.audio].filter((x): x is string => !!x);
  const args = inputs.flatMap((url) => ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
    ...(o.fromStart ? ["-live_start_index", "0"] : []), "-i", url]);
  const map = s.combined ? ["-map", "0:v:0?", "-map", "0:a:0?"]
    : s.video && s.audio ? ["-map", "0:v:0", "-map", "1:a:0"]
    : s.video ? ["-map", "0:v:0"] : ["-map", "0:a:0"];
  return { kind: "stream", args, copy: true, map };
}

// --- running yt-dlp --------------------------------------------------------

export type Described = { ok: true; info: YtInfo } | { ok: false; problem: YtProblem; message: string };

/** `yt-dlp --dump-single-json` for one video. Never throws. */
export function describeVideo(id: string, o: { bin?: string; maxHeight?: number; timeoutMs?: number } = {}): { promise: Promise<Described>; kill: () => void } {
  const bin = o.bin ?? process.env.YT_DLP ?? "yt-dlp";
  const h = o.maxHeight ?? 1080;
  const args = ["--no-warnings", "--no-playlist", "--skip-download", "--ignore-no-formats-error", "--dump-single-json",
    "-f", `bv*[height<=?${h}]+ba/b[height<=?${h}]`, watchUrl(id)];
  let proc: ChildProcess | null = null;
  const promise = new Promise<Described>((resolve) => {
    let out = "", err = "";
    const done = (d: Described) => resolve(d);
    try { proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return done({ ok: false, problem: "transient", message: String(e) }); }
    const timer = setTimeout(() => { proc?.kill("SIGKILL"); }, o.timeoutMs ?? 60_000);
    proc.stdout!.on("data", (c: Buffer) => { if (out.length < 40_000_000) out += c.toString("utf8"); });
    proc.stderr!.on("data", (c: Buffer) => { if (err.length < 20_000) err += c.toString("utf8"); });
    proc.on("error", (e) => { clearTimeout(timer); done({ ok: false, problem: "transient", message: `can't run ${bin}: ${e.message}` }); });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(out) as YtInfo | null;
        if (info && typeof info === "object") return done({ ok: true, info });
      } catch { /* fall through to the error */ }
      const message = (err.trim().split("\n").filter((l) => /ERROR/.test(l)).pop() ?? err.trim() ?? "yt-dlp failed").slice(0, 400);
      done({ ok: false, problem: classifyError(err), message });
    });
  });
  return { promise, kill: () => { proc?.kill("SIGKILL"); } };
}

// --- the session -----------------------------------------------------------

const POLL_WAITING_MS = 20_000, POLL_LIVE_MS = 45_000, POLL_OTHER_MS = 10_000;
const LATE_START_MS = 2 * 60_000;

export class YouTubeSession implements CaptureSession {
  needsEmail = false;
  onChange: (state: string) => void = () => {};
  onSpeaker: (name: string) => void = () => {};
  onCaption: (text: string) => void = () => {};

  private st: State = State.LOADING;
  private info: YtInfo | null = null;
  private last: Described | null = null;
  private lastAt = 0;
  private running: { promise: Promise<Described>; kill: () => void } | null = null;
  private started = 0;           // parts started so far
  private closed = false;

  constructor(private id: string, private o: { bin?: string; maxHeight?: number; now?: () => number; describeFn?: typeof describeVideo } = {}) {}

  private now() { return this.o.now?.() ?? Date.now(); }

  async open(): Promise<void> { await this.refresh(true); }

  async close(): Promise<void> { this.closed = true; this.running?.kill(); }

  async state(): Promise<State> { await this.refresh(false); return this.st; }

  /** Ask yt-dlp again when it's due (more often while there's nothing to record). */
  private async refresh(force: boolean): Promise<void> {
    if (this.closed) return;
    const every = this.st === State.IN_MEETING ? POLL_LIVE_MS : this.st === State.WAITING ? POLL_WAITING_MS : POLL_OTHER_MS;
    if (!force && this.now() - this.lastAt < every) return;
    if (this.running) return void await this.running.promise;
    this.running = (this.o.describeFn ?? describeVideo)(this.id, { bin: this.o.bin, maxHeight: this.o.maxHeight });
    let d: Described;
    try { d = await this.running.promise; } finally { this.running = null; }
    this.lastAt = this.now();
    this.last = d;
    const before = this.st;
    if (d.ok) {
      this.info = d.info;
      this.st = stateOf(d.info) ?? (this.st === State.IN_MEETING ? State.IN_MEETING : State.LOADING);
    } else if (d.problem === "blocked") this.st = State.BLOCKED;
    else if (d.problem === "invalid") this.st = State.INVALID;
    else if (d.problem === "ended") this.st = State.ENDED;
    else if (d.problem === "waiting") this.st = State.WAITING;
    else if (this.st !== State.IN_MEETING) this.st = State.LOADING;   // a hiccup while recording changes nothing
    if (!d.ok) log.warn(`${this.id}: ${d.problem}: ${d.message}`);
    if (this.st !== before) this.onChange(this.st);
  }

  async advance(): Promise<void> { /* nothing to click */ }

  input(): RecorderInput {
    if (!this.info) throw new Error("no stream described yet");
    const info = this.info;
    // A stream that was already live for a while when we first start: begin at the start of its DVR window.
    const since = (info.release_timestamp ?? info.timestamp ?? 0) * 1000;
    const late = this.started === 0 && since > 0 && this.now() - since > LATE_START_MS;
    this.started++;
    return recorderInput(info, { fromStart: late });
  }

  async dump(dir: string, label: string): Promise<void> {
    try {
      mkdirSync(dir, { recursive: true });
      // The stream URLs are signed; keep the shape, not the URLs.
      const strip = (f: YtFormat) => ({ ...f, url: f.url ? "(url)" : undefined });
      const i = this.info;
      writeFileSync(path.join(dir, `${label}.yt.json`), JSON.stringify({ state: this.st, last: this.last && !this.last.ok ? this.last : "ok",
        live_status: i?.live_status, release_timestamp: i?.release_timestamp, requested_formats: i?.requested_formats?.map(strip) }, null, 2));
    } catch { /* a debug aid */ }
  }
}

export const youtube: Platform = {
  id: "youtube",
  label: "YouTube",
  methods: ["stream"],
  savedLogin: false,
  match: (link) => videoIdOf(link) !== null,
  normalize(link) {
    const id = videoIdOf(link);
    if (!id) throw new Error("not a YouTube video link (https://www.youtube.com/watch?v=..., youtu.be/..., or youtube.com/live/...)");
    return watchUrl(id);
  },
  publicId: (link) => videoIdOf(link) ?? "?",
  publicUrl: (link) => { const id = videoIdOf(link); return id ? watchUrl(id) : undefined; },
  extractLink(text) {
    for (const m of text.matchAll(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>]*|live\/[A-Za-z0-9_-]+)|youtu\.be\/[A-Za-z0-9_-]+)/g)) {
      const id = videoIdOf(m[0].replace(/&amp;/g, "&"));
      if (id) return watchUrl(id);
    }
    return undefined;
  },
  create(link: string, _o: SessionOpts): CaptureSession {
    const id = videoIdOf(link);
    if (!id) throw new Error("not a YouTube video link");
    return new YouTubeSession(id, { maxHeight: Number(process.env.YOUTUBE_MAX_HEIGHT) || undefined });
  },
};
