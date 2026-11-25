# Modularization plan

Status: design, 2026-11-24, revised the same day with the owner's
decisions. Nothing here is built yet. Ticket numbers refer to issues in
LangfordOGSociety/minutes (project board "minutes").

Goal: turn minutes from "one admin schedules Zoom links by hand" into a
public archive that finds meetings on its own, records them from more than
one platform, publishes them automatically, and lets the public watch and
(with their own token) download them.

1. **Feeds.** Pluggable parsers read municipal agenda sites, calendars and
   channels, detect meeting times and join links, and are polled on a
   schedule. Every change (new meeting, moved, link changed, cancelled) is
   recorded and can schedule, update or cancel a capture.
2. **Platforms.** Zoom becomes one capture platform of several. First new
   ones: YouTube (stream pull and screen capture) and Microsoft Teams.
3. **Public site.** Anyone can see upcoming and past meetings and watch
   them. Recordings publish automatically; while one is being processed its
   page says so, and each result (video, captions, transcript) appears as
   soon as it exists. Only admins configure feeds and captures.
4. **Accounts and tokens.** Two roles: `admin` and `user`. Anyone can sign
   up as a `user` and create their own API tokens to download videos and
   transcripts; usage is tracked per token and per user, with room for
   rate limits and a speed throttle later.
5. **Extensibility.** Adding a parser or a platform is one file plus a
   registry line, documented in two short guides.

Out of scope here: notifications, agenda chapters, transcript search,
official-video linking, storage tiers, takedown workflow, metrics. Those
will be handled by openlangford.ca. The one surrounding feature kept is
nightly backups.

## What stays the same

- The capture child process model in `jobs.ts`: one CLI process per
  capture, its own Xvfb display and null sink. The runner's recovery logic
  is what's been tested live; it gets a platform interface, not a rewrite.
- Every invariant in CLAUDE.md, now for every platform: never send audio or
  video into a meeting, `mediaGuard()` first in every frame of every
  browser-based platform, MKV parts, SIGTERM still stitches, atomic
  manifest writes.
- `recordings/<slug>/` layout and the transcriber's file contract. The
  transcriber doesn't need to know about feeds, users or platforms.
- No runtime npm deps beyond playwright (see Storage and Mail for how).
- The k8s namespace/labels stay `zoom-capture` (see CLAUDE.md).

## Architecture after the change

```
                 +-------------------- minutes serve ---------------------+
 agenda sites    |  feeds/poller.ts -> feeds/<parser>.ts -> diff -> changes|
 calendars  ---->|        |                                   |           |
 channels        |        v                                   v           |
                 |   meetings table  <----- policy ------> jobs (scheduler)|
                 |        |                                   |           |
 public  <-------|  public pages (live status) / API (tokens) | spawn     |
 users   <-------|  account pages (sign-up, tokens, usage)    |           |
 admins  <-------|  admin pages (feeds, captures, audit log)  v           |
                 +--------------------------------  minutes <capture CLI> -+
                                                       runner.ts
                                                         |  Platform registry
                                       +-----------------+---------------+
                                       v                 v               v
                                 platforms/zoom   platforms/teams  platforms/youtube
                                 (screen)         (screen)         (stream or screen)
                                       \                 |               /
                                        recorder.ts: screen input | stream input
```

### Source layout

```
src/
  db.ts                  node:sqlite wrapper, migrations, tx helper
  mail.ts                minimal SMTP client (node:tls), verification + reset mail
  auth/users.ts          users, roles, password hashing (scrypt), sessions
  auth/tokens.ts         API tokens, usage logging, rate-limit + throttle hooks
  feeds/types.ts         FeedParser interface, DetectedMeeting
  feeds/registry.ts      id -> parser
  feeds/poller.ts        schedules runs, conditional GET, backoff
  feeds/diff.ts          snapshot -> change events
  feeds/ical.ts          built-in parsers, one file each
  feeds/html.ts
  feeds/escribe.ts       Langford
  feeds/granicus.ts      Saanich
  feeds/youtube.ts
  platforms/types.ts     Platform + CaptureSession interfaces, State
  platforms/registry.ts  link -> platform (also the link allowlist)
  platforms/guard.ts     mediaGuard(), shared by every browser platform
  platforms/zoom.ts      today's zoom.ts, MARKERS unchanged
  platforms/teams.ts
  platforms/youtube.ts   stream and screen methods
  web/public.ts          public pages + API, meeting status
  web/account.ts         sign-up, login, tokens, own usage
  web/admin.ts           admin pages + API
  ...existing runner, recorder, stitch, timeline, jobs, session
docs/extending/feed-parsers.md
docs/extending/platforms.md
test/fixtures/feeds/<parser>/*.html|ics|json
```

## Storage

Users, sessions, tokens, usage, feed history and change logs are relational
and write-heavy; `jobs.json` won't stretch that far. Use **`node:sqlite`**,
built into Node 22.13+ / 24 with no flag, so the "playwright only" rule
holds. This needs the image's Node bumped from 20.18 to 24 LTS (check the
ICU tzdata override in the Dockerfile still applies).

The database lives at `<out>/minutes.db` on the existing volume (WAL mode,
one writer: the server process; capture children keep writing only their
own `manifest.json`). `jobs.json` is imported once on first start and kept
as `jobs.json.migrated`.

Tables (first cut):

| table | purpose |
|---|---|
| `users` | id, email, name, role (`admin` or `user`), password_hash, email_verified_at, disabled_at, last_login_at |
| `sessions` | sha256(cookie), user_id, expires_at, ip, user_agent |
| `email_codes` | sha256(code), user_id, purpose (`verify`, `reset`), expires_at, used_at |
| `feeds` | parser id, name, config JSON, interval, policy, enabled, etag/last-modified, last_ok_at, last_error |
| `feed_runs` | per poll: started, finished, status, item count, content hash, error |
| `meetings` | one per real-world meeting: feed_id, external_id, title, body/committee, platform, capture method, link (secret), start, est. end, status, visibility, slug |
| `meeting_changes` | meeting_id, feed_run_id, kind, field, old, new, at |
| `jobs` | today's Job plus `meeting_id` (a meeting can have several capture attempts) |
| `api_tokens` | user_id, prefix, sha256(secret), label, scopes, expires_at, revoked_at, last_used_at |
| `token_usage` | token_id, user_id, at, method, route, status, bytes, ip (raw, pruned after N days) |
| `token_usage_daily` | rollup per token per day: requests, bytes, errors |
| `audit_log` | user_id, at, action, target, detail (every admin write) |

`meetings` vs `jobs`: today the job *is* the meeting. Splitting them lets a
feed update a meeting (new time, new link) and have the scheduler follow,
lets the public page list meetings that won't be captured, and lets one
meeting have a failed attempt plus a successful retry.

## Feeds

### Parser interface

```ts
export interface FeedParser<C = unknown> {
  id: string;                        // "ical", "escribe", "granicus", "youtube"
  label: string;
  fields: FieldSpec[];               // drives the admin form
  validate(config: unknown): C;      // throw BadRequest with a field name
  fetch(config: C, ctx: FeedContext): Promise<FeedResult>;
}

export interface FeedContext {
  http(url: string, init?: RequestInit): Promise<Response>; // UA, timeout, cond. GET, size cap
  page(url: string): Promise<Page>;  // headless Playwright for JS-rendered sites
  tz: string; now: Date; log: Logger;
}

export interface DetectedMeeting {
  externalId: string;                // stable across polls (agenda id, UID, video id)
  title: string;
  body?: string;                     // "Council", "Committee of the Whole"
  start: Date;
  end?: Date;
  link?: string;                     // join/watch link if published
  agendaUrl?: string;
  cancelled?: boolean;
}

export type FeedResult = { notModified: true } | { meetings: DetectedMeeting[] };
```

Rules for parsers: fetch and parse only. No DB access, no scheduling, no
writing files. Everything after `fetch()` (diffing, policy, scheduling) is
core code, so a parser bug can't cancel a capture except by what it
returns, and the diff step guards that too (below). HTML parsing without a
dependency: use `ctx.page()` (Playwright is already in the image) for
anything non-trivial; regex only for tiny, stable pages.

### Built-in parsers, in order

1. **eScribe** (Langford): base URL
   `https://pub-langford.escribemeetings.com/`. The site has an RSS feed
   and the calendar page calls JSON endpoints
   (`MeetingsCalendarView.aspx/GetCalendarMeetings`, `.../PastMeetings`);
   prefer the JSON for times and meeting ids, then each meeting's page for
   the join link and agenda URL. Agendas often print only an ID and a
   numeric passcode: build `https://zoom.us/j/<id>?pwd=<passcode>`. Config
   takes the base URL and an optional list of meeting types (the site has
   ~20: Council Meeting, Committee of the Whole, Special ...). eScribe is
   used by many municipalities, so this parser should only need the base
   URL to work elsewhere.
2. **Granicus** (Saanich, next target): same shape, own parser.
   Granicus has several products (Legistar, the older MediaManager
   ViewPublisher pages, Peak agenda); find which Saanich uses first.
3. **iCal** (`.ics` URL): UID as externalId, `LOCATION`/`DESCRIPTION`
   scanned for a supported link.
4. **Generic HTML**: config is a URL plus CSS selectors (row, title, date,
   link) and a date format. Covers one-off sites without code.
5. **YouTube channel**: the channel's upcoming/live streams (scheduled
   start, video id). Pairs with the YouTube platform.

### Polling

- Per-feed interval (default 1h; 5 min on the day of a known meeting, so a
  late link change is caught before join time).
- Conditional GET (ETag / Last-Modified) and a content hash: unchanged
  content ends the run without diffing.
- Jitter, a per-host concurrency of 1, and exponential backoff on errors
  (cap 6h). A feed failing for 24h shows red in the admin UI.
- "Run now" and "Preview" (fetch + parse + diff, nothing saved) buttons.

### Change tracking

Each run's result is diffed against the feed's current meetings by
`externalId`:

| change | when | default effect |
|---|---|---|
| `added` | new externalId | policy decides (below) |
| `time_changed` | start moved | reschedule the job if not started |
| `link_changed` | link added/changed | update the job's link (stays secret) |
| `cancelled` | parser reports it | cancel the job, keep the meeting, mark cancelled |
| `removed` | missing from a run | **only flagged**, never auto-cancels |
| `details_changed` | title/body/agenda | recorded only |

`removed` is deliberately passive: a broken parser returning zero rows must
not cancel every capture. Safety valve: a run that would remove more than
half the feed's future meetings is stored as `suspect` and applies nothing.

Per-feed **policy**: `auto` (schedule captures for new meetings with a
supported link), `review` (new meetings wait for an admin to approve), or
`list_only` (public listing, no capture). Default `review` until a parser
has been trusted for a few weeks.

**Dedup:** the same meeting can come from two feeds (agenda site and
YouTube channel). Match on normalized link, else same body + start within
15 min, and link them rather than creating two captures. Admin can merge or
split by hand.

## Platforms

### Interface

The seam already exists: `runner.ts` only uses `open / close / state /
advance / dump`, `needsEmail` and the three callbacks of `ZoomSession`.

```ts
export interface Platform {
  id: string;                        // "zoom", "teams", "youtube"
  label: string;
  match(link: string): boolean;      // also the link allowlist
  publicId(link: string): string;    // safe to show (meeting id, video id)
  methods: CaptureMethod[];          // first is the default
  create(opts: SessionOpts & { method: CaptureMethod }): CaptureSession;
}

export type CaptureMethod = "screen" | "stream";

export interface CaptureSession {
  open(): Promise<void>;
  close(): Promise<void>;
  state(): Promise<State>;           // shared State enum
  advance(state: State): Promise<void>;
  dump(dir: string, label: string): Promise<void>;
  input(): RecorderInput;            // screen (display + sink) or stream (url/args)
  needs: null | "email" | "passcode" | "signin";
  onChange: (s: string) => void;
  onSpeaker?: (name: string) => void;
  onCaption?: (text: string) => void;
}
```

The capture method is chosen per meeting (default from the platform,
overridable per feed and per meeting in the admin UI). `jobs.ts` only
allocates an Xvfb display and null sink for `screen` jobs.

`jobs.ts` link validation and `meetingId()` in `serve.ts` move to the
registry. `session.ts` (saved login keep-alive) becomes Zoom-specific and
only runs when Zoom jobs exist.

### YouTube

Two methods, both supported:

- **`stream`** (default): `yt-dlp` (pinned binary in the image, not an npm
  dep) reports `live_status` (`is_upcoming`, `is_live`, `post_live`,
  `was_live`), which maps onto the existing states (`waiting`,
  `in_meeting`, `ended`), and records with `--live-from-start` into MKV
  parts, so a late start or a dropped connection still gets the beginning.
  Original quality, no Xvfb or sink, cheap. After the stream ends, fetch
  the archived VOD and prefer it if it's longer.
- **`screen`**: open the watch page in headed Chromium on the job's Xvfb
  display and record it like Zoom (x11grab + pulse). Player state from the
  page (`waiting for stream`, playing, `stream ended`). For when yt-dlp is
  blocked or broken by a YouTube change. `mediaGuard()` still applies
  (YouTube never asks for a mic, but the rule is per platform, not per
  site).

`auto` (the per-meeting default) starts with `stream` and, if yt-dlp fails
twice before the first frame, switches the next part to `screen`. Parts of
both kinds stitch together (stitch already re-encodes on mismatch).

Risks: YouTube's bot checks ("Sign in to confirm you're not a bot") hit
datacenter IPs harder than the homelab; recent yt-dlp releases also need an
external JS runtime (Deno) for YouTube. Verify both when building, and plan
to update yt-dlp often (a separate image layer).

### Microsoft Teams

Screen method, like Zoom: `teams.microsoft.com/l/meetup-join/...` ->
"Continue on this browser" -> name -> "Join now" -> lobby -> in meeting.
Anonymous join depends on the organizer's tenant policy; detect "you need
to sign in" as `blocked`, like Zoom's 9516. Town halls / live events are
view-only and may be closer to a stream. Same requirements as Zoom before
any live run: `mediaGuard()` first, camera never granted, verified peak
level 0 in the image, own `MARKERS` table, saved-HTML fixtures for each
screen.

### Recorder

`recorder.ts` gets an input spec instead of display/sink:
`{ kind: "screen", display, sink }` (today) or `{ kind: "stream", args }`
(ffmpeg/yt-dlp reading a URL, `-c copy` where possible). Parts stay MKV
with the same flush settings; stitch and timeline don't change.

## Accounts, roles, public access

- **Roles**: `admin` and `user`, via a role -> capability map (new roles
  are data, not code). The first admin is created with `minutes user add
  --admin <email>` (prints a one-time password); admins can promote users.
- **Sign-up**: anyone can register as `user` with email + password
  (scrypt from `node:crypto`). The email must be verified (emailed code)
  before the account can create tokens. Password reset by emailed code.
  Abuse controls: per-IP sign-up and login rate limits, a honeypot field,
  unverified accounts deleted after 7 days. Admins can disable a user,
  which revokes their tokens and sessions.
- **Sessions**: random 32-byte cookie, stored hashed, `HttpOnly; Secure;
  SameSite=Lax`, 14-day sliding expiry. `CAPTURE_WEB_TOKEN` Basic auth is
  removed once this lands.
- **Permissions**:

| capability | public | user | admin |
|---|---|---|---|
| list upcoming/past meetings, watch, read transcripts, live status | yes | yes | yes |
| create/revoke own API tokens, see own usage | no | yes (verified) | yes |
| download files via API (with a token) | no | yes | yes |
| see join links, live screen, logs, Zoom login status | no | no | yes |
| manage feeds, captures, meetings, users, all tokens and usage | no | no | yes |

- **Hardening** for internet exposure: same-origin check already exists;
  add CSP and security headers, `X-Forwarded-For` trusted only from a
  configured proxy, request size and time caps, no directory listing (the
  existing slug/extension rules stay), admin routes under `/admin` so a
  proxy can also restrict them.
- **Audit log** of every admin write (who, what, before/after), shown in
  the admin UI.

### Mail

Sign-up needs outgoing mail. A minimal SMTP submission client on
`node:tls` (implicit TLS on 465, AUTH PLAIN, one message at a time, about
150 lines) keeps the no-deps rule and works with any provider or relay.
Configured with `SMTP_URL` and `MAIL_FROM` from a secret. Without it,
sign-up is off and admins create accounts by hand.

## Publishing and processing status

Recordings are **public by default**, the moment they exist. `hidden` stays
as an admin-only override for pulling one. Each meeting page shows where
the meeting is, in place, and fills in as results land, without a reload
(the page polls a small `/api/meetings/:id/status` every 10-30s while
anything is pending):

| stage | page shows | source |
|---|---|---|
| `upcoming` | date, time, body, countdown, agenda link | `meetings` |
| `live` | "Recording now", elapsed time, live transcript draft (marked draft) | job status, `<slug>/live.json` |
| `stitching` | "Processing the video" | manifest `outcome` set, no mp4 yet |
| `video_ready` | player; Zoom captions if any; "Transcript in progress, N%" | `<slug>.mp4`, `transcript.status.json` |
| `ready` | player with transcript track and panel | `<slug>.vtt`, `.transcript.json` |
| `failed` / `not_recorded` | plain explanation, link to the city's own video page | job outcome |

Getting results out sooner:
- The video is playable right after stitch (a remux, seconds to minutes).
- Live mode drafts (already built) are shown during the meeting and until
  the final transcript replaces them.
- Speaker labels from Zoom (`<slug>.speakers.json`) show before
  diarization finishes.
- The transcriber writes the final files atomically, so the page never
  shows a half-written transcript.

## API tokens and usage

- Token format `mnt_<8-char prefix>_<32 random bytes base64url>`. Only the
  sha256 is stored; the prefix identifies it in logs and the UI. Shown once.
- Every token belongs to a user (`api_tokens.user_id`). Fields: label,
  scopes (`read`, `download`), optional expiry, revoked_at, last_used_at.
  Verified users create and revoke their own (up to 5 active); admins see
  and revoke all.
- API (`/api/v1`, `Authorization: Bearer`): list meetings, meeting detail
  and status, file list, file download with Range. Public read endpoints
  work without a token; downloads need one.
- Usage: every token request logged with its token and user (route,
  status, bytes actually sent, counting Range responses), rolled up daily,
  raw rows pruned after 90 days. Users see their own; admins see per token
  and per user: requests and GB per day, last used, top files.
- Rate limits: a `limit(token, route)` hook is called on every request and
  returns "allow" for now. Later a token bucket from a per-user or
  per-token `limits` column, `429` + `Retry-After`.
- Speed throttle: an optional bytes/second cap for downloads, per token and
  global, **off by default** (the homelab has 1 Gb/s upload). Implemented
  as a paced stream in the file server so it can be switched on from
  config without code changes.
- Document the API in an OpenAPI file served at `/api/v1/openapi.json`
  with a short human page. Note there: anything playable in a browser can
  be saved, so tokens are about tracking and fair use of bulk access, not
  protecting files.

## Extensibility docs

Two short guides, each under ~150 lines, each ending in a checklist:

- `docs/extending/feed-parsers.md`: the interface, a minimal parser,
  externalId rules, timezone handling, saving fixtures, `minutes feed test
  <parser> --config ... [--fixture file]` to run a parser offline and print
  the meetings it found.
- `docs/extending/platforms.md`: the interface, capture methods, state
  mapping, `MARKERS` convention, the media-safety checklist (guard first,
  camera never granted, peak-level test in the image), fixtures,
  `CAPTURE_DEBUG` dumps, what must be verified live before enabling it.

CLAUDE.md's Layout section shrinks to point at these.

## Backups

Nightly `VACUUM INTO` of `minutes.db` plus `auth/` to a second location
(k8s CronJob or in-process timer), keeping 14 days, with a documented and
tested restore. Recordings themselves are out of scope (large, and the
city publishes its own copy). (#31)

## Phases

Order matters: nothing becomes public before accounts exist.

| phase | contents | tickets |
|---|---|---|
| 0. Foundations | Node 24 + SQLite, jobs.json migration, meeting/job split, Platform interface with Zoom moved behind it, recorder inputs | #1, #2, #3, #4 |
| 1. Accounts | admin + user roles, sessions, hardening, audit log, sign-up with mail, backups | #5, #6, #7, #32, #31 |
| 2. Feeds | parser interface + admin UI, poller, change tracking, policy + dedup, iCal/HTML, eScribe (Langford), Granicus (Saanich) | #8-#13, #34 |
| 3. Public site | public pages, auto-publish, in-place processing status | #14, #33 |
| 4. API tokens | user-owned tokens, download API, usage, OpenAPI, throttle option | #16-#19, #36 |
| 5. Platforms | YouTube stream + screen methods, YouTube channel feed, Teams | #20, #35, #21, #22 |
| 6. Docs | extension guides + offline test harness | #23 |

## Decisions (2026-11-24)

1. Tokens are self-serve: anyone can sign up as a `user` and create their
   own; tokens and usage are tied to the user account.
2. Recordings publish automatically, with processing status shown on the
   meeting page and results shown as soon as they exist.
3. Langford uses eScribe (`pub-langford.escribemeetings.com`, has RSS);
   Saanich, the next target, uses Granicus.
4. Homelab has 1 Gb/s upload: no throttling now, but a throttle option
   exists for later.
5. YouTube supports both a stream-pull and a screen-capture method.
6. Surrounding features other than backups are left to openlangford.ca.

7. Sign-up mail goes through Cloudflare Email Service as
   `minutes@emc2.build` (2026-11-25), the same sender Alertmanager uses.

Still open:
- The public never sees join links (proposed: link to the city's own
  meeting page instead).
