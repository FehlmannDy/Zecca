// Dev only: the API with the card connector mounted, for trying the card before app.ts wires it (orchestrator step).
// Same as src/server.ts plus mountCard/registerCard, FEATURE_CARD=1 and DEMO_MODE=1. Run from zecca/, unsandboxed:
//   node --env-file=.env -r ./scripts/dev/dnsfix.cjs node_modules/tsx/dist/cli.mjs services/api/src/connectors/card/dev-server.ts --port 8838
// CARD_DEV_TIER1=1 marks every new account verified (tier 1) so the card can be tried without the identity flow.
import { serve } from '@hono/node-server'
import { createApp } from '../../app'
import { consoleLogger } from '../../core'
import { seedDemoShop } from '../../seed'
import { wiringFor } from '../../wiring'
import { mountCard, registerCard, stopCard } from './index'

const argv = process.argv.slice(2)
const p = argv.indexOf('--port')
const port = Number(p >= 0 ? argv[p + 1] : process.env.API_PORT ?? 8838)
const env: Record<string, string | undefined> = { ...process.env, FEATURE_CARD: '1', DEMO_MODE: '1', LEDGER_MODE: process.env.LEDGER_MODE ?? 'mock' }

const w = await wiringFor(env, (m) => console.log(m))
const app = createApp({ env, db: env.DATABASE_PATH ?? ':memory:', ledger: w.ledger, keystore: w.keystore, poolWorker: w.poolWorker, log: consoleLogger })
mountCard(app, app.core)
registerCard(app.core)
await seedDemoShop(app.core)
await w.poolWorker.start()
app.jobs.start({ reconcileMs: 0 })
if (env.CARD_DEV_TIER1 === '1') {
  setInterval(() => app.core.db.prepare("UPDATE users SET tier = 1 WHERE tier = 0 AND status = 'active'").run(), 500).unref()
  console.log('[card-dev] every new account is marked verified (CARD_DEV_TIER1=1)')
}
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (i) => console.log(`[card-dev] API with the card on http://${i.address}:${i.port}`))
const stop = async () => {
  stopCard(app.core)
  app.jobs.stop()
  server.close()
  await Promise.allSettled([w.poolWorker.stop(), w.close()])
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
