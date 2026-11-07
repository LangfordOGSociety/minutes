"""
zoom-capture transcriber (Phase 1: transcribe + align, CPU-only).

Watches the shared recordings/ volume. For each finished capture (manifest
outcome is final and the stitched MP4 exists) it writes, next to the video:

  transcript.status.json   queued|running|done|failed, stage, timings, error
  <slug>.transcript.json   segments with word timings (source of truth)
  <slug>.vtt / <slug>.srt  subtitles, cue-split for reading
  <slug>.txt               readable transcript

If capture recorded who Zoom showed as the active speaker
(<slug>.speakers.json), each segment gets that name as `zoom_speaker` and the
subtitles use it. That's Zoom's label, not voice diarization (Phase 2).

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
MODEL = os.environ.get("WHISPER_MODEL", "distil-large-v3")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
BATCH = int(os.environ.get("WHISPER_BATCH", "8"))
THREADS = int(os.environ.get("WHISPER_THREADS", str(max(1, (os.cpu_count() or 2) - 1))))
POLL_S = int(os.environ.get("POLL_SECONDS", "60"))
# Don't compete with a live capture for CPU (each needs about a core).
WAIT_FOR_CAPTURES = os.environ.get("WAIT_FOR_CAPTURES", "1") not in ("0", "false", "no")
VOCAB = Path(os.environ.get("VOCAB_FILE", Path(__file__).with_name("vocab.txt")))
# Whisper invents fluent sentences on near-silent audio (room tone, recesses).
# Segments whose loudest 50ms window is below this are dropped from the
# subtitles/text (kept in the JSON under "dropped_quiet" for audit).
# Measured 2026-11-06: real speech -14..-20 dB, invented text -48..-57 dB.
SILENCE_DB = float(os.environ.get("SILENCE_DB", "-40"))

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
                        "speaker": seg.get("zoom_speaker")})
            continue
        cur: list[dict] = []
        for w in words:
            text = " ".join(x["word"].strip() for x in cur + [w])
            if cur and (len(text) > max_chars or w["end"] - cur[0]["start"] > max_dur):
                out.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                            "text": " ".join(x["word"].strip() for x in cur), "speaker": seg.get("zoom_speaker")})
                cur = []
            cur.append(w)
        if cur:
            out.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                        "text": " ".join(x["word"].strip() for x in cur), "speaker": seg.get("zoom_speaker")})
    return [c for c in out if c["text"]]


def write_outputs(d: Path, slug: str, result: dict, meta: dict) -> None:
    segs = result["segments"]
    write_atomic(d / f"{slug}.transcript.json", json.dumps({**meta, "segments": segs}, indent=1))

    cs = cues(segs)
    vtt = ["WEBVTT", "", f"NOTE Whisper transcript ({meta['model']}). Speaker names are Zoom's active-speaker label.", ""]
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
        who = s.get("zoom_speaker")
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


# --------------------------------------------------------------- pipeline --

_model = None
_align = None


def models():
    global _model, _align
    import whisperx  # slow import; only when there's work
    if _model is None:
        prompt = " ".join(l.strip() for l in VOCAB.read_text(encoding="utf-8").splitlines()
                          if l.strip() and not l.lstrip().startswith("#")) if VOCAB.exists() else None
        log(f"loading {MODEL} ({COMPUTE}, {THREADS} threads)")
        _model = whisperx.load_model(MODEL, "cpu", compute_type=COMPUTE, language=LANGUAGE,
                                     threads=THREADS, asr_options={"initial_prompt": prompt})
    if _align is None:
        _align = whisperx.load_align_model(language_code=LANGUAGE, device="cpu")
    return whisperx, _model, _align


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

            audio = whisperx.load_audio(str(wav))
            audio_s = len(audio) / 16000
            set_status(d, stage="transcribing", audio_seconds=round(audio_s, 1))
            t = time.monotonic()
            result = model.transcribe(audio, batch_size=BATCH, language=LANGUAGE,
                                      progress_callback=progress(d, "transcribing", 0, 90))
            timings["transcribe"] = round(time.monotonic() - t, 1)

            set_status(d, stage="aligning words")
            t = time.monotonic()
            result = whisperx.align(result["segments"], align_model, align_meta, audio, "cpu",
                                    return_char_alignments=False,
                                    progress_callback=progress(d, "aligning words", 90, 100))
            timings["align"] = round(time.monotonic() - t, 1)

        result["segments"], dropped = drop_quiet(result["segments"], audio)
        if dropped:
            log(f"{slug}: dropped {len(dropped)} segment(s) quieter than {SILENCE_DB} dB (likely invented on silence)")
        label_speakers(result["segments"], read_json(d / f"{slug}.speakers.json"))
        meta = {"model": MODEL, "compute_type": COMPUTE, "language": LANGUAGE, "created": now(),
                "audio_seconds": round(audio_s, 1), "source": video.name, "silence_db": SILENCE_DB,
                "dropped_quiet": [{"start": x.get("start"), "end": x.get("end"), "level_db": x["level_db"],
                                   "text": x.get("text", "").strip()} for x in dropped]}
        write_outputs(d, slug, result, meta)
        total = round(time.monotonic() - t0, 1)
        work = timings["transcribe"] + timings["align"]
        set_status(d, status="done", stage=None, progress=100, finished=now(), timings=timings, elapsed_seconds=total,
                   realtime_factor=round(work / audio_s, 3) if audio_s else None,
                   segments=len(result["segments"]), dropped_quiet=len(dropped), source_mtime=video.stat().st_mtime,
                   outputs=[f"{slug}.vtt", f"{slug}.srt", f"{slug}.txt", f"{slug}.transcript.json"])
        log(f"{slug}: done, {audio_s:.0f}s of audio in {total:.0f}s "
            f"(transcribe {timings['transcribe']}s, align {timings['align']}s)")
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
