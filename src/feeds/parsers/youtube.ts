/**
 * YouTube channels (#21): the channel's live and upcoming streams, for
 * councils that stream on YouTube. Pairs with the YouTube platform
 * (platforms/youtube.ts): each stream comes with its watch link as the join
 * link, so the capture can be scheduled from the feed.
 *
 * No API key. Two kinds of page, both read with ctx.http:
 * 1. The channel's /streams tab: its `ytInitialData` lists the videos. Only
 *    the ones that are live now ("N watching" / a LIVE badge) or upcoming
 *    ("N waiting", "Scheduled for ...") matter; past streams are skipped.
 *    The "Scheduled for 11/29/26, 7:25 AM" text is in the *requester's*
 *    timezone, so it is never used for the time.
 * 2. Each candidate's watch page: its `ytInitialPlayerResponse` has the real
 *    start (`liveBroadcastDetails.startTimestamp`, ISO with offset, or the
 *    offline slate's epoch `scheduledStartTime`) and whether it's live.
 *
 * Both are YouTube's internal page data, which changes without notice
 * (this layout, `lockupViewModel`, replaced `videoRenderer`; the old shape is
 * still read). When the data isn't there the run fails with a message
 * instead of returning nothing, so a broken parser looks broken. Fixtures
 * are trimmed from real pages saved 2026-11-26 (NASA's channel).
 *
 * externalId = the video id (stable). A stream cancelled before it starts
 * simply disappears from the tab; the sync flags that (never deletes).
 */
import { registerParser } from "../registry.js";
import { ConfigError, cfg, type DetectedMeeting, type FeedParser } from "../types.js";

interface Config { channel: string; titleFilter: string[]; maxVideos: number }

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const HEADERS = { "Accept-Language": "en-US,en;q=0.9" };

/** The channel's /streams URL from a channel URL, handle or id; throws ConfigError. */
export function streamsUrl(input: string): string {
  const s = input.trim();
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return `https://www.youtube.com/channel/${s}/streams`;
  if (/^@[A-Za-z0-9._-]{3,30}$/.test(s)) return `https://www.youtube.com/${s}/streams`;
  let u: URL;
  try { u = new URL(s); } catch { throw new ConfigError("channel", "must be a channel URL (https://www.youtube.com/@name), a @handle, or a channel id (UC...)"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOSTS.has(u.hostname.toLowerCase())) throw new ConfigError("channel", "must be a youtube.com channel");
  const m = /^\/(@[A-Za-z0-9._-]{3,30}|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)(?:\/(?:streams|live|videos|featured|about))?\/?$/.exec(u.pathname);
  if (!m) throw new ConfigError("channel", "must be a channel page (/@name, /channel/UC..., /c/name or /user/name), not a video or playlist");
  return `https://www.youtube.com/${m[1]}/streams`;
}

/** The JSON object assigned to `name` in a page's inline script. */
export function pageJson(html: string, name: string): unknown | null {
  const i = html.indexOf(`var ${name} = `);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  if (start < 0) return null;
  // Walk to the matching brace (strings may contain braces).
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; } }
  }
  return null;
}

type J = Record<string, any>;

/** Every object stored under `key` anywhere in the data. */
function* find(o: unknown, key: string): Generator<J> {
  if (Array.isArray(o)) { for (const v of o) yield* find(v, key); }
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o as J)) { if (k === key && v && typeof v === "object") yield v as J; yield* find(v, key); }
  }
}

export interface Candidate { id: string; title: string; live: boolean; upcoming: boolean; start?: Date }

/** The live and upcoming videos in a channel tab's data. Past streams are left out. */
export function candidates(data: unknown): Candidate[] {
  const out = new Map<string, Candidate>();
  // The current layout: lockupViewModel, status in the metadata rows and a badge on the thumbnail.
  for (const L of find(data, "lockupViewModel")) {
    const id = typeof L.contentId === "string" ? L.contentId : "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || (L.contentType && !/VIDEO/.test(String(L.contentType)))) continue;
    const md = L.metadata?.lockupMetadataViewModel ?? {};
    const parts: string[] = (md.metadata?.contentMetadataViewModel?.metadataRows ?? []).flatMap((r: J) => (r.metadataParts ?? []).map((p: J) => String(p.text?.content ?? "")));
    const badges: string[] = [...find(L, "thumbnailBadgeViewModel")].map((b) => String(b.badgeStyle ?? "") + " " + String(b.text ?? ""));
    const live = parts.some((p) => /\bwatching\b/i.test(p)) || badges.some((b) => /BADGE_STYLE_LIVE\b/.test(b));
    const upcoming = !live && (parts.some((p) => /\bwaiting\b|^scheduled for\b|^premieres\b/i.test(p)) || badges.some((b) => /UPCOMING/i.test(b)));
    if (live || upcoming) out.set(id, { id, title: String(md.title?.content ?? ""), live, upcoming });
  }
  // The older layout: videoRenderer, with the start time right there.
  for (const v of find(data, "videoRenderer")) {
    const id = typeof v.videoId === "string" ? v.videoId : "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || out.has(id)) continue;
    const styles: string[] = (v.thumbnailOverlays ?? []).map((o: J) => String(o.thumbnailOverlayTimeStatusRenderer?.style ?? ""));
    const live = styles.includes("LIVE"), upcoming = !live && (styles.includes("UPCOMING") || !!v.upcomingEventData);
    if (!live && !upcoming) continue;
    const secs = Number(v.upcomingEventData?.startTime);
    out.set(id, { id, title: String(v.title?.runs?.[0]?.text ?? v.title?.simpleText ?? ""), live, upcoming, start: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : undefined });
  }
  return [...out.values()];
}

/** What a watch page says about a stream: when it starts (or started), and whether it's live. */
export function watchInfo(html: string): { title?: string; start?: Date; live: boolean; upcoming: boolean; unavailable?: string } | null {
  const d = pageJson(html, "ytInitialPlayerResponse") as J | null;
  if (!d) return null;
  const vd = d.videoDetails ?? {}, mf = d.microformat?.playerMicroformatRenderer ?? {}, ps = d.playabilityStatus ?? {};
  const b = mf.liveBroadcastDetails ?? {};
  const slate = ps.liveStreamability?.liveStreamabilityRenderer?.offlineSlate?.liveStreamOfflineSlateRenderer ?? {};
  let start: Date | undefined;
  for (const x of [b.startTimestamp, Number(slate.scheduledStartTime) ? new Date(Number(slate.scheduledStartTime) * 1000).toISOString() : undefined]) {
    const t = x ? new Date(x) : undefined;
    if (t && !Number.isNaN(t.getTime())) { start = t; break; }
  }
  const live = vd.isLive === true || b.isLiveNow === true;
  const upcoming = vd.isUpcoming === true || ps.status === "LIVE_STREAM_OFFLINE";
  const unavailable = ps.status === "ERROR" || ps.status === "UNPLAYABLE" || ps.status === "LOGIN_REQUIRED" ? String(ps.reason ?? ps.status) : undefined;
  return { title: typeof vd.title === "string" ? vd.title : mf.title?.simpleText, start, live, upcoming, unavailable };
}

export const youtubeChannel: FeedParser<Config> = {
  id: "youtube",
  label: "YouTube channel (live and upcoming streams)",
  description: "A YouTube channel's live and upcoming streams, e.g. https://www.youtube.com/@CityOfExample. Each is recorded from its stream (the YouTube platform).",
  fields: [
    { name: "channel", label: "Channel", type: "text", required: true, placeholder: "https://www.youtube.com/@CityOfExample", help: "A channel URL, a @handle, or a channel id (UC...)." },
    { name: "titleFilter", label: "Only titles containing", type: "list", help: "One per line, any match (e.g. Council). Blank: every live or upcoming stream." },
    { name: "maxVideos", label: "Most streams to check", type: "number", placeholder: "12" },
  ],
  validate(c) {
    const o = cfg.obj(c);
    const channel = cfg.text(o, "channel", true, 200)!;
    streamsUrl(channel);
    return { channel, titleFilter: cfg.list(o, "titleFilter"), maxVideos: cfg.int(o, "maxVideos", 12, 1, 30) };
  },
  host() { return "https://www.youtube.com/"; },
  async fetch(c, ctx) {
    const url = streamsUrl(c.channel);
    const page = await ctx.http(url, { headers: HEADERS });
    const data = pageJson(page.body, "ytInitialData");
    if (!data) throw new Error("YouTube didn't return the channel's streams as expected (a consent page, or YouTube changed its layout); try again later");
    const want = c.titleFilter.map((t) => t.toLowerCase());
    const cands = candidates(data).filter((x) => !want.length || want.some((t) => x.title.toLowerCase().includes(t))).slice(0, c.maxVideos);
    const out: DetectedMeeting[] = [];
    for (const x of cands) {
      const link = `https://www.youtube.com/watch?v=${x.id}`;
      let start = x.start, title = x.title, live = x.live;
      if (!start || live) {
        try {
          const w = watchInfo((await ctx.http(link, { headers: HEADERS })).body);
          if (!w) throw new Error("no player data on the watch page");
          if (w.unavailable) { ctx.log(`${x.id} ${x.title}: unavailable (${w.unavailable})`); continue; }
          start = w.start ?? start;
          title = w.title || title;
          live = live || w.live;
        } catch (e) { ctx.log(`${x.id} ${x.title}: ${(e as Error).message}`); }
      }
      if (!start) { ctx.log(`${x.id} ${x.title}: no start time found, skipped`); continue; }
      // A stream that has been live for days is a 24/7 loop, not a meeting.
      if (live && start.getTime() < ctx.now.getTime() - 24 * 3_600_000) { ctx.log(`${x.id} ${x.title}: live since ${start.toISOString().slice(0, 10)}, skipped (a 24/7 stream)`); continue; }
      out.push({ externalId: x.id, title, start, link, pageUrl: link, streamUrl: link });
    }
    ctx.log(`${cands.length} live or upcoming stream(s) on the channel, ${out.length} with a start time`);
    return { meetings: out };
  },
};

registerParser(youtubeChannel);
