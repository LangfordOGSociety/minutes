# zoom-capture

Records a Zoom meeting end to end without host cooperation: waits for the
scheduled start, joins via the Zoom web client in headed Chromium on Xvfb,
records screen + audio with ffmpeg, survives drops by rejoining as new parts,
and stitches the parts into one MP4 with a chapter at every gap.

First target is City of Langford council meetings, which are public, run on
Zoom, and publish the official video 24-48h later. The goal is having video
(and later transcripts) the same night.

## Layout

- `src/index.ts` CLI (node:util parseArgs, no deps). Sets TZ before use.
- `src/runner.ts` lifecycle state machine. Event-driven via `Waker`.
- `src/zoom.ts` Playwright session. **All Zoom-specific markers live in `MARKERS`.**
  `pageAgent()` is injected into every frame with `addInitScript`; it must stay
  self-contained (it's serialized, so no references outside the function).
- `src/recorder.ts` ffmpeg x11grab + pulse -> MKV parts. Encoders: x264, vaapi, nvenc.
- `src/stitch.ts` remux-repair each part, concat with chapters, re-encode fallback.
- `src/login.ts` `zoom-capture login`: human signs in once, saves storage state.
- `src/serve.ts` `zoom-capture serve`: node:http web UI + JSON API, Range
  serving for video, optional Basic auth (CAPTURE_WEB_TOKEN), same-origin
  check on writes. Only serves .mp4/.mkv/.png/.json/.vtt/.srt/.txt directly inside
  a slug dir.
- `src/jobs.ts` scheduler: jobs.json (atomic), launches the normal CLI as a
  child per job with its own Xvfb display (:100+) and null sink (zoom_<n>)
  via DISPLAY / CAPTURE_SINK / PULSE_SINK. Never touches the default source.
  Links are restricted to *.zoom.us or bare IDs; the meeting password never
  leaves the server (API returns meetingId only).
- `src/webui.ts` the page, as a String.raw template: its script must not use
  backticks or dollar-brace. All data goes in via textContent; build children
  with `fill()`, not `replaceChildren()` (which renders a null arg as "null").
- `src/timeline.ts` active speaker + Zoom captions: appended per change to
  `speakers.jsonl` / `captions.jsonl` while recording, then mapped onto the
  stitched clock as `<slug>.speakers.json`, `<slug>.zoom-captions.{json,vtt}`.
  Offsets use each part's `videoStart` (first captured frame, from ffmpeg
  `-progress`), not spawn time: ffmpeg takes ~1.5-2.6s to open x11grab+pulse.
- `transcriber/` separate Python container (WhisperX, CPU int8). Watches
  recordings/, writes `<slug>.{vtt,srt,txt,transcript.json}` and
  `transcript.status.json`; waits while a capture is running. Uses
  `<slug>.speakers.json` to label segments (`zoom_speaker`).
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
meeting... sign in to join"). `zoom-capture login` saves a signed-in session
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

Timezone data: the image's Node ships tzdata 2024a, and even Node 24's 2025b
predates BC's move to permanent daylight time (2026-11-01, UTC-7), so
`--start` and chapter times were an hour off. The Dockerfile now installs ICU
tz files for 2026f (pinned, sha256-checked) and sets ICU_TIMEZONE_FILES_DIR;
verified `--start 2026-11-16T19:00` -> 02:00Z and chapter clock correct. The
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
   `zoom-capture login` shortly before. (Debug dumps exist; the interruption
   tests passed on the test meeting.)
2. Done offline: active-speaker and Zoom-caption timelines. Verify on the
   committee dry run (step 1): check `speakers.json` names against the video,
   and whether the meeting has captions (and whether the CC click worked).
3. Transcription: Phase 1 built (transcribe + align, subtitles, transcript
   panel). Next is Phase 2, pyannote diarization (needs HF_TOKEN), then
   voiceprints. See `docs/transcription-plan.md`.

## Run

    npm ci && npm run build
    docker build -t zoom-capture .
    docker run --rm --shm-size=1g -v "$PWD/recordings:/recordings" zoom-capture \
      --link "https://zoom.us/j/87093163922" --start 2026-11-16T19:00 \
      --slug council-2026-11-16 --name "Recorder (Eric)"

Docker image tag and the `playwright` npm version are pinned together (1.48.0)
so the bundled Chromium matches. Bump them together.

## Style

- No runtime deps beyond playwright. Keep it that way unless there's a real reason.
- Owner's preference: no em dashes in comments, docs, or output text.
