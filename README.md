# zoom-capture

Joins a Zoom meeting in headed Chromium on a virtual display, records screen +
audio with ffmpeg, survives drops, and stitches the parts into one MP4.

Detection is event-driven: an agent injected into every frame watches the DOM
with a MutationObserver and calls back into Node when the meeting state
changes (joined, reconnecting, ended). Polling every few seconds is only a
heartbeat and hung-renderer check.

## Run

    docker build -t zoom-capture .
    docker run --rm --shm-size=1g -v "$PWD/recordings:/recordings" zoom-capture \
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
to jump around. CPU-only; roughly half the meeting length to transcribe on a
6-core machine, longer for big models. The transcriber waits while a capture
is running so it doesn't take its CPU. Model choice: `WHISPER_MODEL`
(default `distil-large-v3`). Edit `transcriber/vocab.txt` with council and
place names; that's where Whisper slips most.

Alongside the video, captures also record who Zoom shows as the active
speaker (`<slug>.speakers.json`, used to label the transcript) and Zoom's own
live captions when the host has them on (`<slug>.zoom-captions.vtt`, a second
subtitle track in the player, kept as a reference).

## Web interface

Schedule meetings, watch a capture live, and replay recordings in a browser:

    docker run -d --name zoom-capture --shm-size=1g --stop-timeout 120 \
      -p 127.0.0.1:8080:8080 \
      -v "$PWD/recordings:/recordings" -v "$PWD/auth:/auth" \
      -e CAPTURE_WEB_TOKEN=change-me \
      zoom-capture serve --auth /auth/zoom-auth.json

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

Each capture runs on its own virtual display and audio sink, so meetings can
overlap (`--max-jobs`, default 2; each 1080p30 x264 capture needs roughly a CPU
core). Jobs live in `recordings/jobs.json`. If the server restarts mid-capture,
that job is marked *interrupted* and not relaunched (it would overwrite its
parts). Give `docker stop` time to stitch: `--stop-timeout 120`.

Anyone who can reach the page can make your Zoom account join meetings and
can watch every recording: set `CAPTURE_WEB_TOKEN`, and publish the port on
`127.0.0.1` (or behind a VPN / reverse proxy with TLS).

## Hardware encoding

    # Intel/AMD iGPU (VAAPI)
    docker run ... --device /dev/dri \
      --group-add "$(getent group render | cut -d: -f3)" \
      -e CAPTURE_ENCODER=vaapi zoom-capture ...

    # Nvidia (needs nvidia-container-toolkit)
    docker run ... --gpus all -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility \
      -e CAPTURE_ENCODER=nvenc zoom-capture ...

Cheaper capture without new hardware: `-e CAPTURE_WIDTH=1280 -e CAPTURE_HEIGHT=720 --fps 15`.

## Before trusting it on council night

Everything Zoom-specific is in `MARKERS` at the top of `src/zoom.ts`. Do a dry
run on a committee meeting with `-e LOG_LEVEL=DEBUG` to see every agent signal,
and watch the `state` events in the manifest. To see what the bot sees:
`docker exec <id> ffmpeg -f x11grab -video_size 1920x1080 -i :99 -frames:v 1 /recordings/shot.png`.

## Develop

    npm install && npm run build
