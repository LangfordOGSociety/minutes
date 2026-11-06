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
