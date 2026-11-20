import { describe, expect, it } from 'vitest'
import * as rk from 'ripple-keypairs'
import { encryptAmount, generateBlindingFactor } from '@xrplf/mpt-crypto'
import { ActivityPage, DisclosureResponse, Statement, type Activity } from '@zecca/contracts'
import { createFakePool, type FakeLedger, type FakePool } from '../../testing/fakes'
import { eventually, makeHarness, type Harness, type TestUser } from '../../testing/harness'
import { mountProofs, registerProofs } from './index'
import { verifyStatement } from './statement'
import { verifyAmountProof } from './amount-proof'

const ON = { FEATURE_PROOFS: '1' }

function setup(o: { env?: Record<string, string>; pool?: FakePool } = {}) {
  const h = makeHarness<FakeLedger, FakePool>({ env: { ...ON, ...o.env }, pool: o.pool })
  mountProofs(h.app, h.app.core)
  registerProofs(h.app.core)
  const seed = rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })
  const kycAddress = rk.deriveAddress(rk.deriveKeypair(seed).publicKey)
  h.keystore.setWallet('kycIssuer', { address: kycAddress, seed, algorithm: 'ecdsa-secp256k1' })
  return { h, kycAddress }
}

async function paid(h: Harness<FakeLedger, FakePool>, from: TestUser, to: TestUser, amountMinor: number) {
  const t = await h.json('POST', '/v1/transfers', { token: from.token, body: { to: to.user.id, amountMinor } })
  const s = await h.submit(from, t.body.prepared)
  await eventually(async () => expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: from.token })).body.status).toBe('paid_out'))
  await h.app.core.idle()
  return { intentId: t.body.intent.id as string, depositHash: s.body.hash as string, prepared: t.body.prepared }
}
const activity = async (h: Harness<FakeLedger, FakePool>, u: TestUser): Promise<Activity[]> =>
  ActivityPage.parse((await h.json('GET', '/v1/activity', { token: u.token })).body).items
const count = (h: Harness<FakeLedger, FakePool>) => (h.app.core.db.prepare('SELECT COUNT(*) AS n FROM proof_statements').get() as { n: number }).n

describe('disclosures behind FEATURE_PROOFS', () => {
  it('with the flag off both routes answer 404 feature_off', async () => {
    const h = makeHarness()
    mountProofs(h.app, h.app.core)
    registerProofs(h.app.core)
    const ana = await h.signUp('ana')
    const post = await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: ['act_x'] } })
    expect(post).toMatchObject({ status: 404, body: { error: { code: 'feature_off' } } })
    expect(await h.json('GET', '/v1/disclosures/stm_x')).toMatchObject({ status: 404, body: { error: { code: 'feature_off' } } })
  })
})

describe('POST /v1/disclosures and GET /v1/disclosures/:id', () => {
  it('builds a signed statement of the caller own activity, served publicly by id', async () => {
    const { h, kycAddress } = setup()
    const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
    const carla = await h.signUp('carla', { displayName: 'Carla Rossi' })
    const p = await paid(h, ana, carla, 1200)
    const items = await activity(h, ana)
    const out = items.find((a) => a.kind === 'p2p')!
    const welcome = items.find((a) => a.kind === 'welcome')!

    const res = await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: [out.id, welcome.id, out.id] } })
    expect(res.status).toBe(200)
    const { id, url } = DisclosureResponse.parse(res.body)
    expect(url).toBe(`http://localhost:3100/statement/${id}`)

    const got = await h.json('GET', `/v1/disclosures/${id}`)
    expect(got.status).toBe(200)
    const s = Statement.parse(got.body)
    expect(s).toMatchObject({ id, holder: { displayName: 'Ana Ferri', handle: 'ana', address: ana.user.address }, attestation: 'zecca' })
    // Oldest first, one line per activity item.
    expect(s.lines.map((l) => l.activityId)).toEqual([welcome.id, out.id])
    expect(s.lines[1]).toMatchObject({
      counterparty: 'Carla Rossi',
      direction: 'out',
      amountMinor: 1200,
      feeMinor: 0,
      depositTxHash: p.depositHash,
      payoutTxHash: out.ledger.payoutTxHash,
      network: 'devnet',
      date: out.at,
    })
    expect(s.lines[0]).toMatchObject({ counterparty: 'Zecca demo credit', direction: 'in', amountMinor: 5000 })
    // Mock ledger ciphertexts are not real: no amount proof, the amounts are attested by Zecca.
    expect(s.lines.every((l) => l.amountProof === undefined)).toBe(true)
    expect(verifyStatement(s)).toEqual({ ok: true, signerAddress: kycAddress })
  })

  it("refuses another user's activity id, and an unknown one, without storing anything", async () => {
    const { h } = setup()
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla')
    await paid(h, ana, carla, 700)
    const carlas = await activity(h, carla)
    const anas = await activity(h, ana)
    const r1 = await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: [anas[0].id, carlas[0].id] } })
    expect(r1).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    const r2 = await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: ['act_doesnotexist'] } })
    expect(r2.status).toBe(404)
    expect(count(h)).toBe(0)
  })

  it('validates the body against the contract and needs a session', async () => {
    const { h } = setup()
    const ana = await h.signUp('ana')
    expect((await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: [] } })).body.error.code).toBe('bad_request')
    expect((await h.json('POST', '/v1/disclosures', { token: ana.token, body: {} })).status).toBe(400)
    expect((await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: [42] } })).status).toBe(400)
    const many = Array.from({ length: 201 }, (_, k) => `act_${k}`)
    expect((await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: many } })).status).toBe(400)
    expect((await h.call('POST', '/v1/disclosures', { token: ana.token, body: 'not json' })).status).toBe(400)
    expect((await h.json('POST', '/v1/disclosures', { body: { activityIds: ['act_1'] } })).status).toBe(401)
    expect(await h.json('GET', '/v1/disclosures/stm_unknown')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
  })

  it('only completed payments go on a statement', async () => {
    const pool = createFakePool({ auto: false })
    const { h } = setup({ pool })
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla')
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 300 } })
    await h.submit(ana, t.body.prepared)
    const pending = (await activity(h, ana)).find((a) => a.kind === 'p2p')!
    expect(pending.status).toBe('pending')
    const r = await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: [pending.id] } })
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } })
  })

  it('says so when the statement key is missing', async () => {
    const h = makeHarness({ env: ON })
    mountProofs(h.app, h.app.core)
    const ana = await h.signUp('ana')
    const w = (await activity(h, ana))[0]
    const r = await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: [w.id] } })
    expect(r).toMatchObject({ status: 500, body: { error: { code: 'internal' } } })
  })

  it('with real ciphertexts on the ledger each line carries an amount proof anyone can check', async () => {
    const { h } = setup()
    const kp = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
    const poolKey = { publicKey: kp.publicKey, privateKey: kp.privateKey.slice(2) }
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla')
    const p = await paid(h, ana, carla, 1200)
    h.keystore.setElGamal('pool', poolKey)
    const ct = await encryptAmount(1200n, poolKey.publicKey, await generateBlindingFactor())
    const poolAddress = h.keystore.getWallet('pool').address
    h.ledger.txByHash = async (hash: string) =>
      hash === p.depositHash
        ? { hash, ledgerIndex: 5, validated: true, engineResult: 'tesSUCCESS', tx: { TransactionType: 'ConfidentialMPTSend', Account: ana.user.address, Destination: poolAddress, DestinationEncryptedAmount: ct } }
        : null
    const out = (await activity(h, ana)).find((a) => a.kind === 'p2p')!
    const r = await h.json('POST', '/v1/disclosures', { token: ana.token, body: { activityIds: [out.id] } })
    const s = Statement.parse((await h.json('GET', `/v1/disclosures/${r.body.id}`)).body)
    expect(s.attestation).toBe('proof')
    expect(await verifyAmountProof({ amountProof: s.lines[0].amountProof!, amountMinor: 1200, ciphertext: ct, publicKey: poolKey.publicKey })).toBe(true)
    expect(verifyStatement(s).ok).toBe(true)
  })
})
