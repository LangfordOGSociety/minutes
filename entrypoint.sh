#!/usr/bin/env bash
# Brings up a virtual display and audio, then runs the capture.
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
W="${CAPTURE_WIDTH:-1920}"
H="${CAPTURE_HEIGHT:-1080}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p -m 700 "$XDG_RUNTIME_DIR"

Xvfb "$DISPLAY" -screen 0 "${W}x${H}x24" -nolisten tcp -ac &
for _ in $(seq 1 50); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done

pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit --log-target=stderr
for _ in $(seq 1 50); do pactl info >/dev/null 2>&1 && break; sleep 0.1; done

# "zoom" is where Chromium plays meeting audio; ffmpeg records zoom.monitor.
# "silence" is the default *source*, so the browser's "mic" is dead air.
# Without it the default source could end up being zoom.monitor and you'd
# feed the meeting back into itself.
pactl load-module module-null-sink sink_name=zoom    sink_properties=device.description=zoom >/dev/null
pactl load-module module-null-sink sink_name=silence sink_properties=device.description=silence >/dev/null
pactl set-default-sink zoom
pactl set-default-source silence.monitor

exec node /app/dist/index.js "$@"
