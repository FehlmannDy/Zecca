// createApp(deps): the whole HTTP API on Hono, every dependency injected so tests run in memory.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { KeyStore, Ledger, PoolWorker } from '@zecca/contracts'
import { openDb, type Db } from './db'
import { createEventBus } from './bus'
import { publicConfig, settingsFrom, type Env } from './config'
import { consoleLogger, randomId, type Core, type Logger } from './core'
import { Err } from './errors'
import { errorResponse, mount } from './http'
import { createPrivyVerifier, type PrivyVerifier } from './auth/privy'
import { mountAuth } from './auth/routes'
import { createRateLimiter } from './limits'
import { mountDirectory } from './directory'
import { mountOnboarding } from './onboarding'
import { mountSubmit } from './prepared/submit'
import { mountActivity } from './activity'
import { mountTransfers } from './transfers'
import { mountPaymentRequests } from './paymentRequests/routes'
import { mountEvents } from './events'
import { mountDev } from './dev'
import { mountRamp, type RampDeps } from './connectors/ramp'
import { mountDemoShop } from './demoShop'
import { mountCard, registerCard } from './connectors/card'
import { mountEarn, registerEarn } from './connectors/earn'
import { mountMarket, registerMarket } from './connectors/market'
import { mountIdentity, registerIdentity } from './connectors/identity'
import { mountProofs, registerProofs } from './connectors/proofs'
import { registerSendHandler, wirePoolEvents } from './intents/flow'
import { createJobs, type Jobs } from './jobs'
import { recordCardActivity } from './books'

export { publicConfig } from './config'
export type { Env } from './config'

export type AppDeps = {
  /** Mount the phase-2 connectors (card, earn, market, identity, proofs). Default true; the test harness turns it off so connector tests mount their own with fakes. */
  connectors?: boolean
  env: Env
  /** A database, or a path (default DATABASE_PATH, else ./.data/zecca.sqlite). Tests pass ':memory:'. */
  db?: Db | string
  ledger: Ledger
  keystore: KeyStore
  poolWorker: PoolWorker
  /** Defaults to the real verifier when PRIVY_APP_ID and PRIVY_APP_SECRET are set. */
  privy?: PrivyVerifier
  clock?: () => number
  ids?: (prefix: string) => string
  log?: Logger
  /** Ramp connector: MoonPay API and Testnet reader (defaults: the real ones). Tests pass fakes. */
  ramp?: RampDeps
}

export type ZeccaApp = Hono & { core: Core; jobs: Jobs }

export function createApp(deps: AppDeps): ZeccaApp {
  const settings = settingsFrom(deps.env)
  const log = deps.log ?? consoleLogger
  const now = deps.clock ?? Date.now
  const db = typeof deps.db === 'object' && deps.db !== null ? openDb(deps.db) : openDb(deps.db ?? deps.env.DATABASE_PATH ?? './.data/zecca.sqlite')
  const privy =
    deps.privy ??
    (settings.privyAppId && settings.privyAppSecret ? createPrivyVerifier({ appId: settings.privyAppId, appSecret: settings.privyAppSecret }) : undefined)

  const tasks = new Set<Promise<unknown>>()
  const bus = createEventBus({ log: (m) => log.warn(m) })
  const core: Core = {
    env: deps.env,
    settings,
    db,
    ledger: deps.ledger,
    keystore: deps.keystore,
    pool: deps.poolWorker,
    privy,
    bus: {
      ...bus,
      // Card purchases live in the card connector's sub-ledger: each card.authorization also keeps the cardholder's activity row.
      toUser(userId, e) {
        bus.toUser(userId, e)
        if (e.type === 'card.authorization') recordCardActivity(core, userId, e.data.id)
      },
    },
    log,
    now,
    iso: (ms) => new Date(ms ?? now()).toISOString(),
    id: deps.ids ?? randomId,
    submitHandlers: new Map(),
    receivedHandlers: new Map(),
    track(p, what) {
      const t = p.catch((e) => log.error(`[api] background ${what} failed: ${(e as Error)?.message ?? e}`)).finally(() => tasks.delete(t))
      tasks.add(t)
    },
    async idle() {
      while (tasks.size) await Promise.all([...tasks])
    },
    rateLimit: (key) => limiter.hit(key),
  }
  const limiter = createRateLimiter(core, settings.prepareRateLimitPerMin)

  const app = new Hono()
  app.use('/v1/*', cors({ origin: settings.webOrigin, credentials: true }))
  app.onError((err, c) => errorResponse(c, err, core))
  app.notFound((c) => c.json(Err.notFound().body(), 404))

  mount(app, core, 'health', () => ({ ok: true, ledger: settings.ledgerMode, version: '0.1.0' }))
  mount(app, core, 'config', () => publicConfig(deps.env, { keystore: deps.keystore, ledger: deps.ledger }))
  mountAuth(app, core)
  mountDirectory(app, core)
  mountOnboarding(app, core)
  mountSubmit(app, core)
  mountActivity(app, core)
  mountTransfers(app, core)
  mountPaymentRequests(app, core)
  mountEvents(app, core)
  mountDev(app, core)
  mountRamp(app, core, deps.ramp)
  mountDemoShop(app, core)
  // Phase 2: each connector stays dark (404 feature_off) until its FEATURE_* flag is on.
  if (deps.connectors !== false) {
    registerCard(core)
    mountCard(app, core)
    registerEarn(core)
    mountEarn(app, core)
    registerMarket(core)
    mountMarket(app, core)
    registerIdentity(core)
    mountIdentity(app, core)
    registerProofs(core)
    mountProofs(app, core)
  }
  registerSendHandler(core)
  wirePoolEvents(core)

  return Object.assign(app, { core, jobs: createJobs(core) })
}
