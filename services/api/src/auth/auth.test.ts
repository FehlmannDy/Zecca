import { describe, expect, it } from 'vitest'
import { mockRawSigner, signMessage } from '@zecca/xrpl-core/signer'
import { makeHarness } from '../testing/harness'
import type { PrivyVerifier } from './privy'

async function nonceFor(h: ReturnType<typeof makeHarness>, s = mockRawSigner()) {
  const n = await h.json('POST', '/v1/auth/nonce', { body: { address: s.address, publicKey: s.publicKey } })
  return { s, n }
}

describe('auth: nonce shape (SIGNER_MODE=mock)', () => {
  it('issues a nonce and a session for a valid signature; the session is bound to the address', async () => {
    const h = makeHarness()
    const { s, n } = await nonceFor(h)
    expect(n.status).toBe(200)
    expect(n.body.message).toContain(s.address)
    const signature = await signMessage(s.rawSign, n.body.message)
    const r = await h.json('POST', '/v1/auth/session', { body: { address: s.address, publicKey: s.publicKey, nonce: n.body.nonce, signature } })
    expect(r.status).toBe(200)
    expect(r.body.token.length).toBeGreaterThanOrEqual(16)
    expect(r.body.user).toBeUndefined()
    // Not signed up yet: user routes say so.
    const me = await h.json('GET', '/v1/me', { token: r.body.token })
    expect(me.status).toBe(403)
    expect(me.body.error.code).toBe('not_signed_up')
  })

  it('refuses a key that does not derive the address', async () => {
    const h = makeHarness()
    const a = mockRawSigner()
    const b = mockRawSigner()
    const n = await h.json('POST', '/v1/auth/nonce', { body: { address: a.address, publicKey: b.publicKey } })
    expect(n.status).toBe(400)
    expect(n.body.error.code).toBe('bad_request')
  })

  it('refuses a signature by another key, a reused nonce, an expired nonce', async () => {
    const h = makeHarness()
    const { s, n } = await nonceFor(h)
    const other = mockRawSigner()
    const bad = await signMessage(other.rawSign, n.body.message)
    const r1 = await h.json('POST', '/v1/auth/session', { body: { address: s.address, publicKey: s.publicKey, nonce: n.body.nonce, signature: bad } })
    expect(r1.status).toBe(401)

    const good = await signMessage(s.rawSign, n.body.message)
    const ok = await h.json('POST', '/v1/auth/session', { body: { address: s.address, publicKey: s.publicKey, nonce: n.body.nonce, signature: good } })
    expect(ok.status).toBe(200)
    const replay = await h.json('POST', '/v1/auth/session', { body: { address: s.address, publicKey: s.publicKey, nonce: n.body.nonce, signature: good } })
    expect(replay.status).toBe(401)

    const { n: n2 } = await nonceFor(h, s)
    h.clock.advance(6 * 60_000)
    const late = await h.json('POST', '/v1/auth/session', {
      body: { address: s.address, publicKey: s.publicKey, nonce: n2.body.nonce, signature: await signMessage(s.rawSign, n2.body.message) },
    })
    expect(late.status).toBe(401)
  })

  it('refuses a nonce issued to another address', async () => {
    const h = makeHarness()
    const { n } = await nonceFor(h)
    const s2 = mockRawSigner()
    const r = await h.json('POST', '/v1/auth/session', {
      body: { address: s2.address, publicKey: s2.publicKey, nonce: n.body.nonce, signature: await signMessage(s2.rawSign, n.body.message) },
    })
    expect(r.status).toBe(401)
  })

  it('refuses the privy shape in mock signer mode', async () => {
    const h = makeHarness()
    const s = mockRawSigner()
    const r = await h.json('POST', '/v1/auth/session', { body: { privyToken: 'x'.repeat(40), address: s.address, publicKey: s.publicKey } })
    expect(r.status).toBe(400)
  })

  it('rejects bad Bearer tokens and missing ones on user routes', async () => {
    const h = makeHarness()
    expect((await h.json('GET', '/v1/me')).status).toBe(401)
    expect((await h.json('GET', '/v1/me', { token: 'not-a-real-session-token-xx' })).status).toBe(401)
  })

  it('sessions expire', async () => {
    const h = makeHarness()
    const u = await h.signUp('ana')
    expect((await h.json('GET', '/v1/me', { token: u.token })).status).toBe(200)
    h.clock.advance(8 * 24 * 3_600_000)
    expect((await h.json('GET', '/v1/me', { token: u.token })).status).toBe(401)
  })
})

describe('auth: privy shape (SIGNER_MODE=privy)', () => {
  const fakePrivy = (ok: Record<string, string>): PrivyVerifier => ({
    async verify(token, address) {
      if (ok[token] !== address) throw new Error('refused')
      return { privyUserId: 'did:privy:' + token.slice(0, 8) }
    },
  })

  it('accepts a verified token for a linked address and refuses the nonce shape (DEMO_MODE off)', async () => {
    const s = mockRawSigner()
    const h = makeHarness({ env: { SIGNER_MODE: 'privy', DEMO_MODE: '0' }, privy: fakePrivy({ tok_valid_0001: s.address }) })
    const r = await h.json('POST', '/v1/auth/session', { body: { privyToken: 'tok_valid_0001', address: s.address, publicKey: s.publicKey } })
    expect(r.status).toBe(200)
    const bad = await h.json('POST', '/v1/auth/session', { body: { privyToken: 'tok_other_0001', address: s.address, publicKey: s.publicKey } })
    expect(bad.status).toBe(401)
    const n = await h.json('POST', '/v1/auth/nonce', { body: { address: s.address, publicKey: s.publicKey } })
    expect(n.status).toBe(403)
  })

  it('accepts both shapes when DEMO_MODE=1', async () => {
    const h = makeHarness({ env: { SIGNER_MODE: 'privy', DEMO_MODE: '1' }, privy: fakePrivy({}) })
    await expect(h.signIn()).resolves.toMatchObject({ token: expect.any(String) })
  })

  it('refuses a privy token when the public key does not derive the address', async () => {
    const s = mockRawSigner()
    const other = mockRawSigner()
    const h = makeHarness({ env: { SIGNER_MODE: 'privy' }, privy: fakePrivy({ tok_valid_0002: s.address }) })
    const r = await h.json('POST', '/v1/auth/session', { body: { privyToken: 'tok_valid_0002', address: s.address, publicKey: other.publicKey } })
    expect(r.status).toBe(401)
  })
})
