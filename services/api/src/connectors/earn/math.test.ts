import { describe, expect, it } from 'vitest'
import { dropsToUsdMinor, earnFeeDrops, fundingDrops, mintPlan, parseMicros, quoteDeposit, quoteWithdrawal, sharesFor } from './math'

// Integers only: cents, drops, micro-dollars per XRP, basis points.
describe('Earn maths', () => {
  it('quotes a deposit: 0.3% conversion fee in cents, the rest converted at the feed rate, drops rounded down', () => {
    // $10.00 at $0.91263 per XRP
    const q = quoteDeposit({ amountMinor: 1000, microUsdPerXrp: 912_630, swapBps: 30 })
    expect(q).toEqual({ swapFeeMinor: 3, netMinor: 997, xrpDrops: 10_924_471, rateMinorPerXrp: 91 })
    // 997 cents = 9 970 000 micro-dollars; 9 970 000 / 0.91263 = 10 924 471.9 drops
    expect(Number.isSafeInteger(q.xrpDrops)).toBe(true)
  })

  it('rounds the swap fee half up and never returns a rate of 0 cents', () => {
    expect(quoteDeposit({ amountMinor: 50, microUsdPerXrp: 2_200_000, swapBps: 30 }).swapFeeMinor).toBe(0)
    expect(quoteDeposit({ amountMinor: 167, microUsdPerXrp: 2_200_000, swapBps: 30 }).swapFeeMinor).toBe(1)
    expect(quoteDeposit({ amountMinor: 100, microUsdPerXrp: 4_000, swapBps: 30 }).rateMinorPerXrp).toBe(1)
  })

  it('refuses a non-integer or non-positive rate', () => {
    expect(() => quoteDeposit({ amountMinor: 100, microUsdPerXrp: 0, swapBps: 30 })).toThrow()
    expect(() => quoteDeposit({ amountMinor: 100, microUsdPerXrp: 1.5, swapBps: 30 })).toThrow()
    expect(() => quoteDeposit({ amountMinor: 10.5, microUsdPerXrp: 1_000_000, swapBps: 30 })).toThrow()
  })

  it('values drops in cents, rounded down', () => {
    expect(dropsToUsdMinor(10_924_471, 912_630)).toBe(996)
    expect(dropsToUsdMinor(25_041_000, 2_000_000)).toBe(5008)
    expect(dropsToUsdMinor(0, 912_630)).toBe(0)
  })

  it('plans the Core Vault payment like ff.mjs: net + max(0.25%, 0.1 XRP) minting fee + executor fee', () => {
    const p = mintPlan({ depositUBA: 10_020_000n, marginUBA: 10_000n, feeBips: 25n, minFeeUBA: 100_000n, execFeeUBA: 100_000n })
    // The probe's step 3: NET 10.03, fee 0.1 (0.25% of 10.03 is below the floor), executor 0.1 -> 10.23 XRP
    expect(p).toEqual({ netUBA: 10_030_000n, mintFeeUBA: 100_000n, amountDrops: 10_230_000n })
    const big = mintPlan({ depositUBA: 100_000_000n, marginUBA: 0n, feeBips: 25n, minFeeUBA: 100_000n, execFeeUBA: 100_000n })
    expect(big.mintFeeUBA).toBe(250_000n)
  })

  it('funds only what the wallet lacks: reserve + payment + fee margin - balance', () => {
    expect(fundingDrops({ paymentDrops: 10_230_000n, balanceDrops: 0n, reserveDrops: 1_000_000n, feeMarginDrops: 1_000n })).toBe(11_231_000n)
    expect(fundingDrops({ paymentDrops: 300_000n, balanceDrops: 1_200_000n, reserveDrops: 1_000_000n, feeMarginDrops: 1_000n })).toBe(101_000n)
    expect(fundingDrops({ paymentDrops: 300_000n, balanceDrops: 5_000_000n, reserveDrops: 1_000_000n, feeMarginDrops: 1_000n })).toBe(0n)
  })

  it('takes EARN_FEE_BPS of the earnings only, never of the deposit', () => {
    expect(earnFeeDrops({ withdrawnDrops: 10_100_000, costBasisDrops: 10_000_000, feeBps: 1000 })).toBe(10_000)
    expect(earnFeeDrops({ withdrawnDrops: 9_900_000, costBasisDrops: 10_000_000, feeBps: 1000 })).toBe(0)
  })

  it('quotes a withdrawal back to dollars with the same 0.3% conversion', () => {
    expect(quoteWithdrawal({ drops: 10_924_471, microUsdPerXrp: 912_630, swapBps: 30 })).toEqual({ grossMinor: 996, swapFeeMinor: 3, netMinor: 993 })
  })

  it('turns a drops amount into vault shares, capped at what the account holds', () => {
    // 1 share = 1.00074 FXRP (probe): convertToShares is read on chain; here assets/shares proportion
    expect(sharesFor({ drops: 5_000_000, assets: 10_020_000, shares: 10_012_590 })).toBe(4_996_302n)
    expect(sharesFor({ drops: 99_000_000, assets: 10_020_000, shares: 10_012_590 })).toBe(10_012_590n)
  })

  it('parses a decimal price into micro-dollars without float maths', () => {
    expect(parseMicros('0.91263')).toBe(912_630)
    expect(parseMicros('2.2')).toBe(2_200_000)
    expect(parseMicros('1')).toBe(1_000_000)
    expect(parseMicros('0.123456789')).toBe(123_456)
    expect(parseMicros('1e-7')).toBeNull()
    expect(parseMicros('abc')).toBeNull()
    expect(parseMicros('0')).toBeNull()
  })
})
