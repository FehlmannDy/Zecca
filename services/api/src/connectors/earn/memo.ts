// 0xFF memo-field custom instruction (port of ../flare-firelight/memo.mjs, D6):
//   0xFF | walletId 1 B | executorFeeUBA uint64 BE | abi.encode(PackedUserOperation)
// The facet decodes it with abi.decode(_memoData[10:], (PackedUserOperation)) (verified source of 0x2054188F...).
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, padHex, size as hexSize, toHex, type Hex } from 'viem'
import { abis } from './abi'

export type Call = { target: Hex; value: bigint; data: Hex }

export const PUO = {
  type: 'tuple',
  components: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
    { name: 'signature', type: 'bytes' },
  ],
} as const

const Z32: Hex = `0x${'00'.repeat(32)}`
const w = (n: number | bigint) => padHex(toHex(n), { size: 32 })

/** PersonalAccount.executeUserOp(calls): the batch the smart account runs. */
export const callDataFor = (calls: Call[]): Hex => encodeFunctionData({ abi: abis.pa, functionName: 'executeUserOp', args: [calls] })

export function canonicalUserOp(sender: Hex, nonce: bigint, calls: Call[]): Hex {
  return encodeAbiParameters(
    [PUO],
    [{ sender, nonce, initCode: '0x', callData: callDataFor(calls), accountGasLimits: Z32, preVerificationGas: 0n, gasFees: Z32, paymasterAndData: '0x', signature: '0x' }],
  )
}

/**
 * Same ABI value, but initCode / paymasterAndData / signature (all empty) share ONE zero-length tail. Solidity's
 * abi.decode accepts overlapping in-bounds offsets; saves 64 bytes, which is what makes approve + deposit fit (1002 B).
 */
export function compactUserOp(sender: Hex, nonce: bigint, calls: Call[]): Hex {
  const cd = callDataFor(calls)
  const len = hexSize(cd)
  const padded = Math.ceil(len / 32) * 32
  const head = 9 * 32
  const emptyOff = head
  const cdOff = head + 32
  const tuple = concatHex([
    padHex(sender, { size: 32 }),
    w(nonce),
    w(emptyOff),
    w(cdOff),
    Z32,
    w(0),
    Z32,
    w(emptyOff),
    w(emptyOff),
    w(0),
    w(len),
    padHex(cd, { size: padded, dir: 'right' }),
  ])
  return concatHex([w(32), tuple])
}

const stable = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

export function memoFF(o: { sender: Hex; nonce: bigint; calls: Call[]; executorFeeUBA: bigint; walletId?: number; compact?: boolean }): Hex {
  const uo = (o.compact ? compactUserOp : canonicalUserOp)(o.sender, o.nonce, o.calls)
  // Self-check: the compact form decodes to exactly the struct of the canonical one.
  const a = decodeAbiParameters([PUO], uo)[0]
  const b = decodeAbiParameters([PUO], canonicalUserOp(o.sender, o.nonce, o.calls))[0]
  if (stable(a) !== stable(b)) throw new Error('compact userOp decode mismatch')
  return concatHex(['0xff', toHex(o.walletId ?? 0, { size: 1 }), toHex(o.executorFeeUBA, { size: 8 }), uo])
}

/** Serialized size of an XRPL Memos field holding one memo with only MemoData (rippled caps it at 1024 bytes). */
export function serializedMemosSize(memoHex: Hex): number {
  const n = hexSize(memoHex)
  return 1 + 1 + 1 + (n <= 192 ? 1 : 2) + n + 1 + 1
}

export const MEMOS_CAP = 1024

/** The XRPL Memos field for a memo, after the size check (D6: assert under 1024 before sending). */
export function memosField(memoHex: Hex): { Memo: { MemoData: string } }[] {
  const n = serializedMemosSize(memoHex)
  if (n > MEMOS_CAP) throw new Error(`memo too large: ${n} > ${MEMOS_CAP} bytes`)
  return [{ Memo: { MemoData: memoHex.slice(2).toUpperCase() } }]
}

/** Decodes a memo back into its header and calls (the mock Flare side runs them; tests read them). */
export function decodeMemo(memoHex: Hex): { walletId: number; executorFeeUBA: bigint; sender: Hex; nonce: bigint; callData: Hex } {
  const bytes = memoHex.slice(2)
  if (bytes.slice(0, 2).toLowerCase() !== 'ff') throw new Error('not a 0xFF memo')
  const walletId = Number.parseInt(bytes.slice(2, 4), 16)
  const executorFeeUBA = BigInt('0x' + bytes.slice(4, 20))
  const uo = decodeAbiParameters([PUO], `0x${bytes.slice(20)}`)[0]
  return { walletId, executorFeeUBA, sender: uo.sender, nonce: uo.nonce, callData: uo.callData }
}
