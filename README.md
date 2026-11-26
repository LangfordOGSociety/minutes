# minutes

**The meeting's over. The minutes are ready.**

Records online meetings start to finish without help from the host, and turns
them into one chaptered video with a speaker-labelled transcript, the same
night. Built for public council meetings; Zoom today, more platforms next.

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

## Feeds: finding meetings automatically

`/admin/feeds` polls a municipality's calendar and keeps its meetings up
to date: new ones, moved times, join links published late, cancellations.

| Source type | For | Config |
|---|---|---|
| eScribe meetings portal | Langford and many others | the portal URL, e.g. `https://pub-langford.escribemeetings.com`; optionally the meeting types to keep |
| Granicus (MediaManager) | Saanich and many others | the site URL, e.g. `https://saanich.ca.granicus.com`, view id (1), timezone |
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
known from another feed or scheduled by hand isn't captured twice. Each
meeting's history shows every change a feed made and what it did to the
capture.

Langford, recommended start: eScribe, portal URL as above, meeting types
`Council Meeting`, `Special Council Meeting`, `Committee of the Whole
Meeting`, folder prefix `langford` (recordings become
`langford-council-meeting-2026-12-08`, which also picks the Langford
transcription vocabulary), policy *wait for review*.

Saanich: Granicus, `https://saanich.ca.granicus.com`, view 1, timezone
`America/Vancouver`, policy *list only*: its meetings stream on Granicus,
which isn't a capture platform yet, so they're listed with their watch
page but not recorded.

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
