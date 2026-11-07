# Transcription service plan (CPU-only)

Status: Phase 1 built and tested 2026-11-06 (see "Phase 1 results" at the
end). Phases 2-3 are still design.

Goal: subtitles and a speaker-labelled transcript for every recording, the
same night, on CPU. A GPU later should only change `device` / `compute_type`.

## Shape

A separate container next to the capture container, sharing the
`recordings/` volume. Python, because WhisperX and pyannote are Python + torch;
keeping it out of the Node app preserves the "no runtime deps beyond
playwright" rule. The two containers only talk through files, so either can
be restarted independently.

```
recordings/<slug>/
  manifest.json          <- capture writes (outcome != "pending" means finished)
  <slug>.mp4             <- stitched video
  transcript.status.json <- transcriber: queued|running|done|failed, progress, error
  <slug>.vtt             <- subtitles with <v Speaker> tags, loaded by the web player
  <slug>.srt             <- same, for other players
  <slug>.transcript.json <- segments + word timings + speaker + confidence (source of truth)
  <slug>.txt             <- readable "Speaker: text" paragraphs

transcriber/
  Dockerfile             python:3.11-slim + ffmpeg + CPU-only torch wheels
  requirements.txt       whisperx, pyannote.audio, pinned
  transcribe.py          watch loop + pipeline
  enroll.py              build voiceprints for known speakers
  vocab.txt              names and terms to bias recognition
models/                  volume: cached model weights (download once, then offline)
voices/                  volume: <name>.npy speaker embeddings
```

## Pipeline, per recording

1. **Pick up work.** Every 60s, look for a `manifest.json` with a final
   `outcome`, an existing MP4, and no `done` status. Take a lock file so two
   workers never process the same recording.
2. **Extract audio**: `ffmpeg -i <slug>.mp4 -ac 1 -ar 16000 audio.wav`. Work
   on the stitched MP4, not the parts: timestamps then line up with the video
   and its chapters, with no offset bookkeeping across reconnect gaps, and
   speaker labels stay consistent across the whole meeting.
3. **Transcribe**: WhisperX, `compute_type=int8`, `language="en"`, VAD on
   (skips silence, recesses, pre-meeting waits). Pass `vocab.txt` as the
   initial prompt: "Langford", council and staff names, street names, bylaw
   terms. Names are Whisper's weakest point. Model: an English distilled or
   turbo large-v3 variant for CPU speed, `medium.en` as the fallback. Check
   what's current when building.
4. **Align**: word-level timestamps via WhisperX's wav2vec2 aligner (cheap on CPU).
5. **Diarize**: pyannote with `min_speakers=6, max_speakers=15` by default,
   overridable per meeting. Needs `HF_TOKEN` once to download the models
   (free account, accept the model terms).
6. **Name speakers**: one embedding per anonymous speaker, cosine similarity
   against `voices/*.npy`. Above the threshold it gets that name, otherwise
   "Speaker N". Tune the threshold on real meetings. Always record the best
   match and its score in the JSON so mislabels can be audited.
7. **Write outputs** atomically (tmp + rename, like the capture side), set
   status `done`.

### Diarization caveats (why a range and voiceprints)

- With no count given, pyannote estimates it, and that's the weak spot:
  similar voices merge, and one person on two mics (room vs laptop) can split.
  A min/max range around the known council size keeps it from drifting.
- Overlapping speech goes to one speaker or is dropped (rare in a chaired
  meeting). Very short turns ("Seconded", "Aye") are often misattributed.
- Labels (`SPEAKER_00`...) are anonymous and only consistent within one file,
  never across meetings. Voiceprints fix both.
- Zoom's active-speaker name only helps if everyone is their own Zoom
  participant. Council chambers on one room mic is one Zoom participant, so
  voice separation is the only way to tell people apart there.

## Voiceprints (`enroll.py`)

```
enroll.py --name "Councillor A" --video past-meeting.mp4 \
  --at 00:12:30-00:13:10 --at 01:02:00-01:02:40
```

Two or three clean 20-60s clips per person from any past recording (the
City's official videos are fine). Averages their embeddings into
`voices/councillor-a.npy`. Re-enroll when council changes. Delegations and
the public stay "Speaker N".

## CPU budget

- Rough expectation, to be measured: on a modern 8-core box, transcription
  with an int8 distil/turbo model somewhere between about a third of and
  about equal to the meeting length, plus diarization at a further fraction.
  So a 3-hour meeting might take roughly 1.5-4 hours. **Measure on
  `livetest-3` first** (short, has real speech).
- Don't slow live captures: read `recordings/jobs.json` and wait while any
  capture is `running`, and run under `nice 10` with capped threads
  (`OMP_NUM_THREADS`, `cpu_threads`).
- "Same night" is likely but not guaranteed. If too slow: smaller model with
  diarization kept, then a GPU.

## Web interface changes (small, in the existing app)

- `serve.ts`: allow `.vtt`, `.srt`, `.txt`, `.transcript.json`; add a
  `transcript` field (status, progress) to `/api/recordings`.
- Player: `<track kind="subtitles" src="<slug>.vtt" default>` when present.
  CSP already allows same-origin media.
- Transcript panel beside the video: lines clickable to seek, a search box,
  speaker names coloured.
- Recordings list: "transcribing 40%" / "transcript" badge.

## Failure handling

- Status `failed` with the error; retried on transcriber restart or via a
  "Retry" button in the UI.
- Idempotent: deleting the status file re-runs it. Changing voiceprints can
  re-run just the naming step from the saved JSON, without re-transcribing.
- No MP4 (never got into the meeting): skipped. If a recording's
  `manifest.json` mtime changes after `done` (it grew), re-queue it.

## Build order

1. **Phase 1**: container, transcribe + align, `.vtt` / `.txt`, subtitle
   track in the player. Measure speed on `livetest-3`. No HF token needed.
2. **Phase 2**: diarization with anonymous speakers; transcript panel and
   search. Needs `HF_TOKEN`.
3. **Phase 3**: voiceprint enrollment and naming.
4. **Later**: draft transcripts while the meeting is still running (chunk the
   growing part); use Zoom active-speaker names when participants are
   individual (see the active-speaker step in CLAUDE.md); align to agenda
   items from the published agenda PDF.

## Open decisions

- Default speaker range (proposed 6-15).
- Wait for captures to finish, or just run at low priority alongside them.
- Model choice after measuring on real audio.

## Phase 1 results (2026-11-06)

- `transcriber/` container: python:3.11-slim, torch 2.8.0+cpu, whisperx 3.8.6,
  faster-whisper 1.2.1 (full pinned set in `requirements.txt`). Image ~2.2GB;
  models ~1.5GB more in the `models` volume on first run.
- distil-large-v3, int8, 5 threads on a 6-CPU Docker VM: realtime factor
  0.51 on continuous speech (42s synthetic council dialogue, 3 voices).
  Every line correct apart from US spelling ("favor") and casing.
  Mostly-silent audio is much faster (VAD skips it): 0.09 on a 110s clip.
- Zoom active-speaker labels (from capture's `<slug>.speakers.json`, built
  in the same change) attach to segments as `zoom_speaker` and show as
  `<v Name>` in the VTT. This is Zoom's label, not diarization.
- Web player: transcript track on by default, Zoom captions as a second
  track, transcript panel (click to seek, search, follows playback),
  status badge in the list.
- Not yet: a long real meeting (the 3h CPU estimate is extrapolated), Canadian
  spelling, Phase 2 diarization.
