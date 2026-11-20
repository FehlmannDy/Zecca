// What happens to a purchase after the authorization: Lithic does not send clearing, voids or returns to the ASA
// endpoint, so a small poller reads them from GET /v1/transactions. Void, expiry, or a final decline after our
// approval (our answer reached Lithic too late) -> the money goes back to the card; clearing -> "Completed" (for less:
// the difference goes back), then the pool pays what was taken to the card settlement account; a return -> a refund
// line, credited once. Settling at the clearing, not at the answer, leaves nothing to undo on the ledger for a void.
import type { Core } from '../../core'
import { cardCtx, displayMerchant, emitAuthorization, settlementAddress, type CardCtx } from './context'
import type { LithicApi, LithicTx } from './lithic-api'
import type { HoldRow } from './store'

const evTypes = (tx: LithicTx) => (tx.events ?? []).map((e) => e.type)

/** The sandbox never clears a purchase by itself: the poller retries our clearing, up to this many calls in all. */
export const MAX_CLEAR_TRIES = 5

/** Lithic's final answer was not an approval, whatever our webhook answered. */
const declinedByLithic = (tx: LithicTx) => tx.status === 'DECLINED' || (!!tx.result && tx.result !== 'APPROVED')

/** The pool pays the card settlement account for one cleared purchase. Once per authorization; failures stay on the hold. */
export async function settle(core: Core, ctx: CardCtx, h: HoldRow): Promise<void> {
  if (h.settleTx) return
  const to = settlementAddress(core)
  if (!to) {
    ctx.store.annotate(h.authToken, { settleError: 'no card settlement account in the key store' })
    return core.log.warn(`[card] ${h.authToken}: no card settlement account, purchase not settled on the ledger`)
  }
  try {
    const { hash } = await core.pool.payout({ intentId: `cset_${h.authToken}`, to, amountMinor: h.amountMinor })
    ctx.store.annotate(h.authToken, { settleTx: hash })
    core.log.info(`[card] ${h.authToken}: ${h.amountMinor} settled pool -> card settlement tx=${hash}`)
  } catch (e) {
    ctx.store.annotate(h.authToken, { settleError: (e as Error).message.slice(0, 300) })
    core.log.error(`[card] ${h.authToken}: settlement failed, not retried: ${(e as Error).message}`)
  }
}

/** The purchase cleared: the cardholder and the shop receipt hear it, and the cleared amount settles on the ledger. */
function completed(core: Core, ctx: CardCtx, authToken: string): void {
  const h = ctx.store.hold(authToken)
  if (!h) return
  emitAuthorization(core, h)
  if (h.orderId) ctx.store.setChargeStatus(h.orderId, 'completed')
  core.track(settle(core, ctx, h), 'card settlement')
}

/** Applies one Lithic transaction to its hold. Returns true when something changed. */
export function applyTransaction(core: Core, ctx: CardCtx, h: HoldRow, tx: LithicTx): boolean {
  if (h.status !== 'authorised') return false
  if (tx.status === 'VOIDED' || tx.status === 'EXPIRED' || declinedByLithic(tx)) {
    if (!ctx.store.voidHold(h.authToken)) return false
    emitAuthorization(core, ctx.store.hold(h.authToken))
    return true
  }
  if (tx.status === 'SETTLED' || evTypes(tx).includes('CLEARING')) {
    const clearings = (tx.events ?? []).filter((e) => e.type === 'CLEARING' && Number.isSafeInteger(e.amount))
    const settled = Number.isSafeInteger(tx.settled_amount) && (tx.settled_amount as number) > 0 ? tx.settled_amount : clearings.length ? clearings.reduce((s, e) => s + Math.abs(e.amount!), 0) : undefined
    if (!ctx.store.complete(h.authToken, settled)) return false
    completed(core, ctx, h.authToken)
    return true
  }
  return false
}

/**
 * Lithic's decision on a purchase we asked for (shop charge, test purchase), against our webhook's. Returns the hold
 * when both approved it. Approved by us and declined by Lithic: the money goes back. Approved by Lithic and not by our
 * webhook (another ASA endpoint, or none): the card balance was not checked, so the purchase is voided.
 */
export function confirmDecision(core: Core, ctx: CardCtx, lithic: LithicApi, token: string, tx: LithicTx): HoldRow | undefined {
  const h = ctx.store.hold(token)
  if (h) applyTransaction(core, ctx, h, tx)
  if (tx.result !== 'APPROVED') return undefined
  const now = ctx.store.hold(token)
  if (now && (now.status === 'authorised' || now.status === 'completed')) return now
  core.log.error(`[card] purchase ${token} approved by Lithic but not by our webhook; voiding it`)
  core.track(ctx.gate.run(() => lithic.simulateVoid({ token })), 'card void (undecided purchase)')
  return undefined
}

/** Settles a sandbox purchase we made at Lithic (POST /v1/simulate/clearing) and marks it "Completed". */
export async function clear(core: Core, ctx: CardCtx, lithic: LithicApi, token: string): Promise<void> {
  if (ctx.clearing.has(token)) return
  ctx.clearing.add(token)
  try {
    const tries = ctx.store.clearTry(token)
    try {
      await ctx.gate.run(() => lithic.simulateClearing({ token }))
    } catch (e) {
      const next = tries < MAX_CLEAR_TRIES ? 'the poller tries again' : 'not tried again'
      return core.log.warn(`[card] clearing ${token} failed (try ${tries}): ${(e as Error).message} (${next})`)
    }
    if (ctx.store.complete(token)) completed(core, ctx, token)
  } finally {
    ctx.clearing.delete(token)
  }
}

const returnAmount = (tx: LithicTx): number | undefined => {
  const ev = (tx.events ?? []).find((e) => e.type === 'RETURN' && Number.isSafeInteger(e.amount))
  const a = ev?.amount ?? tx.amounts?.cardholder?.amount ?? tx.amount
  return Number.isSafeInteger(a) && a !== 0 ? Math.abs(a!) : undefined
}

/** One pass: open holds first, then each card's list for returns. Never throws (logged), never runs twice at once. */
export async function cardSync(core: Core): Promise<void> {
  const ctx = cardCtx(core)
  const lithic = ctx.lithic
  if (!lithic || ctx.syncing) return
  ctx.syncing = true
  try {
    for (const h of ctx.store.openHolds()) {
      try {
        const tx = await lithic.getTransaction(h.authToken)
        if (!tx || applyTransaction(core, ctx, h, tx)) continue
        // Still open at Lithic after our clearing failed: try again.
        if (tx.status === 'PENDING' && tx.result === 'APPROVED' && h.clearTries && h.clearTries < MAX_CLEAR_TRIES) await clear(core, ctx, lithic, h.authToken)
      } catch (e) {
        core.log.warn(`[card] sync ${h.authToken}: ${(e as Error).message}`)
      }
    }
    for (const card of ctx.store.allCards()) {
      try {
        for (const tx of await lithic.listTransactions({ cardToken: card.token })) {
          if (!evTypes(tx).includes('RETURN') || tx.status === 'DECLINED' || tx.status === 'VOIDED') continue
          const amount = returnAmount(tx)
          if (!amount) continue
          const key = `${tx.token}:return`
          if (ctx.store.refund({ key, userId: card.userId, cardToken: card.token, amountMinor: amount, merchant: displayMerchant(tx.merchant?.descriptor ?? '') }))
            emitAuthorization(core, ctx.store.hold(key))
        }
      } catch (e) {
        core.log.warn(`[card] sync returns for a card: ${(e as Error).message}`)
      }
    }
  } finally {
    ctx.syncing = false
  }
}
