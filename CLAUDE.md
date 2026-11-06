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

Built and partially tested, NOT yet run against live Zoom.

Tested:
- Strict TS build, CLI parsing, `webClientUrl()` for /j/, /w/, bare IDs.
- Stitch: 3 parts incl. one SIGKILLed mid-write -> repaired, chapters with gap
  lengths, correct offsets.
- Recorder lifecycle with `scripts/fake-ffmpeg.sh`: graceful 'q' stop (~150ms,
  exit 0), detection of ffmpeg dying on its own, new part after a crash.

Untested (needs a real browser + Zoom):
- `pageAgent` classification and the `__ccSignal` binding across frames.
- Every regex/selector in `MARKERS`, `JOIN_BUTTON`, `JOIN_AUDIO`, `MUTE_SELECTOR`.
  These are best guesses at the current web client and are the most likely
  thing to need fixing. In particular `MARKERS.overlays`: while the meeting UI
  is up, ended/reconnect text is only matched inside those overlays (so chat
  and captions can't end a recording). If Zoom's real end-of-meeting dialog
  or reconnect banner isn't one of them, it will be missed while the footer
  is still in the DOM.
- `app.zoom.us/wc/join/<id>` URL form actually landing on the browser client.
- VAAPI / NVENC paths.

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
