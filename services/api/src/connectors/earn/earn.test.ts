import { describe, expect, it } from 'vitest'
import { EarnDepositResponse, EarnPosition, EarnWithdrawResponse } from '@zecca/contracts'
import { generateWalletSecret } from '@zecca/xrpl-core'
import { eventually, makeHarness, type TestUser } from '../../testing/harness'
import type { FakeLedger, FakePool } from '../../testing/fakes'
import { createMockEarnSides } from './mock-sides'
import { earnOf, mountEarn, registerEarn } from './index'

const RATE = { microUsdPerXrp: 912_630, at: '2026-11-20T22:28:51.000Z', source: 'Test feed' }

function setup(o: { flag?: boolean; executeAfterMs?: number; openTimeoutMs?: number; autoPool?: boolean } = {}) {
  const h = makeHarness<FakeLedger, FakePool>({ env: o.flag === false ? {} : { FEATURE_EARN: '1' } })
  if (o.autoPool === false) h.pool.auto = false
  h.keystore.setWallet('testnetTreasury', generateWalletSecret())
  const sides = createMockEarnSides({ keystore: h.keystore, executeAfterMs: o.executeAfterMs ?? 0, payoutAfterMs: 0 })
  // coston2.down: every read of whether Flare executed a payment fails (RPC errors), while Flare itself keeps executing.
  const coston2 = { down: false }
  const flare = {
    ...sides.flare,
    isExecuted: async (hash: string) => {
      if (coston2.down) throw new Error('Coston2 RPC timeout')
      return sides.flare.isExecuted(hash)
    },
  }
  registerEarn(h.app.core, { sides: { testnet: sides.testnet, flare }, price: { rate: async () => RATE }, pollMs: 2, openTimeoutMs: o.openTimeoutMs ?? 2_000, payoutTimeoutMs: 2_000, jobs: false })
  mountEarn(h.app, h.app.core)
  const verified = async (handle: string) => {
    const u = await h.signUp(handle)
    h.app.core.db.prepare('UPDATE users SET tier = 1 WHERE id = ?').run(u.user.id)
    return u
  }
  const position = async (u: TestUser) => {
    const r = await h.json('GET', '/v1/earn/position', { token: u.token })
    expect(r.status).toBe(200)
    expect(EarnPosition.safeParse(r.body).success).toBe(true)
    return r.body
  }
  const balance = async (u: TestUser) => (await h.json('GET', '/v1/balance', { token: u.token })).body
  const withdrawalStatus = () => (h.app.core.db.prepare('SELECT status FROM earn_withdrawals ORDER BY created_at DESC LIMIT 1').get() as { status: string }).status
  return { h, sides, coston2, verified, position, balance, withdrawalStatus }
}

describe('Earn connector', () => {
  it('is off unless FEATURE_EARN=1: every route answers 404 feature_off', async () => {
    const { h } = setup({ flag: false })
    const ana = await h.signUp('ana')
    for (const [m, p, body] of [
      ['GET', '/v1/earn/position', undefined],
      ['POST', '/v1/earn/deposits', { amountMinor: 1000 }],
      ['POST', '/v1/earn/withdrawals', { amountDrops: 1_000_000 }],
    ] as const) {
      const r = await h.json(m, p, { token: ana.token, body })
      expect(r.status).toBe(404)
      expect(r.body.error.code).toBe('feature_off')
    }
  })

  it('requires a verified identity (tier 1) to add money', async () => {
    const { h, position } = setup()
    const ana = await h.signUp('ana')
    const r = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    expect(r.status).toBe(403)
    expect(r.body.error.message).toBe('Verify your identity to use Earn.')
    expect((await position(ana)).status).toBe('none')
  })

  it('quotes before approval: 0.3% conversion, XRP at the feed rate, the rate time; the deposit is a normal send to the pool', async () => {
    const { h, verified } = setup()
    const ana = await verified('ana')
    const r = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    expect(r.status).toBe(200)
    expect(EarnDepositResponse.safeParse(r.body).success).toBe(true)
    expect(r.body.quote).toMatchObject({ xrpDrops: 10_924_471, rateMinorPerXrp: 91, swapFeeMinor: 3, rateAt: RATE.at, rateSource: 'Test feed' })
    expect(r.body.intent).toMatchObject({ kind: 'earn_deposit', status: 'created', amountMinor: 1000, feeMinor: 3 })
    expect(r.body.intent.toUserId).toBeUndefined()
    expect(r.body.prepared.kind).toBe('send')
    expect(r.body.prepared.tx).toMatchObject({ TransactionType: 'ConfidentialMPTSend', Destination: h.keystore.getWallet('pool').address })
  })

  it('refuses less than the minimum, and more than the balance', async () => {
    const { h, verified } = setup()
    const ana = await verified('ana')
    const small = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 300 } })
    expect(small.status).toBe(400)
    expect(small.body.error.message).toMatch(/^Add at least \$\d+\.00 to Earn\.$/)
    const big = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 9000 } })
    expect(big.status).toBe(409)
    expect(big.body.error.code).toBe('insufficient_funds')
  })

  it('one approval: none -> funding -> opening -> active, then the position reads from the vault', async () => {
    const { h, sides, verified, position, balance } = setup({ executeAfterMs: 60, autoPool: false })
    const ana = await verified('ana')
    expect((await position(ana)).status).toBe('none')
    const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    const s = await h.submit(ana, d.body.prepared)
    expect(s.body.status).toBe('validated')
    expect((await balance(ana)).availableMinor).toBe(4000)
    expect((await position(ana)).status).toBe('funding')

    const exp = h.pool.expected.at(-1)!
    h.pool.emit({ type: 'received', ...exp })
    await eventually(async () => expect((await position(ana)).status).toBe('opening'))
    const opening = await position(ana)
    expect(opening.inFlight).toMatchObject({ xrpDrops: 10_924_471, amountMinor: 1000 })
    expect(opening.mode).toBe('mock')

    await eventually(async () => expect((await position(ana)).status).toBe('active'))
    const p = await position(ana)
    expect(p).toMatchObject({ depositedDrops: 10_924_471, valueDrops: 10_924_471, valueUsdMinor: 996 })
    expect(p.history.length).toBeGreaterThanOrEqual(1)
    expect(p.history.at(-1).valueDrops).toBe(10_924_471)
    expect(p.rate).toMatchObject({ minorPerXrp: 91, at: RATE.at, source: 'Test feed' })
    expect(sides.control.executedCount()).toBe(1)
    await h.app.core.idle()
    expect((await h.json('GET', `/v1/transfers/${d.body.intent.id}`, { token: ana.token })).body.status).toBe('paid_out')
  })

  it('is idempotent per intent: a second run sends nothing more', async () => {
    const { h, sides, verified, position } = setup()
    const ana = await verified('ana')
    const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    await h.submit(ana, d.body.prepared)
    await h.settle()
    await eventually(async () => expect((await position(ana)).status).toBe('active'))
    const earn = earnOf(h.app.core)
    await Promise.all([earn.runDeposit(d.body.intent.id), earn.runDeposit(d.body.intent.id)])
    expect(sides.control.executedCount()).toBe(1)
    expect((await position(ana)).depositedDrops).toBe(10_924_471)
  })

  it('two deposits in a row wait for each other (one smart-account nonce at a time)', async () => {
    const { h, sides, verified, position } = setup({ executeAfterMs: 20 })
    const ana = await verified('ana')
    for (const amount of [1000, 1200]) {
      const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: amount } })
      await h.submit(ana, d.body.prepared)
    }
    await eventually(async () => expect(sides.control.executedCount()).toBe(2), 4000)
    await eventually(async () => expect((await position(ana)).status).toBe('active'))
    const p = await position(ana)
    expect(p.depositedDrops).toBe(p.valueDrops)
    expect(p.depositedDrops).toBeGreaterThan(20_000_000)
  })

  it('a silent Flare failure times out: the deposit fails and the dollars come back', async () => {
    const { h, sides, verified, position, balance } = setup({ executeAfterMs: 60_000, openTimeoutMs: 40 })
    const ana = await verified('ana')
    const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    await h.submit(ana, d.body.prepared)
    await eventually(async () => expect((await balance(ana)).availableMinor).toBe(5000), 4000)
    const p = await position(ana)
    expect(p.status).toBe('none')
    expect(p.lastFailure).toMatch(/didn't reach Earn/)
    expect(sides.control.executedCount()).toBe(0)
    expect(h.pool.payouts.at(-1)).toMatchObject({ to: ana.signer.address, amountMinor: 1000 })
  })

  it('a Coston2 read that keeps failing is not a silent failure: no refund, the deposit stays opening and goes active once reads work', async () => {
    const { h, sides, coston2, verified, position, balance } = setup({ openTimeoutMs: 40 })
    coston2.down = true
    const ana = await verified('ana')
    const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    await h.submit(ana, d.body.prepared)
    await h.settle()
    await eventually(async () => expect(sides.control.executedCount()).toBe(1))
    const earn = earnOf(h.app.core)
    await earn.runDeposit(d.body.intent.id) // past the timeout, still unreadable
    await h.app.core.idle()
    await h.settle()
    const kept = await position(ana)
    expect(kept.status).toBe('opening')
    expect(kept.lastFailure).toBeUndefined()
    expect((await balance(ana)).availableMinor).toBe(4000)
    expect(h.pool.payouts.filter((p) => p.to === ana.signer.address && p.amountMinor === 1000)).toEqual([])

    coston2.down = false
    await earn.tick()
    const p = await position(ana)
    expect(p).toMatchObject({ status: 'active', depositedDrops: 10_924_471, valueDrops: 10_924_471 })
    expect((await balance(ana)).availableMinor).toBe(4000)
  })

  it('a withdrawal step whose execution cannot be read is kept (requesting, then claiming) and moves on once reads work', async () => {
    const { h, sides, coston2, verified, position, balance, withdrawalStatus } = setup({ openTimeoutMs: 40 })
    const ana = await verified('ana')
    const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    await h.submit(ana, d.body.prepared)
    await eventually(async () => expect((await position(ana)).status).toBe('active'))
    const earn = earnOf(h.app.core)

    coston2.down = true
    const w = await h.json('POST', '/v1/earn/withdrawals', { token: ana.token, body: { amountDrops: 10_924_471 } })
    expect(w.status).toBe(200)
    await h.app.core.idle()
    expect(withdrawalStatus()).toBe('requesting')
    expect((await position(ana)).pendingWithdrawal).toBeDefined()
    coston2.down = false
    await earn.tick()
    expect(withdrawalStatus()).toBe('requested')

    sides.control.advancePeriods(2)
    coston2.down = true
    await earn.tick({ force: true })
    expect(withdrawalStatus()).toBe('claiming')
    coston2.down = false
    await earn.tick({ force: true })
    await h.settle()
    expect(withdrawalStatus()).toBe('credited')
    await eventually(async () => expect((await balance(ana)).availableMinor).toBeGreaterThan(4000 + 980))
  })

  it('refuses before approval what the treasury cannot fund, and names the most it can take; that amount goes through', async () => {
    const { h, verified, position, balance } = setup()
    const ana = await verified('ana')
    await h.json('POST', '/v1/dev/credit', { token: ana.token, body: { amountMinor: 200_000 } })
    await h.settle()
    await eventually(async () => expect((await balance(ana)).availableMinor).toBe(205_000))
    // Mock treasury: 1000 XRP, plus at most FAUCET_ROUNDS faucet grants of 100 XRP each.
    const big = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 150_000 } })
    expect(big.status).toBe(400)
    const m = /^Add at most \$([\d,]+)\.00 to Earn\.$/.exec(big.body.error.message)
    expect(m).not.toBeNull()
    const most = Number(m![1].replace(/,/g, '')) * 100
    expect(most).toBeGreaterThan(130_000)
    expect(most).toBeLessThan(150_000)
    expect((await balance(ana)).availableMinor).toBe(205_000)

    const ok = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: most } })
    expect(ok.status).toBe(200)
    await h.submit(ana, ok.body.prepared)
    await eventually(async () => expect((await position(ana)).status).toBe('active'), 4000)
    expect((await position(ana)).lastFailure).toBeUndefined()
  })

  it('withdraw: requested now, claimable in the next period; then claim, redeem and a dollar credit through the pool', async () => {
    const { h, sides, verified, position, balance } = setup()
    const ana = await verified('ana')
    const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
    await h.submit(ana, d.body.prepared)
    await eventually(async () => expect((await position(ana)).status).toBe('active'))

    const w = await h.json('POST', '/v1/earn/withdrawals', { token: ana.token, body: { amountDrops: 10_924_471 } })
    expect(w.status).toBe(200)
    expect(EarnWithdrawResponse.safeParse(w.body).success).toBe(true)
    expect(Date.parse(w.body.claimableAt)).toBeGreaterThan(Date.now())
    const again = await h.json('POST', '/v1/earn/withdrawals', { token: ana.token, body: { amountDrops: 10_924_471 } })
    expect(again.status).toBe(409)

    const earn = earnOf(h.app.core)
    await h.app.core.idle()
    const p = await position(ana)
    expect(p.pendingWithdrawal).toMatchObject({ amountDrops: 10_924_471, claimableAt: w.body.claimableAt })
    expect(p.valueDrops).toBe(0)

    // Not claimable yet: the tick does nothing.
    await earn.tick()
    expect((await position(ana)).pendingWithdrawal).toBeDefined()

    sides.control.advancePeriods(2)
    await earn.tick({ force: true })
    await h.settle()
    await eventually(async () => expect((await position(ana)).pendingWithdrawal).toBeUndefined(), 4000)
    // 10.92 XRP back, minus the 0.5% redemption and system fees, at the same rate, minus 0.3%: about $9.86.
    await eventually(async () => expect((await balance(ana)).availableMinor).toBeGreaterThan(4000 + 980))
    expect(h.pool.mints.at(-1)?.reference).toMatch(/^earn:/)
    const after = await position(ana)
    expect(after.status).toBe('none')
    expect(after.depositedDrops).toBe(0)
  })

  it('refuses a withdrawal with nothing in Earn', async () => {
    const { h, verified } = setup()
    const ana = await verified('ana')
    const r = await h.json('POST', '/v1/earn/withdrawals', { token: ana.token, body: { amountDrops: 6_000_000 } })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe("There's nothing in Earn to withdraw yet.")
  })
})
