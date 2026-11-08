"""
zoom-capture transcriber (transcribe + align + speaker diarization, CPU-only).

Watches the shared recordings/ volume. For each finished capture (manifest
outcome is final and the stitched MP4 exists) it writes, next to the video:

  transcript.status.json   queued|running|done|failed, stage, timings, error
  <slug>.transcript.json   segments with word timings (source of truth)
  <slug>.vtt / <slug>.srt  subtitles, cue-split for reading
  <slug>.txt               readable transcript

Speakers: with HF_TOKEN set (or the pyannote model already cached), voices
are separated with pyannote (`speaker`, e.g. SPEAKER_03) and shown as
"Speaker N" in order of first appearance. If capture recorded Zoom's active
speaker (<slug>.speakers.json), each segment also gets `zoom_speaker`, and a
voice takes the Zoom name only when the two match one-to-one (a council
chamber on one room mic is one Zoom name for many voices: no names then).
`label` is what the subtitles and text show. Per-recording speaker counts:
<slug>/transcribe.json {"min_speakers": 6, "max_speakers": 15} (or
"num_speakers"); defaults from DIARIZE_MIN / DIARIZE_MAX.

Usage:
  transcribe.py                 watch forever (the container default)
  transcribe.py --once          process what's pending, then exit
  transcribe.py --slug NAME     (re)transcribe one recording now, then exit
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get("RECORDINGS", "/recordings"))
# large-v3-turbo over distil-large-v3: same CPU speed here, and it follows
# the vocabulary prompt (distil ignored it: 0 of 5 council names right on the
# Langford 2026-10-05 test clip vs 4 of 5 for turbo).
MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
BATCH = int(os.environ.get("WHISPER_BATCH", "8"))
THREADS = int(os.environ.get("WHISPER_THREADS", str(max(1, (os.cpu_count() or 2) - 1))))
POLL_S = int(os.environ.get("POLL_SECONDS", "60"))
# Don't compete with a live capture for CPU (each needs about a core).
WAIT_FOR_CAPTURES = os.environ.get("WAIT_FOR_CAPTURES", "1") not in ("0", "false", "no")
# Whisper's prompt = vocab/common.txt + the council's file, picked by the
# recording name's prefix ("langford-..." -> vocab/langford.txt) or by
# <slug>/transcribe.json {"vocab": "langford"}. VOCAB_FILE overrides all.
VOCAB_DIR = Path(os.environ.get("VOCAB_DIR", Path(__file__).with_name("vocab")))
VOCAB_FILE = os.environ.get("VOCAB_FILE")
# Whisper invents fluent sentences on near-silent audio (room tone, recesses).
# Segments whose loudest 50ms window is below this are dropped from the
# subtitles/text (kept in the JSON under "dropped_quiet" for audit).
# Measured 2026-11-06: real speech -14..-20 dB, invented text -48..-57 dB.
SILENCE_DB = float(os.environ.get("SILENCE_DB", "-40"))
# Speaker diarization (pyannote, gated model: needs HF_TOKEN for the first
# download, then runs from the models volume). DIARIZE=0 turns it off.
DIARIZE = os.environ.get("DIARIZE", "1") not in ("0", "false", "no")
HF_TOKEN = os.environ.get("HF_TOKEN") or None
DIARIZE_MODEL = os.environ.get("DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")
DIARIZE_MIN = int(os.environ["DIARIZE_MIN"]) if os.environ.get("DIARIZE_MIN") else None
DIARIZE_MAX = int(os.environ["DIARIZE_MAX"]) if os.environ.get("DIARIZE_MAX") else None
# Step of pyannote's 10s analysis window, as a fraction of it. Speaker embeddings
# (97% of diarization time on CPU) scale with 1/step. Measured on a 5 min slice
# of a council meeting: 0.1 (pyannote's default) 316s, 0.25 126s and 5% DER
# from 0.1, 0.5 64s but merged two speakers.
DIARIZE_STEP = float(os.environ.get("DIARIZE_STEP", "0.25"))

FINAL_OUTCOMES_SKIP = {"pending"}
STATUS = "transcript.status.json"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def log(msg: str) -> None:
    print(f"{now()} transcriber {msg}", flush=True)


def write_atomic(path: Path, data: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def set_status(d: Path, **fields) -> dict:
    st = read_json(d / STATUS) or {}
    st.update(fields, updated=now())
    write_atomic(d / STATUS, json.dumps(st, indent=1))
    return st


def captures_running() -> bool:
    jobs = read_json(ROOT / "jobs.json") or []
    return any(j.get("status") in ("running", "stopping") for j in jobs if isinstance(j, dict))


def pending() -> list[Path]:
    """Finished recordings with a video and no up-to-date transcript, oldest first."""
    out = []
    for d in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        m = read_json(d / "manifest.json")
        if not m or m.get("outcome") in FINAL_OUTCOMES_SKIP or not m.get("output"):
            continue
        video = d / m["output"]
        if not video.exists():
            continue
        st = read_json(d / STATUS) or {}
        if st.get("status") == "failed":
            continue  # retried on restart (see main) or by deleting the status file
        if st.get("status") == "done" and st.get("source_mtime") == video.stat().st_mtime:
            continue
        out.append(d)
    return sorted(out, key=lambda d: (d / "manifest.json").stat().st_mtime)


# ---------------------------------------------------------------- outputs --

def ts(t: float, sep: str) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def vtt_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("-->", "->")


def cues(segments: list[dict], max_chars: int = 84, max_dur: float = 6.0) -> list[dict]:
    """Split segments into subtitle-sized cues on word boundaries."""
    out = []
    for seg in segments:
        words = [w for w in seg.get("words", []) if "start" in w and "end" in w]
        if not words:
            out.append({"start": seg["start"], "end": seg["end"], "text": seg["text"].strip(),
                        "speaker": seg.get("label")})
            continue
        cur: list[dict] = []
        for w in words:
            text = " ".join(x["word"].strip() for x in cur + [w])
            if cur and (len(text) > max_chars or w["end"] - cur[0]["start"] > max_dur):
                out.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                            "text": " ".join(x["word"].strip() for x in cur), "speaker": seg.get("label")})
                cur = []
            cur.append(w)
        if cur:
            out.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                        "text": " ".join(x["word"].strip() for x in cur), "speaker": seg.get("label")})
    return [c for c in out if c["text"]]


def write_outputs(d: Path, slug: str, result: dict, meta: dict) -> None:
    segs = result["segments"]
    write_atomic(d / f"{slug}.transcript.json", json.dumps({**meta, "segments": segs}, indent=1))

    cs = cues(segs)
    note = (f"NOTE Whisper transcript ({meta['model']}). Speakers separated by voice (pyannote); "
            "a name appears only where one Zoom participant matched one voice.") if meta.get("diarization") else \
           f"NOTE Whisper transcript ({meta['model']}). Speaker names are Zoom's active-speaker label."
    vtt = ["WEBVTT", "", note, ""]
    srt = []
    for i, c in enumerate(cs, 1):
        who = c.get("speaker")
        body = vtt_escape(c["text"])
        vtt += [str(i), f"{ts(c['start'], '.')} --> {ts(c['end'], '.')}", f"<v {vtt_escape(who)}>{body}" if who else body, ""]
        srt += [str(i), f"{ts(c['start'], ',')} --> {ts(c['end'], ',')}", f"{who}: {c['text']}" if who else c["text"], ""]
    write_atomic(d / f"{slug}.vtt", "\n".join(vtt))
    write_atomic(d / f"{slug}.srt", "\n".join(srt))

    # Readable text: one paragraph per speaker turn, with a timestamp.
    lines, last = [], object()
    for s in segs:
        who = s.get("label")
        if who != last or not lines:
            lines.append(f"\n[{ts(s['start'], '.')[:8]}] {who or 'Speaker'}:")
            last = who
        lines.append(s["text"].strip())
    write_atomic(d / f"{slug}.txt", ("\n".join(lines)).strip() + "\n")


def level_db(audio, start: float, end: float, sr: int = 16000, win: float = 0.05) -> float:
    """Loudest short-window RMS in [start, end], dBFS. Windowed so a single
    click can't make a silent stretch look like speech."""
    import numpy as np
    x = audio[int(max(start, 0) * sr):int(max(end, 0) * sr)]
    if x.size == 0:
        return -120.0
    n = int(win * sr)
    k = x.size // n
    rms = np.sqrt(np.mean(x[:k * n].reshape(k, n) ** 2, axis=1)).max() if k else np.sqrt(np.mean(x ** 2))
    return round(20 * float(np.log10(max(float(rms), 1e-6))), 1)


def drop_quiet(segs: list[dict], audio) -> tuple[list[dict], list[dict]]:
    keep, dropped = [], []
    for s in segs:
        s["level_db"] = level_db(audio, s.get("start", 0), s.get("end", 0))
        (keep if s["level_db"] >= SILENCE_DB else dropped).append(s)
    return keep, dropped


def label_speakers(segs: list[dict], spans: list[dict] | None) -> None:
    """Attach Zoom's active speaker (by most overlap) to each segment."""
    if not spans:
        return
    for s in segs:
        best, best_ov = None, 0.0
        for sp in spans:
            ov = min(s["end"], sp["until"]) - max(s["start"], sp["at"])
            if ov > best_ov:
                best, best_ov = sp["name"], ov
        if best:
            s["zoom_speaker"] = best


def name_speakers(segs: list[dict]) -> dict:
    """Set each segment's display `label`. Voices become "Speaker N" in order
    of first appearance. A voice takes a Zoom name only when it's mutual: at
    least 80% of the voice's time is under that Zoom name, and at least 80%
    of that Zoom name's time is this voice. Returns {raw id: label}."""
    order: list[str] = []
    for s in segs:
        sp = s.get("speaker")
        if sp and sp not in order:
            order.append(sp)
    labels = {sp: f"Speaker {i}" for i, sp in enumerate(order, 1)}
    # time per (voice, zoom name)
    both: dict[tuple[str, str], float] = {}
    voice_t: dict[str, float] = {}
    zoom_t: dict[str, float] = {}
    for s in segs:
        dur = max(0.0, s.get("end", 0) - s.get("start", 0))
        sp, zn = s.get("speaker"), s.get("zoom_speaker")
        if sp:
            voice_t[sp] = voice_t.get(sp, 0) + dur
        if zn:
            zoom_t[zn] = zoom_t.get(zn, 0) + dur
        if sp and zn:
            both[(sp, zn)] = both.get((sp, zn), 0) + dur
    for (sp, zn), t in both.items():
        if t >= 0.8 * voice_t[sp] and t >= 0.8 * zoom_t[zn] and voice_t[sp] > 0:
            labels[sp] = zn
    for s in segs:
        sp = s.get("speaker")
        s["label"] = labels[sp] if sp else s.get("zoom_speaker")
    return labels


def read_opts(d: Path) -> dict:
    o = read_json(d / "transcribe.json") or {}
    out = {"min_speakers": DIARIZE_MIN, "max_speakers": DIARIZE_MAX, "num_speakers": None}
    for k in out:
        if isinstance(o.get(k), int) and o[k] > 0:
            out[k] = o[k]
    if out["num_speakers"]:
        out["min_speakers"] = out["max_speakers"] = None
    return out


# --------------------------------------------------------------- pipeline --

_model = None
_align = None
_diarize = None          # pipeline, or the reason it's unavailable (str)


def read_vocab(path: Path) -> str:
    if not path.exists():
        return ""
    return " ".join(l.strip() for l in path.read_text(encoding="utf-8").splitlines()
                    if l.strip() and not l.lstrip().startswith("#"))


def vocab_for(d: Path) -> tuple[str | None, list[str]]:
    """(prompt, files used) for one recording."""
    if VOCAB_FILE:
        files = [Path(VOCAB_FILE)]
    else:
        files = [VOCAB_DIR / "common.txt"]
        name = (read_json(d / "transcribe.json") or {}).get("vocab")
        if not isinstance(name, str) or not (VOCAB_DIR / f"{name}.txt").exists():
            name = next((f.stem for f in sorted(VOCAB_DIR.glob("*.txt"))
                         if f.stem != "common" and d.name.lower().startswith(f.stem.lower())), None)
        if name:
            files.append(VOCAB_DIR / f"{name}.txt")
    prompt = " ".join(t for t in (read_vocab(f) for f in files) if t)
    return prompt or None, [f.name for f in files if f.exists()]


def models():
    global _model, _align
    import whisperx  # slow import; only when there's work
    if _model is None:
        log(f"loading {MODEL} ({COMPUTE}, {THREADS} threads)")
        _model = whisperx.load_model(MODEL, "cpu", compute_type=COMPUTE, language=LANGUAGE, threads=THREADS)
    if _align is None:
        _align = whisperx.load_align_model(language_code=LANGUAGE, device="cpu")
    return whisperx, _model, _align


def diarizer():
    """The pyannote pipeline, or a string saying why there isn't one."""
    global _diarize
    if _diarize is None:
        if not DIARIZE:
            _diarize = "off (DIARIZE=0)"
        else:
            try:
                from whisperx.diarize import DiarizationPipeline
                log(f"loading {DIARIZE_MODEL}")
                _diarize = DiarizationPipeline(model_name=DIARIZE_MODEL, token=HF_TOKEN, device="cpu")
                seg = _diarize.model._segmentation
                seg.step = DIARIZE_STEP * seg.duration
            except Exception as e:  # noqa: BLE001 - no token / terms not accepted / offline
                _diarize = f"unavailable: {type(e).__name__}: {e}"[:300]
                log(f"speaker separation {_diarize}" + ("" if HF_TOKEN else " (set HF_TOKEN, see docs/transcription-plan.md)"))
    return _diarize


def progress(d: Path, stage: str, lo: float, hi: float):
    """whisperx progress (0-100) -> overall percent in the status file, at most every 5s."""
    last = [0.0]

    def cb(pct: float) -> None:
        t = time.monotonic()
        if t - last[0] >= 5 or pct >= 100:
            last[0] = t
            set_status(d, stage=stage, progress=round(lo + (hi - lo) * min(max(pct, 0), 100) / 100))
    return cb


def transcribe(d: Path) -> None:
    m = read_json(d / "manifest.json") or {}
    slug, video = d.name, d / m["output"]
    lock = open(d / ".transcribe.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log(f"{slug}: locked by another worker, skipping")
        return
    t0 = time.monotonic()
    timings: dict[str, float] = {}
    try:
        set_status(d, status="running", stage="extracting audio", progress=0, model=MODEL, started=now(), error=None)
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "audio.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000", str(wav)],
                           check=True)
            timings["extract"] = round(time.monotonic() - t0, 1)

            set_status(d, stage="loading model")
            t = time.monotonic()
            whisperx, model, (align_model, align_meta) = models()
            timings["load"] = round(time.monotonic() - t, 1)

            # The prompt is per recording (per council), so set it on the
            # loaded model's options rather than at load time.
            from dataclasses import replace
            prompt, vocab_files = vocab_for(d)
            model.options = replace(model.options, initial_prompt=prompt)

            audio = whisperx.load_audio(str(wav))
            audio_s = len(audio) / 16000
            set_status(d, stage="transcribing", audio_seconds=round(audio_s, 1))
            t = time.monotonic()
            result = model.transcribe(audio, batch_size=BATCH, language=LANGUAGE,
                                      progress_callback=progress(d, "transcribing", 0, 70))
            timings["transcribe"] = round(time.monotonic() - t, 1)

            set_status(d, stage="aligning words")
            t = time.monotonic()
            result = whisperx.align(result["segments"], align_model, align_meta, audio, "cpu",
                                    return_char_alignments=False,
                                    progress_callback=progress(d, "aligning words", 70, 78))
            timings["align"] = round(time.monotonic() - t, 1)

            diar_meta: dict | None = None
            pipe = diarizer()
            if not isinstance(pipe, str):
                opts = read_opts(d)
                set_status(d, stage="separating speakers")
                t = time.monotonic()
                diar, emb = pipe(audio, return_embeddings=True, progress_callback=progress(d, "separating speakers", 78, 100),
                                 **{k: v for k, v in opts.items() if v})
                result = whisperx.assign_word_speakers(diar, result)
                timings["diarize"] = round(time.monotonic() - t, 1)
                diar_meta = {"model": DIARIZE_MODEL, "options": opts, "step": DIARIZE_STEP,
                             "speakers_found": int(diar["speaker"].nunique()) if len(diar) else 0,
                             "turns": [{"start": round(float(r.start), 2), "end": round(float(r.end), 2), "speaker": r.speaker}
                                       for r in diar.itertuples()],
                             # pyannote voice embeddings per speaker: input for voiceprints (Phase 3)
                             "embeddings": {k: [round(float(x), 5) for x in v] for k, v in (emb or {}).items()}}

        result["segments"], dropped = drop_quiet(result["segments"], audio)
        if dropped:
            log(f"{slug}: dropped {len(dropped)} segment(s) quieter than {SILENCE_DB} dB (likely invented on silence)")
        label_speakers(result["segments"], read_json(d / f"{slug}.speakers.json"))
        labels = name_speakers(result["segments"])
        if diar_meta is not None:
            diar_meta["labels"] = labels
        meta = {"model": MODEL, "compute_type": COMPUTE, "language": LANGUAGE, "created": now(),
                "audio_seconds": round(audio_s, 1), "source": video.name, "silence_db": SILENCE_DB,
                "vocab": vocab_files,
                "diarization": diar_meta, "diarization_note": None if diar_meta else diarizer(),
                "dropped_quiet": [{"start": x.get("start"), "end": x.get("end"), "level_db": x["level_db"],
                                   "text": x.get("text", "").strip()} for x in dropped]}
        write_outputs(d, slug, result, meta)
        total = round(time.monotonic() - t0, 1)
        work = timings["transcribe"] + timings["align"] + timings.get("diarize", 0)
        set_status(d, status="done", stage=None, progress=100, finished=now(), timings=timings, elapsed_seconds=total,
                   realtime_factor=round(work / audio_s, 3) if audio_s else None,
                   segments=len(result["segments"]), dropped_quiet=len(dropped), source_mtime=video.stat().st_mtime,
                   speakers=(diar_meta or {}).get("speakers_found"),
                   outputs=[f"{slug}.vtt", f"{slug}.srt", f"{slug}.txt", f"{slug}.transcript.json"])
        log(f"{slug}: done, {audio_s:.0f}s of audio in {total:.0f}s "
            f"(transcribe {timings['transcribe']}s, align {timings['align']}s"
            + (f", diarize {timings['diarize']}s, {diar_meta['speakers_found']} speakers" if diar_meta else "") + ")")
    except Exception as e:  # noqa: BLE001 - record any failure in the status file
        set_status(d, status="failed", stage=None, error=f"{type(e).__name__}: {e}"[:500])
        log(f"{slug}: FAILED\n{traceback.format_exc()}")
    finally:
        lock.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="process pending recordings, then exit")
    ap.add_argument("--slug", help="(re)transcribe one recording now, then exit")
    a = ap.parse_args()
    try:
        os.nice(10)
    except OSError:
        pass

    if a.slug:
        d = ROOT / a.slug
        if not (d / "manifest.json").exists():
            log(f"no recording {a.slug}")
            return 2
        transcribe(d)
        return 0 if (read_json(d / STATUS) or {}).get("status") == "done" else 1

    # On startup, give failed and interrupted jobs another go.
    for d in ROOT.iterdir():
        st = read_json(d / STATUS) if d.is_dir() else None
        if st and st.get("status") in ("failed", "running"):
            set_status(d, status="queued", error=st.get("error"))

    log(f"watching {ROOT} (model {MODEL}, wait for captures: {WAIT_FOR_CAPTURES})")
    while True:
        todo = pending()
        if todo and WAIT_FOR_CAPTURES and captures_running():
            for d in todo:
                if (read_json(d / STATUS) or {}).get("stage") != "waiting for live captures":
                    set_status(d, status="queued", stage="waiting for live captures")
        else:
            for d in todo:
                if WAIT_FOR_CAPTURES and captures_running():
                    break
                transcribe(d)
        if a.once:
            return 0
        time.sleep(POLL_S)


if __name__ == "__main__":
    sys.exit(main())
