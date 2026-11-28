# minutes

**The meeting's over. The minutes are ready.**

Records online meetings start to finish without help from the host, and turns
them into one chaptered video with a speaker-labelled transcript, the same
night, and publishes them. Built for public council meetings: Zoom, YouTube
and Granicus today.

What it does, end to end:

- **Finds meetings** by itself from a municipality's calendar (eScribe,
  PrimeGov, Granicus, iCal, a web page), tracks every change (moved,
  cancelled, new documents) and lets you review before anything is recorded.
- **Records** a Zoom meeting in a browser, a YouTube live stream, or imports a
  finished Granicus video, and stitches it into one chaptered video.
- **Transcribes** it on a GPU (WhisperX, speakers separated), with names you
  can add by hand.
- **Publishes** it: a page per meeting that fills in as results land,
  permalinks, an embeddable player, search across every transcript, email
  alerts, a download API with tokens, and notes to the operator when
  something needs a look.

Joins a Zoom meeting in headed Chromium on a virtual display, records screen +
audio with ffmpeg, survives drops, and stitches the parts into one MP4.

Detection is event-driven: an agent injected into every frame watches the DOM
with a MutationObserver and calls back into Node when the meeting state
changes (joined, reconnecting, ended). Polling every few seconds is only a
heartbeat and hung-renderer check.

## Run

    docker build -t minutes .
    docker run --rm --shm-size=1g -v "$PWD/recordings:/recordings" minutes \
      --link "https://zoom.us/j/87093163922" \
      --start 2026-11-16T19:00 \
      --slug council-2026-11-16 \
      --name "Recorder (Eric)"

`--start` without an offset is local time in `$TZ` (America/Vancouver by default).

Output in `recordings/<slug>/`:

- `<slug>.mp4` stitched result, one chapter per part, gap length in the chapter title
- `part_NNN.mkv` raw parts (kept), `part_NNN.ffmpeg.log`
- `manifest.json` parts with wall-clock start/end, gaps, state events, outcome

`docker stop` / SIGTERM closes the current part cleanly and still stitches.
A second Ctrl-C bails immediately.

## Everything together (web interface + transcription)

    docker compose up -d --build
    open http://127.0.0.1:8080/

`compose.yaml` runs the web server/scheduler and the transcriber. Finished
recordings get subtitles (`<slug>.vtt`), a transcript (`.txt`, `.srt`,
`.transcript.json`) and, in the player, a searchable transcript you can click
to jump around, with speakers separated by voice. CPU-only. Model choice:
`WHISPER_MODEL` (default `large-v3-turbo`).

Names are where Whisper slips most. `transcriber/vocab/common.txt` is always
used, plus the council's own file (`langford.txt`, `oakbay.txt`) picked from
the recording's slug prefix, or named in `<slug>/transcribe.json` as
`{"vocab": "oakbay"}`. Keep each council's list to the mayor, councillors,
key staff and place names: Whisper only reads about 220 tokens of it.

Speaker separation (pyannote) needs a free Hugging Face token once, to
download the model: accept the terms of
`pyannote/speaker-diarization-community-1`, then put `HF_TOKEN=...` in `.env`
next to `compose.yaml` (it's git- and docker-ignored). Without it,
transcripts still work, labelled only by Zoom's active speaker. Speaker count
hints per recording go in `<slug>/transcribe.json`:
`{"min_speakers": 8, "max_speakers": 20}`.

### Live transcription (during the meeting)

So the transcript is ready soon after the meeting ends instead of hours
later, the transcriber works through the recording while it's still being
captured (`LIVE_TRANSCRIBE=1`, the default).

1. **While the capture runs**, every 15s the transcriber looks for running
   jobs (`recordings/active.json`, written by the server). Each part file (`part_NNN.mkv`) is flushed
   to disk every second, so it can be read while it grows.
2. Once at least `LIVE_CHUNK_S` (120s) of new audio exists, it decodes only
   that window, cuts it at the quietest 0.3s near the end (so no word is
   split), and transcribes and aligns it. A transcriber that falls behind
   catches up in chunks of at most `LIVE_CHUNK_MAX_S` (300s).
3. Results are kept per part in `<slug>/.live/state.json` and written as a
   draft to `<slug>/live.json`, which the Watch panel shows under the live
   screenshot (new lines about every 2 minutes, no speakers yet).
4. **When the meeting ends**, the capture stitches the parts into the MP4.
   The final pass transcribes what's left of each part, maps the live
   segments onto the stitched video's clock (from `offsets` in
   `manifest.json`), and then only runs speaker separation over the whole
   meeting. Separation stays in the final pass because speaker labels must
   be consistent across the meeting.

Interruptions: a rejoin starts a new part, which gets its own chunks. A
transcriber restart resumes from `state.json`. A part cut short by a crash
is clipped to its stitched length. If the live state is missing or
incomplete for any part, the final pass falls back to transcribing the whole
MP4, so nothing is lost, it just takes longer.

Measured on Oak Bay council (2h01m, 6-CPU Docker VM shared with the
capture): chunks ran at about 0.7x realtime alongside the capture, and the
finished transcript was ready 1h34m after the meeting ended, 65 min of it
speaker separation. Without live mode, transcribing and aligning would add
roughly 45 min more. A larger machine shortens both.

Settings (in `.env`):

| Variable | Default | |
|---|---|---|
| `LIVE_TRANSCRIBE` | `1` | `0` to transcribe only after the meeting |
| `LIVE_CHUNK_S` | `120` | Minimum new audio per chunk. 60 on a machine with spare CPU gives a fresher draft |
| `LIVE_CHUNK_MAX_S` | `300` | Largest catch-up chunk, bounds memory |
| `DIARIZE_STEP` | `0.25` | Speaker-separation window step; smaller is slower and slightly more accurate |
| `TRANSCRIBER_MEM` | `4500m` | Memory cap, so the transcriber can never starve a capture |
| `IDLE_UNLOAD_S` | `600` | Free the models after this long with nothing to do |

Alongside the video, captures also record who Zoom shows as the active
speaker (`<slug>.speakers.json`, used to label the transcript) and Zoom's own
live captions when the host has them on (`<slug>.zoom-captions.vtt`, a second
subtitle track in the player, kept as a reference).

## Web interface

Schedule meetings, watch a capture live, and replay recordings in a browser:

    docker run -d --name minutes --shm-size=1g --stop-timeout 120 \
      -p 127.0.0.1:8080:8080 \
      -v "$PWD/recordings:/recordings" -v "$PWD/auth:/auth" \
      -e COOKIE_SECURE=0 \
      minutes serve --auth /auth/zoom-auth.json
    docker exec minutes node /app/dist/index.js user add --admin you@example.com

The last command prints a one-time password. Open http://127.0.0.1:8080/admin,
sign in, and choose your own password.

The site has two halves:

- **`/`, public**: published recordings with their transcripts, and the
  live draft transcript of a meeting being recorded. No join links, meeting
  IDs, bot screen, logs, failed attempts or login state, and `/media` only
  serves a published recording's video, subtitles and transcripts (never
  `manifest.json`, parts or logs). A recording is published when a capture
  job made it, its meeting is public (the default) and not cancelled, and it
  has a video or is recording now. Share a recording as `/#<slug>`.
- **`/admin`, admins only**: everything below. Its APIs are under
  `/api/admin` and its files under `/admin/media`, so a proxy can keep the
  whole admin off the internet by path (the k8s public host does).

**Accounts.** Two roles: `admin` runs captures (schedule, edit, stop,
watch the bot's screen and log, Zoom login status); `user` can sign in but,
for now, sees no more than anyone else (recordings and transcripts). Manage
them on the server:

    minutes user add [--admin] [--name "Name"] <email>   # prints a one-time password
    minutes user passwd <email>        # new one-time password, signs them out everywhere
    minutes user role <email> admin|user
    minutes user disable|enable <email>
    minutes user list

**Sign-up** (only with mail set up): anyone can create a `user` account
on `/login`. They get a 6-digit code by email (valid 24 hours, 5 tries)
and are signed in once it's entered; an account never confirmed is deleted
after 7 days, and until then it can't have API tokens. "Forgot password?"
emails a reset code (15 minutes, once) and signs the account out
everywhere. The answers never say whether an address has an account (an
existing owner gets a note instead of a code). Limits: 5 sign-ups an hour
per address, 3 mails an hour per account, 30 wrong codes per 15 min per
address, and a hidden form field that only bots fill. Admins see every
account on `/admin` (Users) and can promote, demote and disable them.

Mail goes out over SMTP with implicit TLS:

    SMTP_URL=smtps://api_token@smtp.mx.cloudflare.net:465   # user in the URL
    SMTP_PASSWORD=<Cloudflare API token with Email Sending>
    MAIL_FROM="minutes <minutes@emc2.build>"                 # an onboarded domain
    PUBLIC_URL=https://minutes.emc2.build                    # for the emails

`minutes mail-test you@example.com` sends a test message. Without
`SMTP_URL`, sign-up and reset are off and admins make accounts.

Every admin change (schedule, edit, cancel, stop, record again, Zoom login
check), every password change, and every `minutes user` command lands in
the **audit log** on the admin page: who (the account, or `cli`), from
which address, when, and the fields that changed. Meeting links show only
the meeting number, the email typed into Zoom only that it was set or
changed, and passwords never appear. Filter by action, who and what.

Passwords are scrypt hashes; sessions are a random cookie stored only as a
hash, valid 14 days from last use. Failed sign-ins are limited per account
(10 per 15 min) and per address (30). The cookie is `__Host-` prefixed and
`Secure`, which browsers only accept over https: set `COOKIE_SECURE=0` when
serving plain http (compose does, on 127.0.0.1). `CAPTURE_WEB_TOKEN` (the old shared Basic
password) is gone.

- **Schedule**: paste a Zoom link or meeting ID and the start time (server
  timezone). It joins `--lead-min` (15) minutes early.
- **Captures**: status of each job. *Edit* changes a scheduled capture's
  link, start, name or Zoom display name (leave the link blank to keep it).
  *Watch* shows a screenshot of exactly
  what's being recorded (every 5s) and the capture log. *Stop* closes the
  current part and stitches what's there.
- **Recordings**: play any stitched MP4 in the browser, jump between
  chapters (one per reconnect gap), download it.
- **Zoom login**: the bar under the title shows whether the saved login
  still works. The server checks it daily and 2 hours before each scheduled
  capture, and saves the refreshed session each time, which keeps it from
  going stale. It can't sign in for you: when it says *expired*, run
  `minutes login` again (the bar clears on its own a minute later).
  Set `CAPTURE_NOTIFY_URL` (e.g. an ntfy.sh topic) to get a push alert too.
  The same address also hears about each capture: "Recording started",
  "Recording finished: ... 151 min" or "Recording problem: ... blocked / never
  started / failed" (high priority, with what to check), "Not recording yet"
  when a capture hasn't started 10 minutes after its meeting did, and
  "Transcript ready" (with the public link) or "Transcription FAILED". Each
  once, never a meeting link or passcode.
  With mail set up, `OPERATOR_EMAIL=you@example.com` also emails every one of
  these (and the login, backup and feed messages), so you don't need a push
  service at all: a message is its subject line, the problems say "This one
  needs a look".
  From the command line: `minutes check-login --auth auth/zoom-auth.json`.
- **Meetings that ask for an email**: some hosts require an email address
  before Join works. Fill in the form's optional *Email* field for that
  capture, or set `CAPTURE_EMAIL` in `.env` as the default for all of them
  (the form's value wins). It's only typed when Zoom asks, and the host sees
  it. Like the link, it's never sent back to the page: the list just says
  "email set", and editing keeps it unless you type a new one or tick
  *Remove the saved email*. With neither, such a capture stops right away
  with the outcome `email_required`.

Each capture runs on its own virtual display and audio sink, so meetings can
overlap (`--max-jobs`, default 2; each 1080p30 x264 capture needs roughly a CPU
core). Jobs live in `recordings/minutes.db` (SQLite; an older `jobs.json` is
imported on first start and kept as `jobs.json.migrated`). If the server restarts mid-capture,
that job is marked *interrupted* and not relaunched (it would overwrite its
parts). Give `docker stop` time to stitch: `--stop-timeout 120`.

Published recordings and transcripts are open to anyone who can reach the
server; everything else needs an admin account. For internet exposure, put
TLS in front and set `TRUSTED_PROXIES` to the proxy's addresses (IPs or
CIDRs): only then is its `X-Forwarded-For` believed, for sign-in limits and
logs. Every response carries security headers; pages get a CSP that allows
only their own inline script (by hash). URLs over 2 KB, headers over 16 KB,
bodies over 16 KB and requests that take over 30s to arrive are refused.

**Search.** `/search` (and a box on the home page, and `/api/v1/search`)
finds what was said across every public meeting's transcript: words must
all appear (the last can be a word start), "quoted phrases" stay together,
and each result is a ~30 second passage with the matched words
highlighted, who said it, and a link that opens the meeting at that
second. Hiding a meeting hides its transcript from search at once. The
index lives in the database and is rebuilt from the transcript files, so
nothing needs backing up separately.

**Alerts.** With mail set up, anyone with a confirmed email can save a
search ("zoning", "public hearing") from the search page or their account
page and get an email when it comes up in a *new* meeting's transcript, with
a link to the moment. One email per meeting listing every alert that
matched, up to 10 alerts each, and every email has a link that stops that
alert without signing in. Existing meetings aren't announced.

**Granicus (Saanich).** A Granicus clip link (an archived meeting,
`https://<city>.granicus.com/player/clip/<id>`) is imported as a recording:
schedule it on `/admin` with the meeting's own date as the start and it's
recorded at once, in minutes, then transcribed like any other. The PrimeGov
feed does this by itself for finished meetings whose video Granicus has
published (within 45 days; with the review policy you approve each first).
Live Granicus events are expected to work the same way as a live stream but
haven't been tried on a real meeting yet.

**YouTube.** A meeting whose link is a YouTube video or live link
(`https://www.youtube.com/watch?v=...`, `youtu.be/...`, `/live/...`) shows
YouTube's own player on its page (and in `/embed/<slug>`): the video is
embedded, not copied or stored. For the transcript and the speaker labels the
server still needs the sound, so it follows the stream with yt-dlp (no
browser, no Xvfb, no login) and keeps only the audio: it waits while the
stream is upcoming, records while it's live (a late start still gets the
beginning of the stream, as far back as YouTube keeps it) and stops when it
ends. The sound is never served, and is deleted as soon as the transcript is
done (`KEEP_AUDIO_DAYS=3` keeps it that long, for transcribing again; a
transcript made from deleted sound can't be redone). The transcript beside the
embedded player follows it and seeks it. `YOUTUBE_RECORD=video` records the
picture too, played from here instead of YouTube. Schedule one like any
meeting on `/admin`, or let a feed find the link. yt-dlp is a pinned binary
in the image (`YT_DLP_VERSION` in the Dockerfile); when YouTube changes and
captures start failing, bumping it is the first thing to try.
`YOUTUBE_MAX_HEIGHT` (default 1080) only matters with `YOUTUBE_RECORD=video`.
A YouTube meeting we missed live gets its embed but no transcript: fetching the
sound of a finished stream is not built.

**API.** `/api/v1` (docs at `/api/docs`, OpenAPI at
`/api/v1/openapi.json`) lists meetings, their status, history and files with
no token. Downloading files needs a token: people with a confirmed email
make up to five on their account page (shown once; `mnt_...`), and revoke
them there. Admins see every token and per-user, per-token usage (requests
and data per day, most-downloaded files) on `/admin`; disabling a user
revokes their tokens. Reads are open to other sites (CORS). Anything that
plays in a browser can be saved: tokens are for tracking and fair use of
bulk access, not for protecting files. There are no rate limits yet (the
hook is in `src/tokens.ts`). An optional download speed cap, off by
default: `DOWNLOAD_MAX_BPS` for all API downloads together and
`DOWNLOAD_TOKEN_BPS` for each token (bytes per second, or `20m`, `500k`),
and an admin can give one token its own cap. Playback (`/media`) is never
throttled.

**Streaming quality.** Besides the original recording, the server makes
smaller copies (720p, 480p and 360p H.264, a fraction of the original's
size) one at a time, at low priority, and never while a capture is running
or about to start. The player on the meeting page and in embeds has a
Quality menu: Auto (picks one from the screen size and connection, and
steps down if playback keeps stalling), Original, or a size; the choice is
remembered. `RENDITIONS=720,480` changes the sizes, `RENDITIONS=off`
turns them off. The API lists them as `video-smaller` files. Why plain MP4
and H.264 rather than HLS or newer codecs: `docs/streaming-quality.md`.
A source already at one of those sizes gets a copy at its own size when it
is much heavier than ours would be (a city's 2.5 Mbps 720p stream becomes
about 0.35 Mbps). Each recording also keeps its raw capture part
(`part_001.mkv`) next to the stitched MP4: the same bytes twice. Set
`KEEP_PARTS_DAYS=7` to delete the parts of finished recordings whose MP4 is
that old and checked (same length as the stitch recorded, same size as the
parts); off by default.

**Permalinks and embedding.** Every public meeting has a permanent page,
`/m/<slug>` (`?t=90` or `?t=1m30s` starts the video there), and
`/embed/<slug>` is the video on its own for other sites' iframes, with
`?transcript=1`, `?chapters=1`, `?title=0`, `?t=` and `?theme=light|dark`.
The meeting page's Share box has the link and the iframe code, and
`/oembed?url=<meeting link>` serves oEmbed JSON for sites that support
it. `/embed` is the only page other sites may frame: `EMBED_ORIGINS` limits
who (`*` by default, since it's public and read-only; `none`; or origins
like `https://openlangford.ca https://*.openlangford.ca`). Set
`PUBLIC_URL` so the canonical and preview links are absolute.

## Feeds: finding meetings automatically

`/admin/feeds` polls a municipality's calendar and keeps its meetings up
to date: new ones, moved times, join links published late, cancellations.

| Source type | For | Config |
|---|---|---|
| eScribe meetings portal | Langford and many others | the portal URL, e.g. `https://pub-langford.escribemeetings.com`; optionally the meeting types to keep |
| PrimeGov public portal | Saanich (agendas) and others | the portal URL, e.g. `https://saanichca.primegov.com`; optionally title words to keep; timezone |
| CivicWeb portal | Colwood and others on `*.civicweb.net` | the portal URL, e.g. `https://colwood.civicweb.net`; optionally title words to keep; timezone. Reads the portal's own JSON (times, agendas, minutes); the meeting's YouTube stream becomes its join link once the city sets it up |
| Granicus (MediaManager) | sites that list meetings on Granicus | the site URL, e.g. `https://saanich.ca.granicus.com`, view id (1), timezone |
| iCalendar (.ics) | any calendar feed | the `.ics` URL |
| Web page (CSS selectors) | a page that lists meetings | the URL plus selectors for each row, its title, date (and time), link |

For each feed, choose what happens to new meetings: **wait for review**
(the default: they show in the review queue, Approve schedules the
capture), **record automatically** once there's a Zoom link, or **list
only**. Preview shows what a feed returns and what it would change before
anything is saved. Join links are found in the agenda or calendar entry,
including agendas that print only "Meeting ID: 843 4290 9811" and a
passcode.

Safety: a meeting that disappears from a feed is only flagged, never
cancelled; a run that would remove most of a feed's upcoming meetings
(a broken page, say) changes nothing and notifies you. A meeting already
known from another feed or scheduled by hand isn't captured twice.

Every meeting on `/admin/feeds` shows whether its **join link** (what
minutes records from) has been found yet, as the platform and meeting
number linking to the meeting without its passcode, plus "passcode on
file" when there is one; and whether its public **stream page** (the
live or recorded video: Granicus player, eScribe stream, PrimeGov video)
is known, with the link.

Each meeting's history (History on `/admin/feeds`) shows every change a
feed made and what it did to the capture: announced (first seen), moved
to another date or time (old and new, local time), join link published,
cancelled or back on, gone from the listing or back, title/body changes,
and, for eScribe and Granicus, each document posted, retitled or pulled
(agenda, revised agenda, addenda, notices, minutes). Changes are seen on
the next poll (hourly, every 5 minutes on a meeting day), and history
starts when the feed was added.

Langford, recommended start: eScribe, portal URL as above, meeting types
`Council Meeting`, `Special Council Meeting`, `Committee of the Whole
Meeting`, folder prefix `langford` (recordings become
`langford-council-meeting-2026-12-08`, which also picks the Langford
transcription vocabulary), policy *wait for review*.

Leaving the meeting types (or titles) blank keeps every meeting the source
lists; the policy, not the type, decides what's recorded.

Saanich: PrimeGov, `https://saanichca.primegov.com`, timezone
`America/Vancouver`, policy *list only*: it meets in person and streams
on Granicus, which isn't a capture platform yet, so its meetings are listed
with their agendas, documents and video but not recorded. (Its Granicus
site lists no upcoming meetings any more; PrimeGov is the source.) Its
meetings are on Microsoft Teams, and the join links are on the city's own
schedule page, not in the agendas: put that page's address in "Meeting links
page" and each link is matched to its meeting and shown as its join link.

Colwood: CivicWeb, `https://colwood.civicweb.net`, timezone
`America/Vancouver`, folder prefix `colwood`, policy *wait for review* at
first. Its council meetings stream on YouTube; the portal says which video
belongs to which meeting once the city has set it up, so no separate YouTube
feed is needed (and one would list each meeting twice). The meeting page
embeds the YouTube video; we keep only its sound long enough for the
transcript and the speaker labels (see below), not the video. Capturing that
sound from a YouTube stream has not been verified from the homelab's address
(see the YouTube notes above).

## Hardware encoding

    # Intel/AMD iGPU (VAAPI)
    docker run ... --device /dev/dri \
      --group-add "$(getent group render | cut -d: -f3)" \
      -e CAPTURE_ENCODER=vaapi minutes ...

    # Nvidia (needs nvidia-container-toolkit)
    docker run ... --gpus all -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility \
      -e CAPTURE_ENCODER=nvenc minutes ...

Cheaper capture without new hardware: `-e CAPTURE_WIDTH=1280 -e CAPTURE_HEIGHT=720 --fps 15`.

## Before trusting it on council night

Everything Zoom-specific is in `MARKERS` at the top of `src/platforms/zoom.ts`. Do a dry
run on a committee meeting with `-e LOG_LEVEL=DEBUG` to see every agent signal,
and watch the `state` events in the manifest. To see what the bot sees:
`docker exec <id> ffmpeg -f x11grab -video_size 1920x1080 -i :99 -frames:v 1 /recordings/shot.png`.

## Backups

With `BACKUP_DIR` set (compose and the k8s deployment set it to
`/backups`), `minutes serve` backs up its state once a day after 03:00
local (`BACKUP_HOUR`) and keeps 14 days (`BACKUP_KEEP_DAYS`). A backup is a
folder `minutes-YYYY-MM-DD_HHMM` with a `VACUUM INTO` copy of `minutes.db`,
the saved Zoom login, and `backup.json` (schema, row counts, sha256 of each
file). Each one is checked before it's kept: sqlite `integrity_check`, the
schema, the hashes. A failed backup is logged, sent to `CAPTURE_NOTIFY_URL`
once, and retried hourly. Recordings aren't backed up.

The folder holds live session tokens: keep it as private as `auth/`.

    minutes backup --dir /backups            # one now
    minutes backup --dir /backups --list
    minutes backup --verify /backups/<name>
    minutes restore /backups/<name> --out /recordings --auth /auth/zoom-auth.json

`restore` needs the server stopped. It verifies the backup, then puts the
database and login back; the files it replaces stay next to them as
`*.before-restore-<time>`. With compose: `docker compose stop capture`,
`docker compose run --rm capture restore /backups/<name> --out /recordings
--auth /auth/zoom-auth.json`, `docker compose start capture`. On the
cluster: `deploy/k8s/restore.sh` (see `deploy/k8s/README.md`).

## Develop

    npm install && npm run build
    npm test

`npm test` builds `src` and `test` into `.test-build/` and runs them with
`node --test`. The recorder and stitch tests need ffmpeg, and the media
guard and page classifier tests need Playwright's Chromium
(`npx playwright install chromium`); without them those tests skip locally.
CI installs both and runs everything on every pull request. To run it all in
the image instead:

    npx tsc -p tsconfig.test.json && docker build -t minutes .
    docker run --rm --entrypoint node -e CI=true -v "$PWD/.test-build:/app/.test-build:ro" \
      -w /app minutes --test '.test-build/test/**/*.test.js'
