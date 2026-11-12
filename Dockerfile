# syntax=docker/dockerfile:1

# --- Server dependencies --------------------------------------------------------
# better-sqlite3 ships prebuilt binaries for glibc x64/arm64; the build tools are only a
# fallback for platforms without one and never reach the runtime image.
FROM node:22-bookworm-slim AS server-deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Frontend build -----------------------------------------------------------
# The build writes THIRD_PARTY_NOTICES.txt and LICENSE.txt into dist/ (X68). The notices cover the
# server's production packages too, so this stage needs the server's lockfile and node_modules.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/package-lock.json ./server/
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY index.html vite.config.js jsconfig.json postcss.config.js tailwind.config.js components.json LICENSE ./
COPY scripts/third-party-notices.mjs ./scripts/
COPY public ./public
COPY src ./src
COPY shared ./shared
RUN npm run build

# --- Runtime --------------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY shared /app/shared
COPY --from=web /web/dist /app/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
