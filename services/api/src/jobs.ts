// Background jobs: expire stale intents and requests; reconcile our books against the decrypted on-ledger balances (SPEC §4.3).
// Never on a request path. Off in tests unless started.
import type { Core } from './core'
import { getBalance } from './books'
import { intents } from './intents/repo'
import { emitIntent } from './intents/flow'
import { preparedForIntent } from './prepared/store'
import { expireRequests } from './paymentRequests/routes'
import { users } from './users'

/** created intents whose approval can no longer reach the ledger (LastLedgerSequence passed, or expired) -> expired. */
export async function expireIntents(core: Core): Promise<number> {
  const created = intents.withStatus(core, 'created').filter((i) => i.kind === 'p2p' || i.kind === 'merchant')
  if (!created.length) return 0
  const index = await core.ledger.ledgerIndex()
  let n = 0
  for (const i of created) {
    if (i.submittedAt) continue // being submitted right now
    const ps = preparedForIntent(core, i.id)
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
