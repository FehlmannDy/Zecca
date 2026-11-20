// What happens to a purchase after the authorization: Lithic does not send clearing, voids or returns to the ASA
// endpoint, so a small poller reads them from GET /v1/transactions. Void or expiry -> the money goes back to the card;
// clearing -> "Completed" (for less: the difference goes back); a return -> a refund line, credited once.
import type { Core } from '../../core'
import { cardCtx, displayMerchant, emitAuthorization, type CardCtx } from './context'
import type { LithicTx } from './lithic-api'
import type { HoldRow } from './store'

const evTypes = (tx: LithicTx) => (tx.events ?? []).map((e) => e.type)

/** Applies one Lithic transaction to its hold. Returns true when something changed. */
export function applyTransaction(core: Core, ctx: CardCtx, h: HoldRow, tx: LithicTx): boolean {
  if (h.status !== 'authorised') return false
  let changed = false
  if (tx.status === 'VOIDED' || tx.status === 'EXPIRED') changed = ctx.store.voidHold(h.authToken)
  else if (tx.status === 'SETTLED' || evTypes(tx).includes('CLEARING')) {
    const clearings = (tx.events ?? []).filter((e) => e.type === 'CLEARING' && Number.isSafeInteger(e.amount))
    const settled = Number.isSafeInteger(tx.settled_amount) && (tx.settled_amount as number) > 0 ? tx.settled_amount : clearings.length ? clearings.reduce((s, e) => s + Math.abs(e.amount!), 0) : undefined
    changed = ctx.store.complete(h.authToken, settled)
  }
  if (changed) emitAuthorization(core, ctx.store.hold(h.authToken))
  return changed
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
        if (tx) applyTransaction(core, ctx, h, tx)
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
