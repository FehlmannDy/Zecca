import { describe, expect, it, vi } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { Intent, PreparedTx } from '@zecca/contracts'
import { ZeccaApiError } from '../../lib/api'
import { approveTransfer, STILL_ON_ITS_WAY, type ApproveDeps, type Transfer } from './approve-flow'

const UNCONFIRMED = "The payment network hasn't confirmed this yet. It will update here by itself within a few minutes."
const OFFLINE = "Can't reach Zecca right now. Check your connection and try again."
const err = (status: number, code: ConstructorParameters<typeof ZeccaApiError>[1]['code'], message: string) => new ZeccaApiError(status, { code, message })

type How = 'validated' | 'lost' | 'offline-after' | 'offline-before' | 'internal-after' | 'failed' | 'signer-cancel'

/** A small model of the API's rules for one sender (prepared/store.ts checkSubmission, prepared/submit.ts, intents/flow.ts). */
function fakeApi(plan: How[]) {
  let clock = Date.parse('2026-11-21T10:00:00Z')
  let n = 0
  const rows = new Map<string, { intent: Intent; prepared: PreparedTx; used: boolean }>()
  /** Intents whose money left the sender. */
  const landed: string[] = []
  const byPrepare = (id: string) => [...rows.values()].find((r) => r.prepared.prepareId === id)!

  const make = (): Transfer => {
    n++
    const intent: Intent = { ...fx.intents.p2pCreated, id: `int_${n}` }
    const prepared: PreparedTx = { ...fx.preparedSend, prepareId: `prep_${n}`, expiresAt: new Date(clock + 60_000).toISOString() }
    rows.set(intent.id, { intent, prepared, used: false })
    return { intent, prepared }
  }
  const set = (id: string, status: Intent['status']) => {
    const r = rows.get(id)!
    r.intent = { ...r.intent, status }
  }

  const deps = {
    getIntent: vi.fn(async (id: string) => rows.get(id)!.intent),
    create: vi.fn(async () => make()),
    submit: vi.fn(async (p: PreparedTx): Promise<Intent | undefined> => {
      const how = plan.shift() ?? 'validated'
      if (how === 'signer-cancel') throw new Error('You closed the approval.')
      if (how === 'offline-before') throw err(0, 'upstream_error', OFFLINE)
      const row = byPrepare(p.prepareId)
      if (row.used) throw err(403, 'policy_refused', 'This approval was already used.')
      if (Date.parse(p.expiresAt) <= clock) throw err(403, 'policy_refused', 'This approval has expired. Start again.')
      row.used = true
      if (how === 'failed') {
        set(row.intent.id, 'failed')
        throw err(422, 'ledger_error', "That didn't go through and nothing was taken. Try again.")
      }
      landed.push(row.intent.id)
      if (how === 'lost') throw err(502, 'ledger_error', UNCONFIRMED)
      if (how === 'offline-after') throw err(0, 'upstream_error', OFFLINE)
      if (how === 'internal-after') throw err(500, 'internal', 'Something went wrong on our side. Try again in a moment.')
      set(row.intent.id, 'submitted')
      return rows.get(row.intent.id)!.intent
    }),
    onTransfer: vi.fn(),
    onUnsure: vi.fn(),
  } satisfies ApproveDeps

  return {
    deps,
    first: make(),
    landed,
    /** The jobs tick finds the lost submits on the ledger. */
    settle: () => landed.forEach((id) => rows.get(id)!.intent.status === 'created' && set(id, 'submitted')),
    advance: (ms: number) => (clock += ms),
  }
}

describe('approveTransfer: a payment whose answer was lost', () => {
  it('is followed, not paid again: "Try again" never makes a second transfer while the first may land', async () => {
    const api = fakeApi(['lost'])
    await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow(UNCONFIRMED)
    expect(api.deps.onUnsure).toHaveBeenCalledWith(api.first.intent, UNCONFIRMED)

    // Still unconfirmed when the person taps "Try again".
    await expect(approveTransfer(api.first, true, api.deps)).rejects.toThrow()
    expect(api.deps.create).not.toHaveBeenCalled()
    expect(api.landed).toEqual([api.first.intent.id])
    expect(api.deps.onUnsure).toHaveBeenLastCalledWith(api.first.intent, STILL_ON_ITS_WAY)
  })

  it('shows as sent on "Try again" once the first one went through', async () => {
    const api = fakeApi(['lost'])
    await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow()
    api.settle()
    const i = await approveTransfer(api.first, true, api.deps)
    expect(i).toMatchObject({ id: api.first.intent.id, status: 'submitted' })
    expect(api.deps.submit).toHaveBeenCalledTimes(1)
    expect(api.deps.create).not.toHaveBeenCalled()
  })

  it('treats a dropped connection or a server error after the request left as maybe sent', async () => {
    for (const how of ['offline-after', 'internal-after', 'offline-before'] as const) {
      const api = fakeApi([how])
      await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow()
      expect(api.deps.onUnsure).toHaveBeenCalledWith(api.first.intent, STILL_ON_ITS_WAY)
      await approveTransfer(api.first, true, api.deps).catch(() => {})
      expect(api.deps.create).not.toHaveBeenCalled()
      expect(api.landed).toEqual([api.first.intent.id])
    }
  })
})

describe('approveTransfer: "Try again" after a real failure', () => {
  it('makes a new transfer when the first one failed', async () => {
    const api = fakeApi(['failed', 'validated'])
    await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow("That didn't go through")
    expect(api.deps.onUnsure).not.toHaveBeenCalled()
    const i = await approveTransfer(api.first, true, api.deps)
    expect(api.deps.create).toHaveBeenCalledTimes(1)
    expect(api.deps.onTransfer).toHaveBeenCalledWith(expect.objectContaining({ intent: expect.objectContaining({ id: 'int_2' }) }))
    expect(i).toMatchObject({ id: 'int_2', status: 'submitted' })
    expect(api.landed).toEqual(['int_2'])
  })

  it('sends the same approval again when it never reached Zecca', async () => {
    const api = fakeApi(['signer-cancel', 'validated'])
    await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow('You closed the approval.')
    expect(api.deps.onUnsure).not.toHaveBeenCalled()
    const i = await approveTransfer(api.first, true, api.deps)
    expect(i).toMatchObject({ id: api.first.intent.id, status: 'submitted' })
    expect(api.deps.create).not.toHaveBeenCalled()
  })

  it('replaces an approval that expired unused with a new transfer', async () => {
    const api = fakeApi(['signer-cancel', 'validated', 'validated'])
    await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow()
    api.advance(120_000)
    const i = await approveTransfer(api.first, true, api.deps)
    expect(api.deps.create).toHaveBeenCalledTimes(1)
    expect(i).toMatchObject({ id: 'int_2', status: 'submitted' })
    expect(api.landed).toEqual(['int_2'])
  })

  it('does not submit again when the transfer was already received', async () => {
    const api = fakeApi(['lost'])
    await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow()
    api.settle()
    const got = { ...(await api.deps.getIntent(api.first.intent.id)), status: 'paid_out' as const }
    api.deps.getIntent.mockResolvedValueOnce(got)
    expect(await approveTransfer(api.first, true, api.deps)).toBe(got)
    expect(api.deps.submit).toHaveBeenCalledTimes(1)
  })
})

describe('approveTransfer: errors that are not answers of the API', () => {
  it('are final even when they carry a status (a wallet error, say)', async () => {
    const api = fakeApi([])
    api.deps.submit.mockRejectedValueOnce(Object.assign(new Error('Wallet unavailable'), { status: 500, code: 'internal' }))
    await expect(approveTransfer(api.first, false, api.deps)).rejects.toThrow('Wallet unavailable')
    expect(api.deps.onUnsure).not.toHaveBeenCalled()
  })
})
