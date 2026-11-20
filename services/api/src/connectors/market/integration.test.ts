// The market on the real mock ledger (@zecca/ledger-mock) and the real pool worker, in process: the metal issuances
// are created at start-up (mock only), a verified user buys gold (two approvals the first time) and sells part of it.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decode } from 'ripple-binary-codec'
import { createMockEnvironment, type MockLedger } from '@zecca/ledger-mock'
import { createMemoryPoolStore, createPoolWorker } from '@zecca/pool-worker'
import type { PoolWorker } from '@zecca/contracts'
import { eventually, makeHarness } from '../../testing/harness'
import { mountMarket, registerMarket } from './index'
import { issuanceIdFrom, metalIssuanceId } from './metals'

/**
 * Test stand-in for the metal side only, while @zecca/ledger-mock cannot issue MPTs: public payments of a metal
 * (issuer -> holder mints, holder -> issuer burns). Everything else, the dollars included, is the real mock.
 */
function metalBook(ledger: MockLedger, issuer: string) {
  const cmpt = ledger.issuanceId.toUpperCase()
  const bal = new Map<string, number>()
  const k = (a: string, iss: string) => `${a}|${iss.toUpperCase()}`
  const isMetal = (tx: Record<string, any>) => tx.TransactionType === 'Payment' && typeof tx.Amount === 'object' && String(tx.Amount.mpt_issuance_id).toUpperCase() !== cmpt
  const apply = (tx: Record<string, any>) => {
    const iss = String(tx.Amount.mpt_issuance_id)
    const mg = Number(tx.Amount.value)
    const hash = randomBytes(32).toString('hex').toUpperCase()
    if (tx.Account !== issuer) {
      if ((bal.get(k(tx.Account, iss)) ?? 0) < mg) return { validated: true, engineResult: 'tecINSUFFICIENT_FUNDS', hash }
      bal.set(k(tx.Account, iss), (bal.get(k(tx.Account, iss)) ?? 0) - mg)
    }
    if (tx.Destination !== issuer) bal.set(k(tx.Destination, iss), (bal.get(k(tx.Destination, iss)) ?? 0) + mg)
    return { validated: true, engineResult: 'tesSUCCESS', hash }
  }
  const submitAs = ledger.submitAs.bind(ledger)
  ledger.submitAs = async (role, tx) => (isMetal(tx) ? apply(tx) : submitAs(role, tx))
  const submitUserSigned = ledger.submitUserSigned.bind(ledger)
  ledger.submitUserSigned = async (blob) => {
    const tx = decode(blob) as Record<string, any>
    return isMetal(tx) ? apply(tx) : submitUserSigned(blob)
  }
  const mptBalance = ledger.mptBalance.bind(ledger)
  ledger.mptBalance = async (a, iss) => (iss.toUpperCase() === cmpt ? mptBalance(a, iss) : (bal.get(k(a, iss)) ?? 0))
}

function realWorld(o: { metalBook?: boolean } = {}) {
  const env = createMockEnvironment()
  if (o.metalBook) metalBook(env.ledger, env.keystore.getWallet('marketIssuer').address)
  const pool = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
  const h = makeHarness<MockLedger, PoolWorker>({ ledger: env.ledger, keystore: env.keystore, pool, env: { FEATURE_MARKET: '1' } })
  mountMarket(h.app, h.app.core)
  registerMarket(h.app.core, { retryMs: 1 })
  return { h, env, pool }
}

// Needs @zecca/ledger-mock to register the issuer of an MPTokenIssuanceCreate (contract request in the market task):
// until then the mock refuses the issuer's metal payment (tecINSUFFICIENT_FUNDS) and the purchase ends in 'failed'.
const mockIssuesMpts = (() => {
  const env = createMockEnvironment()
  return env.ledger.submitAs('marketIssuer', { TransactionType: 'MPTokenIssuanceCreate', Account: env.keystore.getWallet('marketIssuer').address }).then(async (r) => {
    const seq = (await env.ledger.txByHash(r.hash))?.tx.Sequence as number
    const user = env.keystore.getWallet('demoShop').address
    const iss = issuanceIdFrom(seq, env.keystore.getWallet('marketIssuer').address)
    await env.ledger.submitAs('demoShop', { TransactionType: 'MPTokenAuthorize', Account: user, MPTokenIssuanceID: iss })
    const pay = await env.ledger.submitAs('marketIssuer', { TransactionType: 'Payment', Account: env.keystore.getWallet('marketIssuer').address, Destination: user, Amount: { mpt_issuance_id: iss, value: '1' } })
    return pay.engineResult === 'tesSUCCESS'
  })
})()

describe('market integration: mock ledger + pool worker', async () => {
  const supported = await mockIssuesMpts
  it(`buys gold (authorize, then deposit) and sells part of it; books and ledger agree${supported ? '' : ' (metal side stood in)'}`, async () => {
    const { h, env, pool } = realWorld({ metalBook: !supported })
    await pool.start()
    await h.app.core.idle()
    const xau = metalIssuanceId(h.keystore, 'XAU')!
    expect(xau).toMatch(/^[0-9A-F]{48}$/)
    const ana = await h.signUp('ana')
    expect((await h.json('POST', '/v1/dev/market/tier', { token: ana.token })).body.tier).toBe(1)
    const bal = async () => (await h.json('GET', '/v1/balance', { token: ana.token })).body

    let o = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 1000 } })
    expect(o.body.prepared.kind).toBe('market_authorize')
    expect((await h.submit(ana, o.body.prepared)).body.status).toBe('validated')
    o = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 1000 } })
    expect(o.body.prepared.kind).toBe('send')
    expect((await h.submit(ana, o.body.prepared)).body.status).toBe('validated')
    await eventually(async () => expect((await h.json('GET', `/v1/transfers/${o.body.intent.id}`, { token: ana.token })).body.status).toBe('paid_out'), 5000)
    const mg = o.body.quote.quantityMg
    expect(await env.ledger.mptBalance(ana.user.address, xau)).toBe(mg)
    expect(await bal()).toMatchObject({ availableMinor: 5000 - o.body.quote.amountMinor, pendingMinor: 0 })
    expect(env.ledger.mock.balances(ana.user.address).spendableMinor).toBe(5000 - o.body.quote.amountMinor)

    const s = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'sell', quantityMg: 50 } })
    expect((await h.submit(ana, s.body.prepared)).body.status).toBe('validated')
    await eventually(async () => expect((await bal()).pendingMinor).toBe(0), 5000)
    const after = 5000 - o.body.quote.amountMinor + s.body.quote.amountMinor
    expect(await bal()).toMatchObject({ availableMinor: after })
    expect(env.ledger.mock.balances(ana.user.address)).toMatchObject({ spendableMinor: after, inboxMinor: 0 })
    expect(await env.ledger.mptBalance(ana.user.address, xau)).toBe(mg - 50)
    await pool.stop()
  })

  it.runIf(!supported)('(waiting for ledger-mock to issue MPTs: see the contract request) the metal issuances are still created and recorded', async () => {
    const { h } = realWorld()
    await h.app.core.idle()
    for (const s of ['XAU', 'XAG', 'XPD'] as const) expect(metalIssuanceId(h.keystore, s)).toMatch(/^[0-9A-F]{48}$/)
  })

  it.runIf(!supported)('a mock ledger that cannot pay metals refuses purchases before any money moves', async () => {
    const { h } = realWorld()
    await h.app.core.idle()
    const ana = await h.signUp('ana')
    await h.json('POST', '/v1/dev/market/tier', { token: ana.token })
    const before = (await h.json('GET', '/v1/balance', { token: ana.token })).body
    const o = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 1000 } })
    expect(o.status).toBe(503)
    expect(o.body.error.message).toBe("Metals aren't available right now. Try again later.")
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body).toEqual(before)
    expect((await h.json('GET', '/v1/market/assets', { token: ana.token })).status).toBe(200) // prices still show
  })
})
