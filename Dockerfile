# Zecca API: services/api with the pool worker on its own thread. One image that runs unchanged on Render, Railway
# or Fly (BUILD D3). TypeScript source runs through tsx, as in development; there is no build step.
#
#   docker build -t zecca-api .
#   docker run -p 8800:8800 -e LEDGER_MODE=mock -e SIGNER_MODE=mock -e DEMO_MODE=1 -e DATABASE_PATH=:memory: zecca-api
#
# Devnet: mount a volume on /data holding keystore.enc and pass KEYSTORE_PASSPHRASE (see DEPLOY.md).

FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 downloads a prebuilt binary; the tools are the fallback when none matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --omit=dev --no-audit --no-fund \
      --workspace=@zecca/api --workspace=@zecca/pool-worker --include-workspace-root \
 && npm cache clean --force \
 && rm -rf apps e2e

FROM node:22-slim
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    PORT=8800 \
    DATABASE_PATH=/data/zecca.sqlite \
    POOL_DB_PATH=/data/pool.sqlite \
    KEYSTORE_PATH=/data/keystore.enc
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8800
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||process.env.PORT||8800)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "services/api/src/server.ts"]
