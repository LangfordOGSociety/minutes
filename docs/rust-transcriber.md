# Rust transcriber: investigation (#50)

Status: investigation only, nothing built. Written 2026-11-26 from the
current Python transcriber (`transcriber/transcribe.py`, 785 lines) and web
research. Numbers marked "reported" are other people's, on similar but not
identical hardware, and must be re-measured here before deciding anything.

## What the Python transcriber does

| Step | Python today | Rust candidates |
|---|---|---|
| Decode audio (ffmpeg) | subprocess | same (or `symphonia`) |
| Speech to text | faster-whisper (CTranslate2), large-v3-turbo, prompt/vocab | `whisper-rs` (whisper.cpp), `ct2rs` (CTranslate2), `candle` |
| Word alignment | WhisperX wav2vec2 forced alignment | none ready-made; wav2vec2 via `ort` (ONNX) or `candle`, alignment written by hand |
| Diarization | pyannote 3.x via WhisperX | `pyannote-rs` (ONNX, one label per region, no overlap), `speakrs` (full pyannote community-1 pipeline, VBx) |
| Zoom-name matching, quiet gate, live chunks, vocab, status files, outputs | plain Python | straightforward port, no library needed |

The glue (watching recordings, status JSON, VTT/SRT/TXT writing, the silence
gate, live chunking, `vocab_extra`) is about 60% of the file and ports
mechanically. The risk is entirely in the three model steps.

## Findings

1. **GPU is the deciding factor.** The homelab runs on k3s-07's Radeon 8060S
   (gfx1151). Today: CTranslate2's ROCm wheel through Python, ~23x faster
   than the CPU box. `ct2rs` exposes only `cuda`, `openblas` and `dnnl`
   features (no ROCm/HIP), so keeping CTranslate2 from Rust means building
   CTranslate2 with HIP ourselves and patching the sys crate.
   `whisper-rs` wraps whisper.cpp, which runs on gfx1151 through Vulkan and
   HIP ([whisper.cpp discussion #3460](https://github.com/ggml-org/whisper.cpp/discussions/3460)).
2. **whisper.cpp may be slower here.** One report on the same Radeon 8060S
   has whisper.cpp large-v3 at ~4.5x realtime against ~9x for CTranslate2
   ([davidguttman/whisper-rocm](https://github.com/davidguttman/whisper-rocm)).
   Another has large-v3-turbo on Vulkan (Windows) at 80 min of audio in
   ~3 min (~27x), which is in our current range
   ([discussion](https://github.com/ggml-org/whisper.cpp/discussions/3460)).
   gfx1151 hipBLAS has known performance problems
   ([ROCm/TheRock #9130](https://github.com/ROCm/TheRock/issues/9130)); Vulkan
   is reported as the steadier backend. Needs a measurement, not a guess.
3. **Diarization is the weak spot.** `pyannote-rs` uses segmentation-3.0 and a
   wespeaker embedding with one label per region; its successor's authors
   say it can't represent overlapping speakers ([speakrs](https://github.com/attevon-llc/speakrs),
   their claim, not independently checked). Council meetings have crosstalk
   and our Zoom-name matching relies on clean voice segments. A Rust
   diarizer that is worse than pyannote 3.x is a regression users hear.
4. **Alignment has one real candidate:** [wav2vec2-rs](https://github.com/Djoe-Denne/wav2vec2-rs)
   (crate `wav2vec2-align`): CTC forced alignment of a known transcript onto
   audio, word timings in milliseconds with a confidence score, Viterbi on
   CPU, wgpu (Vulkan) or CUDA, model through Candle (safetensors) or ONNX
   Runtime. That is the WhisperX alignment step. It fits, with caveats:
   - **No licence file** (GitHub shows none), so by default all rights are
     reserved. We would need the author's permission or a licence before
     depending on it or copying code. Ask first.
   - **Young and small:** created 2026-02, ~14 stars, one author, CI runs CPU
     only; the GPU paths are not tested in CI.
   - **GPU is CUDA-shaped.** On our AMD GPU the usable parts are the wgpu
     Viterbi and Candle/ONNX on the CPU. The Viterbi is cheap; the wav2vec2
     forward pass is the cost. Alignment is a small part of the total next to
     Whisper, so CPU may be fine, but that needs measuring.
   - **Segment-level work is ours:** it takes text and 16 kHz audio. Splitting
     into segments, number and punctuation normalisation, and mapping words
     back to the Whisper text are what WhisperX does around its aligner and
     we would still write. Check the model: WhisperX uses an English wav2vec2
     (`WAV2VEC2_ASR_BASE_960H`-class); the same family exports to ONNX with
     the repo's script.
   - Its README describes quality as "MFA-quality" boundaries; compare it
     with WhisperX's on our own meetings before believing it.
5. **What Rust would genuinely give us:** a much smaller image (the ROCm
   Python image is multi-GB: torch, TheRock wheels, pyannote), faster CI
   builds (the transcriber image is the slowest to build), lower idle memory
   (no interpreter, no model unloading dance), one static binary. Not
   speed per se.

## Recommendation

Do not rewrite everything. Stage it so each step can be stopped:

1. **Baseline (small).** Run `transcriber/bench.py` on a fixed 30 min Langford
   clip on k3s-07, record per-step times, peak memory, image size, and CI
   build time. Without this nothing below can be judged. CI image job
   today: ~1.5 min cached; measure a cold build too.
2. **Spike A: speech-to-text only.** A small Rust binary, `whisper-rs` with the
   Vulkan feature, large-v3-turbo GGML, same initial prompt. Compare on the
   same clip: realtime factor, word error on a hand-checked 5 min excerpt,
   how the vocab prompt behaves (we depend on it: distil-large-v3 ignored it).
3. **Decision gate.** Continue only if A is within ~25% of CTranslate2's
   speed and no worse on names. Otherwise stop, and the Rust effort moves to
   what it is good for without ML: nothing in this repo needs it.
4. **Spike B (only after the gate): alignment and diarization.** wav2vec2-rs against WhisperX word timings (after the licence is sorted out); then `speakrs` against pyannote 3.x
   on a meeting with crosstalk; compare speaker count and boundary errors.
5. **Hybrid fallback.** If B or alignment disappoints, ship a Rust
   orchestrator and STT with the Python pieces behind a small local service
   for diarization/alignment. That gets most of the image and memory win
   with no quality loss, but it is not "Python removed".

## Benchmarks to add (the issue asks for them)

- `bench.py` already times transcribe / align / diarize separately; extend to
  print peak RSS and write one JSON line per run so Python and Rust runs diff.
- CI: record `images` job duration cold and warm, and the pushed image sizes,
  in the job summary for the Python image now, the Rust image if it exists.
- Alignment: word start/end of wav2vec2-rs against WhisperX on the same excerpt (median and 95th percentile difference in ms, words missing).
- Quality: a fixed excerpt with a hand-corrected reference transcript, word
  error rate and name-term recall (names are what the vocab work is for).

## Not decided

Whether the effort is worth it at all: the Python transcriber works, the
image is slow to build rather than broken, and the diarization gap is real.
The cheaper wins for image size and build time (slimmer layers, dropping
unused torch parts) should be tried first and measured against step 1.
