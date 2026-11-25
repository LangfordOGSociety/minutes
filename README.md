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
      -e CAPTURE_WEB_TOKEN=change-me \
      minutes serve --auth /auth/zoom-auth.json

Open http://127.0.0.1:8080/ (any username, password = `CAPTURE_WEB_TOKEN`).

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

Anyone who can reach the page can make your Zoom account join meetings and
can watch every recording: set `CAPTURE_WEB_TOKEN`, and publish the port on
`127.0.0.1` (or behind a VPN / reverse proxy with TLS).

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

## Develop

    npm install && npm run build
