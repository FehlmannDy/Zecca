// Background jobs: expire stale intents and requests; reconcile our books against the decrypted on-ledger balances (SPEC §4.3).
// Never on a request path. Off in tests unless started.
import type { Core } from './core'
import { getBalance } from './books'
import { intents } from './intents/repo'
import { emitIntent, recoverIntents } from './intents/flow'
import { preparedForIntent } from './prepared/store'
import { settleUnknownSubmits } from './prepared/submit'
import { expireRequests } from './paymentRequests/routes'
import { users } from './users'

/** Intents that start with the person's deposit approval (send to the pool); a created top-up is minted by recovery instead. */
const APPROVED_DEPOSIT_KINDS: ReadonlySet<string> = new Set(['p2p', 'merchant', 'card_load', 'earn_deposit', 'market_buy'])

/** created intents whose approval can no longer reach the ledger (LastLedgerSequence passed, or expired) -> expired. */
export async function expireIntents(core: Core): Promise<number> {
  const created = intents.withStatus(core, 'created').filter((i) => APPROVED_DEPOSIT_KINDS.has(i.kind))
  if (!created.length) return 0
  const index = await core.ledger.ledgerIndex()
  let n = 0
  for (const i of created) {
    if (i.submittedAt) continue // being submitted right now
    const ps = preparedForIntent(core, i.id)
    // No prepared tx yet: still being built (proofs take seconds on Devnet). Only give up on it after 10 minutes.
    if (!ps.length) {
      if (core.now() - Date.parse(i.createdAt) > 10 * 60_000 && intents.transition(core, i.id, 'created', 'expired')) {
        emitIntent(core, i.id)
        n++
      }
      continue
    }
    if (ps.some((p) => p.usedAt)) continue
    const dead = ps.every((p) => Date.parse(p.expiresAt) <= core.now() || (p.lastLedgerSequence !== undefined && index > p.lastLedgerSequence))
    if (dead && intents.transition(core, i.id, 'created', 'expired')) {
      emitIntent(core, i.id)
      n++
    }
  }
  return n
}

export type Difference = { userId: string; handle: string; booksMinor: number; ledgerMinor: number }

/** Decrypts every active user's on-ledger balance and reports where it differs from our books. Logs, never blocks. */
export async function reconcile(core: Core): Promise<Difference[]> {
  const out: Difference[] = []
  for (const u of users.active(core)) {
    if (!core.keystore.has({ user: u.address })) continue
    try {
      const c = await core.ledger.confidentialBalance(u.address, core.keystore.getElGamal({ user: u.address }))
      const b = getBalance(core, u.id)
      const books = b.availableMinor + b.pendingMinor
      const ledger = c.spendableMinor + c.inboxMinor
      if (books !== ledger) {
        out.push({ userId: u.id, handle: u.handle, booksMinor: books, ledgerMinor: ledger })
        core.log.warn(`[reconcile] @${u.handle}: books ${books} != ledger ${ledger} (spendable ${c.spendableMinor}, inbox ${c.inboxMinor})`)
      }
    } catch (e) {
      core.log.warn(`[reconcile] @${u.handle}: ${(e as Error).message}`)
    }
  }
  return out
}

export type Jobs = { tick(): Promise<void>; reconcile(): Promise<Difference[]>; start(o?: { tickMs?: number; reconcileMs?: number }): void; stop(): void }

export function createJobs(core: Core): Jobs {
  let timers: NodeJS.Timeout[] = []
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      expireRequests(core)
      await expireIntents(core)
      await settleUnknownSubmits(core)
      recoverIntents(core)
    } catch (e) {
      core.log.warn(`[jobs] tick: ${(e as Error).message}`)
    } finally {
      busy = false
    }
  }
  return {
    tick,
    reconcile: () => reconcile(core),
    start(o = {}) {
      void tick() // at start: picks up what the last run left behind
      timers.push(setInterval(() => void tick(), o.tickMs ?? 5_000))
      if (o.reconcileMs !== 0) timers.push(setInterval(() => void reconcile(core), o.reconcileMs ?? 60_000))
      for (const t of timers) t.unref?.()
    },
    stop() {
      for (const t of timers) clearInterval(t)
      timers = []
    },
  }
}
