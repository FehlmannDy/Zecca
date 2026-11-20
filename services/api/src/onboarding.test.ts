import { describe, expect, it } from 'vitest'
import { Balance, PreparedTx, User } from '@zecca/contracts'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { makeHarness } from './testing/harness'
import type { PrivyVerifier } from './auth/privy'

const body = (s: { address: string; publicKey: string }, o: Record<string, unknown> = {}) => ({
  address: s.address,
  publicKey: s.publicKey,
  handle: 'ana',
  displayName: 'Ana Ferri',
  role: 'user',
  ...o,
})

describe('onboarding', () => {
  it('prepares a sponsored Batch with the user key, then activates the user with the demo credit', async () => {
    const h = makeHarness()
    const { token, signer } = await h.signIn()
    const p = await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer) })
    expect(p.status).toBe(200)
    expect(PreparedTx.parse(p.body).kind).toBe('onboarding')
    expect(p.body.tx.SigningPubKey).toBe(signer.publicKey)
    expect(p.body.tx.Sponsor).toBe(h.keystore.getWallet('sponsor').address)
    expect(h.keystore.has({ user: signer.address })).toBe(true)

    const s = await h.submit({ token, signer }, p.body)
    expect(s.status).toBe(200)
    expect(s.body.status).toBe('validated')
    const user = User.parse(s.body.user)
    expect(user).toMatchObject({ handle: 'ana', displayName: 'Ana Ferri', role: ['user'], tier: 0, address: signer.address })

    const me = await h.json('GET', '/v1/me', { token })
    expect(me.status).toBe(200)
    expect(me.body.id).toBe(user.id)
    const bal = await h.json('GET', '/v1/balance', { token })
    expect(Balance.parse(bal.body)).toMatchObject({ availableMinor: 5000, pendingMinor: 0 })
    const act = await h.json('GET', '/v1/activity', { token })
    expect(act.body.items).toHaveLength(1)
    expect(act.body.items[0]).toMatchObject({ kind: 'welcome', direction: 'in', amountMinor: 5000, note: 'Demo credit', status: 'done' })
    expect(act.body.items[0].ledger.depositTxHash).toBe(s.body.hash)

    // Signing in again returns the user.
    const again = await h.signIn(signer)
    expect(again.user?.id).toBe(user.id)
  })

  it('grants the relayer the merge permission when the relayer wallet exists', async () => {
    const h = makeHarness()
    const calls: unknown[] = []
    const orig = h.ledger.buildOnboarding.bind(h.ledger)
    h.ledger.buildOnboarding = async (p) => (calls.push(p), orig(p))
    await h.signUp('ana')
    expect(calls[0]).toMatchObject({ welcomeCreditMinor: 5000, delegateMergeTo: h.keystore.getWallet('relayer').address })
  })

  it('creates a merchant with business name and fee', async () => {
    const h = makeHarness()
    const u = await h.signUp('caffebruno', { role: 'merchant', businessName: 'Caffè Bruno', displayName: 'Bruno Esposito' })
    expect(u.user).toMatchObject({ role: ['user', 'merchant'], merchant: { businessName: 'Caffè Bruno', feeBps: 50 } })
  })

  it('requires a business name for a merchant', async () => {
    const h = makeHarness()
    const { token, signer } = await h.signIn()
    const p = await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer, { role: 'merchant' }) })
    expect(p.status).toBe(400)
  })

  it('refuses a taken handle with 409 handle_taken "Taken, try another."', async () => {
    const h = makeHarness()
    await h.signUp('ana')
    const { token, signer } = await h.signIn()
    const p = await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer) })
    expect(p.status).toBe(409)
    expect(p.body.error).toMatchObject({ code: 'handle_taken', message: 'Taken, try another.' })
  })

  it('refuses reserved handles and invalid ones', async () => {
    const h = makeHarness()
    const { token, signer } = await h.signIn()
    expect((await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer, { handle: 'admin' }) })).body.error.code).toBe('handle_taken')
    const bad = await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer, { handle: 'A!' }) })
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toMatch(/3 to 20 characters/)
  })

  it('one sign-up per address: a second prepare after activation is refused', async () => {
    const h = makeHarness()
    const u = await h.signUp('ana')
    const p = await h.json('POST', '/v1/onboarding/prepare', { token: u.token, body: body(u.signer, { handle: 'ana2' }) })
    expect(p.status).toBe(409)
    expect(p.body.error.code).toBe('already_signed_up')
  })

  it('refuses to sign up another address than the session one', async () => {
    const h = makeHarness()
    const a = await h.signIn()
    const b = await h.signIn()
    const p = await h.json('POST', '/v1/onboarding/prepare', { token: a.token, body: body(b.signer) })
    expect(p.status).toBe(403)
  })

  it('a pending sign-up can be restarted (new handle) and holds its handle for 30 minutes only', async () => {
    const h = makeHarness()
    const a = await h.signIn()
    expect((await h.json('POST', '/v1/onboarding/prepare', { token: a.token, body: body(a.signer, { handle: 'first' }) })).status).toBe(200)
    expect((await h.json('POST', '/v1/onboarding/prepare', { token: a.token, body: body(a.signer, { handle: 'second' }) })).status).toBe(200)
    expect((await h.json('GET', '/v1/directory/handle-available?handle=first')).body.available).toBe(true)
    expect((await h.json('GET', '/v1/directory/handle-available?handle=second')).body.available).toBe(false)
    h.clock.advance(31 * 60_000)
    const b = await h.signIn()
    expect((await h.json('POST', '/v1/onboarding/prepare', { token: b.token, body: body(b.signer, { handle: 'second' }) })).status).toBe(200)
  })

  it('a failed onboarding leaves the user pending and credits nothing', async () => {
    const h = makeHarness()
    const { token, signer } = await h.signIn()
    const p = await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer) })
    h.ledger.failNext('tecNO_PERMISSION')
    const s = await h.submit({ token, signer }, p.body)
    expect(s.status).toBe(200)
    expect(s.body.status).toBe('failed')
    expect(s.body.engineResult).toBe('tecNO_PERMISSION')
    expect((await h.json('GET', '/v1/me', { token })).status).toBe(403)
  })

  it('rate-limits prepares per user', async () => {
    const h = makeHarness({ env: { PREPARE_RATE_LIMIT_PER_MIN: '3' } })
    const { token, signer } = await h.signIn()
    for (let i = 0; i < 3; i++) expect((await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer) })).status).toBe(200)
    const r = await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer) })
    expect(r.status).toBe(429)
    expect(r.body.error.code).toBe('rate_limited')
    h.clock.advance(61_000)
    expect((await h.json('POST', '/v1/onboarding/prepare', { token, body: body(signer) })).status).toBe(200)
  })

  it('one sign-up per Privy user: a second address of the same Privy user is refused', async () => {
    const a = mockRawSigner()
    const b = mockRawSigner()
    const privy: PrivyVerifier = { verify: async (token, address) => ({ privyUserId: 'did:privy:same' + (address === a.address || address === b.address ? '' : token) }) }
    const h = makeHarness({ env: { SIGNER_MODE: 'privy', DEMO_MODE: '0' }, privy })
    const session = async (s: typeof a) =>
      (await h.json('POST', '/v1/auth/session', { body: { privyToken: 'privy-token-' + s.address, address: s.address, publicKey: s.publicKey } })).body.token as string
    const ta = await session(a)
    const p = await h.json('POST', '/v1/onboarding/prepare', { token: ta, body: body(a) })
    expect((await h.submit({ token: ta, signer: a }, p.body)).body.status).toBe('validated')
    const tb = await session(b)
    const r = await h.json('POST', '/v1/onboarding/prepare', { token: tb, body: body(b, { handle: 'other' }) })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('already_signed_up')
  })
})
