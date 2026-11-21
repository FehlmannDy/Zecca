import { describe, expect, it } from 'vitest'
import { decode, encode } from 'ripple-binary-codec'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { createMockEnvironment, mockCiphertext } from './index'

async function onboard(env: ReturnType<typeof createMockEnvironment>, credit = 5000, delegate = true) {
  const { ledger, keystore } = env
  const user = mockRawSigner()
  await ledger.ensureAccount(user.address)
  keystore.createUserElGamal(user.address)
  const tx = await ledger.buildOnboarding({
    address: user.address,
    publicKey: user.publicKey,
    holderKey: keystore.getElGamal({ user: user.address }),
    welcomeCreditMinor: credit,
    delegateMergeTo: delegate ? keystore.getWallet('relayer').address : undefined,
  })
  const signed = await user.sign(tx)
  const res = await ledger.submitUserSigned(signed.tx_blob)
  return { user, res, signed }
}

describe('mock ledger: accounts and sign-up', () => {
  it('system accounts exist and a new account is created once by the sponsor', async () => {
    const env = createMockEnvironment()
    expect(await env.ledger.accountExists(env.keystore.getWallet('pool').address)).toBe(true)
    const u = mockRawSigner()
    expect(await env.ledger.accountExists(u.address)).toBe(false)
    expect((await env.ledger.ensureAccount(u.address)).created).toBe(true)
    expect((await env.ledger.ensureAccount(u.address)).created).toBe(false)
    expect(await env.ledger.accountExists(u.address)).toBe(true)
  })

  it('the one-signature onboarding Batch validates and the welcome credit is spendable', async () => {
    const env = createMockEnvironment()
    const { user, res, signed } = await onboard(env)
    expect(res.validated).toBe(true)
    expect(res.engineResult).toBe('tesSUCCESS')
    expect(res.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(res.hash).not.toBe(signed.hash) // the sponsor co-signature changes the hash, like the real ledger
    expect(env.ledger.mock.balances(user.address)).toMatchObject({ spendableMinor: 5000, inboxMinor: 0 })
    const bal = await env.ledger.confidentialBalance(user.address, env.keystore.getElGamal({ user: user.address }))
    expect(bal).toEqual({ spendableMinor: 5000, inboxMinor: 0 })
  })

  it('omits the issuer payment when the welcome credit is 0', async () => {
    const env = createMockEnvironment()
    const { user, res } = await onboard(env, 0)
    expect(res.validated).toBe(true)
    expect(env.ledger.mock.balances(user.address).spendableMinor).toBe(0)
  })

  it('builders fill every field the adapter would otherwise autofill', async () => {
    const env = createMockEnvironment()
    const u = mockRawSigner()
    await env.ledger.ensureAccount(u.address)
    env.keystore.createUserElGamal(u.address)
    const tx = await env.ledger.buildOnboarding({ address: u.address, publicKey: u.publicKey, holderKey: env.keystore.getElGamal({ user: u.address }), welcomeCreditMinor: 100 })
    expect(tx.Fee).toBeTypeOf('string')
    expect(tx.Sequence).toBeTypeOf('number')
    expect(tx.LastLedgerSequence).toBe((await env.ledger.ledgerIndex()) + 150)
    expect(tx.Sponsor).toBe(env.keystore.getWallet('sponsor').address)
    expect(tx.SigningPubKey).toBe(u.publicKey)
    expect(() => encode(tx as never)).not.toThrow()
  })
})

describe('mock ledger: confidential sends', () => {
  it('a sponsored send moves the amount to the pool inbox; the pool decrypts it', async () => {
    const env = createMockEnvironment()
    const { user } = await onboard(env)
    const pool = env.keystore.getWallet('pool').address
    const tx = await env.ledger.buildSend({ from: user.address, to: pool, amountMinor: 1200, senderKey: env.keystore.getElGamal({ user: user.address }), sponsored: true, publicKey: user.publicKey })
    const seen: string[] = []
    env.ledger.watchAccount(pool, (e) => seen.push(e.hash))
    const res = await env.ledger.submitUserSigned((await user.sign(tx)).tx_blob)
    expect(res.engineResult).toBe('tesSUCCESS')
    expect(seen).toEqual([res.hash])
    expect(env.ledger.mock.balances(user.address).spendableMinor).toBe(3800)
    expect(env.ledger.mock.balances(pool).inboxMinor).toBe(1200)
    const ev = await env.ledger.txByHash(res.hash)
    expect(ev?.tx.TransactionType).toBe('ConfidentialMPTSend')
    const amount = await env.ledger.decryptAmount(String(ev!.tx.DestinationEncryptedAmount), env.keystore.getElGamal('pool').privateKey)
    expect(amount).toBe(1200)
    const recent = await env.ledger.accountTx(pool, 5)
    expect(recent[0].hash).toBe(res.hash)
  })

  it('the pool merges its inbox and pays out; the recipient merges through the relayer', async () => {
    const env = createMockEnvironment()
    const a = await onboard(env)
    const b = await onboard(env, 0)
    const pool = env.keystore.getWallet('pool').address
    await env.ledger.submitUserSigned((await a.user.sign(await env.ledger.buildSend({ from: a.user.address, to: pool, amountMinor: 1000, senderKey: env.keystore.getElGamal({ user: a.user.address }), sponsored: true, publicKey: a.user.publicKey }))).tx_blob)
    const poolKey = env.keystore.getElGamal('pool')
    expect((await env.ledger.submitAs('pool', await env.ledger.buildMergeInbox({ account: pool, sponsored: false }))).engineResult).toBe('tesSUCCESS')
    const pay = await env.ledger.submitAs('pool', await env.ledger.buildSend({ from: pool, to: b.user.address, amountMinor: 995, senderKey: poolKey, sponsored: false }))
    expect(pay.engineResult).toBe('tesSUCCESS')
    expect(env.ledger.mock.balances(b.user.address)).toMatchObject({ inboxMinor: 995, spendableMinor: 0 })
    const relayer = env.keystore.getWallet('relayer').address
    const merge = await env.ledger.submitAs('relayer', await env.ledger.buildMergeInbox({ account: b.user.address, sponsored: false, delegate: relayer }))
    expect(merge.engineResult).toBe('tesSUCCESS')
    expect(env.ledger.mock.balances(b.user.address)).toMatchObject({ inboxMinor: 0, spendableMinor: 995 })
    expect(env.ledger.mock.balances(pool)).toMatchObject({ spendableMinor: 5, inboxMinor: 0 })
  })

  it('a delegated merge without the DelegateSet is refused', async () => {
    const env = createMockEnvironment()
    const b = await onboard(env, 0, false)
    const relayer = env.keystore.getWallet('relayer').address
    const r = await env.ledger.submitAs('relayer', await env.ledger.buildMergeInbox({ account: b.user.address, sponsored: false, delegate: relayer }))
    expect(r.validated).toBe(false)
    expect(r.engineResult).toMatch(/^tec/)
  })

  it('refuses to build a send above the spendable balance', async () => {
    const env = createMockEnvironment()
    const { user } = await onboard(env, 100)
    await expect(env.ledger.buildSend({ from: user.address, to: env.keystore.getWallet('pool').address, amountMinor: 101, senderKey: env.keystore.getElGamal({ user: user.address }), sponsored: true })).rejects.toThrow(/insufficient/i)
  })

  it('mock ciphertexts decode to the amount and look different each time', async () => {
    const env = createMockEnvironment()
    const a = mockCiphertext(450)
    const b = mockCiphertext(450)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9A-F]{132}$/)
    expect(await env.ledger.decryptAmount(a, 'unused')).toBe(450)
  })
})

describe('mock ledger: MPT issuances (metals)', () => {
  it('MPTokenIssuanceCreate registers the issuer, returns mpt_issuance_id, and the issuer can pay an authorized holder', async () => {
    const env = createMockEnvironment()
    const issuer = env.keystore.getWallet('marketIssuer').address
    const r = await env.ledger.submitAs('marketIssuer', { TransactionType: 'MPTokenIssuanceCreate', Account: issuer, AssetScale: 0, Flags: 0x20 })
    expect(r.engineResult).toBe('tesSUCCESS')
    const id = String((r.meta as Record<string, unknown>).mpt_issuance_id)
    expect(id).toMatch(/^[0-9A-F]{48}$/)
    const { user } = await onboard(env, 0)
    const auth = await env.ledger.submitUserSigned((await user.sign(await env.ledger.prepareSponsored({ TransactionType: 'MPTokenAuthorize', Account: user.address, MPTokenIssuanceID: id }, { reserve: true, publicKey: user.publicKey }))).tx_blob)
    expect(auth.engineResult).toBe('tesSUCCESS')
    const pay = await env.ledger.submitAs('marketIssuer', { TransactionType: 'Payment', Account: issuer, Destination: user.address, Amount: { mpt_issuance_id: id, value: '1500' } })
    expect(pay.engineResult).toBe('tesSUCCESS')
    expect(await env.ledger.mptBalance(user.address, id)).toBe(1500)
  })
})

describe('mock ledger: seeded demo shop', () => {
  it('the demo shop merchant lets the relayer merge its inbox, like a merchant signed up through the app', async () => {
    const env = createMockEnvironment()
    const shop = env.keystore.getWallet('demoShop').address
    const relayer = env.keystore.getWallet('relayer').address
    const r = await env.ledger.submitAs('relayer', await env.ledger.buildMergeInbox({ account: shop, sponsored: false, delegate: relayer }))
    expect(r.engineResult).toBe('tesSUCCESS')
  })
})

describe('mock ledger: what a node refuses', () => {
  it('a tampered blob fails signature verification', async () => {
    const env = createMockEnvironment()
    const { user } = await onboard(env)
    const tx = await env.ledger.buildSend({ from: user.address, to: env.keystore.getWallet('pool').address, amountMinor: 100, senderKey: env.keystore.getElGamal({ user: user.address }), sponsored: true })
    const signed = decode((await user.sign(tx)).tx_blob) as Record<string, unknown>
    signed.DestinationEncryptedAmount = mockCiphertext(1)
    const r = await env.ledger.submitUserSigned(encode(signed as never))
    expect(r.validated).toBe(false)
    expect(env.ledger.mock.balances(user.address).spendableMinor).toBe(5000)
  })

  it('refuses a blob sponsored by someone else, a stale sequence and a passed LastLedgerSequence', async () => {
    const env = createMockEnvironment()
    const { user } = await onboard(env)
    const pool = env.keystore.getWallet('pool').address
    const key = env.keystore.getElGamal({ user: user.address })
    const tx = await env.ledger.buildSend({ from: user.address, to: pool, amountMinor: 100, senderKey: key, sponsored: true, publicKey: user.publicKey })
    await expect(env.ledger.submitUserSigned((await user.sign({ ...tx, Sponsor: pool })).tx_blob)).rejects.toThrow(/not sponsored by this backend/)
    const first = await env.ledger.submitUserSigned((await user.sign(tx)).tx_blob)
    expect(first.validated).toBe(true)
    const replay = await env.ledger.submitUserSigned((await user.sign(tx)).tx_blob)
    expect(replay.validated).toBe(false)
    expect(replay.engineResult).toBe('tefPAST_SEQ')
    const late = await env.ledger.buildSend({ from: user.address, to: pool, amountMinor: 100, senderKey: key, sponsored: true })
    env.ledger.mock.advance(151)
    const r = await env.ledger.submitUserSigned((await user.sign(late)).tx_blob)
    expect(r.engineResult).toBe('tefMAX_LEDGER')
  })

  it('failNext makes the next submission fail with the given engine result', async () => {
    const env = createMockEnvironment()
    env.ledger.mock.failNext('tecINSUFFICIENT_FUNDS')
    const r = await env.ledger.submitAs('pool', await env.ledger.buildMergeInbox({ account: env.keystore.getWallet('pool').address, sponsored: false }))
    expect(r).toMatchObject({ validated: false, engineResult: 'tecINSUFFICIENT_FUNDS' })
  })

  it('public MPT payments: issuer mints to the pool, the pool converts to confidential', async () => {
    const env = createMockEnvironment()
    const pool = env.keystore.getWallet('pool').address
    const issuer = env.keystore.getWallet('issuer').address
    const pay = await env.ledger.submitAs('issuer', { TransactionType: 'Payment', Account: issuer, Destination: pool, Amount: { mpt_issuance_id: env.ledger.issuanceId, value: '4000' } })
    expect(pay.engineResult).toBe('tesSUCCESS')
    expect(await env.ledger.mptBalance(pool, env.ledger.issuanceId)).toBe(4000)
    const conv = await env.ledger.submitAs('pool', await env.ledger.buildConvert({ account: pool, amountMinor: 4000, holderKey: env.keystore.getElGamal('pool') }))
    expect(conv.engineResult).toBe('tesSUCCESS')
    expect(env.ledger.mock.balances(pool)).toMatchObject({ publicMinor: 0, inboxMinor: 4000 })
  })

  it('submitAs is serialised per account', async () => {
    const env = createMockEnvironment({ validationDelayMs: 5 })
    const pool = env.keystore.getWallet('pool').address
    // submitAs fills a missing Sequence inside the per-account queue, so concurrent callers do not collide
    const strip = async () => {
      const { Sequence: _s, ...tx } = await env.ledger.buildMergeInbox({ account: pool, sponsored: false })
      return tx as typeof tx & { TransactionType: string; Account: string }
    }
    const results = await Promise.all([1, 2, 3].map(async () => env.ledger.submitAs('pool', await strip())))
    expect(results.map((r) => r.engineResult)).toEqual(['tesSUCCESS', 'tesSUCCESS', 'tesSUCCESS'])
  })
})
