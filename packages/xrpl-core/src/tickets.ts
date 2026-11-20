// Issuer Tickets for the sign-up Batch. Its welcome-credit inner Payment used to take the issuer's next Sequence when the
// Batch was prepared, so any issuer tx landing before the user approved (a pool-worker mint, a parallel sign-up) made the
// whole Batch fail (tecBATCH_INNER_FAILED, Devnet 4E09D1D4...D50A). A Ticket is consumed only by its own tx, so sign-ups
// no longer collide with each other or with mints. scripts/bootstrap-ledger.ts creates the tickets.
import type { XrplClient } from './client'

export type TicketClient = Pick<XrplClient, 'request'>

/** The account's unused tickets in the current (open) ledger, lowest first. */
export async function listTickets(client: TicketClient, account: string): Promise<number[]> {
  const r = await client.request({ command: 'account_objects', account, type: 'ticket', ledger_index: 'current', limit: 400 })
  return (r.result.account_objects as { TicketSequence: number }[]).map((o) => Number(o.TicketSequence)).sort((a, b) => a - b)
}

export interface TicketAllocator {
  /**
   * Holds the lowest free ticket of `account` for a tx valid until `lastLedgerSequence`, or null when none is free.
   * A hold ends once `currentLedger` is past it. Holds are in memory: only one process prepares sign-ups (the API);
   * after a restart a ticket held by a tx prepared before it may be handed out again (one of the two then fails).
   */
  take(account: string, lastLedgerSequence: number, currentLedger: number): Promise<number | null>
}

export function createTicketAllocator(client: TicketClient): TicketAllocator {
  const held = new Map<string, number>()
  return {
    async take(account, lastLedgerSequence, currentLedger) {
      const tickets = await listTickets(client, account)
      // From here to the end it runs without awaiting, so concurrent callers never get the same ticket.
      for (const [k, until] of held) if (currentLedger > until) held.delete(k)
      const free = tickets.find((t) => !held.has(`${account}:${t}`))
      if (free == null) return null
      held.set(`${account}:${free}`, lastLedgerSequence)
      return free
    },
  }
}
