# Image tag and the playwright npm version must match, so the bundled
# browser is the one the library expects.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.48.0-jammy
# intel-media-va-driver (Intel iGPU VAAPI) only exists for amd64. On arm64
# only mesa's VAAPI drivers are installed; x264 is the expected encoder there.
RUN set -e; \
    intel=""; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then intel="intel-media-va-driver"; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xvfb x11-utils pulseaudio pulseaudio-utils ffmpeg \
      mesa-va-drivers $intel; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json entrypoint.sh ./
RUN mkdir -p /recordings && chown pwuser:pwuser /recordings

USER pwuser
ENV TZ=America/Vancouver \
    CAPTURE_OUT=/recordings
VOLUME ["/recordings"]
ENTRYPOINT ["/app/entrypoint.sh"]
