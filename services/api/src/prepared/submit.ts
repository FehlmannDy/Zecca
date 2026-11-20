// POST /v1/tx/submit: policy check, mark used BEFORE submitting, sponsor co-sign + submit (in the Ledger), then the kind's effects.
// A submit whose answer was lost is 'unknown', not failed: the jobs tick settles it once the ledger shows what happened.
import type { Hono } from 'hono'
import type { Intent, LedgerTxEvent, SubmitResult, User } from '@zecca/contracts'
import type { Core } from '../core'
import { Err } from '../errors'
import { mount } from '../http'
import type { Session } from '../auth/sessions'
import { checkSubmission, markUsed, preparedUnknown, recordResult, settleRecorded, type PreparedRow, POLICY_COPY } from './store'

export type SubmitHandler = {
  /** Last checks before the transaction is sent (throw an ApiErr to refuse; nothing is marked used then). May reserve funds. */
  before?(core: Core, p: PreparedRow, session: Session): Promise<void> | void
  /** Undo what `before` reserved once the transaction cannot apply (refused, failed on the ledger, or never landed). No session from the jobs. */
  undo?(core: Core, p: PreparedRow, session: Session | undefined, reason: { engineResult: string }): Promise<void> | void
  /** Effects once the outcome is final. No session when the jobs settle a submit whose answer was lost. */
  after(
    core: Core,
    p: PreparedRow,
    r: SubmitResult,
    session?: Session,
  ): Promise<{ intent?: Intent; user?: User }> | { intent?: Intent; user?: User }
}

export const SUBMIT_UNCONFIRMED = "The payment network hasn't confirmed this yet. It will update here by itself within a few minutes."

/**
 * Final: validated (any result), or a result after which the transaction can no longer apply (tec, tem, tef, tel; the live client
 * reports a validated tec as validated: false). Anything else (SUBMIT_ERROR, an RPC error, a ter) may still land.
 */
export const isFinal = (r: SubmitResult) => r.validated || /^te[cmfl]/.test(r.engineResult)

async function finish(core: Core, p: PreparedRow, h: SubmitHandler, r: SubmitResult, session?: Session) {
  const ok = r.validated && r.engineResult === 'tesSUCCESS'
  if (!ok) {
    core.log.warn(`[submit] ${p.kind} ${p.id} ${r.engineResult}`)
    await h.undo?.(core, p, session, { engineResult: r.engineResult })
  }
  return { ok, extra: await h.after(core, p, { ...r, validated: ok }, session) }
}

export function mountSubmit(app: Hono, core: Core): void {
  mount(app, core, 'txSubmit', async ({ body, session }) => {
    const p = await checkSubmission(core, session!, body.prepareId, body.txBlob)
    const h = core.submitHandlers.get(p.kind)
    if (!h) throw Err.policy("This kind of approval isn't accepted yet.")
    await h.before?.(core, p, session!)
    if (!markUsed(core, p.id)) {
      await h.undo?.(core, p, session!, { engineResult: 'ALREADY_USED' })
      throw Err.policy(POLICY_COPY.used)
    }

    let r: SubmitResult | undefined
    try {
      r = await core.ledger.submitUserSigned(body.txBlob)
    } catch (e) {
      core.log.error(`[submit] ${p.kind} ${p.id}: no answer from the ledger (${(e as Error).message})`)
    }
    if (!r || !isFinal(r)) {
      // It may still land: keep what `before` reserved; the jobs tick settles it from the ledger.
      core.log.warn(`[submit] ${p.kind} ${p.id} unconfirmed (${r?.engineResult ?? 'no answer'}${r?.hash ? ` tx=${r.hash}` : ''})`)
      recordResult(core, p.id, { hash: r?.hash, engineResult: r?.engineResult ?? 'SUBMIT_ERROR' }, 'unknown')
      throw Err.ledger(SUBMIT_UNCONFIRMED)
    }
    recordResult(core, p.id, r)
    const { ok, extra } = await finish(core, p, h, r, session!)
    return { status: ok ? ('validated' as const) : ('failed' as const), hash: r.hash, engineResult: r.engineResult, ...extra }
  })
}

/** What fields must match for a transaction found by account and sequence to be ours (the encrypted amount is unique per build). */
const SAME_FIELDS = ['TransactionType', 'Destination', 'DestinationEncryptedAmount', 'Amount'] as const
const norm = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : JSON.stringify(v ?? null))

async function findOnLedger(core: Core, p: PreparedRow): Promise<LedgerTxEvent | null> {
  if (p.ledgerHash) return core.ledger.txByHash(p.ledgerHash)
  // The submit threw before we learnt the hash: ours is the transaction of this account with this sequence and the same content.
  const txs = await core.ledger.accountTx(p.address, 100)
  const e = txs.find((t) => t.tx.Account === p.address && t.tx.Sequence === p.tx.Sequence)
  return e && SAME_FIELDS.every((k) => norm(e.tx[k]) === norm(p.tx[k])) ? e : null
}

/**
 * Settles submits whose answer was lost: final once the ledger shows the transaction validated, or once LastLedgerSequence has
 * passed without it (it can no longer apply). Then the kind's effects run, as if the submit had answered. Jobs tick only.
 */
export async function settleUnknownSubmits(core: Core): Promise<number> {
  let n = 0
  for (const p of preparedUnknown(core)) {
    const h = core.submitHandlers.get(p.kind)
    if (!h) continue
    try {
      // The index is read before the lookup: not found once the index is past LastLedgerSequence means it never applied.
      const index = await core.ledger.ledgerIndex()
      const e = await findOnLedger(core, p)
      const passed = p.lastLedgerSequence !== undefined ? index > p.lastLedgerSequence : core.now() > Date.parse(p.expiresAt) + 10 * 60_000
      const r: SubmitResult | undefined = e?.validated
        ? { validated: e.engineResult === 'tesSUCCESS', engineResult: e.engineResult, hash: e.hash, ledgerIndex: e.ledgerIndex }
        : passed
          ? { validated: false, engineResult: 'tefMAX_LEDGER', hash: p.ledgerHash ?? '' }
          : undefined
      if (!r || !settleRecorded(core, p.id, r)) continue
      core.log.info(`[submit] ${p.kind} ${p.id} settled from the ledger: ${r.engineResult}${r.hash ? ` tx=${r.hash}` : ''}`)
      await finish(core, p, h, r)
      n++
    } catch (err) {
      core.log.warn(`[submit] settling ${p.kind} ${p.id}: ${(err as Error).message}; tried again on the next tick`)
    }
  }
  return n
}
