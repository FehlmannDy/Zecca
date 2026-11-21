// Market connector (SPEC §4.9, §6.3; UI §5.10): gold, silver and palladium as ordinary MPTs, in milligrams.
// - Buy: intent 'market_buy', a normal confidential deposit to the pool (prepared kind 'send', so the shared send
//   handler debits, checks the limits and tells the pool worker). The first purchase of a metal needs the user's
//   MPTokenAuthorize first (reserve sponsored, prepared kind 'market_authorize'): a send's proof binds the account
//   sequence, so the send is built once the authorize has validated (DECISIONS: two approvals, two calls).
//   On 'received' the market issuer pays the metal (public MPT Payment, marked with an InvoiceID per attempt). At most one
//   payment lands per order: a lost answer is looked up on the ledger (by hash, else by InvoiceID) before anything is sent
//   again, and a new attempt goes out only after a final failure or once the last one's LastLedgerSequence has passed.
// - Sell: the user pays the metal back to the market issuer (public MPT Payment, fee sponsored, kind 'market_sell');
//   on validation the pool pays out the dollars like any payout (pending -> payout -> merge -> available). The sale
//   is an intent of kind 'market_buy' (the metals kind, from Zecca to the user) until IntentKind has 'market_sell';
//   kinds with a received handler settle their own payouts, so the sale's payout and merge are run here, and asked again
//   by the market's tick until settled (an unconfirmed payout is never a failure).
// - Prices: PriceFeed (feed.ts), published on the ledger with OracleSet when the ledger is live (oracle.ts).
// Mounted by the orchestrator: mountMarket(app, core) and registerMarket(core). Everything is behind FEATURE_MARKET.
import type { Hono } from 'hono'
import { DEFAULTS, formatGrams, type MetalSymbol, type PreparedTx, type PriceFeed, type SubmitResult } from '@zecca/contracts'
import type { Core } from '../../core'
import { ApiErr, Err } from '../../errors'
import { mount } from '../../http'
import { addActivity, adjustBalance, claimEffect, emitActivity, emitBalance, getBalance } from '../../books'
import { checkOutgoing } from '../../limits'
import { lookupSession } from '../../auth/sessions'
import { toUser, users, type UserRow } from '../../users'
import { intents, toIntent, ZECCA } from '../../intents/repo'
import { ciphertextPreviewOf, emitIntent } from '../../intents/flow'
import { storePrepared } from '../../prepared/store'
import { MergePostponed, mergeInbox, onAccountFree } from '../../prepared/account-gate'
import { change24hPct, createFixtureFeed, createHttpFeed } from './feed'
import { createOracleFeed } from './oracle'
import { deliveryInvoiceId, ensureMetalIssuances, metalDelivery, METALS, metalIssuanceId, metalOf } from './metals'
import { QuoteError, quoteBuy, quoteSell, sidePrices, valueOfMg, type Quote } from './quote'
import { holders, initMarketTables, orders, type OrderRow } from './repo'

export const LOCKED = 'Verify your identity to trade metals.'
const HISTORY_POINTS = 30

type MarketCtx = {
  feed: PriceFeed
  spreadBps: number
  retryMs: number
  tickMs: number
  ready: Promise<void>
  registered: boolean
  /** False on a mock ledger that cannot pay metals: purchases are refused before any money moves. */
  canPayMetals: boolean
  /** Work running in this process ('deliver:<order>', 'sale:<intent>'), never run twice at once. */
  running: Set<string>
  /** Sales to ask again: tries so far and not before `at` (5 s, 10 s, 20 s ... up to 60 s). */
  retry: Map<string, { tries: number; at: number }>
  ticking: boolean
}
const contexts = new WeakMap<Core, MarketCtx>()

export type MarketOptions = {
  /** Injected price feed (tests). Default: MARKET_PRICE_SOURCE=live|fixture (live on Devnet, fixture on the mock). */
  feed?: PriceFeed
  /** Base delay between metal delivery attempts (default 2 s). */
  retryMs?: number
  /** Interval of the market's background job (default 5 s). 0: off (tests call marketTick). */
  tickMs?: number
}

const on = (core: Core) => !!core.settings.features.market

function spreadOf(core: Core): number {
  const n = Number.parseInt(core.env.MARKET_SPREAD_BPS ?? '', 10)
  return Number.isSafeInteger(n) && n >= 0 && n <= 10_000 ? n : DEFAULTS.MARKET_SPREAD_BPS
}

function defaultFeed(core: Core): PriceFeed {
  const source = core.env.MARKET_PRICE_SOURCE ?? (core.settings.ledgerMode === 'devnet' ? 'live' : 'fixture')
  const base = source === 'live' ? createHttpFeed({ now: core.now, log: (m) => core.log.warn(m) }) : createFixtureFeed()
  const oracle = core.env.MARKET_ORACLE ?? (core.ledger.mode === 'live' ? '1' : '0')
  if (oracle !== '1' || !core.keystore.hasWallet('oracle')) return base
  return createOracleFeed({ inner: base, ledger: core.ledger, oracleAddress: core.keystore.getWallet('oracle').address, now: core.now, log: (m) => core.log.info(m) })
}

function ctx(core: Core, o: MarketOptions = {}): MarketCtx {
  let c = contexts.get(core)
  if (!c) {
    initMarketTables(core)
    c = {
      feed: o.feed ?? defaultFeed(core),
      spreadBps: spreadOf(core),
      retryMs: o.retryMs ?? 2000,
      tickMs: o.tickMs ?? 5000,
      ready: Promise.resolve(),
      registered: false,
      canPayMetals: true,
      running: new Set(),
      retry: new Map(),
      ticking: false,
    }
    contexts.set(core, c)
  } else {
    if (o.feed) c.feed = o.feed
    if (o.retryMs !== undefined) c.retryMs = o.retryMs
    if (o.tickMs !== undefined) c.tickMs = o.tickMs
  }
  return c
}

const UNAVAILABLE = "Metals aren't available right now. Try again later."

function issuanceOf(core: Core, symbol: MetalSymbol): string {
  const id = metalIssuanceId(core.keystore, symbol)
  if (!id || !core.keystore.hasWallet('marketIssuer')) throw new ApiErr(503, 'upstream_error', UNAVAILABLE)
  return id
}

const gramsOf = (mg: number, symbol: MetalSymbol) => `${formatGrams(mg)} g of ${metalOf(symbol).noun}`
const publicQuote = (q: Quote) => ({ quantityMg: q.quantityMg, amountMinor: q.amountMinor, unitPriceMinor: q.unitPriceMinor, spreadMinor: q.spreadMinor })

// ---------- routes ----------
export function mountMarket(app: Hono, core: Core): void {
  mount(app, core, 'marketAssets', async () => {
    const m = ctx(core)
    return Promise.all(
      METALS.map(async ({ symbol, name }) => {
        const [p, history] = await Promise.all([m.feed.price(symbol), m.feed.history(symbol, HISTORY_POINTS)])
        const change = change24hPct(history)
        return {
          symbol,
          name,
          unit: 'g' as const,
          priceMinor: p.priceMinor,
          ...sidePrices(p.priceMinor, m.spreadBps),
          priceAt: p.at,
          priceSource: p.source,
          ...(change !== undefined ? { change24hPct: change } : {}),
          history,
        }
      }),
    )
  })

  mount(app, core, 'marketHoldings', async ({ user }) => {
    const m = ctx(core)
    return Promise.all(
      METALS.map(async ({ symbol }) => {
        const id = metalIssuanceId(core.keystore, symbol)
        if (!id) return { symbol, quantityMg: 0, valueMinor: 0 }
        let quantityMg: number
        try {
          quantityMg = await core.ledger.mptBalance(user!.address, id)
        } catch (e) {
          core.log.warn(`[market] holdings of ${user!.handle}: ${(e as Error).message}`)
          throw Err.ledger()
        }
        const { sellPriceMinor } = sidePrices((await m.feed.price(symbol)).priceMinor, m.spreadBps)
        return { symbol, quantityMg, valueMinor: valueOfMg(quantityMg, sellPriceMinor) }
      }),
    )
  })

  mount(app, core, 'marketOrder', async ({ user, body }) => {
    const u = user!
    if (u.tier !== 1) throw Err.forbidden(LOCKED)
    const m = ctx(core)
    await m.ready
    if (!m.canPayMetals) throw new ApiErr(503, 'upstream_error', UNAVAILABLE)
    const issuanceId = issuanceOf(core, body.symbol)
    const p = await m.feed.price(body.symbol)
    let q: Quote
    try {
      const args = { priceMinor: p.priceMinor, spreadBps: m.spreadBps, amountMinor: body.amountMinor, quantityMg: body.quantityMg }
      q = body.side === 'buy' ? quoteBuy(args) : quoteSell(args)
    } catch (e) {
      if (e instanceof QuoteError) throw Err.badRequest(e.message)
      throw e
    }
    const price = { feedPriceMinor: p.priceMinor, priceAt: p.at, priceSource: p.source }
    return body.side === 'buy' ? placeBuy(core, u, body.symbol, issuanceId, q, price) : placeSell(core, u, body.symbol, issuanceId, q, price)
  })

  // DEMO_MODE-only test hook (E2E-2 market): lifts the caller to tier 1 without the identity flow.
  app.post('/v1/dev/market/tier', async (c) => {
    if (!on(core)) throw Err.featureOff()
    if (!core.settings.demoMode) throw Err.notFound()
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const s = token ? lookupSession(core, token) : undefined
    if (!s) throw Err.unauthorized()
    if (!s.user || s.user.status !== 'active') throw Err.notSignedUp()
    users.setTier(core, s.user.id, 1)
    return c.json(toUser(users.byId(core, s.user.id)!), 200)
  })
}

type PriceInfo = { feedPriceMinor: number; priceAt: string; priceSource: string }

async function placeBuy(core: Core, u: UserRow, symbol: MetalSymbol, issuanceId: string, q: Quote, price: PriceInfo) {
  checkOutgoing(core, u, undefined, q.amountMinor, q.spreadMinor)
  const b = getBalance(core, u.id)
  if (b.availableMinor < q.amountMinor) throw Err.insufficient(q.amountMinor - b.availableMinor)
  core.rateLimit(u.address)
  const orderId = core.id('ord')
  const row = { id: orderId, userId: u.id, symbol, side: 'buy' as const, quantityMg: q.quantityMg, amountMinor: q.amountMinor, unitPriceMinor: q.unitPriceMinor, spreadMinor: q.spreadMinor, ...price }

  if (!holders.has(core, u.id, symbol)) {
    // First purchase of this metal: the user opens their holding (reserve sponsored). The deposit comes after.
    let prepared: PreparedTx
    try {
      const tx = () => core.ledger.prepareSponsored({ TransactionType: 'MPTokenAuthorize', Account: u.address, MPTokenIssuanceID: issuanceId }, { reserve: true, publicKey: u.publicKey })
      prepared = await storePrepared(core, { address: u.address, publicKey: u.publicKey, kind: 'market_authorize', tx })
    } catch (e) {
      core.log.error(`[market] authorize for ${u.handle} ${symbol}: ${(e as Error).message}`)
      throw Err.ledger()
    }
    orders.insert(core, { ...row, status: 'authorize', prepareId: prepared.prepareId })
    return { orderId, prepared, quote: publicQuote(q) }
  }

  const intentId = core.id('int')
  intents.insert(core, { id: intentId, kind: 'market_buy', status: 'created', fromUserId: u.id, amountMinor: q.amountMinor, feeMinor: q.spreadMinor, note: gramsOf(q.quantityMg, symbol) })
  orders.insert(core, { ...row, status: 'open', intentId })
  let prepared: PreparedTx
  try {
    const tx = () =>
      core.ledger.buildSend({
        from: u.address,
        to: core.keystore.getWallet('pool').address,
        amountMinor: q.amountMinor,
        senderKey: core.keystore.getElGamal({ user: u.address }),
        sponsored: true,
        publicKey: u.publicKey,
      })
    prepared = await storePrepared(core, { address: u.address, publicKey: u.publicKey, kind: 'send', tx, intentId })
    intents.patch(core, intentId, { prepareId: prepared.prepareId, ciphertextPreview: ciphertextPreviewOf(prepared.tx) })
    orders.setPrepare(core, orderId, prepared.prepareId)
  } catch (e) {
    core.log.error(`[market] prepare ${intentId} failed: ${(e as Error).message}`)
    intents.transition(core, intentId, 'created', 'failed', { failure: { code: 'prepare_failed', message: "We couldn't prepare this purchase. Try again." } })
    orders.move(core, orderId, 'open', 'failed')
    throw Err.ledger()
  }
  return { orderId, intent: toIntent(intents.byId(core, intentId)!), prepared, quote: publicQuote(q) }
}

async function placeSell(core: Core, u: UserRow, symbol: MetalSymbol, issuanceId: string, q: Quote, price: PriceInfo) {
  let held: number
  try {
    held = await core.ledger.mptBalance(u.address, issuanceId)
  } catch (e) {
    core.log.warn(`[market] balance of ${u.handle} ${symbol}: ${(e as Error).message}`)
    throw Err.ledger()
  }
  if (held < q.quantityMg) throw new ApiErr(409, 'insufficient_funds', held > 0 ? `You have ${gramsOf(held, symbol)}.` : `You don't have any ${metalOf(symbol).noun} yet.`)
  core.rateLimit(u.address)
  const orderId = core.id('ord')
  const intentId = core.id('int')
  // The dollars come from Zecca (the pool) to the user: gross at the feed price, the spread as the fee, net = proceeds.
  intents.insert(core, { id: intentId, kind: 'market_buy', status: 'created', fromUserId: ZECCA, toUserId: u.id, amountMinor: q.feedValueMinor, feeMinor: q.spreadMinor, note: `Sold ${gramsOf(q.quantityMg, symbol)}` })
  orders.insert(core, { id: orderId, userId: u.id, symbol, side: 'sell', quantityMg: q.quantityMg, amountMinor: q.amountMinor, unitPriceMinor: q.unitPriceMinor, spreadMinor: q.spreadMinor, ...price, status: 'open', intentId })
  let prepared: PreparedTx
  try {
    const tx = () =>
      core.ledger.prepareSponsored(
        { TransactionType: 'Payment', Account: u.address, Destination: core.keystore.getWallet('marketIssuer').address, Amount: { mpt_issuance_id: issuanceId, value: String(q.quantityMg) } },
        { publicKey: u.publicKey },
      )
    prepared = await storePrepared(core, { address: u.address, publicKey: u.publicKey, kind: 'market_sell', tx, intentId })
    intents.patch(core, intentId, { prepareId: prepared.prepareId })
    orders.setPrepare(core, orderId, prepared.prepareId)
  } catch (e) {
    core.log.error(`[market] prepare sale ${intentId} failed: ${(e as Error).message}`)
    intents.transition(core, intentId, 'created', 'failed', { failure: { code: 'prepare_failed', message: "We couldn't prepare this sale. Try again." } })
    orders.move(core, orderId, 'open', 'failed')
    throw Err.ledger()
  }
  return { orderId, intent: toIntent(intents.byId(core, intentId)!), prepared, quote: publicQuote(q) }
}

// ---------- start-up: submit handlers, the received handler, background work ----------
export function registerMarket(core: Core, o: MarketOptions = {}): void {
  const m = ctx(core, o)
  // Once per core: a second call only updates the options (it must not start a second issuance bootstrap).
  if (m.registered) return
  m.registered = true
  // A sale's merge postponed by an open approval runs as soon as the seller's account is free.
  onAccountFree(core, (address) => {
    const u = users.byAddress(core, address)
    if (!u) return
    for (const o of orders.withStatus(core, 'done')) {
      const i = o.side === 'sell' && o.userId === u.id && o.intentId ? intents.byId(core, o.intentId) : undefined
      if (i?.status === 'paid_out' && !effectDone(core, `${i.id}:settled`)) core.track(runSale(core, i.id), 'market sale merge')
    }
  })

  core.submitHandlers.set('market_authorize', {
    before(core, p) {
      const order = orders.byPrepare(core, p.id)
      if (!order || order.status !== 'authorize') throw Err.policy('This approval is no longer open. Start again.')
    },
    after(core, p, r) {
      const order = orders.byPrepare(core, p.id)!
      // tecDUPLICATE: the holding already exists on the ledger (e.g. opened before our records).
      if (r.validated || r.engineResult === 'tecDUPLICATE') {
        holders.add(core, order.userId, order.symbol, r.hash)
        orders.move(core, order.id, 'authorize', 'authorized', { ledgerTxHash: r.hash })
      }
      return {}
    },
  })

  core.submitHandlers.set('market_sell', {
    before(core, p) {
      const i = p.intentId ? intents.byId(core, p.intentId) : undefined
      const order = p.intentId ? orders.byIntent(core, p.intentId) : undefined
      if (!i || !order || i.status !== 'created' || order.status !== 'open') throw Err.policy('This sale is no longer open. Start again.')
      const claimed = core.db.prepare("UPDATE intents SET submitted_at = ? WHERE id = ? AND status = 'created' AND submitted_at IS NULL").run(core.iso(), i.id).changes
      if (claimed !== 1) throw Err.policy('This sale is already being sent.')
    },
    undo(core, p, _s, reason) {
      const id = p.intentId!
      const released = core.db.prepare("UPDATE intents SET submitted_at = NULL WHERE id = ? AND status = 'created' AND submitted_at IS NOT NULL").run(id).changes
      if (released !== 1 || reason.engineResult === 'ALREADY_USED') return
      intents.transition(core, id, 'created', 'failed', { failure: { code: reason.engineResult, message: "The sale didn't go through. Your metal wasn't moved." } })
      const order = orders.byIntent(core, id)
      if (order) orders.move(core, order.id, 'open', 'failed')
      emitIntent(core, id)
    },
    after(core, p, r) {
      const id = p.intentId!
      if (!r.validated) return { intent: toIntent(intents.byId(core, id)!) }
      const order = orders.byIntent(core, id)!
      intents.transition(core, id, 'created', 'submitted', { depositTxHash: r.hash })
      orders.move(core, order.id, 'open', 'done', { ledgerTxHash: r.hash })
      emitIntent(core, id)
      // The metal is back with the issuer: the pool pays the proceeds out like any payout (idempotent by intent id).
      creditSale(core, id)
      return { intent: toIntent(intents.byId(core, id)!) }
    },
  })

  core.receivedHandlers.set('market_buy', (core, intentId) => deliver(core, intentId))

  if (!on(core)) return
  // The mock ledger starts empty on every run: create the metal issuances there. Devnet: scripts/bootstrap-market.ts.
  if (core.ledger.mode === 'mock' && METALS.some((x) => !metalIssuanceId(core.keystore, x.symbol))) {
    m.ready = ensureMetalIssuances(core.ledger, core.keystore, (l) => core.log.info(l))
      .then(() => canPayMetals(core))
      .then((ok) => {
        m.canPayMetals = ok
        if (!ok) core.log.warn('[market] this mock ledger cannot pay metals yet (no MPT issuance support): purchases are refused')
      })
      .catch((e) => core.log.warn(`[market] metal issuances not created: ${(e as Error).message}`))
    core.track(m.ready, 'market issuances')
  }
  // At start-up (what the last run left behind), then every tickMs.
  core.track(marketTick(core), 'market sweep')
  if (m.tickMs > 0) setInterval(() => core.track(marketTick(core), 'market tick'), m.tickMs).unref?.()
}

/**
 * Mock ledger only: can the market issuer pay a metal? @zecca/ledger-mock without MPT issuance support cannot, and a purchase
 * would then take the dollars and fail at delivery. A 1 mg round trip with the oracle wallet (in memory).
 */
async function canPayMetals(core: Core): Promise<boolean> {
  const iss = metalIssuanceId(core.keystore, 'XAU')
  if (!iss || !core.keystore.hasWallet('oracle')) return true
  const issuer = core.keystore.getWallet('marketIssuer').address
  const holder = core.keystore.getWallet('oracle').address
  const mg = { mpt_issuance_id: iss, value: '1' }
  await core.ledger.submitAs('oracle', { TransactionType: 'MPTokenAuthorize', Account: holder, MPTokenIssuanceID: iss })
  const paid = await core.ledger.submitAs('marketIssuer', { TransactionType: 'Payment', Account: issuer, Destination: holder, Amount: mg })
  if (paid.engineResult !== 'tesSUCCESS') return false
  await core.ledger.submitAs('oracle', { TransactionType: 'Payment', Account: holder, Destination: issuer, Amount: mg })
  return true
}

/** The market's background job: purchases to deliver or to look up, sales to pay out or settle. */
export async function marketTick(core: Core): Promise<void> {
  const m = ctx(core)
  if (!on(core) || m.ticking) return
  m.ticking = true
  try {
    await m.ready
    const work: Promise<unknown>[] = []
    for (const o of orders.withStatus(core, 'open')) {
      if (o.side === 'buy' && o.intentId && intents.byId(core, o.intentId)?.status === 'received') work.push(deliver(core, o.intentId))
    }
    for (const o of orders.withStatus(core, 'delivering')) {
      work.push(exclusive(core, `deliver:${o.id}`, () => deliveryLoop(core, o.id, () => lookUpDelivery(core, o.id))))
    }
    for (const o of orders.withStatus(core, 'done')) {
      const i = o.side === 'sell' && o.intentId ? intents.byId(core, o.intentId) : undefined
      if (i?.status === 'submitted') creditSale(core, i.id)
      else if (i && (i.status === 'received' || (i.status === 'paid_out' && !effectDone(core, `${i.id}:settled`))) && (m.retry.get(i.id)?.at ?? 0) <= core.now())
        work.push(runSale(core, i.id))
    }
    await Promise.all(work)
  } finally {
    m.ticking = false
  }
}

/** Runs job unless the same key is already running in this process (undefined then, or when it threw: logged, looked at again). */
async function exclusive<T>(core: Core, key: string, job: () => Promise<T>): Promise<T | undefined> {
  const { running } = ctx(core)
  if (running.has(key)) return undefined
  running.add(key)
  try {
    return await job()
  } catch (e) {
    core.log.warn(`[market] ${key}: ${(e as Error).message}`)
    return undefined
  } finally {
    running.delete(key)
  }
}

const effectDone = (core: Core, key: string) => core.db.prepare('SELECT 1 FROM effects WHERE key = ?').get(key) !== undefined
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PAYOUT_FAILED = "The sale went through but the money couldn't be passed on yet. Our team has been told and will sort it out."

/** submitted -> received: the proceeds count as arriving (pending) and show in activity; then the payout. Once per intent. */
function creditSale(core: Core, id: string): void {
  let actId: string | undefined
  core.db.transaction(() => {
    if (!intents.transition(core, id, 'submitted', 'received')) return
    if (!claimEffect(core, `${id}:received`)) return
    const i = intents.byId(core, id)!
    adjustBalance(core, i.toUserId!, { pending: i.amountMinor - i.feeMinor })
    actId = addActivity(core, { userId: i.toUserId!, intentId: id, direction: 'in', kind: i.kind, amountMinor: i.amountMinor - i.feeMinor, feeMinor: i.feeMinor, note: i.note })
  })()
  if (!actId) return
  const i = intents.byId(core, id)!
  emitIntent(core, id)
  emitActivity(core, actId)
  emitBalance(core, i.toUserId!)
  core.track(runSale(core, id), 'market sale payout')
}

/** paySale, one run at a time per sale; when it is not finished, the tick asks again after 5 s, 10 s, 20 s ... up to 60 s. */
async function runSale(core: Core, id: string): Promise<void> {
  const m = ctx(core)
  if (await exclusive(core, `sale:${id}`, () => paySale(core, id))) return void m.retry.delete(id)
  const tries = (m.retry.get(id)?.tries ?? 0) + 1
  m.retry.set(id, { tries, at: core.now() + Math.min(60_000, 5_000 * 2 ** (tries - 1)) })
}

/**
 * The pool pays the proceeds (received -> paid_out), then the relayer merges the inbox and pending becomes available.
 * True when finished (settled, or failed for good); false when it must be asked again.
 */
async function paySale(core: Core, id: string): Promise<boolean> {
  const i = intents.byId(core, id)!
  const to = users.byId(core, i.toUserId!)!
  const net = i.amountMinor - i.feeMinor
  if (i.status === 'received') {
    try {
      const { hash } = await core.pool.payout({ intentId: id, to: to.address, amountMinor: net })
      if (intents.transition(core, id, 'received', 'paid_out', { payoutTxHash: hash })) emitIntent(core, id)
    } catch (e) {
      // payout_unknown: the payout may have landed. Not a failure: asked again (the pool worker looks it up before sending).
      if ((e as { code?: string }).code === 'payout_unknown') {
        core.log.warn(`[market] sale ${id}: payout not confirmed yet: ${(e as Error).message}; asked again later`)
        return false
      }
      core.log.error(`[market] sale ${id}: payout failed: ${(e as Error).message} (money stays in the pool; retry is manual)`)
      let touched = false
      core.db.transaction(() => {
        if (intents.transition(core, id, 'received', 'failed', { failure: { code: 'payout_failed', message: PAYOUT_FAILED } }) && claimEffect(core, `${id}:payout_failed`)) {
          adjustBalance(core, to.id, { pending: -net })
          touched = true
        }
      })()
      emitIntent(core, id)
      if (touched) emitBalance(core, to.id)
      return true
    }
  }
  if (intents.byId(core, id)!.status !== 'paid_out' || effectDone(core, `${id}:settled`)) return true
  try {
    await mergeInbox(core, to.address)
  } catch (e) {
    if (e instanceof MergePostponed) {
      core.log.info(`[market] merge for @${to.handle} after sale ${id} waits: an approval is open`)
      return false
    }
    core.log.warn(`[market] merge for @${to.handle} after sale ${id}: ${(e as Error).message}; the money stays pending and is merged later`)
    return false
  }
  const moved = core.db.transaction(() => {
    if (!claimEffect(core, `${id}:settled`)) return false
    adjustBalance(core, to.id, { pending: -net, available: net })
    return true
  })()
  if (moved) emitBalance(core, to.id)
  return true
}

const DELIVERY_FAILED = "We received your payment but couldn't deliver the metal yet. Our team has been told and will sort it out."
const MAX_ATTEMPTS = 3
/** A delivery's LastLedgerSequence window (xrpl-core's window for our own txs): not on the ledger after it, it never will be. */
const DELIVERY_LLS_WINDOW = 20
/** The payment did not move the metal and never will (a validated tec, or never applied). Anything else may still land. */
const isFinal = (code: string) => /^(tec|tem|tef|tel)/.test(code) && code !== 'tefMAX_LEDGER' && code !== 'tefALREADY'

/** received -> the market issuer pays the metal -> paid_out (payoutTxHash = the metal payment). At most one payment lands. */
async function deliver(core: Core, intentId: string): Promise<void> {
  const order = orders.byIntent(core, intentId)
  if (!order || order.side !== 'buy') return core.log.warn(`[market] received ${intentId}: no purchase order`)
  if (order.status !== 'open') return
  await exclusive(core, `deliver:${order.id}`, () => deliveryLoop(core, order.id, () => sendDelivery(core, order.id, 'open')))
}

/** One step (a send, or a look-up of the last send); after a final failure, the next attempt, up to MAX_ATTEMPTS. */
async function deliveryLoop(core: Core, id: string, first: () => Promise<boolean>): Promise<void> {
  let again = await first()
  while (again) {
    await sleep(ctx(core).retryMs * orders.byId(core, id)!.attempts)
    again = await sendDelivery(core, id, 'delivering')
  }
}

/** Sends one attempt. True when it failed for good and another may be sent; false when done, or when its outcome is unknown. */
async function sendDelivery(core: Core, id: string, from: 'open' | 'delivering'): Promise<boolean> {
  const order = orders.byId(core, id)!
  const user = users.byId(core, order.userId)!
  const attempt = order.attempts + 1
  let tx: ReturnType<typeof metalDelivery>
  try {
    tx = metalDelivery({
      issuer: core.keystore.getWallet('marketIssuer').address,
      to: user.address,
      issuanceId: issuanceOf(core, order.symbol),
      mg: order.quantityMg,
      invoiceId: deliveryInvoiceId(id, attempt),
      lastLedgerSequence: (await core.ledger.ledgerIndex()) + DELIVERY_LLS_WINDOW,
    })
  } catch (e) {
    // Nothing was sent: the tick tries again.
    core.log.warn(`[market] delivery for ${order.intentId} not started: ${(e as Error).message}`)
    return false
  }
  if (!orders.claimDelivery(core, id, from, tx.LastLedgerSequence)) return false
  let r: SubmitResult
  try {
    r = await core.ledger.submitAs('marketIssuer', tx)
  } catch (e) {
    core.log.warn(`[market] delivery for ${order.intentId}: ${(e as Error).message}; it may have been sent, so it is looked up before sending again`)
    return false
  }
  if (r.validated && r.engineResult === 'tesSUCCESS') return delivered(core, order, r.hash)
  if (isFinal(r.engineResult)) return failedAttempt(core, id, r.engineResult)
  orders.setDeliveryHash(core, id, r.hash)
  core.log.warn(`[market] delivery for ${order.intentId}: outcome unknown (${r.engineResult} tx=${r.hash}); looked up before sending again`)
  return false
}

/** A send whose answer was lost: found on the ledger (by hash, else by InvoiceID), or not there once its LastLedgerSequence passed. */
async function lookUpDelivery(core: Core, id: string): Promise<boolean> {
  const order = orders.byId(core, id)!
  if (order.status !== 'delivering' || order.deliveryLls === undefined) return false
  // Read before the look-up: not found while a later ledger than LastLedgerSequence is validated means never applied.
  const index = await core.ledger.ledgerIndex()
  const invoiceId = deliveryInvoiceId(id, order.attempts)
  const tx = order.deliveryHash
    ? await core.ledger.txByHash(order.deliveryHash)
    : ((await core.ledger.accountTx(core.keystore.getWallet('marketIssuer').address, 200)).find((e) => String(e.tx.InvoiceID ?? '').toUpperCase() === invoiceId) ?? null)
  if (tx?.validated && tx.engineResult === 'tesSUCCESS') return delivered(core, order, tx.hash)
  if (tx?.validated) return failedAttempt(core, id, tx.engineResult)
  if (index <= order.deliveryLls) return false
  return failedAttempt(core, id, `not on the ledger by ledger ${order.deliveryLls}`)
}

function delivered(core: Core, order: OrderRow, hash: string): false {
  orders.move(core, order.id, 'delivering', 'done', { ledgerTxHash: hash })
  if (intents.transition(core, order.intentId!, 'received', 'paid_out', { payoutTxHash: hash })) emitIntent(core, order.intentId!)
  return false
}

/** True when another attempt may be sent; after MAX_ATTEMPTS the purchase fails with a sentence the user can read. */
function failedAttempt(core: Core, id: string, why: string): boolean {
  const order = orders.byId(core, id)!
  const user = users.byId(core, order.userId)!
  core.log.warn(`[market] delivery of ${order.quantityMg} mg ${order.symbol} to @${user.handle} (${order.intentId}) attempt ${order.attempts}: ${why}`)
  if (order.attempts < MAX_ATTEMPTS) return true
  core.log.error(`[market] ${order.intentId}: metal not delivered after ${order.attempts} attempts; the dollars stay in the pool (manual retry)`)
  orders.move(core, id, 'delivering', 'failed')
  if (intents.transition(core, order.intentId!, 'received', 'failed', { failure: { code: 'delivery_failed', message: DELIVERY_FAILED } })) emitIntent(core, order.intentId!)
  return false
}
