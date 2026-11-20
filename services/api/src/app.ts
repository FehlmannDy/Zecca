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

export { publicConfig } from './config'
export type { Env } from './config'

export type AppDeps = {
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
}

export type ZeccaApp = Hono & { core: Core }

export function createApp(deps: AppDeps): ZeccaApp {
  const settings = settingsFrom(deps.env)
  const log = deps.log ?? consoleLogger
  const now = deps.clock ?? Date.now
  const db = typeof deps.db === 'object' && deps.db !== null ? openDb(deps.db) : openDb(deps.db ?? deps.env.DATABASE_PATH ?? './.data/zecca.sqlite')
  const privy =
    deps.privy ??
    (settings.privyAppId && settings.privyAppSecret ? createPrivyVerifier({ appId: settings.privyAppId, appSecret: settings.privyAppSecret }) : undefined)

  const tasks = new Set<Promise<unknown>>()
  const core: Core = {
    env: deps.env,
    settings,
    db,
    ledger: deps.ledger,
    keystore: deps.keystore,
    pool: deps.poolWorker,
    privy,
    bus: createEventBus({ log: (m) => log.warn(m) }),
    log,
    now,
    iso: (ms) => new Date(ms ?? now()).toISOString(),
    id: deps.ids ?? randomId,
    submitHandlers: new Map(),
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

  return Object.assign(app, { core })
}
