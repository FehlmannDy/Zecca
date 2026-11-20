// Earn connector (SPEC §4.7, §6.3), behind FEATURE_EARN. The orchestrator adds mountEarn(app, core) and registerEarn(core) to app.ts.
//   EARN_MODE=live|mock   live: XRPL Testnet + Flare Coston2 (default with LEDGER_MODE=devnet); mock: in memory ("Test position")
//   EARN_PRICE=live|fixture   XRP/USD from CoinGecko, or the dated fixture (default: live in live mode)
//   EARN_MOCK_EXECUTE_MS   how long mock Flare takes to execute (default 8000)
//   EARN_JOBS=0            no background resume / withdrawal job
import type { Hono } from 'hono'
import { DEFAULTS } from '@zecca/contracts'
import type { Core } from '../../core'
import { mount } from '../../http'
import { createEarn, type Earn, type EarnDeps } from './service'
import { initEarnTables } from './repo'
import { createMockEarnSides } from './mock-sides'
import { createLiveTestnet } from './live-testnet'
import { createLiveFlare } from './live-flare'
import { createXrpPriceFeed } from './price'
import type { FlareSide, TestnetSide } from './sides'

export type { Earn } from './service'

const services = new WeakMap<Core, Earn>()

const int = (v: string | undefined, d: number) => (v && Number.isSafeInteger(Number(v)) ? Number(v) : d)

export type EarnOptions = Partial<Omit<EarnDeps, 'testnet' | 'flare'>> & { sides?: { testnet: TestnetSide; flare: FlareSide }; jobs?: boolean }

export function earnMode(core: Core): 'live' | 'mock' {
  const m = core.env.EARN_MODE
  if (m === 'live' || m === 'mock') return m
  return core.settings.ledgerMode === 'devnet' ? 'live' : 'mock'
}

function depsFor(core: Core, o: EarnOptions): EarnDeps {
  const mode = o.sides?.testnet.mode ?? earnMode(core)
  const log = (m: string) => core.log.info(m)
  const sides =
    o.sides ??
    (mode === 'live'
      ? { testnet: createLiveTestnet({ keystore: core.keystore, log }), flare: createLiveFlare() }
      : createMockEarnSides({ keystore: core.keystore, executeAfterMs: int(core.env.EARN_MOCK_EXECUTE_MS, 8_000) }))
  const livePrice = core.env.EARN_PRICE ? core.env.EARN_PRICE === 'live' : mode === 'live'
  return {
    testnet: sides.testnet,
    flare: sides.flare,
    price: o.price ?? createXrpPriceFeed({ live: livePrice, log }),
    pollMs: o.pollMs ?? (mode === 'live' ? 10_000 : 1_000),
    openTimeoutMs: o.openTimeoutMs ?? (mode === 'live' ? 15 * 60_000 : 2 * 60_000),
    payoutTimeoutMs: o.payoutTimeoutMs ?? (mode === 'live' ? 15 * 60_000 : 2 * 60_000),
    cacheMs: o.cacheMs ?? (mode === 'live' ? 15_000 : 0),
    feeBps: o.feeBps ?? int(core.env.EARN_FEE_BPS, DEFAULTS.EARN_FEE_BPS),
    swapBps: o.swapBps ?? int(core.env.EARN_SWAP_BPS, DEFAULTS.EARN_SWAP_BPS),
  }
}

/** Startup: Earn's tables, the 'received' effect of earn_deposit intents, and (flag on) the resume / withdrawal job. */
export function registerEarn(core: Core, o: EarnOptions = {}): Earn {
  initEarnTables(core)
  services.get(core)?.stopJobs()
  const earn = createEarn(core, depsFor(core, o))
  services.set(core, earn)
  core.receivedHandlers.set('earn_deposit', (c, intentId) => earnOf(c).runDeposit(intentId))
  if (core.settings.features.earn && (o.jobs ?? core.env.EARN_JOBS !== '0')) earn.startJobs()
  return earn
}

export function earnOf(core: Core): Earn {
  return services.get(core) ?? registerEarn(core)
}

/** GET /v1/earn/position, POST /v1/earn/deposits, POST /v1/earn/withdrawals (404 feature_off while FEATURE_EARN is off). */
export function mountEarn(app: Hono, core: Core): void {
  mount(app, core, 'earnPosition', ({ user }) => earnOf(core).position(user!))
  mount(app, core, 'earnDeposit', ({ user, body }) => earnOf(core).prepareDeposit(user!, body.amountMinor))
  mount(app, core, 'earnWithdraw', ({ user, body }) => earnOf(core).requestWithdrawal(user!, body.amountDrops))
}
