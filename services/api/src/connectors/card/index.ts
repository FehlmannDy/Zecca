// Card connector (Lithic, sandbox), SPEC §4.6 and §4.14. Behind FEATURE_CARD: with the flag off every route answers
// 404 feature_off. The orchestrator plugs it in with mountCard(app, core) and registerCard(core).
//   POST /v1/card, GET /v1/card, GET /v1/card/secret, POST /v1/card/freeze|unfreeze  the card (tier 1)
//   POST /v1/card/load                       intent card_load: a user-signed deposit to the pool, credited on 'received'
//   POST /v1/webhooks/lithic/asa             Lithic asks; answered from the card balance (asa.ts)
//   POST /v1/dev/card/simulate               DEMO_MODE: a test purchase on the user's card
//   POST /v1/demo/shop/charge                DEMO_MODE: the demo shop's "Pay by card" (shop.ts)
import type { Hono } from 'hono'
import type { Card, Intent, PreparedTx } from '@zecca/contracts'
import type { Core } from '../../core'
import { Err } from '../../errors'
import { mount } from '../../http'
import { getBalance } from '../../books'
import { checkOutgoing } from '../../limits'
import { intents, toIntent } from '../../intents/repo'
import { ciphertextPreviewOf, emitIntent } from '../../intents/flow'
import { storePrepared } from '../../prepared/store'
import type { UserRow } from '../../users'
import { handleAsa } from './asa'
import { cardCtx, needLithic, UNAVAILABLE, viaLithic, type CardCtx, type CardOptions } from './context'
import { waitForResult } from './lithic-api'
import { shopCharge } from './shop'
import { toAuthorization, type CardRow } from './store'
import { cardSync, clear, confirmDecision } from './sync'

export { cardSync } from './sync'
export type { CardOptions } from './context'

const RECENT = 20
const LOCKED_CREATE = 'Verify your identity to get a card.'
const LOCKED_LOAD = 'Verify your identity to use the card.'
const NO_CARD = "You don't have a card yet."

const toCard = (c: CardRow): Card => ({ id: c.id, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, state: c.state, holderName: c.holderName })

function cardOf(ctx: CardCtx, user: UserRow): CardRow {
  const c = ctx.store.cardOf(user.id)
  if (!c || c.state === 'CLOSED') throw Err.notFound(NO_CARD)
  return c
}

/** One Lithic card per person; parallel requests share the one creation. */
async function createCard(core: Core, ctx: CardCtx, user: UserRow): Promise<CardRow> {
  const existing = ctx.store.cardOf(user.id)
  if (existing) return existing
  const pending = ctx.creating.get(user.id)
  if (pending) return pending as Promise<CardRow>
  const lithic = needLithic(ctx)
  const p = (async () => {
    const lc = await viaLithic(core, 'create card', () => lithic.createCard({ memo: `Zecca @${user.handle}`.slice(0, 40) }))
    if (!/^\d{4}$/.test(lc.last4) || !Number.isSafeInteger(lc.expMonth) || !Number.isSafeInteger(lc.expYear)) {
      core.log.error(`[card] Lithic card ${lc.token} came back without last four or expiry`)
      throw Err.upstream(UNAVAILABLE)
    }
    ctx.store.linkCard(user.id, { id: core.id('card'), token: lc.token, last4: lc.last4, expMonth: lc.expMonth, expYear: lc.expYear, state: lc.state === 'PAUSED' ? 'PAUSED' : 'OPEN', holderName: user.displayName })
    core.log.info(`[card] virtual sandbox card created for @${user.handle}`)
    return ctx.store.cardOf(user.id)!
  })().finally(() => ctx.creating.delete(user.id))
  ctx.creating.set(user.id, p)
  return p
}

/** POST /v1/card/load: a card_load intent and the user's ConfidentialMPTSend to the pool (prepared kind 'send'). */
async function createCardLoad(core: Core, user: UserRow, amountMinor: number): Promise<{ intent: Intent; prepared: PreparedTx }> {
  checkOutgoing(core, user, undefined, amountMinor, 0)
  const b = getBalance(core, user.id)
  if (b.availableMinor < amountMinor) throw Err.insufficient(amountMinor - b.availableMinor)
  core.rateLimit(user.address)
  const id = core.id('int')
  intents.insert(core, { id, kind: 'card_load', status: 'created', fromUserId: user.id, amountMinor, feeMinor: 0, note: 'Moved to your card' })
  try {
    const tx = await core.ledger.buildSend({
      from: user.address,
      to: core.keystore.getWallet('pool').address,
      amountMinor,
      senderKey: core.keystore.getElGamal({ user: user.address }),
      sponsored: true,
      publicKey: user.publicKey,
    })
    const prepared = await storePrepared(core, { address: user.address, publicKey: user.publicKey, kind: 'send', tx, intentId: id })
    intents.patch(core, id, { prepareId: prepared.prepareId, ciphertextPreview: ciphertextPreviewOf(prepared.tx) })
    return { intent: toIntent(intents.byId(core, id)!), prepared }
  } catch (e) {
    core.log.error(`[card] prepare card load ${id} failed: ${(e as Error).message}`)
    intents.transition(core, id, 'created', 'failed', { failure: { code: 'prepare_failed', message: "We couldn't prepare this. Try again." } })
    throw Err.ledger()
  }
}

/** 'received' for a card_load intent: the pool holds the money, the card balance shows it. Once per intent. */
async function onCardLoadReceived(core: Core, intentId: string): Promise<void> {
  const ctx = cardCtx(core)
  const i = intents.byId(core, intentId)
  if (!i || i.kind !== 'card_load') return
  const r = ctx.store.creditDeposit({ intentId: i.id, userId: i.fromUserId, amountMinor: i.amountMinor })
  if (!r.credited) return
  core.log.info(`[card] card load ${i.id} credited: card balance ${r.balanceMinor}`)
  core.bus.toUser(i.fromUserId, { type: 'balance.updated', data: { ...getBalance(core, i.fromUserId), cardMinor: r.balanceMinor }, at: core.iso() })
  emitIntent(core, i.id)
}

export function mountCard(app: Hono, core: Core, opts: CardOptions = {}): void {
  const ctx = cardCtx(core, opts)
  const tier1 = (u: UserRow, message: string) => {
    if (u.tier !== 1) throw Err.forbidden(message)
  }

  mount(app, core, 'cardCreate', async ({ user }) => {
    tier1(user!, LOCKED_CREATE)
    return toCard(await createCard(core, ctx, user!))
  })

  mount(app, core, 'cardGet', ({ user }) => {
    const c = cardOf(ctx, user!)
    return { ...toCard(c), balanceMinor: ctx.store.balance(user!.id), authorizations: ctx.store.holdsOf(user!.id, RECENT).map(toAuthorization) }
  })

  mount(app, core, 'cardSecret', async ({ c, user }) => {
    const card = cardOf(ctx, user!)
    const lithic = needLithic(ctx)
    const s = await viaLithic(core, 'read card details', () => lithic.getCard(card.token))
    if (!s.pan || !s.cvv) {
      core.log.error('[card] Lithic returned the card without number or code')
      throw Err.upstream(UNAVAILABLE)
    }
    c.header('Cache-Control', 'no-store')
    return { pan: s.pan, cvc: s.cvv, expMonth: s.expMonth, expYear: s.expYear }
  })

  const setState = async (user: UserRow, state: 'OPEN' | 'PAUSED') => {
    const card = cardOf(ctx, user)
    const lithic = needLithic(ctx)
    const lc = await viaLithic(core, state === 'PAUSED' ? 'freeze card' : 'unfreeze card', () => lithic.setCardState(card.token, state))
    ctx.store.setCardState(user.id, lc.state === 'PAUSED' ? 'PAUSED' : 'OPEN')
    return toCard(ctx.store.cardOf(user.id)!)
  }
  mount(app, core, 'cardFreeze', ({ user }) => setState(user!, 'PAUSED'))
  mount(app, core, 'cardUnfreeze', ({ user }) => setState(user!, 'OPEN'))

  mount(app, core, 'cardLoad', ({ user, body }) => {
    tier1(user!, LOCKED_LOAD)
    cardOf(ctx, user!)
    return createCardLoad(core, user!, body.amountMinor)
  })

  // The route table gives this webhook no feature (it is public); handleAsa checks the flag itself.
  mount(app, core, 'lithicWebhook', ({ c }) => handleAsa(core, ctx, c))

  mount(app, core, 'devCardSimulate', async ({ user, body }) => {
    const card = cardOf(ctx, user!)
    const lithic = needLithic(ctx)
    const s = await viaLithic(core, 'read card for a test purchase', () => lithic.getCard(card.token))
    if (!s.pan) throw Err.upstream(UNAVAILABLE)
    const descriptor = body.merchantName.toUpperCase().slice(0, 25)
    const { token } = await viaLithic(core, 'simulate a test purchase', () => ctx.gate.run(() => lithic.simulateAuthorize({ amount: body.amountMinor, descriptor, pan: s.pan! })))
    const tx = await viaLithic(core, 'read the test purchase decision', () => waitForResult(lithic, token))
    const approved = !!confirmDecision(core, ctx, lithic, token, tx)
    if (approved) core.track(clear(core, ctx, lithic, token), 'card clearing')
    const hold = ctx.store.hold(token)
    return { approved, ...(hold ? { authorization: toAuthorization(hold) } : {}) }
  })

  mount(app, core, 'shopCharge', ({ body }) => shopCharge(core, ctx, body))
}

export function registerCard(core: Core, opts: CardOptions = {}): void {
  const ctx = cardCtx(core, opts)
  core.receivedHandlers.set('card_load', onCardLoadReceived)
  if (!core.settings.features.card || !ctx.lithic) return
  // Fetch the ASA secret now so the first purchase does not wait for it (never logged).
  if (!core.env.LITHIC_ASA_SECRET && !ctx.store.getKv('asaSecret'))
    void ctx.lithic.authStreamSecret().then(
      (s) => {
        ctx.store.setKv('asaSecret', s)
        ctx.secret = s
      },
      (e) => core.log.warn(`[card] could not read the ASA secret yet: ${(e as Error).message}`),
    )
  if (ctx.pollMs > 0 && !ctx.timer) {
    ctx.timer = setInterval(() => void cardSync(core), ctx.pollMs)
    ctx.timer.unref?.()
  }
}

/** Stops the poller (shutdown, tests). */
export function stopCard(core: Core): void {
  const ctx = cardCtx(core)
  if (ctx.timer) clearInterval(ctx.timer)
  ctx.timer = undefined
}

/** The card balance, for GET /v1/balance's cardMinor (undefined when the user has no card). */
export function cardBalanceOf(core: Core, userId: string): number | undefined {
  const ctx = cardCtx(core)
  return ctx.store.cardOf(userId) ? ctx.store.balance(userId) : undefined
}

/** The demo shop's card payment of an order, for GET /v1/demo/shop/orders/:id (status 'paid', method 'card'). */
export function cardChargeForOrder(core: Core, orderId: string) {
  return cardCtx(core).store.charge(orderId)
}
