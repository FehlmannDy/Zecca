// Signer + auth flow in SIGNER_MODE=mock, end to end against the mock API handlers.
import { describe, expect, it, vi } from 'vitest'
import { getResponse } from 'msw'
import * as fx from '@zecca/contracts/fixtures'
import { createApi, ZeccaApiError } from '../api'
import { createHandlers } from '../../mocks/handlers'
import { createMockState } from '../../mocks/state'
import { mockSignerForEmail, signInMock } from './mock'
import { signAndSubmit } from './sign-and-submit'

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size }
}

function mockApi() {
  const state = createMockState({ delays: { submitMs: 0, receiveMs: 0, payoutMs: 0, networkMs: 0 } })
  const handlers = createHandlers(state, 'http://api.mock')
  let token: string | null = null
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await getResponse(handlers, new Request(input, init))
    if (!res) throw new TypeError('Failed to fetch')
    return res
  }) as typeof fetch
  const api = createApi({ origin: 'http://api.mock', fetch: f, getToken: () => token })
  return { api, state, setToken: (t: string | null) => (token = t) }
}

describe('mock signer', () => {
  it('keeps one key per email in storage, so signing in again restores the same account', () => {
    const storage = memoryStorage()
    const a = mockSignerForEmail('Ana@Example.com ', storage)
    const b = mockSignerForEmail('ana@example.com', storage)
    const c = mockSignerForEmail('carla@example.com', storage)
    expect(a.address).toBe(b.address)
    expect(c.address).not.toBe(a.address)
    expect(a.address).toMatch(/^r/)
  })

  it('works without storage (private mode): a fresh key each time', () => {
    expect(mockSignerForEmail('x@y.z', null).address).not.toBe(mockSignerForEmail('x@y.z', null).address)
  })
})

describe('sign-in and sign-up (mock signer)', () => {
  it('signs a nonce, gets a session, signs up with one approval, then signs in again as the same user', async () => {
    const { api, setToken } = mockApi()
    const storage = memoryStorage()

    const first = await signInMock({ api, email: 'ana@example.com', storage })
    expect(first.token).toMatch(/^mock_/)
    expect(first.user).toBeUndefined()
    setToken(first.token)

    const prepared = await api.call('onboardingPrepare', {
      body: { address: first.signer.address, publicKey: first.signer.publicKey, handle: 'ana', displayName: 'Ana Ferri', role: 'user', email: 'ana@example.com' },
    })
    const result = await signAndSubmit(api, first.signer, prepared)
    expect(result.status).toBe('validated')
    expect(result.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(result.user?.handle).toBe('ana')
    expect((await api.call('balance')).availableMinor).toBe(fx.config.welcomeCreditMinor)

    setToken(null)
    const again = await signInMock({ api, email: 'ana@example.com', storage })
    expect(again.user?.handle).toBe('ana')
    expect(again.signer.address).toBe(first.signer.address)
  })

  it('throws the API message when the ledger refuses the transaction', async () => {
    const api = { call: vi.fn(async () => ({ status: 'failed', hash: 'A'.repeat(64), engineResult: 'tecUNFUNDED' })) } as never
    const signer = { kind: 'mock' as const, address: 'r', publicKey: '02', sign: vi.fn(async () => ({ tx_blob: 'AB', hash: 'CD' })) }
    const err = await signAndSubmit(api, signer, fx.preparedSend).catch((e) => e)
    expect(err).toBeInstanceOf(ZeccaApiError)
    expect(err.code).toBe('ledger_error')
    expect(err.message).toMatch(/didn't go through/)
  })

  it('passes the prepared tx to the signer untouched and submits its blob with the prepareId', async () => {
    const call = vi.fn(async () => ({ status: 'validated', hash: 'B'.repeat(64), engineResult: 'tesSUCCESS' }))
    const sign = vi.fn(async () => ({ tx_blob: 'ABCD', hash: 'EF' }))
    await signAndSubmit({ call } as never, { kind: 'mock', address: 'r', publicKey: '02', sign }, fx.preparedSend)
    expect(sign).toHaveBeenCalledWith(fx.preparedSend.tx)
    expect(call).toHaveBeenCalledWith('txSubmit', { body: { prepareId: fx.preparedSend.prepareId, txBlob: 'ABCD' } })
  })
})
