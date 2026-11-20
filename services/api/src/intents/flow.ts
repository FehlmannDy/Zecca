// Intents through the pool (SPEC §2.6, §2.7, §8): create + prepare the deposit, submit effects, pool events, payout, merge, top-up.
import type { Intent, PoolEvent, PreparedTx } from '@zecca/contracts'
import type { Core } from '../core'
import { Err } from '../errors'
import { addActivity, adjustBalance, claimEffect, emitActivity, emitBalance, getBalance } from '../books'
import { checkIncoming, checkOutgoing } from '../limits'
import { storePrepared, type PreparedRow } from '../prepared/store'
import { users, type UserRow } from '../users'
import { intents, toIntent, ZECCA, type IntentRow } from './repo'
import { claimRequest, markRequestPaid, releaseRequest } from '../paymentRequests/repo'

/** First 8 bytes (hex) of the deposit's DestinationEncryptedAmount, for the "What the ledger shows" panel. */
export function ciphertextPreviewOf(tx: Record<string, unknown>): string | undefined {
  const ct = tx.DestinationEncryptedAmount
  return typeof ct === 'string' && /^[0-9A-Fa-f]{16,}$/.test(ct) ? ct.slice(0, 16).toUpperCase() : undefined
}

const netOf = (i: IntentRow) => i.amountMinor - i.feeMinor

export function emitIntent(core: Core, id: string): void {
  const i = intents.byId(core, id)
  if (!i) return
  const e = { type: 'intent.updated' as const, data: toIntent(i), at: core.iso() }
  for (const u of new Set([i.fromUserId, i.toUserId])) if (u && u !== ZECCA) core.bus.toUser(u, e)
}

// ---------- create ----------
export async function createSendIntent(
  core: Core,
  o: { sender: UserRow; recipient: UserRow; kind: 'p2p' | 'merchant'; amountMinor: number; feeMinor: number; note?: string; paymentRequestId?: string },
): Promise<{ intent: Intent; prepared: PreparedTx }> {
  const { sender, recipient } = o
  if (recipient.status !== 'active') throw Err.notFound("We couldn't find that person.")
  if (recipient.id === sender.id) throw Err.badRequest("You can't send money to yourself.")
  // Limits first: the limit sheet tells the person more than "not enough money".
  checkOutgoing(core, sender, recipient, o.amountMinor, o.feeMinor)
  const b = getBalance(core, sender.id)
  if (b.availableMinor < o.amountMinor) throw Err.insufficient(o.amountMinor - b.availableMinor)
  core.rateLimit(sender.address)

  const id = core.id('int')
  intents.insert(core, {
    id,
    kind: o.kind,
    status: 'created',
    fromUserId: sender.id,
    toUserId: recipient.id,
    amountMinor: o.amountMinor,
    feeMinor: o.feeMinor,
    note: o.note,
    paymentRequestId: o.paymentRequestId,
  })
  let prepared: PreparedTx
  try {
    const tx = await core.ledger.buildSend({
      from: sender.address,
      to: core.keystore.getWallet('pool').address,
      amountMinor: o.amountMinor,
      senderKey: core.keystore.getElGamal({ user: sender.address }),
      sponsored: true,
      publicKey: sender.publicKey,
    })
    prepared = await storePrepared(core, { address: sender.address, publicKey: sender.publicKey, kind: 'send', tx, intentId: id })
    intents.patch(core, id, { prepareId: prepared.prepareId, ciphertextPreview: ciphertextPreviewOf(prepared.tx) })
  } catch (e) {
    core.log.error(`[intents] prepare ${id} failed: ${(e as Error).message}`)
    intents.transition(core, id, 'created', 'failed', { failure: { code: 'prepare_failed', message: "We couldn't prepare this payment. Try again." } })
    throw Err.ledger()
  }
  return { intent: toIntent(intents.byId(core, id)!), prepared }
}

// ---------- submit (kind 'send') ----------
const NOT_TAKEN = "The payment didn't go through. Nothing was taken from your balance."

export function registerSendHandler(core: Core): void {
  core.submitHandlers.set('send', {
    before(core, p) {
      const i = p.intentId ? intents.byId(core, p.intentId) : undefined
      if (!i || i.status !== 'created') throw Err.policy('This payment is no longer open. Start again.')
      const sender = users.byId(core, i.fromUserId)!
      const recipient = i.toUserId ? users.byId(core, i.toUserId) : undefined
      core.db.transaction(() => {
        // One submit at a time per intent; submitted_at also counts the payment against the limits while it is in flight.
        const claimed = core.db
          .prepare("UPDATE intents SET submitted_at = ? WHERE id = ? AND status = 'created' AND submitted_at IS NULL")
          .run(core.iso(), i.id).changes
        if (claimed !== 1) throw Err.policy('This payment is already being sent.')
        checkOutgoing(core, sender, recipient, i.amountMinor, i.feeMinor, { excludeIntentId: i.id })
        const b = getBalance(core, sender.id)
        if (b.availableMinor < i.amountMinor) throw Err.insufficient(i.amountMinor - b.availableMinor)
        if (i.paymentRequestId) claimRequest(core, i.paymentRequestId, i.id)
        adjustBalance(core, sender.id, { available: -i.amountMinor })
      })()
    },
    undo(core, p, _s, reason) {
      const i = intents.byId(core, p.intentId!)!
      core.db.transaction(() => {
        const released = core.db
          .prepare("UPDATE intents SET submitted_at = NULL WHERE id = ? AND status = 'created' AND submitted_at IS NOT NULL")
          .run(i.id).changes
        if (released !== 1) return
        adjustBalance(core, i.fromUserId, { available: i.amountMinor })
        if (i.paymentRequestId) releaseRequest(core, i.paymentRequestId, i.id)
        if (reason.engineResult !== 'ALREADY_USED') intents.transition(core, i.id, 'created', 'failed', { failure: { code: reason.engineResult, message: NOT_TAKEN } })
      })()
      emitBalance(core, i.fromUserId)
      emitIntent(core, i.id)
    },
    after(core, p: PreparedRow, r, session) {
      const id = p.intentId!
      if (!r.validated) return { intent: toIntent(intents.byId(core, id)!) }
      let actId: string | undefined
      core.db.transaction(() => {
        intents.transition(core, id, 'created', 'submitted', { depositTxHash: r.hash })
        const i = intents.byId(core, id)!
        actId = addActivity(core, {
          userId: i.fromUserId,
          intentId: id,
          direction: 'out',
          kind: i.kind,
          counterpartyUserId: i.toUserId,
          amountMinor: i.amountMinor,
          feeMinor: 0,
          note: i.note,
        })
      })()
      const i = intents.byId(core, id)!
      emitIntent(core, id)
      emitActivity(core, actId)
      emitBalance(core, i.fromUserId)
      core.pool.expectDeposit({ intentId: id, txHash: r.hash, from: session.address, amountMinor: i.amountMinor })
      return { intent: toIntent(i) }
    },
  })
}

// ---------- pool events ----------
export function wirePoolEvents(core: Core): void {
  core.pool.on('received', (e) => core.track(onReceived(core, e as Extract<PoolEvent, { type: 'received' }>), 'received'))
  core.pool.on('paidOut', (e) => core.track(onPaidOut(core, e as Extract<PoolEvent, { type: 'paidOut' }>), 'paidOut'))
  core.pool.on('failed', (e) => core.track(onFailed(core, e as Extract<PoolEvent, { type: 'failed' }>), 'failed'))
}

export async function onReceived(core: Core, e: Extract<PoolEvent, { type: 'received' }>): Promise<void> {
  const i = intents.byId(core, e.intentId) ?? intents.byDepositHash(core, e.txHash)
  if (!i) return core.log.warn(`[intents] received for unknown intent ${e.intentId}`)
  if (i.depositTxHash !== e.txHash) return core.log.error(`[intents] ${i.id}: received hash ${e.txHash} is not the deposit ${i.depositTxHash}`)
  if (e.amountMinor !== i.amountMinor) {
    return onFailed(core, { type: 'failed', intentId: i.id, stage: 'deposit', code: 'amount_mismatch', message: `deposit ${e.amountMinor} != ${i.amountMinor}` })
  }
  const custom = core.receivedHandlers.get(i.kind)
  if (custom) {
    if (!intents.transition(core, i.id, 'submitted', 'received')) return
    if (!claimEffect(core, `${i.id}:received`)) return
    emitIntent(core, i.id)
    core.track(Promise.resolve(custom(core, i.id)), `received:${i.kind}`)
    return
  }
  applyReceived(core, i.id)
}

/** submitted -> received: credit the recipient's pending, mark the request paid, queue the payout. Idempotent by intent id. */
export function applyReceived(core: Core, id: string): void {
  let actId: string | undefined
  let paid: string | undefined
  core.db.transaction(() => {
    if (!intents.transition(core, id, 'submitted', 'received')) return
    if (!claimEffect(core, `${id}:received`)) return
    const i = intents.byId(core, id)!
    adjustBalance(core, i.toUserId!, { pending: netOf(i) })
    actId = addActivity(core, {
      userId: i.toUserId!,
      intentId: id,
      direction: 'in',
      kind: i.kind,
      counterpartyUserId: i.fromUserId === ZECCA ? undefined : i.fromUserId,
      amountMinor: netOf(i),
      feeMinor: i.feeMinor,
      note: i.note,
    })
    if (i.paymentRequestId && markRequestPaid(core, i.paymentRequestId, id)) paid = i.paymentRequestId
  })()
  const i = intents.byId(core, id)!
  if (i.status !== 'received') return
  emitIntent(core, id)
  emitActivity(core, actId)
  emitBalance(core, i.toUserId!)
  if (paid) emitRequestHook?.(core, paid)
  if (actId) core.track(payout(core, id), 'payout')
}

/** Set by the payment requests module (avoids an import cycle). */
let emitRequestHook: ((core: Core, paymentRequestId: string) => void) | undefined
export function onRequestPaid(f: (core: Core, paymentRequestId: string) => void): void {
  emitRequestHook = f
}

async function payout(core: Core, id: string): Promise<void> {
  const i = intents.byId(core, id)!
  const to = users.byId(core, i.toUserId!)!
  if (netOf(i) <= 0) return onPaidOut(core, { type: 'paidOut', intentId: id, txHash: '', to: to.address, amountMinor: 0 })
  try {
    const { hash } = await core.pool.payout({ intentId: id, to: to.address, amountMinor: netOf(i) })
    await onPaidOut(core, { type: 'paidOut', intentId: id, txHash: hash, to: to.address, amountMinor: netOf(i) })
  } catch (err) {
    await onFailed(core, { type: 'failed', intentId: id, stage: 'payout', code: 'payout_failed', message: (err as Error).message })
  }
}

export async function onPaidOut(core: Core, e: Extract<PoolEvent, { type: 'paidOut' }>): Promise<void> {
  const ok = intents.transition(core, e.intentId, 'received', 'paid_out', e.txHash ? { payoutTxHash: e.txHash } : {})
  if (!ok) return
  emitIntent(core, e.intentId)
  core.track(settle(core, e.intentId), 'merge')
}

/** After the payout: the relayer merges the recipient's inbox, then the pending amount becomes available. */
async function settle(core: Core, id: string, attempt = 1): Promise<void> {
  const i = intents.byId(core, id)!
  const to = users.byId(core, i.toUserId!)!
  if (netOf(i) > 0) {
    try {
      await core.pool.mergeInboxFor(to.address)
    } catch (err) {
      core.log.warn(`[intents] merge for ${to.handle} after ${id} failed (attempt ${attempt}): ${(err as Error).message}`)
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt))
        return settle(core, id, attempt + 1)
      }
      return core.log.error(`[intents] ${id}: ${to.handle}'s money stays pending until a merge succeeds`)
    }
  }
  const moved = core.db.transaction(() => {
    if (!claimEffect(core, `${id}:settled`)) return false
    adjustBalance(core, to.id, { pending: -netOf(i), available: netOf(i) })
    return true
  })()
  if (moved) emitBalance(core, to.id)
}

const FAILED_COPY = {
  deposit: "We couldn't confirm this payment. Our team has been told and will sort it out.",
  payout: "The payment was received but couldn't be passed on yet. Our team has been told and will sort it out.",
} as const

export async function onFailed(core: Core, e: Extract<PoolEvent, { type: 'failed' }>): Promise<void> {
  const i = intents.byId(core, e.intentId)
  if (!i) return core.log.warn(`[intents] failed for unknown intent ${e.intentId}`)
  if (e.stage === 'merge') return core.log.warn(`[intents] merge failed after ${i.id}: ${e.code} ${e.message}`)
  core.log.error(`[intents] ${i.id} failed at ${e.stage}: ${e.code} ${e.message} (money stays in the pool; retry is manual)`)
  const message = FAILED_COPY[e.stage]
  let touched: string | undefined
  core.db.transaction(() => {
    if (i.status === 'submitted' && intents.transition(core, i.id, 'submitted', 'failed', { failure: { code: e.code, message } })) {
      if (i.paymentRequestId) releaseRequest(core, i.paymentRequestId, i.id)
    } else if (i.status === 'received' && intents.transition(core, i.id, 'received', 'failed', { failure: { code: e.code, message } })) {
      if (claimEffect(core, `${i.id}:payout_failed`)) {
        adjustBalance(core, i.toUserId!, { pending: -netOf(i) })
        touched = i.toUserId
      }
    }
  })()
  emitIntent(core, i.id)
  if (touched) emitBalance(core, touched)
}

// ---------- top-up (SPEC §2.7): mint into the pool, then a normal payout ----------
export function startTopup(core: Core, user: UserRow, amountMinor: number, o: { note?: string; reference?: string } = {}): Intent {
  checkIncoming(core, user, amountMinor, 'self')
  const id = core.id('int')
  intents.insert(core, { id, kind: 'topup', status: 'created', fromUserId: ZECCA, toUserId: user.id, amountMinor, feeMinor: 0, note: o.note })
  core.track(runTopup(core, id, o.reference ?? `dev-credit:${id}`), 'topup')
  return toIntent(intents.byId(core, id)!)
}

async function runTopup(core: Core, id: string, reference: string): Promise<void> {
  const i = intents.byId(core, id)!
  try {
    const { hash } = await core.pool.mintIn(i.amountMinor, reference)
    intents.transition(core, id, 'created', 'submitted', { depositTxHash: hash, submittedAt: core.iso() })
  } catch (err) {
    core.log.error(`[topup] ${id} mint failed: ${(err as Error).message}`)
    intents.transition(core, id, 'created', 'failed', { failure: { code: 'mint_failed', message: "The top-up didn't go through. Nothing was charged." } })
    return emitIntent(core, id)
  }
  emitIntent(core, id)
  applyReceived(core, id)
}
