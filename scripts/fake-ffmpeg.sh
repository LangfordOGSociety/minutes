#!/usr/bin/env bash
# Stand-in for ffmpeg when there's no X display or PulseAudio (dev boxes, CI).
# Same process lifecycle as the real recorder (responds to 'q' on stdin,
# writes MKV to the last argument) but sources test patterns from lavfi.
#
#   mkdir -p /tmp/fakebin && cp scripts/fake-ffmpeg.sh /tmp/fakebin/ffmpeg
#   PATH=/tmp/fakebin:$PATH node dist/index.js ...
out="${@: -1}"
exec /usr/bin/ffmpeg -hide_banner -loglevel error -y -re \
  -f lavfi -i testsrc2=s=320x240:r=15 -f lavfi -i sine \
  -c:v libx264 -preset ultrafast -g 30 -c:a aac \
  -flush_packets 1 -cluster_time_limit 1000 -f matroska "$out"
