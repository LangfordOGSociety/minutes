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

Known issue: the image's Node ships tzdata 2024a, which predates BC's move to
permanent daylight time (2026-11-01). A `--start` without an offset is read
as UTC-8 instead of UTC-7, an hour late. Pass an explicit offset
(`--start 2026-11-16T19:00-07:00`) until that's fixed.

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
  are in `MARKERS.reconnect` / `overlays`, and the saved live HTML of the
  disconnected screen classifies as `reconnecting` offline. Re-run this live:
  expected `reconnecting` -> 45s -> `feed_lost` -> rejoin.

Still untested live:
- Webinars (`/w/` links, registration), host-removed, meeting-not-started.
- Session expiry: how long a saved login lasts, and whether the write-back
  after each meeting keeps it alive.
- amd64 image live, VAAPI / NVENC paths.

## Suggested next steps

1. Dry run on a low-stakes Langford committee meeting with `LOG_LEVEL=DEBUG`.
   Grab frames from the display (`ffmpeg -f x11grab ... -frames:v 1 shot.png`)
   at each stage and fix `MARKERS` against what the page really shows.
   Consider adding a debug mode that saves a screenshot + `page.content()` on
   every state change, it'll make the markers much faster to tune.
2. Simulate interruptions during the dry run: `docker network disconnect` for
   >45s (should produce a new part), kill chromium (DEAD -> rejoin), kill ffmpeg
   (new part, same session).
3. Speaker/active-speaker metadata: the web client's DOM exposes the participant
   list and active speaker indicator. Have `pageAgent` emit timestamped
   active-speaker changes into the manifest; this is for labelling transcript
   speakers later.
4. Transcription pipeline (separate service): faster-whisper/WhisperX on parts
   as they close, align to agenda items from the published agenda PDF.

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
