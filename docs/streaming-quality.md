# Streaming quality (ticket #86)

Goal: video that streams efficiently to the public site and to other sites' embeds, and a
Quality control so a viewer can pick higher or lower.

## What we record today

A real council recording (46 min, Nov 24): 1920x1080, H.264 High, about 0.9 Mbps video plus
about 0.1 Mbps AAC, 309 MB in all. The screen is mostly slides and a speaker, so the
capture's encoder already spends little. The file is already "faststart" (the index is at the
front), so it plays before it has downloaded.

Two things cost viewers anyway: 1080p is more than a phone or a slow connection needs, and
the original's index (`moov`) is large because the capture's timestamps are variable-rate
(about 75 KB per minute, so 3.4 MB for this meeting, which must arrive before playback starts).
A 30 fps constant-rate copy has an index about 3.5 times smaller.

## What was compared

A 4 minute clip of that recording, video only, scaled and re-encoded on a laptop (Apple
silicon, so only the ratios mean anything). SSIM is against the original scaled to the same
size (1 is identical).

| encoder | size | video rate | SSIM | speed (x realtime) |
|---|---|---|---|---|
| original, 1080p | 1080p | about 900-1000 kbps | | |
| x264 medium crf 26, 1080p | 1080p | 706 kbps | 0.993 | 11 |
| x264 medium crf 26 | 720p | 344 kbps | 0.991 | 20 |
| x264 medium crf 30 | 720p | 199 kbps | 0.986 | 22 |
| x264 slow crf 28 | 720p | 260 kbps | 0.989 | 17 |
| x264 veryfast crf 28 | 720p | 160 kbps | 0.983 | 35 |
| x264 medium crf 28 | 480p | 139 kbps | 0.986 | 34 |
| x264 medium crf 30 | 360p | 70 kbps | 0.980 | 54 |
| x265 medium crf 30 | 720p | 171 kbps | 0.986 | 8 |
| VP9 crf 36 (good, cpu-used 2) | 720p | 301 kbps | 0.990 | 2.8 |
| AV1 (SVT) preset 8 crf 38 | 720p | 394 kbps | 0.993 | 17 |
| AV1 (SVT) preset 5 crf 38 | 720p | 369 kbps | 0.994 | 6 |

Reading it:

- **Resolution is the big lever.** 720p is about a third of the original's rate, 480p about a
  seventh and 360p about a thirteenth, for an SSIM that stays above 0.98.
- **A newer codec buys little here.** At matching quality, x265 and VP9 save roughly 10-15%
  over x264 and cost 3 to 7 times the CPU. The AV1 rows are not smaller (they are higher
  quality at a similar rate), and AV1 encoding is the slowest and the least supported on
  older phones and TVs. HEVC does not play in Firefox and is licensed. Because the picture
  barely moves, x264 is already near what these codecs can do.
- **Preset**: medium was used. The slow and veryfast rows are at different CRFs from the
  medium ones, so they are not a like-for-like comparison; medium is a middle choice that
  encodes at about 20x realtime on this laptop.

## Decisions

1. **Smaller copies as plain progressive MP4, H.264 + AAC, faststart** (`src/renditions.ts`):
   720p, 480p and 360p, 30 fps constant rate, x264 medium, CRF 27 (29 for 480p and 360p), a
   keyframe every 2 seconds so seeking is quick, AAC 96 kbps at 720p and 64 kbps below.
   H.264 plays on every browser and TV, in embeds, and needs no player library.
2. **Not HLS/DASH.** Real adaptive streaming needs a player library (hls.js, about 500 KB;
   the project has no runtime dependencies) or native HLS (Safari only), and many small
   segment files per recording. For a transcript-synced player with seeking and chapters, and
   viewers who mostly watch on one connection, a menu plus an automatic first choice is enough.
   If this is ever wanted, the copies here can be segmented without re-encoding.
3. **The original stays as recorded** (and is the Video download link). Copies are made for
   sizes smaller than the original, and for the original's own size when its video rate is
   more than 2.5 times what our copy would cost (`planHeights`): a city's 2.5 Mbps 720p
   stream gets a 720p copy of about 0.35 Mbps, so the 720p viewer is not sent the original.
4. **Made in the background, politely**: one ffmpeg at a time, `nice -n 19`, four threads, not
   while a capture runs or starts within 30 minutes, written under a temporary name and
   renamed, a failure retried after an hour. Existing recordings are backfilled the same way
   (30 s after a start, then every 5 minutes). `RENDITIONS=off` turns it off.
5. **The Quality menu** (`PLAYER_JS`, on the meeting page and in embeds): Auto, Original, and
   each size. Auto picks the smallest copy that is still sharp for the player's size and the
   screen's pixel density (a 390 px phone at 2x gets 480p, a desktop window 720p), the lowest
   with Save-Data or a 2G connection, and steps down one size after three stalls in half a
   minute. Changing quality keeps the position, speed and play state. The choice is kept in
   `localStorage` (`minutes.quality`).
6. **Public files**: the copies are public files of a public recording (served by `/media` with
   Range, listed by `/api/v1/meetings/:id/files` as `video-smaller` with a `height`).

## Not done, and why

- **Re-encoding the originals.** Langford's are 0.9 Mbps already, and a newer codec saves only
  10-15% for 3-7 times the CPU and a generation of quality. The raw capture parts are the real
  duplicate (the MP4 is a stream copy of them): `KEEP_PARTS_DAYS` removes them (`src/parts.ts`).
- **Audio-only version.** Easy to add the same way if there is a need.
- **A storage budget.** The three copies add roughly 55% of the original's size (about 0.34 +
  0.14 + 0.07 Mbps against 1 Mbps); a 46 minute meeting adds about 190 MB. Check the volume if
  recordings pile up; `RENDITIONS=720,480` drops the smallest.
- **Playback in the tests.** Playwright's Chromium can't play H.264, so the tests check the
  menu, the source it picks and the files; the encode itself is tested with ffmpeg.
