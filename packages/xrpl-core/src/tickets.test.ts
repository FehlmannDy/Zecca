import { describe, expect, it } from 'vitest'
import { createTicketAllocator, listTickets } from './tickets'

type Tx = Record<string, any>

function fakeClient(tickets: Record<string, number[]>) {
  const reqs: Tx[] = []
  return {
    reqs,
    tickets,
    async request(req: Tx) {
      reqs.push(req)
      if (req.command !== 'account_objects' || req.type !== 'ticket') throw new Error('unexpected ' + JSON.stringify(req))
      return { result: { account_objects: (tickets[req.account] ?? []).map((t) => ({ LedgerEntryType: 'Ticket', TicketSequence: t })) } }
    },
  }
}

describe('listTickets', () => {
  it('lists the account tickets from the current ledger, lowest first', async () => {
    const c = fakeClient({ rIssuer: [30, 12, 21] })
    expect(await listTickets(c, 'rIssuer')).toEqual([12, 21, 30])
    expect(c.reqs[0]).toMatchObject({ command: 'account_objects', account: 'rIssuer', type: 'ticket', ledger_index: 'current' })
  })
})

describe('createTicketAllocator', () => {
  it('hands out the lowest free ticket; concurrent callers get distinct tickets; none left gives null', async () => {
    const t = createTicketAllocator(fakeClient({ rIssuer: [5, 6, 7] }))
    expect(await Promise.all([t.take('rIssuer', 1150, 1000), t.take('rIssuer', 1150, 1000)])).toEqual([5, 6])
    expect(await t.take('rIssuer', 1150, 1000)).toBe(7)
    expect(await t.take('rIssuer', 1150, 1000)).toBeNull()
  })

  it('a hold ends once its LastLedgerSequence has passed (the prepared tx can no longer use it)', async () => {
    const t = createTicketAllocator(fakeClient({ rIssuer: [5] }))
    expect(await t.take('rIssuer', 1150, 1000)).toBe(5)
    expect(await t.take('rIssuer', 1200, 1150)).toBeNull()
    expect(await t.take('rIssuer', 1300, 1151)).toBe(5)
  })

  it('a ticket consumed on the ledger is never handed out again', async () => {
    const c = fakeClient({ rIssuer: [5, 6] })
    const t = createTicketAllocator(c)
    expect(await t.take('rIssuer', 1150, 1000)).toBe(5)
    c.tickets.rIssuer = [6]
    expect(await t.take('rIssuer', 1350, 1200)).toBe(6)
    expect(await t.take('rIssuer', 1350, 1200)).toBeNull()
  })
})
