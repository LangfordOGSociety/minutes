"""
Time the transcriber's three heavy steps on one audio file, outside the
service: speech-to-text (faster-whisper / CTranslate2), word alignment
(WhisperX wav2vec2), speaker separation (pyannote). Same model, prompt,
batch size and diarization step as transcribe.py, which it imports.

    python bench.py <audio.wav> <slug> [out.json]

BENCH_DEVICE=cpu (default) or cuda (also ROCm: torch and CTranslate2's
HIP builds both call the GPU "cuda"). WHISPER_COMPUTE defaults to int8 on
CPU, float16 on GPU. Model downloads happen before the clock starts.
Prints one JSON line with the timings and enough output to compare runs.
"""
import json
import os
import platform
import sys
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import transcribe as T  # noqa: E402

DEVICE = os.environ.get("BENCH_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8" if DEVICE == "cpu" else "float16")
STEPS = os.environ.get("BENCH_STEPS", "transcribe,align,diarize").split(",")


def main() -> int:
    wav, slug = sys.argv[1], sys.argv[2]
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    import torch
    import whisperx
    import ctranslate2
    # BENCH_MIOPEN=0: PyTorch's own GPU kernels instead of AMD's MIOpen
    # (cuDNN's stand-in), whose runtime-compiled batch-norm kernel fails on
    # gfx1151 with the 2026-04 ROCm nightlies.
    if os.environ.get("BENCH_MIOPEN", "1") == "0":
        torch.backends.cudnn.enabled = False

    info = {
        "device": DEVICE, "compute": COMPUTE, "model": T.MODEL, "batch": T.BATCH, "threads": T.THREADS,
        "host": os.environ.get("NODE_NAME", platform.node()), "torch": torch.__version__,
        "ctranslate2": ctranslate2.__version__,
        "ct2_gpus": ctranslate2.get_cuda_device_count() if hasattr(ctranslate2, "get_cuda_device_count") else None,
        "torch_gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "miopen": torch.backends.cudnn.enabled,
    }
    print("setup", json.dumps(info), flush=True)
    timings: dict[str, float] = {}

    t = time.monotonic()
    model = whisperx.load_model(T.MODEL, DEVICE, compute_type=COMPUTE, language=T.LANGUAGE, threads=T.THREADS)
    align_model, align_meta = whisperx.load_align_model(language_code=T.LANGUAGE, device=DEVICE)
    prompt, vocab = T.vocab_for(Path("/nonexistent") / slug)
    model.options = replace(model.options, initial_prompt=prompt)
    timings["load"] = round(time.monotonic() - t, 1)

    audio = whisperx.load_audio(wav)
    audio_s = len(audio) / T.SR

    t = time.monotonic()
    result = model.transcribe(audio, batch_size=T.BATCH, language=T.LANGUAGE)
    timings["transcribe"] = round(time.monotonic() - t, 1)
    print("transcribe", timings["transcribe"], flush=True)

    if "align" in STEPS:
        t = time.monotonic()
        result = whisperx.align(result["segments"], align_model, align_meta, audio, DEVICE, return_char_alignments=False)
        timings["align"] = round(time.monotonic() - t, 1)
        print("align", timings["align"], flush=True)

    speakers = None
    if "diarize" in STEPS and T.HF_TOKEN:
        from whisperx.diarize import DiarizationPipeline
        t = time.monotonic()
        pipe = DiarizationPipeline(model_name=T.DIARIZE_MODEL, token=T.HF_TOKEN, device=DEVICE)
        seg = pipe.model._segmentation
        seg.step = T.DIARIZE_STEP * seg.duration
        timings["diarize_load"] = round(time.monotonic() - t, 1)
        t = time.monotonic()
        diar, _emb = pipe(audio, return_embeddings=True)
        result = whisperx.assign_word_speakers(diar, result)
        timings["diarize"] = round(time.monotonic() - t, 1)
        speakers = int(diar["speaker"].nunique()) if len(diar) else 0
        print("diarize", timings["diarize"], flush=True)

    work = sum(v for k, v in timings.items() if k in ("transcribe", "align", "diarize"))
    segs = result["segments"]
    text = " ".join((s.get("text") or "").strip() for s in segs)
    summary = {**info, "audio_s": round(audio_s, 1), "vocab": vocab, "timings": timings, "work_s": round(work, 1),
               "realtime_factor": round(work / audio_s, 3), "segments": len(segs), "speakers": speakers,
               "words": len(text.split())}
    if out:
        out.write_text(json.dumps({**summary, "text": text,
                                   "segments": [{"start": s.get("start"), "end": s.get("end"), "speaker": s.get("speaker"),
                                                 "text": s.get("text")} for s in segs]}))
    print("RESULT", json.dumps(summary), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
