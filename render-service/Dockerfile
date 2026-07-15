# Isolated render service: Node 22 + system Chromium + FFmpeg.
#
# Debian (bookworm-slim), NOT Alpine: @hyperframes/producer drives Chromium via
# puppeteer, and Chromium + its shared libraries are far simpler to provision on
# glibc/Debian than on musl/Alpine. We install the distro Chromium and point
# puppeteer at it (PUPPETEER_EXECUTABLE_PATH) so no second browser is downloaded.
FROM node:22-bookworm-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# chromium + ffmpeg + the fonts/libs a headless Chrome needs to render text and
# composite frames. ca-certificates lets the service fetch any remote asset the
# composition still references.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     ffmpeg \
     ca-certificates \
     fonts-liberation \
     fonts-noto-color-emoji \
     fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Dependencies (cached layer) ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Runner ----
FROM base AS runner

# Non-root: Chromium must run with --no-sandbox in a container, so drop privileges.
RUN groupadd --system --gid 1001 render \
  && useradd --system --uid 1001 --gid render --home-dir /app render \
  && mkdir -p /tmp/openmaic-renders \
  && chown -R render:render /app /tmp/openmaic-renders

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=render:render package.json tsconfig.json ./
COPY --chown=render:render src ./src

ENV PORT=9000 \
    PRODUCER_TMP_PROJECT_DIR=/tmp/openmaic-renders

USER render
EXPOSE 9000

# tsx runs the TypeScript entrypoint directly — the service is small enough that
# a separate compile step buys nothing. NOTE: the entry is `main.ts`, not
# `server.ts`, because @hyperframes/producer auto-starts its own bundled server
# when the process entry path ends with `/src/server.ts` (or `/public-server.js`).
CMD ["node_modules/.bin/tsx", "src/main.ts"]
