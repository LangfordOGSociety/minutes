# minutes

Records a Zoom meeting end to end without host cooperation: waits for the
scheduled start, joins via the Zoom web client in headed Chromium on Xvfb,
records screen + audio with ffmpeg, survives drops by rejoining as new parts,
and stitches the parts into one MP4 with a chapter at every gap.

First target is City of Langford council meetings, which are public, run on
Zoom, and publish the official video 24-48h later. The goal is having video
(and later transcripts) the same night.

Renamed from zoom-capture (2026-11-24). The homelab k8s deployment moved
to namespace `minutes` the same day by rebinding the same Ceph volume (PV
now `Retain`), see `deploy/k8s/MIGRATION.md`. Images are
`ghcr.io/langfordogsociety/minutes` and `minutes-transcriber`, built and
deployed by CI on push to main (`.github/workflows/`, deploy waits for
captures).

## Layout

- `src/index.ts` CLI (node:util parseArgs, no deps). Sets TZ before use.
- `src/runner.ts` lifecycle state machine. Event-driven via `Waker`.
- `src/platforms/` the platform seam. `types.ts`: `Platform` (id, match,
  normalize, publicId, methods, savedLogin, create) and `CaptureSession`
  (open/close/state/advance/dump, needsEmail, three callbacks) plus the
  runner's `State`. `registry.ts`: link -> platform; unclaimed links are
  refused (replaces the old `*.zoom.us` check in jobs.ts). `guard.ts`:
  `mediaGuard()`, first init script of every browser platform.
- `src/platforms/granicus.ts` Granicus MediaManager video, method `stream`:
  a clip (`/player/clip/<id>`, also `MediaPlayer.php?clip_id=`) or event
  page on a city's own `<city>.granicus.com`; the page's
  `video_url="....m3u8"` is the ffmpeg input. A CLIP is an ARCHIVE
  (`Platform.isArchive`): imported at once whatever the meeting's date
  (`Scheduler.parseStart(.., archive)`, the child gets `--archive` so
  there is no start to miss), `RecorderInput.once` ends the capture when
  ffmpeg reads it to the end (exit 0 -> "ended" after one part; a failed
  read is discarded and retried, 3 tries then outcome `archive_failed`).
  VERIFIED on a real Saanich clip (clip 1326, 3 min: 19 s, h264 720p +
  aac). EVENTS (live) are NOT verified live: assumed a playlist not under
  /OnDemand/ while live, none before; under /OnDemand/ = archived. The CDN
  403s tool-like User-Agents (curl, ffmpeg's own) but accepts
  `Mozilla/5.0 (compatible; minutes/0.2; +url)`, which page fetch and
  ffmpeg both send; the playlist must be https on granicus.com. Sync:
  a meeting that's over but has an archive link and no recording is
  imported if within 45 days (`archiveOk`; per policy: auto schedules,
  review queues it (the review view lists past archives), list_only only
  lists); never twice (`scheduleMeeting` refuses if a job is done). The
  PrimeGov parser makes a finished meeting's published Granicus clip its
  link. NOT built: reading the Granicus ViewPublisher archive table.
- `src/platforms/youtube.ts` (#20) YouTube live streams, method `stream`:
  yt-dlp (pinned standalone binary in its own Dockerfile layer, `YT_DLP`
  env, bump it first when YouTube breaks) only DESCRIBES the video
  (`--dump-single-json`, `-f bv*[height<=?1080]+ba/b`, cap `YOUTUBE_MAX_HEIGHT`):
  `live_status` -> State (is_upcoming WAITING, is_live IN_MEETING once HLS
  formats exist, post_live/was_live ENDED; bot check BLOCKED; private/gone
  INVALID; network hiccups keep the last state) and the HLS playlist URLs
  become ffmpeg inputs (`RecorderInput.map`: YouTube serves video and audio
  as separate playlists, and the audio one has acodec null: audio-only
  means vcodec "none"). No Xvfb, sink or login. First part starts at the
  playlist start (`-live_start_index 0`) only if the stream was already
  live >2 min; later parts at the live edge. State polled 20 s waiting /
  45 s live. NOT built: fetching the archived VOD afterwards. Verified
  from a residential IP without Deno (2026-11-26: a real 24/7 stream,
  state in_meeting, two HLS inputs copied into h264 1080p + aac MKV; the
  from-start part pulled the 6 min DVR window in 14 s); NOT verified from
  the homelab IP (bot check). Fixtures: test/fixtures/youtube
  (trimmed real yt-dlp 2026.10.21 output). Zoom wins when an agenda has
  both a Zoom and a YouTube link (`findLink` order).
- `src/platforms/zoom.ts` Playwright session + the `zoom` Platform. **All Zoom-specific markers live in `MARKERS`.**
  `pageAgent()` is injected into every frame with `addInitScript`; it must stay
  self-contained (it's serialized, so no references outside the function).
- `src/recorder.ts` ffmpeg -> MKV parts from a `RecorderInput`: `screen`
  (x11grab + pulse, encoders x264 / vaapi / nvenc) or `stream` (ffmpeg input
  args for a URL, `-c copy` or encoded). The session picks it
  (`CaptureSession.input()`, screen when absent). Stream jobs get no Xvfb or
  sink from the scheduler. `videoStart` comes from the latest `out_time` line.
- `src/stitch.ts` remux-repair each part, concat with chapters, re-encode fallback.
- `src/login.ts` `minutes login`: human signs in once, saves storage state.
- `src/serve.ts` `minutes serve`: node:http web UI + JSON API, Range
  serving for video, accounts and sessions (cookie), same-origin
  check on writes. Every route checks a capability, never a role name.
  `createApp()` is everything but listen/signals (tests drive it over HTTP). Only serves .mp4/.mkv/.png/.json/.vtt/.srt/.txt directly inside
  a slug dir.
- `src/accounts.ts` users (roles `admin` / `user`, ROLE_CAPS -> capabilities,
  "public" = no session), async scrypt hashes with their params, sessions
  (32-byte cookie, sha256 stored, 14-day sliding, written at most every
  10 min), in-memory failure limits. A one-time password (`minutes user
  add|passwd`) sets must_change_password: until changed, the session has
  public capabilities only. The last active admin can't be demoted/disabled.
- `src/db.ts` `<out>/minutes.db` via `node:sqlite` (Node 24, no deps): WAL,
  numbered append-only migrations in `PRAGMA user_version`, `tx()` helper.
  Only the server opens it; capture children write their own manifest.json.
- `src/meetings.ts` one row per real-world meeting (title, body, platform,
  secret link, start, visibility, base slug). A job is one capture attempt
  of a meeting (`Job.meetingRef`; the API's `meetingId` is still the Zoom
  number). Scheduling by hand creates both. Link/start edits go through
  `Scheduler.updateMeeting()`, which copies them to attempts that haven't
  launched. `retry()` (`POST /api/admin/jobs/:id/retry`, "Record again") adds an
  attempt in `<slug>-2`, `-3`... starting now or at the meeting's time.
- `src/jobs.ts` scheduler: `jobs` table (old jobs.json imported once, kept
  as jobs.json.migrated), mirrors running/stopping jobs to `active.json`
  for the transcriber, launches the normal CLI as a
  child per job with its own Xvfb display (:100+) and null sink (zoom_<n>)
  via DISPLAY / CAPTURE_SINK / PULSE_SINK. Never touches the default source.
  Links are restricted to *.zoom.us or bare IDs; the meeting password never
  leaves the server (API returns meetingId only).
  Scheduled/queued jobs can be edited (`PATCH /api/admin/jobs/:id`, Edit button):
  blank fields keep their value (the page never has the link, so a blank
  link means "keep"), all fields validated before any is applied, refused
  once the job starts launching.
  Optional per-job `email` (typed only when Zoom requires one, overrides
  CAPTURE_EMAIL for that child): never returned by the API (`publicJob()`
  sends `hasEmail` only); edit keeps it when blank, `clearEmail` removes it.
- `src/session.ts` keeps the saved login alive: opens zoom.us/profile with
  it in headed Chromium on the server's :99 display, writes refreshed cookies
  back when signed in, never touches the file when not. Daily, once 2h before
  each scheduled launch, 30 min after an error, and as soon as the auth file
  changes after a failed check. Only runs once a job uses a platform with
  `savedLogin` (Zoom). Skipped while a capture runs (the capture
  writes the file back itself). State in `<out>/session.json`, banner in the
  page, optional CAPTURE_NOTIFY_URL. Never types a password: re-login stays
  manual (`minutes login`). Also `minutes check-login`.
- `src/backup.ts` nightly backup (in `serve`, when BACKUP_DIR is set):
  `VACUUM INTO` copy of minutes.db + the saved login into
  `<dir>/minutes-YYYY-MM-DD_HHMM/` with `backup.json` (schema, counts,
  sha256), checked before the temp folder is renamed into place; 14 days,
  never deletes the newest; failure notifies once, retries hourly, and must
  never throw out of the timer. `minutes backup` / `minutes restore`
  (restore copies first, then renames, old files kept as
  `*.before-restore-<time>`). k8s: `backups` CephFS PVC, `restore.sh`.
- `src/pages/` the pages, as String.raw templates: their scripts must not
  use backticks or dollar-brace. All data goes in via textContent; build
  children with `fill()`, not `replaceChildren()` (which renders a null arg
  as "null"). `common.ts` (CSS, helpers, replay player, live transcript)
  is pasted into `public.ts` (`/`) and `admin.ts` (`/admin`); `login.ts`.
  Served with a CSP of their script's sha256 (net.ts `pageCsp`), so no
  eval and no inline handlers: attach listeners in the script.
- `src/site.ts` the public site's model (Phase 3): a meeting row + its
  jobs + its recording folder -> `PublicMeeting` with a `stage` (upcoming,
  live, stitching, video_ready, ready, failed, not_recorded, cancelled;
  `stageOf()`), visible = not hidden / duplicate / pending or rejected
  review. Public id = the meeting slug (`/m/<slug>` also resolves a
  capture's folder name, so old `/#recording` links work). Public history
  = whitelisted change kinds only (announced, date/time moved, cancelled,
  reinstated, documents), never link changes or review/merge entries.
  Endpoints (cap `watch`): `/api/meetings?scope=upcoming|past&body&from&
  to&q&limit&offset` (+ `bodies`), `/api/meetings/:slug` (+ recording,
  history), `/api/meetings/:slug/status` (polled by the page),
  `/api/changes`. Pages: `/` (upcoming, past with filters, recent
  updates), `/m/:slug` (banner per stage, player, live draft, city
  links/documents, history; title/description injected per meeting).
  Permalinks: `/m/<slug>` (slug = the meeting's, stable; canonical, Open
  Graph and oEmbed discovery tags in the head, absolute from PUBLIC_URL
  else the request's host), `?t=90|1m30s|1:30` starts the video there; the
  page's Share box has the link, a link at the current time and iframe
  code. Embed: `/embed/<slug>` (pages/embed.ts) is the video alone for
  other sites' iframes (`?transcript=1&chapters=1&title=0&t=&theme=`),
  the ONLY page that may be framed: frame-ancestors from EMBED_ORIGINS
  (net.ts `embedAncestors`: `*` default, `none`, or origins), X-Frame-
  Options removed for it only; no sign-in, no admin calls. `/oembed?url=`
  (JSON, CORS *) for sites that support oEmbed.
  Admin override: `POST /api/admin/meetings/:id/hide|show` (page, listing
  and /media all 404 while hidden). Public types have no link/feed fields:
  keep it that way (test/site.test.ts greps the JSON).
- `src/tokens.ts` API tokens + usage (Phase 4, migration 10).
  `mnt_<8 hex prefix>_<43 base64url>`, only sha256 stored, shown once,
  5 active per user, scopes read (always) / download, optional expiry;
  disabling a user revokes theirs (`Accounts.setDisabled`), and every
  request re-checks the owner (`capsFor`: verified, not must-change).
  A token is accepted on `/api/v1/*` ONLY (never as a session: tests
  assert an admin's token opens nothing under /admin). `/api/v1`: the
  public meetings/changes endpoints plus `/meetings/:id/files[/:name]`
  (download = token with `download`, Range, only the public recording's
  files, never manifest/parts/live), `/me`, `/openapi.json`; `/api/docs`
  is the human page (`src/apidocs.ts`; a test keeps the OpenAPI paths and
  the routes in step). Invalid Authorization on /api/v1 = 401 even for
  public endpoints. Usage: one `api_usage` row per token request (route
  pattern, status, body bytes actually written via `countBytes`, ip,
  file), 90 days, plus `api_usage_daily` per token per UTC day (kept);
  `Tokens.limiter(token, route)` is called for every token request and
  allows all today (`{allow:false, retryAfterS}` -> 429 + Retry-After; the
  `limits` column is reserved). CORS `*` on the public reads (/api/v1,
  /api/meetings, /api/changes, /media, /oembed) incl. OPTIONS preflight
  for Authorization and Range; never on admin/session routes. Own tokens
  and usage: `/api/account/tokens|usage` (Account page); all: `/api/admin/
  tokens|usage` (Admin page). Download speed caps (`src/throttle.ts`,
  #36, OFF by default): DOWNLOAD_MAX_BPS (all API downloads together) and
  DOWNLOAD_TOKEN_BPS (each token), plain bytes/s or k/m/g (x1000); a
  token's own `limits.downloadBps` (admin `PATCH /api/admin/tokens/:id`)
  overrides the per-token one. Token buckets paced through a Transform in
  `serveFile`, so Range works and usage counts what was written; /media
  (playback) is never throttled.
- `src/search.ts` public transcript search (migration 11: FTS5
  `transcript_search` of ~30 s passages cut at speaker changes, porter +
  unicode61, plus `transcript_index` of each file's size/mtime so changed
  or removed transcripts are re-indexed/dropped; rebuildable from the
  files). Everything is indexed, but WHO may see a hit is decided at query
  time by the meeting ids serve.ts passes (public, recording public,
  transcript present, body/date filters), so hiding a meeting hides its
  words at once. User text is NEVER FTS syntax: `parseQuery` extracts
  words and "phrases" and quotes each (AND/OR/NEAR/col: are plain words;
  last word is a prefix; 8 terms max). `/api/search` and `/api/v1/search`
  (`q body from to limit offset`) -> passages with `parts` (hit flags, no
  markup), `t` seconds and `url` = `/m/<slug>?t=<s>`; `/search` page; a
  search box on `/`; 60 searches a minute per client (`searchesByIp`,
  429 + Retry-After; behind the proxy that's the real client via
  TRUSTED_PROXIES). Index sync: at start, every 2 min, and on a search
  if >30 s old (`App.syncSearch`). node:sqlite FTS5 verified on Node 24.
- `src/alerts.ts` email alerts (migration 12: alerts, alert_deliveries,
  alert_runs; capability `alerts.own`, confirmed email, needs mail).
  A saved search (<=10 per person, body optional) whose owner is emailed
  when a NEW meeting's transcript matches. `processAlerts` runs after every
  search index pass: for each visible meeting with a transcript not in
  alert_runs it runs each applicable alert against just that meeting
  (same query rules/visibility as search) and sends ONE email per person
  (matches, links at the second, a stop link per alert). Once per
  (alert, meeting) via alert_deliveries, so a retry after a mail failure
  only sends what's missing; the meeting is marked handled when every send
  succeeded or after 8 tries. Meetings that began >30 days ago are never
  alerted and the first pass after deploy just marks the existing ones
  handled (an alert made today must not announce the archive). Owners
  who are gone/disabled/unconfirmed lose their matching alerts. The email's
  stop link `/alerts/<token>/stop` is a PAGE that asks (mail scanners
  prefetching links change nothing); `POST /api/alerts/stop {token}` is the
  only credential-less write, 192-bit token, same-origin only. Alerts are
  made from `/search` (button) or the account page; never show the token
  in the API. Audit: alert.create/delete/stop.
- Being found: `/robots.txt` (off /admin, /api/ except /api/docs, /login,
  /account, /embed/, /oembed; Sitemap line) and `/sitemap.xml` (home,
  search, docs, every visible meeting with lastmod; absolute from
  PUBLIC_URL else the Host). The meeting page's head has canonical, Open
  Graph (+ og:image and twitter:card once there's a poster) and
  schema.org JSON-LD: a VideoObject for a meeting with a video, else an
  Event (EventCancelled when cancelled). The JSON has `<` escaped; the
  ld+json block isn't an executable script, so the page CSP is unchanged.
  `src/thumbs.ts`: a poster frame `<slug>.jpg` (ffmpeg, 5% in, max 60 s,
  falls back to the first frame when the recorded duration overshoots) for
  every recording with a video and none yet, made one at a time at
  startup and every 2 min (`ServeOpts.thumbnails`, off in tests; failures
  are not retried for an hour). Used as the player's `poster`, og:image,
  JSON-LD thumbnailUrl, and listed by /api/v1/.../files as `thumbnail`.
- `src/speakers.ts` speaker names added by hand. `<slug>/speaker-names.json`
  maps the transcriber's label ("Speaker 4", or a Zoom name) to a name;
  APPLIED WHEN SERVING (public /media, /admin/media and the API's file
  downloads) to `.transcript.json` (segment `label` + `names_applied`),
  `.vtt` (`<v Label>` at a cue start), `.srt` (`Label: ` at cue text start)
  and `.txt` (`[hh:mm:ss] Label:` headers), anchored so the same words in
  speech aren't touched; the files on disk are never rewritten (a
  transcriber re-run loses nothing, undo = delete a line). Two labels with
  one name merge. The search index uses the named segments and re-indexes
  when the names file changes (migration 13 `names_mtime_ms`). Admin:
  `GET|PUT /api/admin/recordings/:slug/speakers` (labels in first-appearance
  order with time spoken and a first line; PUT replaces the whole set,
  validated against the transcript's own labels, no < > & or control
  characters, audited) and a Speakers button per recording on /admin.
  The player says some names were added by hand. Searching an apostrophe
  name: O'Brien is two tokens (o, brien), so search "o'brien".
- `src/ops.ts` messages to the operator (CAPTURE_NOTIFY_URL, ntfy-style;
  `notify(url, text, {priority, tags})`): `Scheduler.onEvent` emits
  started / finished / overdue (a capture still not started 10 min after
  its meeting did) and `Ops` turns them into plain-words messages
  (`describeOutcome`: ended / not_started / blocked / invalid_link /
  email_required / ended_after_interruption / stopped / failed + error;
  problems are priority high and say "Check /admin"); transcripts ready or
  failed are found by scanning transcript.status.json every 2 min. Each
  message once, remembered in `ops_notified` (migration 14) across
  restarts; the first transcript scan ever only records the existing ones.
  Messages carry titles, outcomes and the PUBLIC page address, never a
  meeting link, passcode or file. Listener errors never reach the
  scheduler. Restart recovery ("interrupted") emits nothing.
  `OPERATOR_EMAIL` (needs mail): `util.setOperatorSink` makes EVERY
  `notify()` call (login, backups, feeds, ops) also email that address
  (module-level sink, set by createApp, cleared on close). Production had
  no CAPTURE_NOTIFY_URL and no push service in the cluster, hence this.
- `src/recordings.ts` recordings on disk, admin view and public view.
  Public = a job made it, its meeting is public and not cancelled, video or
  live. `publicFiles()` is the only list /media serves from (never
  manifest.json: it holds the link and passcode).
- `src/audit.ts` audit_log (migration 4): `audit.record(actor, action,
  target, before, after)` stores only changed fields, through `redact()`
  (links -> meeting number, `email` keys -> [set]/[changed], password /
  hash / token keys dropped, any `pwd=` in any string). serve.ts records
  admin writes and password changes, `minutes user` records as "cli". New
  admin writes (feeds, meetings, tokens, publish) must record too.
- `src/mail.ts` SMTP submission on node:tls (implicit TLS, AUTH PLAIN, one
  message per connection, base64 UTF-8 body, refuses CR/LF in headers).
  SMTP_URL + SMTP_PASSWORD + MAIL_FROM; homelab is Cloudflare Email
  Service (`smtps://api_token@smtp.mx.cloudflare.net:465`, emc2.build is
  onboarded for sending, DMARC p=reject). `minutes mail-test <to>`.
  Sign-up/verify/reset (serve.ts) never reveal whether an email has an
  account; codes are 6 digits, hashed, single use, 5 tries (accounts.ts
  `issueCode`/`useCode`). `capsFor()` withholds tokens until verified.
- `docs/extending/feed-parsers.md` and `platforms.md`: how to add a feed
  parser (interface, externalId and timezone rules, fixtures, checklist)
  or a meeting platform (interface, State mapping, MARKERS convention,
  media-safety checklist, what must be verified live). `minutes feed
  parsers` / `minutes feed test <parser> --config ... --fixture|--route`
  (`src/feeds/cli.ts`, `fixture.ts`) runs a parser offline from saved
  files; `feedContext({ fixtures })` does the same in tests.
- `src/feeds/` where meetings are found (Phase 2). `types.ts`: a
  FeedParser (id, label, fields for the admin form, validate, host, fetch)
  fetches and parses only, never touches the DB or jobs. `context.ts`: the
  ctx.http it must use (UA, 30s timeout, 8 MB cap, http(s) only,
  conditional GET with per-feed ETag/Last-Modified) and ctx.page()
  (headless Chromium). `time.ts` zonedTime(): local wall time -> UTC via
  Intl (feeds publish local times). `store.ts` feeds + feed_runs
  (migration 6, 200 runs kept per feed). `poller.ts`: interval (5 min on
  a meeting day), jitter, one run per host, backoff x2 up to 6h, health
  (unhealthy after 24h failing); a 304 or the same parsed-result hash ends
  the run; an Applier (sync, #10/#11) turns results into meetings.
  `/admin/feeds` (pages/feeds.ts): form built from `fields`, Preview (no
  saving; links shown as platform + meeting number), Run now, runs.
  Parsers register in `parsers/index.ts`: `ical` (UID / UID@local-start
  for recurrences; IANA TZID via Intl, VTIMEZONE ignored on purpose since
  exports carry pre-2026 BC rules; RRULE daily/weekly/monthly + EXDATE +
  RECURRENCE-ID), `html` (CSS selectors on the page rendered by
  ctx.page; loose dates, a row without a time is skipped). Platforms may
  offer `extractLink(text)`; registry `findLink()` (zoom: a zoom.us URL,
  or "Meeting ID: ..." + "Passcode: ..." -> zoom.us/j/<id>?pwd=).
  `escribe`: POST MeetingsCalendarView.aspx/GetCalendarMeetings for the
  window (local "YYYY/MM/DD HH:mm:ss"), body = MeetingType, cancelled by a
  "... Cancellation Notice" document (NOT "Postponement Notice": the
  2026-11-24 council had one and went ahead), link from upcoming meetings'
  HTML agenda (Langford: "Enter the Meeting ID: 843 4290 9811", webinar,
  no passcode). Fixtures saved from Langford in test/fixtures/feeds/escribe.
  `youtube` (#21): a channel's /streams tab (`ytInitialData`: current
  `lockupViewModel` layout, old `videoRenderer` still read) for videos
  that are live ("N watching") or upcoming ("N waiting", "Scheduled
  for"), then each candidate's watch page (`ytInitialPlayerResponse`) for
  the real start (`liveBroadcastDetails.startTimestamp` / offline-slate
  epoch). The tab's "Scheduled for 11/29/26, 7:25 AM" is in the
  REQUESTER's timezone: never used for the time. link = watch URL (the
  YouTube platform takes it), externalId = video id; live streams
  started over 24 h ago (24/7 loops) are skipped; titleFilter, maxVideos.
  Fails loudly when YouTube's page data isn't there (consent page, layout
  change). Fixtures: test/fixtures/feeds/youtube (trimmed real pages,
  2026-11-26).
  `granicus`: ViewPublisher.php?view_id=N, the Upcoming Events table only,
  rows read by content (name = first cell, date = visible text in the
  config timezone: NOT the hidden epoch span, 3h off on Pittsburgh's
  site), externalId = hash(name, start) since event_id links appear only
  later. Saanich streams on Granicus (no capture platform): list_only.
  `primegov` (Saanich's agendas): api/v2/PublicPortal/ListUpcomingMeetings
  + ListArchivedMeetings?year= for days back; local dateTime in the config
  timezone; endDateTime is often before the start, used only if sane;
  documents from documentList (HTML /Portal/Meeting?meetingTemplateId=,
  PDF /Public/CompiledDocument?...&compileOutputType=1) + videoUrl; link
  from zoomMeetingLink (isZoomMeeting) or an upcoming HTML agenda.
  Blank types/titles = every meeting, in every parser.
  streamUrl (migration 9, meetings.stream_url): the public live/recorded
  stream page, separate from the join link. eScribe: VideoStream.aspx
  only while HasLiveVideo (every meeting has that link), else the
  recorded player when HasVideo; Granicus: MediaPlayer; PrimeGov:
  videoUrl. Admin lists get joinLink {label, url via
  Platform.publicUrl (zoom.us/j/<id>, never pwd), passcode: bool}.
  `sync.ts` (the Applier, migration 7): diff by externalId into
  meeting_changes (added, date_changed (another local day) vs
  time_changed (same day), both with local times, link changed, cancelled,
  reinstated, removed, returned, details, document_added / removed /
  changed by URL against meetings.documents (migration 8; a meeting's
  first list, incl. rows from before it, is stored without entries)); `removed` only flags; a run removing more
  than half (and >= 2) of a feed's upcoming meetings is `suspect` and
  applies nothing (hash not saved, so it's re-checked). Policies auto /
  review / list_only; dedup (same link within 12h, or same body within 15
  min) sets duplicateOf, never captured twice. Rows + change log in one tx,
  then captures via Scheduler.scheduleMeeting / updateMeeting /
  cancelMeetingJobs (never launched ones). Links in changes and admin
  lists are "Zoom 870...": never the passcode. Meetings from feeds have
  link "" until one is published; slug = prefix-body-or-title-localdate.
- `src/net.ts` TRUSTED_PROXIES (X-Forwarded-For/-Proto believed only from
  those), security headers, page CSP.
- `src/timeline.ts` active speaker + Zoom captions: appended per change to
  `speakers.jsonl` / `captions.jsonl` while recording, then mapped onto the
  stitched clock as `<slug>.speakers.json`, `<slug>.zoom-captions.{json,vtt}`.
  Offsets use each part's `videoStart` (first captured frame, from ffmpeg
  `-progress`), not spawn time: ffmpeg takes ~1.5-2.6s to open x11grab+pulse.
- `transcriber/` separate Python container (WhisperX). CPU int8 by default
  (`Dockerfile`, compose); the homelab runs `Dockerfile.rocm` on k3s-07's
  Radeon 8060S (gfx1151, ROCm 7 from AMD's TheRock pip nightlies +
  CTranslate2's official ROCm wheel), `WHISPER_DEVICE=cuda` (ROCm says
  "cuda" too), float16, `TORCH_MIOPEN=0` (MIOpen's batch-norm JIT fails on
  gfx1151). `device()` falls back to the CPU if torch or CTranslate2 can't
  see a GPU. ~23x faster than k3s-04's CPU (`bench.py`). Watches
  recordings/, writes `<slug>.{vtt,srt,txt,transcript.json}` and
  `transcript.status.json`; waits while a capture is running. Uses
  `<slug>.speakers.json` to label segments (`zoom_speaker`). Phase 2:
  pyannote diarization (HF_TOKEN in `.env`), voices shown as "Speaker N",
  and a voice gets a Zoom name only on a one-to-one match (`name_speakers`).
  Model large-v3-turbo: distil-large-v3 ignores the vocab prompt entirely.
  Vocab is `vocab/common.txt` + the council file matching the slug prefix;
  faster-whisper keeps only the last ~223 prompt tokens, so keep it short.
  `<slug>/transcribe.json` overrides vocab and speaker counts.
  Live mode (LIVE=1): while a job runs, each growing part is transcribed in
  ~2 min chunks cut at the quietest point (`live_step`), kept in part-local
  time in `<slug>/.live/state.json`, drafted to `<slug>/live.json` (Watch
  panel). The final pass reuses them via manifest `offsets` and only runs
  diarization. Models unload after IDLE_UNLOAD_S idle.
  `requirements.txt` is a pinned freeze; edit `requirements.in`.
- `compose.yaml` runs the web server and the transcriber together.
- `entrypoint.sh` starts Xvfb + PulseAudio with two null sinks (see below).

## Invariants, don't break these

- **Never send audio or video into the meeting.** Default PulseAudio source is
  `silence.monitor`; the browser is granted microphone only, never camera; the
  mute logic checks the aria-label starts with "mute" before clicking because
  the selector also matches "Unmute". If you touch audio routing, make sure the
  default source can never become `zoom.monitor` (that loops council audio back
  into the meeting).
- Client-side mute: `mediaGuard()` (platforms/guard.ts) is injected into every frame
  before Zoom's code. Every mic track the page gets is disabled and can't be
  re-enabled (clones too), camera and screen share requests are refused.
  Tested in the image: track stays disabled after `enabled = true`, peak
  level exactly 0 (fake mic without the guard: audible), video and
  getDisplayMedia -> NotAllowedError, same inside iframes. Keep it as the
  first init script.
- Parts are MKV with `-flush_packets 1 -cluster_time_limit 1000`. Without the
  cluster limit, Matroska buffers ~5s in memory and a hard kill loses it (tested:
  a part killed at 2s was unrecoverable). Don't switch parts to MP4.
- SIGTERM must still close the current part and stitch (k8s eviction, docker stop).
- `manifest.json` is written atomically (tmp + rename) after every event.

## Status

First successful live run 2026-11-05 against a test meeting on the owner's
own free Zoom account (arm64 image, signed-in session). Not yet run against a
Langford meeting, a webinar, or for longer than a few minutes.

**Zoom blocks anonymous web-client bots.** Without a signed-in session the
join API returns `errorCode 9516` ("Automated bots aren't allowed to join this
meeting... sign in to join"). `minutes login` saves a signed-in session
(Playwright storage state, no password) to `auth/zoom-auth.json`; pass it with
`--auth`. A session saved from Chrome on macOS was accepted by Chromium 130 in
the Linux container. The file holds live session tokens: keep it out of git
and images (it's in .gitignore and .dockerignore). Joining this way is tied to
the owner's account; that's an accepted risk.

Verified live:
- `app.zoom.us/wc/join/<id>?pwd=` lands on the browser client.
- `#input-for-name` and the "Join" button; `--name` is honored when signed in.
- Waiting room ("We've let them know you're here") -> `waiting`; admit ->
  `in_meeting` (footer "Leave" button) -> recording after a 3s settle (the
  meeting UI flashes for <1s right after the Join click, before the waiting
  room renders).
- "This meeting has been ended by host" is a dialog caught via
  `MARKERS.overlays` -> `ended` -> stitch -> exit 0.
- Zoom auto-joins computer audio; meeting audio recorded from `zoom.monitor`.
- No mic reaches the meeting: Chromium sees no usable input device ("Cannot
  detect your microphone"), so `JOIN_AUDIO` and `MUTE_SELECTOR` never fire.
  The footer mic button's aria-label is just `audio`, so `MUTE_SELECTOR` would
  not match it anyway. Re-check this if audio routing changes.
- `docker stop` closes the part cleanly and stitches.
- Toasts live in `#notificationManager` (now made transparent via
  `MARKERS.hideCss`); `--kiosk` had no effect, so the window is shifted up by
  the browser-UI height instead (`hideBrowserUi`, verified offline on Xvfb,
  not yet in a live meeting).

Timezone data: Node 20.18 shipped tzdata 2024a, which predates BC's move
to permanent daylight time (2026-11-01, UTC-7), so `--start` and chapter
times were an hour off. The Dockerfile installs ICU tz files for 2026f
(pinned, sha256-checked) and sets ICU_TIMEZONE_FILES_DIR. Re-checked on
Node 24.22.3 (2026-11-24): built-in data is 2026e (also correct), the
override still loads (`process.versions.tz` 2026f), `2026-11-16T19:00` ->
02:00Z (GMT-0700). The
`config` event at startup logs `tzdata` and the resolved start with offset:
check it. Running outside the image (plain `node dist/index.js`) still uses
Node's built-in tzdata, so pass an explicit offset there.

Web interface, verified 2026-11-06 (arm64 image): API validation (non-Zoom
links, bad/past starts, bad slugs, duplicates, cross-origin writes, path
traversal all refused), schedule/cancel, immediate launch on its own display
+ sink with live screenshot and log, Stop -> cleanup of Xvfb and sink,
graceful server SIGTERM, playback + chapter seek in desktop Chrome, layout at
390px and dark mode. Playwright's bundled Chromium can't play H.264 MP4, so
test playback with `channel: "chrome"`. Not yet run: a scheduled job against
a live meeting end to end, two overlapping live captures.

Speaker + captions (2026-11-06), verified offline only, through the real CLI
on a fake meeting page (speaker changes every 6s, captions growing word by
word, ffmpeg SIGKILLed mid-run): spans follow the 6s cadence across the part
boundary, graceful-stop timing within 0.19s, captions merge to one cue per
utterance. NOT verified live: the selectors against a real meeting with
several participants, and Zoom captions at all (none of the test meetings
had them on). The "turn captions on" click (`MARKERS.showCaptions`) is a
guess; it clicks at most once and never once caption text is flowing.

Hard kill loses more than the "about a second" noted above: measured ~2s of
video at the end of a SIGKILLed ffmpeg part (x264 lookahead + frame threads
on top of the 1s Matroska cluster). `-tune zerolatency` would cut it at some
compression cost; not changed.

Transcriber (2026-11-06, Docker VM, 6 CPUs, distil-large-v3 int8): synthetic
council dialogue (macOS `say`, 3 voices, 42s) transcribed with every line
correct apart from US spelling ("favor") and some casing; Zoom speaker labels
correct on all 7 turns. Realtime factor 0.51 on continuous speech (so ~1.5h
for a 3h meeting here); first run also downloads ~1.5GB of models into the
`models` volume. Web player: transcript track on by default, Zoom captions
as a second track, clickable/searchable transcript panel, all checked in
desktop Chrome and at 390px.

Silence gate: Whisper invented fluent sentences on room tone (livetest-4:
"I must be made. I put in the future..."). Segments whose loudest 50ms RMS
window is under `SILENCE_DB` (default -40 dB) are dropped from the
subtitles/text and kept in `<slug>.transcript.json` under `dropped_quiet`.
Measured: real speech -14..-20 dB, invented text -48..-57 dB, a real "Um."
-27 dB (kept). Check it against a real meeting: a soft-spoken delegate on a
far mic is the risk; lower `SILENCE_DB` if real speech lands in
`dropped_quiet`.

Passcodes: agendas often print only an ID and a numeric passcode. Write the
link as `https://zoom.us/j/<id>?pwd=<passcode>`: the browser client
(`app.zoom.us/wc/join`) accepts the plain passcode in `pwd=` (verified live
2026-11-06, no prompt; a normal browser on the `zoom.us/j` link does prompt).
If a prompt ever shows, `advance()` types a plain passcode into
`MARKERS.passcode` (selector unverified). The log hides `pwd=`.

Recording notice (live, Oak Bay 2026-11-09): "This meeting is being
recorded" dialog sits mid-screen. `dismissRecordingNotice()` clicks its "OK"
(only inside an overlay with that text, never Leave/End/Decline); dismissed
3s after recording started.

Out of memory (same meeting): the job's Xvfb :100 was killed twice
(~90s and ~6 min in) when the Docker VM ran out of memory; the first time
the transcriber was OOM-killed too (it kept ~GBs of models loaded while
idle). Chromium died with the display and the rejoin failed with "Missing X
server" until the display came back. Fixes: jobs.ts respawns a job's Xvfb
on the same display; compose caps the transcriber (`mem_limit`,
oom_score_adj 800) and protects capture (oom_score_adj -500); the
transcriber unloads models when idle. Respawn verified 2026-11-10: a test job's
Xvfb was SIGKILLed 80ms after launch, restarted at once, the runner's
first browser launch failed ("Missing X server"), the retry 5s later
worked.

Live transcription, Oak Bay 2026-11-09 (2h01m, two parts, 6 CPUs shared
with the capture): chunks at ~0.7x realtime, memory flat at ~2.2G once
chunks decoded only their window (decoding the whole growing part got the
transcriber OOM-killed at its cap; the capture was unaffected). One read of
a growing part took ~18 min, cause unknown (closed file: 6.5s; a growing
file doesn't block ffmpeg at EOF); slow reads are now logged.

Bot block (2026-11-10): right after Oak Bay ended, a test join to the same
meeting got "Automated bots aren't allowed to join this meeting... sign in
to join" although the saved login checked OK (zoom.us/profile). So a good
login check doesn't guarantee a join; likely Zoom's bot scoring after five
joins of one meeting in one evening. Don't hammer test joins.

Email required (live, ANC 6B 2026-11-10, dc-gov.zoom.us): the preview
page "Enter Meeting Info" has a required `#input-for-email` above the
name, and Join stays disabled until it's filled. With `CAPTURE_EMAIL` set
it's typed in (never logged); without it the runner stops with outcome
`email_required` instead of clicking a disabled Join until the no-show
limit. Tested offline against that page's saved HTML.

Invalid links: "This meeting link is invalid (3,001)" -> `invalid` state ->
outcome `invalid_link` within seconds (was: 2h of `loading`).

Debugging: `CAPTURE_DEBUG=1` writes a screenshot and every frame's HTML to
`<slug>/debug/NNN-<state>.png|html` on each state change.

Tested offline:
- Strict TS build, CLI parsing, `webClientUrl()` for /j/, /w/, bare IDs.
- Stitch: 3 parts incl. one SIGKILLed mid-write -> repaired, chapters with gap
  lengths, correct offsets.
- Recorder lifecycle with `scripts/fake-ffmpeg.sh`: graceful 'q' stop (~150ms,
  exit 0), detection of ffmpeg dying on its own, new part after a crash.

Interruptions, live run 2026-11-05 (livetest-4):
- Killed ffmpeg: `ffmpeg_died` within 1.4s, new part in the same session. OK.
- Killed Chromium: `dead` within 0.5s, part closed, 5s backoff, rejoined in
  12s (needs the host to admit again if there's a waiting room). OK.
- Network cut 70s: FAILED before the fix, fixed but not re-run live. Zoom
  showed "Reconnecting" only in a sr-only role=alert for ~1s, then a
  full-screen `.loading-layer` ("Meeting Disconnected / Trying to
  reconnect..."), then after the network returned gave up with a zm-modal
  "Joining Meeting Timeout or Browser restriction" (Retry / Leave). None of
  that matched, so the bot stayed `in_meeting` recording black. Now all three
  are in `MARKERS.reconnect` / `overlays`. Re-run live (livetest-5): cut at
  07:31:54, sr-only alert blip at +9s, `.loading-layer` -> `reconnecting` at
  +24s and held, `feed_lost` at +70s (45s grace), part closed, rejoined 6s
  after the network returned. Stitched with a 24.6s gap chapter. OK.
- Open question: runs 4 and 5 recorded near-silent audio (peak -40 to -52 dB)
  in every part, vs -6.4 dB in run 3. Bot-side audio state was identical in
  the dumps; most likely the host was muted/quiet. Confirm with a run where
  someone talks.

Still untested live:
- Webinars (`/w/` links, registration), host-removed, meeting-not-started.
- Session expiry: how long a saved login lasts, and whether the write-back
  after each meeting keeps it alive.
- amd64 image live, VAAPI / NVENC paths.

## Suggested next steps

1. Dry run on a real Langford committee meeting (so far only the owner's own
   test meetings). Schedule it from the web UI a few minutes ahead to cover
   the scheduled-job path end to end, with `CAPTURE_DEBUG=1`. Re-run
   `minutes login` shortly before. (Debug dumps exist; the interruption
   tests passed on the test meeting.)
2. Done offline: active-speaker and Zoom-caption timelines. Verify on the
   committee dry run (step 1): check `speakers.json` names against the video,
   and whether the meeting has captions (and whether the CC click worked).
3. Transcription: Phases 1-2 built (transcribe + align + diarization,
   subtitles, transcript panel). Next is Phase 3, voiceprints, which should
   also fix one person split into several "Speaker N". See
   `docs/transcription-plan.md`.

## Run

    npm ci && npm run build
    docker build -t minutes .
    docker run --rm --shm-size=1g -v "$PWD/recordings:/recordings" minutes \
      --link "https://zoom.us/j/87093163922" --start 2026-11-16T19:00 \
      --slug council-2026-11-16 --name "Recorder (Eric)"

The image is Ubuntu 22.04 + Node 24 LTS (`NODE_VERSION`, for `node:sqlite`) with only Chromium,
installed by the `playwright` npm package itself (`playwright install --with-deps
chromium`), so its revision always matches the library: bump playwright alone.
(Was the 1.95GB mcr playwright image, which also ships Firefox and WebKit.)
The transcriber drops `triton` (~1GB, GPU-only, pulled in by whisperx on x86).

## Tests

`npm test` (node:test, no deps): `test/*.test.ts`, compiled with
`tsconfig.test.json` into `.test-build/` (never shipped: tsconfig.json and
.dockerignore leave test/ out). Covers platform links and MARKERS, db
migrations, the Scheduler (validation, edit, cancel, retry, jobs.json
import), timelines, recorder stream input + stitch against real ffmpeg, and
in Chromium the media guard (peak exactly 0, with an unguarded control that
must be audible) and the `pageAgent` classifier. ffmpeg/Chromium tests skip
locally when missing, fail in CI (CI=true). The `test` job in ci.yml runs on
a GitHub-hosted runner for every PR and push; release needs it. When a new
live page breaks a marker, add its text as a classifier case.

## Style

- No runtime deps beyond playwright. Keep it that way unless there's a real reason.
- Owner's preference: no em dashes in comments, docs, or output text.
