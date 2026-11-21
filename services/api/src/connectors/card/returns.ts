// A refund (Lithic RETURN) credits the card in Zecca's books; this moves the same amount back on the ledger, from the card
// settlement account to the pool, so the pool's funds keep matching the books (the purchase had settled pool -> card
// settlement at its clearing, sync.ts). A ConfidentialMPTSend signed by the cardSettlement wallet, after merging its inbox
// when the spendable part is short. Once per refund key (the Lithic transaction): the row is stored with the refund
// (store.refund), the tx is reserved (sequence, last ledger, fingerprint) before the submit, and an unknown outcome is
// looked up on the ledger before anything is sent again. Failures stay on the row and on the refund line; the poller
// (cardSync) tries again, up to MAX_RETURN_TRIES sends. A void needs nothing here: it only ever happens before the clearing.
import type { SubmitResult, UnsignedTx } from '@zecca/contracts'
import type { Core } from '../../core'
import type { CardCtx } from './context'
import type { ReturnRow } from './store'

/** Send attempts per refund (one per poller pass, 15 s apart by default) before a person has to look at it. */
export const MAX_RETURN_TRIES = 20
/** Ledgers the send may take before it can no longer validate (the builder sets none for our own accounts' sends). */
const LLS_WINDOW = 20
/** How far back the settlement account's transactions are read to find a reserved sequence. */
export const LOOKUP_LIMIT = 200

/** The fresh ciphertext of the send (ElGamal randomness): tells our tx from any other on the same sequence. */
const fingerprintOf = (tx: Record<string, unknown>): string | undefined =>
  typeof tx.DestinationEncryptedAmount === 'string' && tx.DestinationEncryptedAmount ? `ConfidentialMPTSend:${tx.DestinationEncryptedAmount.toUpperCase()}` : undefined

/** A result after which the tx can never apply and moved nothing (tefMAX_LEDGER excluded: the live client also reports it when unsure). */
const isFinalFailure = (code: string) => /^(tec|tem|tef|tel)/.test(code) && code !== 'tefMAX_LEDGER'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Lookup = { kind: 'found'; hash: string } | { kind: 'free' } | { kind: 'wait' } | { kind: 'unknown'; why: string }

/** What became of the send reserved at r.sequence: on the ledger, never will be, may still be, or cannot tell. */
async function lookUp(core: Core, from: string, r: ReturnRow): Promise<Lookup> {
  if (r.sequence === undefined || r.lastLedger === undefined || !r.fingerprint) return { kind: 'unknown', why: `the reserved send of ${r.key} has no sequence, last ledger or fingerprint recorded` }
  const idx = await core.ledger.ledgerIndex()
  const all = await core.ledger.accountTx(from, LOOKUP_LIMIT)
  const own = all.filter((e) => e.validated && e.tx.Account === from)
  const hit = own.find((e) => Number(e.tx.Sequence) === r.sequence)
  if (hit) {
    if (hit.engineResult !== 'tesSUCCESS') return { kind: 'free' }
    return fingerprintOf(hit.tx) === r.fingerprint ? { kind: 'found', hash: hit.hash.toUpperCase() } : { kind: 'free' }
  }
  if (own.some((e) => Number(e.tx.Sequence) > r.sequence!)) return { kind: 'unknown', why: `sequence ${r.sequence} is older than the last ${own.length} transactions of the card settlement account` }
  // Not there and nothing of ours after it: it never landed, or payments into the account pushed it out of what was read.
  // Only a read that reaches back before the reserve (or holds the account's whole history) tells them apart.
  const reachesBack = all.length < LOOKUP_LIMIT || (r.fromLedger !== undefined && all.some((e) => e.ledgerIndex > 0 && e.ledgerIndex < r.fromLedger!))
  if (!reachesBack) return { kind: 'unknown', why: `the last ${all.length} transactions of the card settlement account do not reach back to the send at sequence ${r.sequence}` }
  return idx > r.lastLedger + 1 ? { kind: 'free' } : { kind: 'wait' }
}

/** A failed try: recorded; after MAX_RETURN_TRIES it is not tried again. */
function failed(core: Core, ctx: CardCtx, key: string, tries: number, why: string, o: { release?: boolean } = {}): void {
  const stop = tries >= MAX_RETURN_TRIES
  const error = stop ? `${why} (not tried again after ${tries} tries; check the card settlement account by hand)` : why
  ctx.store.returnFailed(key, error, { release: o.release, stop })
  core.log.warn(`[card] return ${key}: ${error}`)
}

/** One refund's way back to the pool. Never throws (the failure is recorded). */
async function sendReturn(core: Core, ctx: CardCtx, r: ReturnRow): Promise<void> {
  const { keystore, ledger } = core
  if (!keystore.hasWallet('cardSettlement')) return failed(core, ctx, r.key, ctx.store.returnTry(r.key), 'no card settlement wallet in the key store to send the refund back to the pool')
  const from = keystore.getWallet('cardSettlement').address
  if (!keystore.has({ user: from })) return failed(core, ctx, r.key, ctx.store.returnTry(r.key), 'no encryption key for the card settlement account in the key store')

  if (r.status === 'reserved') {
    const l = await lookUp(core, from, r)
    if (l.kind === 'found') {
      ctx.store.returnSent(r.key, l.hash)
      return core.log.info(`[card] return ${r.key}: ${r.amountMinor} back card settlement -> pool had landed tx=${l.hash}`)
    }
    if (l.kind === 'wait') return // may still validate; the next pass looks again
    if (l.kind === 'unknown') {
      ctx.store.returnFailed(r.key, `${l.why}; not sent again, check the card settlement account by hand`, { stop: true })
      return core.log.error(`[card] return ${r.key}: ${l.why}; not sent again, check the card settlement account by hand`)
    }
    ctx.store.returnFailed(r.key, r.error ?? 'the earlier send did not reach the ledger', { release: true })
  }

  const tries = ctx.store.returnTry(r.key)
  let tx: UnsignedTx
  let fromLedger: number
  try {
    const senderKey = keystore.getElGamal({ user: from })
    const b = await ledger.confidentialBalance(from, senderKey)
    if (b.spendableMinor < r.amountMinor) {
      if (b.spendableMinor + b.inboxMinor < r.amountMinor)
        return failed(core, ctx, r.key, tries, `the card settlement account holds ${b.spendableMinor + b.inboxMinor}, the refund needs ${r.amountMinor}`)
      const m = await ledger.submitAs('cardSettlement', await ledger.buildMergeInbox({ account: from, sponsored: false }))
      if (m.engineResult !== 'tesSUCCESS') return failed(core, ctx, r.key, tries, `card settlement MergeInbox: ${m.engineResult} tx=${m.hash}`)
    }
    tx = await ledger.buildSend({ from, to: keystore.getWallet('pool').address, amountMinor: r.amountMinor, senderKey, sponsored: false })
    fromLedger = await ledger.ledgerIndex()
    if (tx.LastLedgerSequence === undefined || tx.LastLedgerSequence === null) tx.LastLedgerSequence = fromLedger + LLS_WINDOW
  } catch (e) {
    return failed(core, ctx, r.key, tries, `preparing the send failed: ${msg(e)}`)
  }
  ctx.store.reserveReturn(r.key, { sequence: Number(tx.Sequence), lastLedger: Number(tx.LastLedgerSequence), fromLedger, fingerprint: fingerprintOf(tx) })
  let res: SubmitResult | undefined
  let thrown: unknown
  try {
    res = await ledger.submitAs('cardSettlement', tx)
  } catch (e) {
    thrown = e
  }
  if (res?.engineResult === 'tesSUCCESS') {
    ctx.store.returnSent(r.key, res.hash.toUpperCase())
    return core.log.info(`[card] return ${r.key}: ${r.amountMinor} back card settlement -> pool tx=${res.hash}`)
  }
  if (res && isFinalFailure(res.engineResult)) return failed(core, ctx, r.key, tries, `send refused: ${res.engineResult} tx=${res.hash}`, { release: true })
  // Outcome unknown (SUBMIT_ERROR, a ter, tefMAX_LEDGER, a throw): it stays reserved and the next pass looks the sequence up.
  const why = res ? `${res.engineResult} tx=${res.hash}` : `submit failed: ${msg(thrown)}`
  ctx.store.returnFailed(r.key, `${why}; looking for sequence ${String(tx.Sequence)} on the ledger before sending again`)
  core.log.warn(`[card] return ${r.key}: ${why}; sequence ${String(tx.Sequence)} is looked up before sending again`)
}

/** Every refund whose money is not back in the pool yet, one at a time (one account, one sequence). Never throws. */
export async function sendReturns(core: Core, ctx: CardCtx): Promise<void> {
  for (const r of ctx.store.openReturns()) {
    try {
      await sendReturn(core, ctx, r)
    } catch (e) {
      core.log.error(`[card] return ${r.key}: ${msg(e)}`)
    }
  }
}
