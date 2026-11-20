// Sign-up recovery against the mock API: the account is set up on the server, but this browser lost the user (the
// tab was reloaded or closed during the approval, or the reply dropped). The person must get in, not loop on
// "already set up".
import { describe, expect, it } from 'vitest'
import { getResponse } from 'msw'
import { createApi } from './api'
import { createHandlers } from '../mocks/handlers'
import { createMockState } from '../mocks/state'
import { signInMock } from './wallet/mock'
import { signAndSubmit } from './wallet/sign-and-submit'
import { signedUpUser } from './signup'

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
  return { api, setToken: (t: string | null) => (token = t) }
}

describe('signedUpUser', () => {
  it('finds the account when sign-up finished on the server but not in this browser', async () => {
    const { api, setToken } = mockApi()
    const s = await signInMock({ api, email: 'ana@example.com', storage: null })
    setToken(s.token)
    const body = { address: s.signer.address, publicKey: s.signer.publicKey, handle: 'ana', displayName: 'Ana Ferri', role: 'user' as const }

    expect(await signedUpUser(api)).toBeNull() // not set up yet: resume at the handle step
    await signAndSubmit(api, s.signer, await api.call('onboardingPrepare', { body }))

    // The browser never stored the user, so approving again is refused...
    const again = await api.call('onboardingPrepare', { body: { ...body, handle: 'ana2' } }).catch((e) => e)
    expect(again.code).toBe('already_signed_up')
    // ...and the flow gets the account from the session instead.
    expect((await signedUpUser(api))?.handle).toBe('ana')
  })

  it('returns null when the session is gone (401) or Zecca cannot be reached', async () => {
    const { api, setToken } = mockApi()
    setToken('mock_unknown')
    expect(await signedUpUser(api)).toBeNull()

    const offline = createApi({ origin: 'http://api.mock', getToken: () => 't', fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch })
    expect(await signedUpUser(offline)).toBeNull()
  })
})
