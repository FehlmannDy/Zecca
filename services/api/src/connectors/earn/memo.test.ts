import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, type Hex } from 'viem'
import { callDataFor, canonicalUserOp, compactUserOp, memoFF, PUO, serializedMemosSize } from './memo'
import { claimCalls, depositCalls, redeemCalls, requestCalls } from './calls'
import V from './vectors.json'

const pa = V.personalAccount as Hex
const hex = (m: string) => m.slice(2).toUpperCase()

// The four probe payments that executed on Coston2: our encoder must give the same bytes for the same inputs.
describe('0xFF memo (port of flare-firelight/memo.mjs)', () => {
  it('deposit (approve + deposit) is byte for byte the memo that opened the probe account', () => {
    const calls = depositCalls({ fxrp: V.fxrp as Hex, vault: V.vault as Hex, amountUBA: BigInt(V.deposit.depositUBA), personalAccount: pa })
    const memo = memoFF({ sender: pa, nonce: BigInt(V.deposit.nonce), calls, executorFeeUBA: BigInt(V.executorFeeUBA), compact: true })
    expect(hex(memo)).toBe(V.deposit.memo)
    expect((memo.length - 2) / 2).toBe(1002)
    expect(serializedMemosSize(memo)).toBe(1009)
  })

  it('withdraw request, claim and redeem match their probe memos', () => {
    const exec = BigInt(V.executorFeeUBA)
    const req = memoFF({ sender: pa, nonce: 1n, calls: requestCalls({ vault: V.vault as Hex, shares: BigInt(V.withdrawRequest.shares), personalAccount: pa }), executorFeeUBA: exec, compact: true })
    expect(hex(req)).toBe(V.withdrawRequest.memo)
    const claim = memoFF({ sender: pa, nonce: 3n, calls: claimCalls({ vault: V.vault as Hex, period: BigInt(V.claim.period) }), executorFeeUBA: exec, compact: true })
    expect(hex(claim)).toBe(V.claim.memo)
    const redeem = memoFF({ sender: pa, nonce: 2n, calls: redeemCalls({ assetManager: V.assetManager as Hex, amountUBA: BigInt(V.redeem.amountUBA), to: V.xrplAddress }), executorFeeUBA: exec, compact: true })
    expect(hex(redeem)).toBe(V.redeem.memo)
  })

  it('the canonical encoding of approve + deposit does not fit the 1024-byte cap; the compact one does', () => {
    const calls = depositCalls({ fxrp: V.fxrp as Hex, vault: V.vault as Hex, amountUBA: 1n, personalAccount: pa })
    const canonical = memoFF({ sender: pa, nonce: 0n, calls, executorFeeUBA: 1n })
    expect((canonical.length - 2) / 2).toBe(1066)
    expect(serializedMemosSize(canonical)).toBeGreaterThan(1024)
    expect(serializedMemosSize(memoFF({ sender: pa, nonce: 0n, calls, executorFeeUBA: 1n, compact: true }))).toBeLessThan(1024)
  })

  it('the compact userOp decodes to the same struct as the canonical one (what the facet reads at memo[10:])', () => {
    const calls = depositCalls({ fxrp: V.fxrp as Hex, vault: V.vault as Hex, amountUBA: 123_456_789n, personalAccount: pa })
    const a = decodeAbiParameters([PUO], compactUserOp(pa, 7n, calls))[0]
    const b = decodeAbiParameters([PUO], canonicalUserOp(pa, 7n, calls))[0]
    expect(a).toEqual(b)
    expect(a.callData).toBe(callDataFor(calls))
    expect(a.nonce).toBe(7n)
  })

  it('header: 0xFF, wallet id, executor fee as uint64 big endian', () => {
    const memo = memoFF({ sender: pa, nonce: 0n, calls: claimCalls({ vault: V.vault as Hex, period: 1n }), executorFeeUBA: 0x0102030405n, walletId: 9 })
    expect(memo.slice(0, 2 + 20)).toBe('0xff090000000102030405')
  })

  it('serialized size counts the field ids, the length prefix (1 or 2 bytes) and the end markers', () => {
    expect(serializedMemosSize(('0x' + '00'.repeat(192)) as Hex)).toBe(192 + 6)
    expect(serializedMemosSize(('0x' + '00'.repeat(193)) as Hex)).toBe(193 + 7)
  })
})
