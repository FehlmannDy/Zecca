// The process `npm run dev` starts: the API on :8800 with the pool worker (in process on the mock ledger, on its own thread on Devnet).
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { consoleLogger } from './core'
import { seedDemoShop } from './seed'
import { wiringFor } from './wiring'

const env = process.env
const mode = env.LEDGER_MODE === 'devnet' ? 'devnet' : 'mock'
const w = await wiringFor(env, (m) => console.log(m))
// The mock ledger starts empty on every run, so its database does too unless DATABASE_PATH says otherwise.
const db = env.DATABASE_PATH ?? (mode === 'mock' ? ':memory:' : './.data/zecca.sqlite')
const app = createApp({ env, db, ledger: w.ledger, keystore: w.keystore, poolWorker: w.poolWorker, log: consoleLogger })

if (env.DEMO_MODE === '1' || env.DEMO_MODE === 'true') await seedDemoShop(app.core)
await w.poolWorker.start()
app.jobs.start({ reconcileMs: env.RECONCILE_MS === '0' ? 0 : Number(env.RECONCILE_MS ?? 60_000) })

const port = Number(env.API_PORT ?? env.PORT ?? 8800)
const server = serve({ fetch: app.fetch, port, hostname: env.API_HOST ?? '127.0.0.1' }, (i) =>
  console.log(`[api] listening on http://${i.address}:${i.port} (ledger ${mode}, signer ${env.SIGNER_MODE ?? 'mock'})`),
)

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  app.jobs.stop()
  server.close()
  await Promise.allSettled([w.poolWorker.stop(), w.close()])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
