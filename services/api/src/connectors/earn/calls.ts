// The smart-account calls each Earn payment carries (step3.mjs, step5.mjs). One XRPL payment = one user op.
import { encodeFunctionData, erc20Abi, zeroAddress, type Hex } from 'viem'
import { abis } from './abi'
import type { Call } from './memo'

/** Deposit: FXRP.approve(vault, amount) + Firelight.deposit(amount, PA). The payment mints the FXRP first. */
export function depositCalls(o: { fxrp: Hex; vault: Hex; amountUBA: bigint; personalAccount: Hex }): Call[] {
  return [
    { target: o.fxrp, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [o.vault, o.amountUBA] }) },
    { target: o.vault, value: 0n, data: encodeFunctionData({ abi: abis.firelight, functionName: 'deposit', args: [o.amountUBA, o.personalAccount] }) },
  ]
}

/** Withdraw request: Firelight.redeem(shares, PA, PA) -> a withdrawal for period currentPeriod() + 1. */
export function requestCalls(o: { vault: Hex; shares: bigint; personalAccount: Hex }): Call[] {
  return [{ target: o.vault, value: 0n, data: encodeFunctionData({ abi: abis.firelight, functionName: 'redeem', args: [o.shares, o.personalAccount, o.personalAccount] }) }]
}

/** Claim: Firelight.claimWithdraw(period), once currentPeriod() > period. */
export function claimCalls(o: { vault: Hex; period: bigint }): Call[] {
  return [{ target: o.vault, value: 0n, data: encodeFunctionData({ abi: abis.firelight, functionName: 'claimWithdraw', args: [o.period] }) }]
}

/** Redeem: AssetManager.redeemAmount(amount, xrplAddress, 0x0) -> an agent pays XRP to the XRPL address (minimum 5 XRP). */
export function redeemCalls(o: { assetManager: Hex; amountUBA: bigint; to: string }): Call[] {
  return [{ target: o.assetManager, value: 0n, data: encodeFunctionData({ abi: abis.am, functionName: 'redeemAmount', args: [o.amountUBA, o.to, zeroAddress] }) }]
}
