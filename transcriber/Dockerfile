# CPU-only transcription service for zoom-capture. See docs/transcription-plan.md.
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Same uid as pwuser in the capture image, so both can write recordings/.
RUN useradd -m -u 1000 app
WORKDIR /app

COPY requirements.txt ./
# CPU wheels for torch (no CUDA download).
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY transcribe.py ./
COPY vocab/ ./vocab/
# Owned by app so a fresh named volume inherits writable dirs.
RUN mkdir -p /models/hf /models/torch /models/cache && chown -R app:app /models
USER app

# Model weights are cached on a volume so they download once.
ENV RECORDINGS=/recordings \
    HF_HOME=/models/hf \
    TORCH_HOME=/models/torch \
    XDG_CACHE_HOME=/models/cache \
    MPLCONFIGDIR=/tmp/matplotlib \
    PYTHONUNBUFFERED=1
VOLUME ["/models"]
ENTRYPOINT ["python", "/app/transcribe.py"]
