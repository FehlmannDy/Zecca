import { describe, expect, it } from 'vitest'
import { createMemoryKeyStore } from '@zecca/keystore'
import { generateWalletSecret } from '@zecca/xrpl-core'
import { claimCalls, depositCalls, redeemCalls, requestCalls } from './calls'
import { memoFF, memosField } from './memo'
import { mintPlan } from './math'
import { createMockEarnSides } from './mock-sides'

const keystore = () => {
  const ks = createMemoryKeyStore({ generateElGamal: () => ({ publicKey: '02' + '1'.repeat(64), privateKey: '2'.repeat(64) }) })
  ks.setWallet('testnetTreasury', generateWalletSecret())
  return ks
}
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await f()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('timed out')
}

// The in-memory Testnet + Coston2 behind EARN_MODE=mock: it decodes the same memo the facet decodes and applies the calls.
describe('mock Testnet + Flare sides', () => {
  async function opened(nonceOffset = 0n) {
    const ks = keystore()
    const { testnet, flare, control } = createMockEarnSides({ keystore: ks, executeAfterMs: 0 })
    const user = 'rUserAddressOnDevnetXXXXXXXXXX'
    const addr = testnet.walletFor(user)
    const pa = await flare.personalAccount(addr)
    const p = await flare.mintParams()
    const plan = mintPlan({ depositUBA: 10_000_000n, marginUBA: 10_000n, feeBips: p.feeBips, minFeeUBA: p.minFeeUBA, execFeeUBA: p.execFeeUBA })
    const fund = await testnet.sign('treasury', { Destination: addr, Amount: String(plan.amountDrops + 2_000_000n) })
    expect((await testnet.submit(fund.blob)).validated).toBe(true)
    const memo = memoFF({ sender: pa, nonce: (await flare.nonce(pa)) + nonceOffset, calls: depositCalls({ fxrp: p.fxrp, vault: p.vault, amountUBA: 10_000_000n, personalAccount: pa }), executorFeeUBA: p.execFeeUBA, compact: true })
    const pay = await testnet.sign({ user }, { Destination: p.coreVault, Amount: String(plan.amountDrops), Memos: memosField(memo) })
    const r = await testnet.submit(pay.blob)
    return { ks, testnet, flare, control, user, addr, pa, p, pay, r }
  }

  it('one payment with the deposit memo opens the account and deposits into the vault', async () => {
    const { flare, addr, pay, r } = await opened()
    expect(r).toMatchObject({ validated: true, engineResult: 'tesSUCCESS', hash: pay.hash })
    await until(() => flare.isExecuted(pay.hash))
    expect(await flare.position(addr)).toEqual({ shares: 10_000_000n, assets: 10_000_000n, fxrp: 10_000n })
  })

  it('a wrong nonce fails silently: nothing executes, the position stays empty', async () => {
    const { flare, addr, pay } = await opened(5n)
    await new Promise((r) => setTimeout(r, 20))
    expect(await flare.isExecuted(pay.hash)).toBe(false)
    expect((await flare.position(addr)).shares).toBe(0n)
  })

  it('simulates like ff.mjs: CallFailed for a deposit (no FXRP), InvalidNonce for a stale nonce', async () => {
    const ks = keystore()
    const { testnet, flare } = createMockEarnSides({ keystore: ks, executeAfterMs: 0 })
    const addr = testnet.walletFor('rSomeone')
    const pa = await flare.personalAccount(addr)
    const p = await flare.mintParams()
    const calls = depositCalls({ fxrp: p.fxrp, vault: p.vault, amountUBA: 1_000_000n, personalAccount: pa })
    expect(await flare.simulate(memoFF({ sender: pa, nonce: 0n, calls, executorFeeUBA: 0n, compact: true }), addr)).toBe('CallFailed')
    expect(await flare.simulate(memoFF({ sender: pa, nonce: 3n, calls, executorFeeUBA: 0n, compact: true }), addr)).toBe('InvalidNonce')
  })

  it('withdraw: request goes to the next period, claim once it ended, redeem pays XRP back on Testnet', async () => {
    const { testnet, flare, control, user, addr, pa, p, pay } = await opened()
    await until(() => flare.isExecuted(pay.hash))
    const send = async (calls: ReturnType<typeof requestCalls>) => {
      const memo = memoFF({ sender: pa, nonce: await flare.nonce(pa), calls, executorFeeUBA: p.execFeeUBA, compact: true })
      const s = await testnet.sign({ user }, { Destination: p.coreVault, Amount: '300000', Memos: memosField(memo) })
      expect((await testnet.submit(s.blob)).validated).toBe(true)
      await until(() => flare.isExecuted(s.hash))
    }
    const period = (await flare.currentPeriod()) + 1n
    await send(requestCalls({ vault: p.vault, shares: 10_000_000n, personalAccount: pa }))
    expect(await flare.withdrawal(period, pa)).toEqual({ assets: 10_000_000n, claimed: false })
    expect((await flare.position(addr)).shares).toBe(0n)

    control.advancePeriods(2)
    await send(claimCalls({ vault: p.vault, period }))
    expect(await flare.withdrawal(period, pa)).toEqual({ assets: 10_000_000n, claimed: true })
    const fxrp = (await flare.position(addr)).fxrp
    // the claimed assets, the deposit's rounding margin, and the 0.1 FXRP net mint of the request and of the claim payments
    expect(fxrp).toBe(10_000_000n + 10_000n + 200_000n)

    const before = await testnet.balanceDrops(addr)
    await send(redeemCalls({ assetManager: p.assetManager, amountUBA: fxrp, to: addr }))
    await until(async () => (await testnet.balanceDrops(addr)) > before)
    // payout = 10.21 FXRP minus 0.5% and the system fee; the redeem payment itself cost 0.3 XRP + fee
    expect(await testnet.balanceDrops(addr)).toBe(before - 300_012n + 10_210_000n - 51_050n - 2_042n)
  })
})
