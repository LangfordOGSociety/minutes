# Ubuntu 22.04 + Node 24 LTS (node:sqlite), with only Chromium from Playwright. (The
# mcr.microsoft.com/playwright image also ships Firefox and WebKit and their
# libraries, ~700MB we never use.) The browser comes from the playwright npm
# package in package-lock.json, so its revision always matches the library.
FROM ubuntu:22.04 AS base
ARG NODE_VERSION=24.22.3
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN set -e; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    case "$TARGETARCH" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "unsupported arch $TARGETARCH"; exit 1 ;; esac; \
    f="node-v${NODE_VERSION}-linux-${a}.tar.xz"; cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/$f"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " $f\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "$f" -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/include' --exclude='*/share/doc' --exclude='*/share/man'; \
    rm -f "$f" SHASUMS256.txt; \
    rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM base
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
# Chromium and the system libraries/fonts it needs, then the capture tools.
# intel-media-va-driver (Intel iGPU VAAPI) only exists for amd64. On arm64
# only mesa's VAAPI drivers are installed; x264 is the expected encoder there.
RUN set -e; \
    node node_modules/playwright/cli.js install --with-deps chromium; \
    intel=""; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then intel="intel-media-va-driver"; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xvfb x11-utils pulseaudio pulseaudio-utils ffmpeg \
      mesa-va-drivers $intel; \
    rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm /tmp/*; \
    useradd -m -u 1000 -s /bin/bash pwuser

# Timezone data for Node's ICU, pinned. Node 20.18 shipped tzdata 2024a,
# which predates BC's move to permanent daylight time (2026-11-01, UTC-7),
# so --start and chapter times came out an hour off. Node 24.22.3 bundles
# 2026e (already has it, checked 2026-11-24); this keeps the data at least
# this new whatever Node ships. ICU loads these .res files from
# ICU_TIMEZONE_FILES_DIR in preference to its built-in data. Bump
# ICU_TZ_VERSION and the sums together (from unicode-org/icu-data).
ARG ICU_TZ_VERSION=2026f
RUN set -e; \
    mkdir -p /usr/share/icu-tz; cd /usr/share/icu-tz; \
    base="https://raw.githubusercontent.com/unicode-org/icu-data/main/tzdata/icunew/${ICU_TZ_VERSION}/44/le"; \
    for f in zoneinfo64 timezoneTypes metaZones windowsZones; do curl -fsSL -o "$f.res" "$base/$f.res"; done; \
    printf '%s\n' \
      "d9382726ee8a499514310e63a9e97f1dbdd7fc2db328e1a785dde05f2afbb7e6  zoneinfo64.res" \
      "5e77ce5afb7374a36cbe3be197d0a6deaa919e6f672c2a372f7a9d91b7f8534f  timezoneTypes.res" \
      "cc9d283bb2797813a17c00d80c2a86d27bc80da5e1cd24da846e8b4af6dbd860  metaZones.res" \
      "377691d021bbdd7012806d8188412d13e587a76b64ecc7b79fec4dc36a419deb  windowsZones.res" \
      | sha256sum -c -
ENV ICU_TIMEZONE_FILES_DIR=/usr/share/icu-tz

COPY --from=build /app/dist ./dist
COPY package.json entrypoint.sh ./
RUN mkdir -p /recordings && chown pwuser:pwuser /recordings

USER pwuser
ENV TZ=America/Vancouver \
    CAPTURE_OUT=/recordings
EXPOSE 8080
VOLUME ["/recordings"]
ENTRYPOINT ["/app/entrypoint.sh"]
