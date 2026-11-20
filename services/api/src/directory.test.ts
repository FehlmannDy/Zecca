import { describe, expect, it } from 'vitest'
import { ContactsResponse, ResolveResponse } from '@zecca/contracts'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { makeHarness } from './testing/harness'

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
    expect(await r('carla@example.com')).toEqual(carlaProfile)
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

  it('contacts starts empty', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    expect(ContactsResponse.parse((await h.json('GET', '/v1/contacts', { token: ana.token })).body)).toEqual([])
  })
})
