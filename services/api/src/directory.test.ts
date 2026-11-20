import { describe, expect, it } from 'vitest'
import { ContactsResponse, ResolveResponse } from '@zecca/contracts'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { makeHarness } from './testing/harness'
import type { PrivyVerifier } from './auth/privy'

describe('directory', () => {
  it('handle-available is public; reserved words, taken and invalid handles are unavailable', async () => {
    const h = makeHarness()
    await h.signUp('ana')
    const q = async (handle: string) => (await h.json('GET', `/v1/directory/handle-available?handle=${encodeURIComponent(handle)}`)).body
    expect(await q('bruno')).toEqual({ available: true })
    expect(await q('@Bruno')).toEqual({ available: true })
    expect(await q('ana')).toEqual({ available: false, reason: 'Taken, try another.' })
    for (const r of ['admin', 'zecca', 'support', 'pool']) expect((await q(r)).available).toBe(false)
    const bad = await q('a')
    expect(bad.available).toBe(false)
    expect(bad.reason).toMatch(/3 to 20 characters/)
  })

  it('resolve: handle with or without @, email, phone, XRPL address (zecca or external), unknown', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla', { displayName: 'Carla Rossi', email: 'Carla@Example.com', phone: '+393331234567' })
    const r = async (q: string) => ResolveResponse.parse((await h.json('GET', `/v1/directory/resolve?q=${encodeURIComponent(q)}`, { token: ana.token })).body)
    const carlaProfile = { kind: 'zecca', profile: { id: carla.user.id, handle: 'carla', displayName: 'Carla Rossi', isMerchant: false } }
    expect(await r('carla')).toEqual(carlaProfile)
    expect(await r('@carla')).toEqual(carlaProfile)
    // An email typed at sign-up (test sign-in, nobody checked it) finds nobody; see the Privy tests below.
    expect(await r('carla@example.com')).toEqual({ kind: 'unknown' })
    expect(await r('+39 333 123 4567')).toEqual(carlaProfile)
    expect(await r(carla.user.address)).toEqual(carlaProfile)
    const ext = mockRawSigner().address
    expect(await r(ext)).toEqual({ kind: 'external', address: ext })
    expect(await r('nobody')).toEqual({ kind: 'unknown' })
    expect(await r('nobody@example.com')).toEqual({ kind: 'unknown' })
    // Requires a session.
    expect((await h.json('GET', '/v1/directory/resolve?q=carla')).status).toBe(401)
  })

  it('resolve shows merchants by business name', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    await h.signUp('caffebruno', { role: 'merchant', businessName: 'Caffè Bruno' })
    const r = await h.json('GET', '/v1/directory/resolve?q=caffebruno', { token: ana.token })
    expect(r.body.profile).toMatchObject({ displayName: 'Caffè Bruno', isMerchant: true })
  })

  it('pending sign-ups are not resolvable', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const { token, signer } = await h.signIn()
    await h.json('POST', '/v1/onboarding/prepare', { token, body: { address: signer.address, publicKey: signer.publicKey, handle: 'ghost', displayName: 'G', role: 'user' } })
    expect((await h.json('GET', '/v1/directory/resolve?q=ghost', { token: ana.token })).body).toEqual({ kind: 'unknown' })
  })

  it('two sign-ups with the same typed email: the email finds neither (nobody verified it)', async () => {
    const h = makeHarness()
    await h.signUp('mallory', { displayName: 'Bob', email: 'bob@example.com' })
    const bob = await h.signUp('bob', { displayName: 'Bob', email: 'bob@example.com' })
    const r = await h.json('GET', `/v1/directory/resolve?q=${encodeURIComponent('bob@example.com')}`, { token: bob.token })
    expect(r.body).toEqual({ kind: 'unknown' })
    // The person still sees the email they typed on their own profile.
    expect((await h.json('GET', '/v1/me', { token: bob.token })).body.email).toBe('bob@example.com')
  })

  describe('Privy sign-in: the email is the one Privy verified', () => {
    function privyWorld() {
      const verified = new Map<string, string>()
      const privy: PrivyVerifier = { verify: async (_token, address) => ({ privyUserId: 'did:privy:' + address, email: verified.get(address) }) }
      const h = makeHarness({ env: { SIGNER_MODE: 'privy', DEMO_MODE: '0' }, privy })
      const signUp = async (handle: string, o: { verifiedEmail?: string; typedEmail?: string }) => {
        const s = mockRawSigner()
        if (o.verifiedEmail) verified.set(s.address, o.verifiedEmail)
        const token = (await h.json('POST', '/v1/auth/session', { body: { privyToken: 'privy-token-' + s.address, address: s.address, publicKey: s.publicKey } })).body
          .token as string
        const body = { address: s.address, publicKey: s.publicKey, handle, displayName: 'Bob', role: 'user', ...(o.typedEmail ? { email: o.typedEmail } : {}) }
        const p = await h.json('POST', '/v1/onboarding/prepare', { token, body })
        expect(p.status).toBe(200)
        const r = await h.submit({ token, signer: s }, p.body)
        expect(r.body.status).toBe('validated')
        return { token, signer: s, user: r.body.user }
      }
      const resolve = async (token: string, q: string) => (await h.json('GET', `/v1/directory/resolve?q=${encodeURIComponent(q)}`, { token })).body
      return { h, signUp, resolve }
    }

    it('ignores the typed email and finds people by their verified one', async () => {
      const { signUp, resolve } = privyWorld()
      const mallory = await signUp('mallory', { verifiedEmail: 'mallory@example.com', typedEmail: 'bob@example.com' })
      expect(mallory.user.email).toBe('mallory@example.com')
      const bob = await signUp('bob', { verifiedEmail: 'Bob@Example.com' })
      expect(await resolve(mallory.token, 'bob@example.com')).toEqual({ kind: 'zecca', profile: { id: bob.user.id, handle: 'bob', displayName: 'Bob', isMerchant: false } })
      expect((await resolve(bob.token, 'mallory@example.com')).profile.id).toBe(mallory.user.id)
    })

    it('a Privy account with no email is not findable by any email', async () => {
      const { signUp, resolve } = privyWorld()
      const ghost = await signUp('ghost', { typedEmail: 'bob@example.com' })
      expect(ghost.user.email).toBeUndefined()
      expect(await resolve(ghost.token, 'bob@example.com')).toEqual({ kind: 'unknown' })
    })

    it('one verified email finds one person: a second account with it signs up but does not take it over', async () => {
      const { signUp, resolve } = privyWorld()
      const bob = await signUp('bob', { verifiedEmail: 'bob@example.com' })
      const other = await signUp('bobby', { verifiedEmail: 'bob@example.com' })
      expect((await resolve(other.token, 'bob@example.com')).profile.id).toBe(bob.user.id)
    })
  })

  it('contacts starts empty', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    expect(ContactsResponse.parse((await h.json('GET', '/v1/contacts', { token: ana.token })).body)).toEqual([])
  })
})
