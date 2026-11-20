# Deploying Zecca

Nothing is deployed yet: everything runs locally (`npm run dev`). This is how to put it online when the time comes.

The shape (BUILD decision D3): the **web app** (Next.js) goes on Vercel; the **API and the pool worker** run as one long-lived Node process in a Docker container on Render, Railway or Fly, with a small persistent volume. The API keeps a WebSocket to the ledger and generates zero-knowledge proofs on a worker thread, which a serverless function cannot do.

```
browser ──HTTPS──> Vercel: apps/web  (NEXT_PUBLIC_API_ORIGIN)
        ──HTTPS + SSE──> container: services/api + pool worker thread ──WebSocket──> XRPL Devnet / Testnet
                                     /data: zecca.sqlite, pool.sqlite, keystore.enc
```

## 1. The API image

```sh
docker build -t zecca-api .
docker run --rm -p 8800:8800 -e LEDGER_MODE=mock -e SIGNER_MODE=mock -e DEMO_MODE=1 -e DATABASE_PATH=:memory: zecca-api
curl http://localhost:8800/v1/health   # {"ok":true,"ledger":"mock","version":"0.1.0"}
```

What the image is:

- `node:22-slim`, the workspace packages and services as TypeScript source run with `tsx` (no build step), the pool worker on its own thread. Runs as the non-root user `node`: hosted volumes are mounted owned by root, so the container starts as root only to hand `/data` to `node`, then runs the command (the API, or a one-off such as the bootstrap) as `node`.
- No `VOLUME` line (Railway refuses one): the host attaches the volume at `/data`.
- Listens on `0.0.0.0:$PORT` (default 8800; Render and Railway set `PORT` themselves). A `HEALTHCHECK` calls `GET /v1/health`.
- State lives in the volume at `/data`: `DATABASE_PATH=/data/zecca.sqlite`, `POOL_DB_PATH=/data/pool.sqlite`, `KEYSTORE_PATH=/data/keystore.enc`.
- It never contains `.env`, a key store, a database, the web app, tests, or the laptop-only DNS workaround (`scripts/dev/`). See `.dockerignore`.
- Run **one instance only**. Pool transactions must be strictly sequential; two containers would send from the pool at the same time.

### Environment

Every variable, with its default, is in [`.env.example`](.env.example). For a Devnet deployment:

| Variable | Value |
|---|---|
| `LEDGER_MODE` | `devnet` |
| `SIGNER_MODE` | `privy` (or `mock` for a test deployment with the local signer) |
| `KEYSTORE_PASSPHRASE` | The passphrase of the key store in `/data` (secret) |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | The Privy app (secret) |
| `WEB_ORIGIN` | The Vercel URL, e.g. `https://zecca.vercel.app` (CORS and links) |
| `API_ORIGIN`, `PUBLIC_WEBHOOK_BASE` | This service's public URL |
| `MOONPAY_*`, `LITHIC_*`, `RAMP_SANDBOX_SCALE` | When top-up and card are switched on |
| `DEMO_MODE`, `FEATURE_*` | What the demo shows |

Mock mode (`LEDGER_MODE=mock`) is for a quick look only: its ledger lives in memory and is empty after every restart, so also set `DATABASE_PATH=:memory:`.

Set secrets in the host's secret store (typed into its dashboard or CLI), never in a committed file.

### The key store

In Devnet mode the API exits at startup unless the key store in `/data` holds the sponsor, issuer, pool and the confidential token's id. A new volume is empty, and with `LEDGER_MODE=devnet` there is never a running container to open a shell on. So a Devnet deployment goes in three steps, in this order:

1. **Deploy once in mock mode**, to get a running container with the volume: leave `LEDGER_MODE` unset (mock is the default) and set `DATABASE_PATH=:memory:`, so no mock data is written to the volume. Set `KEYSTORE_PASSPHRASE` and the other variables now.
2. **Put the key store on the volume**, in one of two ways:
   - **Reuse the local one.** Copy `.data/keystore.enc` to `/data/keystore.enc` and use the same `KEYSTORE_PASSPHRASE`. The file is encrypted (AES-256-GCM); it is still a secret.
   - **Create a fresh one** from a shell on the running container: `cd /app && node --import tsx scripts/bootstrap-ledger.ts`. It reads `KEYSTORE_PATH` and `KEYSTORE_PASSPHRASE` from the environment (if the shell does not have the service's variables, put them before the command), creates every account from the Devnet and Testnet faucets and the confidential token, and does nothing on a second run. The accounts are new, so existing users are not carried over.
3. **Switch to Devnet**: set `LEDGER_MODE=devnet`, remove the `DATABASE_PATH` override (the image default is `/data/zecca.sqlite`), and redeploy. Files that a root shell wrote to `/data` are handed to `node` when the container starts again.

### Fly.io

```sh
fly launch --no-deploy --name zecca-api            # uses the Dockerfile
fly volumes create zecca_data --size 1
fly secrets set KEYSTORE_PASSPHRASE=… PRIVY_APP_SECRET=…
fly deploy                                          # step 1, with DATABASE_PATH = ":memory:" in fly.toml [env]
fly ssh sftp shell                                  # step 2: put .data/keystore.enc /data/keystore.enc
                                                    #   (or fly ssh console, then the bootstrap command)
fly deploy                                          # step 3, after editing fly.toml [env]
```

In `fly.toml`: mount `zecca_data` at `/data`, `internal_port = 8800`, and keep the machine running (`auto_stop_machines = "off"`, `min_machines_running = 1`): a stopped machine stops paying out. Put the non-secret variables in `[env]`: `DATABASE_PATH = ":memory:"` and no `LEDGER_MODE` for step 1; `LEDGER_MODE = "devnet"` and no `DATABASE_PATH` for step 3.

### Render

New Web Service, runtime Docker, root of the repository. Add a disk mounted at `/data` (1 GB; disks need a paid instance). Health check path `/v1/health`. One instance. Set the variables above. For the key store follow the three steps above; step 2 runs in the service's Shell tab, and each variable change redeploys.

### Railway

New service from the repository; Railway builds the Dockerfile at the root. Add a volume mounted at `/data`, set the variables, health check path `/v1/health`, one replica. `RAILWAY_RUN_UID` is not needed: the image hands the volume to `node` itself. For the key store follow the three steps above; step 2 runs in a shell on the service (`railway ssh`).

## 2. The web app on Vercel

1. Import the repository in Vercel and set **Root Directory** to `apps/web`. Keep "Include files outside the root directory in the Build Step" on: the app compiles `packages/contracts` and `packages/xrpl-core` from source.
2. [`apps/web/vercel.json`](apps/web/vercel.json) sets the framework (Next.js), the install command (`npm ci --workspace=@zecca/web --include-workspace-root`; npm finds the workspace root and its lock file from `apps/web`) and the build command (`next build`).
3. Environment variable, for Production and Preview: `NEXT_PUBLIC_API_ORIGIN=https://<the API's public URL>`. It is built into the pages, so redeploy after changing it.
4. Deploy, then set the API's `WEB_ORIGIN` to the Vercel URL and restart the API.

## 3. After both are up

- **Privy dashboard**: add the Vercel origin to the allowed origins, and `https://<web>/wallet/privy` to the allowed redirect URLs (Google login).
- **MoonPay** (top-up): set the webhook to `https://<api>/v1/webhooks/moonpay`.
- **Lithic** (card): enrol `https://<api>/v1/webhooks/lithic/asa` as the authorization webhook.
- **Android merchant app**: the pay-link host allowlist is compiled in. Rebuild it with the web's host: `./gradlew assembleDebug -PzeccaNfcHosts=<web host>` (see `apps/merchant-nfc/README.md`).
- **Smoke test** against the deployed API (needs `SIGNER_MODE=mock` or `DEMO_MODE=1` there):
  `node node_modules/tsx/dist/cli.mjs scripts/smoke/demo-path.ts --api https://<api>`
