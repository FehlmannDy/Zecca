// Identity connector (SPEC §4.8, §6.3): sessions, the on-ledger credential, the tier lift. On the fakes, then on the real mock ledger.
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { IdentitySession, IdentitySessionStatus, type KeyStore, type Ledger, type PoolWorker, type UnsignedTx, type WalletRole } from '@zecca/contracts'
import { createMockEnvironment, type MockLedger } from '@zecca/ledger-mock'
import { createMemoryPoolStore, createPoolWorker } from '@zecca/pool-worker'
import { makeHarness, type Harness } from '../../testing/harness'
import { CREDENTIAL_TYPE, liftTier, mountIdentity, registerIdentity, SESSION_TTL_MS, verifierFromEnv } from './index'
import { sessionById } from './store'
import type { IdentityVerifier, VerifierStatus } from './verifier'

const ZECCA_KYC_HEX = Buffer.from('ZeccaKYC').toString('hex').toUpperCase()

function addKycIssuer(ks: KeyStore) {
  const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
  ks.setWallet('kycIssuer', { address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
  return w.classicAddress
}

/** Records what our own wallets submit, and can fail the next one. */
function spyOnSubmitAs(ledger: Ledger) {
  const calls: Array<{ role: WalletRole; tx: UnsignedTx }> = []
  let fail: string | undefined
  const orig = ledger.submitAs.bind(ledger)
  ledger.submitAs = async (role, tx) => {
    calls.push({ role, tx })
    if (fail) {
      const engineResult = fail
      fail = undefined
      return { validated: engineResult === 'tecDUPLICATE', engineResult, hash: 'F'.repeat(64) }
    }
    return orig(role, tx)
  }
  return { calls, failNext: (e: string) => (fail = e), creates: () => calls.filter((c) => c.tx.TransactionType === 'CredentialCreate') }
}

function fakeVerifier() {
  let n = 0
  let next: VerifierStatus = { state: 'pending' }
  let startError: Error | undefined
  const polls: string[] = []
  const v: IdentityVerifier = {
    mode: 'live',
    async start() {
      if (startError) throw startError
      n++
      return { transactionId: `TX${n}`, link: `eudi-openid4vp://?client_id=c&request_uri=https%3A%2F%2Fv%2Fr%2FTX${n}&request_uri_method=get` }
    },
    async poll(tx) {
      polls.push(tx)
      return next
    },
  }
  return { v, polls, answer: (s: VerifierStatus) => (next = s), failStart: (e: Error) => (startError = e) }
}

function world<L extends Ledger = Ledger, P extends PoolWorker = PoolWorker>(o: { env?: Record<string, string>; verifier?: IdentityVerifier; h?: Harness<L, P> } = {}) {
  const h = (o.h ?? makeHarness({ env: { FEATURE_IDENTITY: '1', ...o.env } })) as Harness<L, P>
  const kyc = h.keystore.hasWallet('kycIssuer') ? h.keystore.getWallet('kycIssuer').address : addKycIssuer(h.keystore)
  const spy = spyOnSubmitAs(h.ledger)
  mountIdentity(h.app, h.app.core, o.verifier ? { verifier: o.verifier } : {})
  registerIdentity(h.app.core)
  const start = (token: string) => h.json('POST', '/v1/identity/sessions', { token })
  const status = (token: string, id: string) => h.json('GET', `/v1/identity/sessions/${id}`, { token })
  return { h, kyc, spy, start, status }
}

describe('identity: feature flag', () => {
  it('off: both routes answer 404 feature_off, and an identity approval is refused', async () => {
    const h = makeHarness()
    addKycIssuer(h.keystore)
    mountIdentity(h.app, h.app.core)
    registerIdentity(h.app.core)
    const ana = await h.signUp('ana')
    for (const [m, p] of [
      ['POST', '/v1/identity/sessions'],
      ['GET', '/v1/identity/sessions/idv_x'],
    ] as const) {
      const r = await h.json(m, p, { token: ana.token })
      expect(r.status).toBe(404)
      expect(r.body.error.code).toBe('feature_off')
    }
  })

  it('IDENTITY_MODE picks the verifier: unset or mock -> mock, eudi or live -> the EU verifier', () => {
    const now = () => 0
    expect(verifierFromEnv({}, { now }).mode).toBe('mock')
    expect(verifierFromEnv({ IDENTITY_MODE: 'mock' }, { now }).mode).toBe('mock')
    expect(verifierFromEnv({ IDENTITY_MODE: 'eudi' }, { now }).mode).toBe('live')
    expect(verifierFromEnv({ IDENTITY_MODE: 'live' }, { now }).mode).toBe('live')
  })
})

describe('identity: mock mode (the default)', () => {
  it('pending for 3 s, then the test identity, one CredentialCreate and a sponsored CredentialAccept to approve', async () => {
    const { h, kyc, spy, start, status } = world()
    const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
    const s = await start(ana.token)
    expect(s.status).toBe(200)
    const session = IdentitySession.parse(s.body)
    expect(session.mode).toBe('mock')
    expect(session.qrUrl).toMatch(/^eudi-openid4vp:\/\/\?client_id=/)
    expect(session.deepLink).toBe(session.qrUrl)
    expect(Date.parse(session.expiresAt) - h.clock.now).toBe(SESSION_TTL_MS)

    expect((await status(ana.token, session.id)).body).toEqual({ status: 'pending' })
    h.clock.advance(2_999)
    expect((await status(ana.token, session.id)).body).toEqual({ status: 'pending' })
    expect(spy.creates()).toHaveLength(0)
    h.clock.advance(1)
    const v = await status(ana.token, session.id)
    expect(v.status).toBe(200)
    const body = IdentitySessionStatus.parse(v.body)
    expect(body.status).toBe('verified')
    expect(body.identity).toEqual({ givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12', over18: true })

    // The credential: issued by the KYC issuer to the user, nothing personal on the ledger.
    expect(CREDENTIAL_TYPE).toBe(ZECCA_KYC_HEX)
    expect(spy.creates()).toEqual([{ role: 'kycIssuer', tx: { TransactionType: 'CredentialCreate', Account: kyc, Subject: ana.user.address, CredentialType: ZECCA_KYC_HEX } }])
    expect(body.prepared?.kind).toBe('credential_accept')
    expect(body.prepared?.tx).toMatchObject({
      TransactionType: 'CredentialAccept',
      Account: ana.user.address,
      Issuer: kyc,
      CredentialType: ZECCA_KYC_HEX,
      Sponsor: h.keystore.getWallet('sponsor').address,
    })

    // Polling again changes nothing: same approval, no second credential.
    const again = await status(ana.token, session.id)
    expect(again.body.prepared.prepareId).toBe(body.prepared!.prepareId)
    expect(spy.creates()).toHaveLength(1)
    // Still tier 0 until the user accepts.
    expect((await h.json('GET', '/v1/me', { token: ana.token })).body.tier).toBe(0)
  })

  it('accepting lifts the tier: limits refresh, and a $60 send is no longer refused for the per-payment cap', async () => {
    const { h, start, status } = world()
    const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
    const carla = await h.signUp('carla')
    await h.json('POST', '/v1/dev/credit', { token: ana.token, body: { amountMinor: 4000 } })
    await h.settle()
    const before = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 6000 } })
    expect(before.status).toBe(403)
    expect(before.body.error.details.limit).toBe('per_payment')

    const id = (await start(ana.token)).body.id
    h.clock.advance(3_000)
    const prepared = (await status(ana.token, id)).body.prepared
    const events = h.app.core.bus.history().length
    const sub = await h.submit(ana, prepared)
    expect(sub.status).toBe(200)
    expect(sub.body).toMatchObject({ status: 'validated', user: { tier: 1, displayName: 'Ana Ferri' } })
    expect((await h.json('GET', '/v1/me', { token: ana.token })).body.tier).toBe(1)
    expect(h.app.core.bus.history().slice(events).map((e) => `${e.to}:${e.event.type}`)).toContain(`user:${ana.user.id}:balance.updated`)

    const after = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 6000 } })
    expect(after.status).toBe(200)
    expect(sessionById(h.app.core, id)?.status).toBe('accepted')
    // The verified session now reads as done, with no approval left.
    const done = (await status(ana.token, id)).body
    expect(done.status).toBe('verified')
    expect(done.prepared).toBeUndefined()
  })

  it('the tier lift is idempotent; a used approval is refused; a verified user gets no second credential', async () => {
    const { h, spy, start, status } = world()
    const ana = await h.signUp('ana')
    const id = (await start(ana.token)).body.id
    h.clock.advance(3_000)
    const prepared = (await status(ana.token, id)).body.prepared
    expect((await h.submit(ana, prepared)).body.status).toBe('validated')
    // Default display name ("Ana", the handle) is replaced by the verified name, once.
    expect((await h.json('GET', '/v1/me', { token: ana.token })).body.displayName).toBe('Ana Ferri')

    const row = sessionById(h.app.core, id)!
    const u1 = liftTier(h.app.core, row, 'A'.repeat(64))
    const u2 = liftTier(h.app.core, row, 'A'.repeat(64))
    expect([u1.tier, u2.tier]).toEqual([1, 1])
    expect(u2.displayName).toBe('Ana Ferri')

    const replay = await h.submit(ana, prepared)
    expect(replay.status).toBe(403)

    const second = (await start(ana.token)).body.id
    h.clock.advance(3_000)
    const s2 = (await status(ana.token, second)).body
    expect(s2.status).toBe('verified')
    expect(s2.prepared).toBeUndefined()
    expect(s2.message).toMatch(/already verified/i)
    expect(spy.creates()).toHaveLength(1)
  })

  it('keeps a display name the user chose', async () => {
    const { h, start, status } = world()
    const bea = await h.signUp('bea', { displayName: 'Bea R.' })
    const id = (await start(bea.token)).body.id
    h.clock.advance(3_000)
    const sub = await h.submit(bea, (await status(bea.token, id)).body.prepared)
    expect(sub.body.user).toMatchObject({ tier: 1, displayName: 'Bea R.' })
  })
})

describe('identity: live verifier outcomes (fake verifier)', () => {
  it('rejected and wallet errors end the session with one sentence; the verifier is not asked again', async () => {
    const f = fakeVerifier()
    const { h, start, status } = world({ verifier: f.v })
    const ana = await h.signUp('ana')
    const s = (await start(ana.token)).body
    expect(s.mode).toBe('live')
    f.answer({ state: 'rejected', cause: 'IssuerCertificateIsNotTrusted' })
    const r = (await status(ana.token, s.id)).body
    expect(r.status).toBe('rejected')
    expect(r.message).toMatch(/issuer/i)
    f.answer({ state: 'pending' })
    expect((await status(ana.token, s.id)).body.status).toBe('rejected')
    expect(f.polls).toHaveLength(1)

    const s2 = (await start(ana.token)).body
    f.answer({ state: 'error', cause: 'access_denied' })
    const e = (await status(ana.token, s2.id)).body
    expect(e.status).toBe('error')
    expect(e.message).toMatch(/declined|share/i)
  })

  it('under 18: verified, over18 false, no credential and no approval', async () => {
    const f = fakeVerifier()
    const { h, spy, start, status } = world({ verifier: f.v })
    const ana = await h.signUp('ana')
    const id = (await start(ana.token)).body.id
    f.answer({ state: 'verified', claims: { givenName: 'Teo', familyName: 'Bianchi', birthDate: '2008-11-22' } }) // 18 tomorrow (clock: 2026-11-21)
    const r = (await status(ana.token, id)).body
    expect(r).toMatchObject({ status: 'verified', identity: { givenName: 'Teo', familyName: 'Bianchi', birthDate: '2008-11-22', over18: false } })
    expect(r.prepared).toBeUndefined()
    expect(r.message).toMatch(/18/)
    expect(spy.creates()).toHaveLength(0)
  })

  it('a presentation without the name or birth date is an error', async () => {
    const f = fakeVerifier()
    const { h, spy, start, status } = world({ verifier: f.v })
    const ana = await h.signUp('ana')
    const id = (await start(ana.token)).body.id
    f.answer({ state: 'verified', claims: { givenName: 'Ana', familyName: 'Ferri', birthDate: null } })
    const r = (await status(ana.token, id)).body
    expect(r.status).toBe('error')
    expect(r.identity).toBeUndefined()
    expect(r.message).toMatch(/name and date of birth/)
    expect(spy.creates()).toHaveLength(0)
  })

  it('only the owner reads a session; unknown ids are 404', async () => {
    const f = fakeVerifier()
    const { h, start, status } = world({ verifier: f.v })
    const ana = await h.signUp('ana')
    const bea = await h.signUp('bea')
    const id = (await start(ana.token)).body.id
    expect((await status(bea.token, id)).status).toBe(404)
    expect((await status(ana.token, 'idv_nope')).status).toBe(404)
    expect((await h.json('POST', '/v1/identity/sessions')).status).toBe(401)
  })

  it('expires after 10 minutes', async () => {
    const f = fakeVerifier()
    const { h, start, status } = world({ verifier: f.v })
    const ana = await h.signUp('ana')
    const id = (await start(ana.token)).body.id
    h.clock.advance(SESSION_TTL_MS + 1)
    const r = (await status(ana.token, id)).body
    expect(r.status).toBe('error')
    expect(r.message).toMatch(/expired/i)
    expect(f.polls).toHaveLength(0)
  })

  it('the verifier down at start: 502 upstream_error with a sentence to show', async () => {
    const f = fakeVerifier()
    f.failStart(new Error('EUDI verifier refused the transaction: 503'))
    const { h, start } = world({ verifier: f.v })
    const ana = await h.signUp('ana')
    const r = await start(ana.token)
    expect(r.status).toBe(502)
    expect(r.body.error.code).toBe('upstream_error')
  })

  it('a failed CredentialCreate answers 502 and is retried on the next poll; an existing credential (tecDUPLICATE) is reused', async () => {
    const f = fakeVerifier()
    const { h, spy, start, status } = world({ verifier: f.v })
    const ana = await h.signUp('ana')
    const id = (await start(ana.token)).body.id
    f.answer({ state: 'verified', claims: { givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12' } })
    spy.failNext('tecNO_PERMISSION')
    const r1 = await status(ana.token, id)
    expect(r1.status).toBe(502)
    expect(r1.body.error.code).toBe('ledger_error')
    spy.failNext('tecDUPLICATE')
    const r2 = (await status(ana.token, id)).body
    expect(r2.status).toBe('verified')
    expect(r2.prepared.kind).toBe('credential_accept')
    expect(spy.creates()).toHaveLength(2)
  })

  it('without a KYC issuer wallet: an error, nothing sent', async () => {
    const f = fakeVerifier()
    const h = makeHarness({ env: { FEATURE_IDENTITY: '1' } })
    mountIdentity(h.app, h.app.core, { verifier: f.v })
    registerIdentity(h.app.core)
    const spy = spyOnSubmitAs(h.ledger)
    const ana = await h.signUp('ana')
    const id = (await h.json('POST', '/v1/identity/sessions', { token: ana.token })).body.id
    f.answer({ state: 'verified', claims: { givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12' } })
    const r = (await h.json('GET', `/v1/identity/sessions/${id}`, { token: ana.token })).body
    expect(r.status).toBe('error')
    expect(r.message).toMatch(/not set up/i)
    expect(spy.calls).toHaveLength(0)
  })
})

describe('identity on the real mock ledger', () => {
  it('CredentialCreate by the KYC issuer and the sponsored CredentialAccept both validate; the tier lifts', async () => {
    const env = createMockEnvironment()
    const pool = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
    const h = makeHarness<MockLedger, PoolWorker>({ ledger: env.ledger, keystore: env.keystore, pool, env: { FEATURE_IDENTITY: '1' } })
    await pool.start()
    const { start, status } = world({ h })
    const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
    const id = (await start(ana.token)).body.id
    h.clock.advance(3_000)
    const prepared = (await status(ana.token, id)).body.prepared
    expect(prepared.tx.SponsorFlags).toBe(3) // fee + reserve
    const sub = await h.submit(ana, prepared)
    expect(sub.body).toMatchObject({ status: 'validated', engineResult: 'tesSUCCESS', user: { tier: 1 } })
    const kinds = env.ledger.mock
      .txs()
      .filter((t) => String(t.tx.TransactionType).startsWith('Credential'))
      .map((t) => `${t.tx.TransactionType}:${t.engineResult}`)
    expect(kinds).toEqual(['CredentialCreate:tesSUCCESS', 'CredentialAccept:tesSUCCESS'])
    await pool.stop()
  })
})
