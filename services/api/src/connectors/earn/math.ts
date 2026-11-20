// Earn maths in integers (BUILD §8 rule 5): cents, drops (1 XRP = 1 000 000 drops = 1 000 000 FXRP UBA),
// micro-dollars per XRP for the rate, basis points for fees. BigInt where products can pass 2^53.
import { feeMinor } from '@zecca/contracts'

const int = (n: number, name: string) => {
  if (!Number.isSafeInteger(n)) throw new TypeError(`${name} must be a safe integer, got ${n}`)
  return n
}
const positive = (n: number, name: string) => {
  if (int(n, name) <= 0) throw new RangeError(`${name} must be positive, got ${n}`)
  return n
}

/** Micro-dollars in one cent. */
const MICROS_PER_CENT = 10_000n
const DROPS_PER_XRP = 1_000_000n

export type DepositQuote = { swapFeeMinor: number; netMinor: number; xrpDrops: number; rateMinorPerXrp: number }

/** Dollars -> XRP: EARN_SWAP_BPS of the amount is Zecca's conversion fee; the rest is converted at the feed rate, rounded down. */
export function quoteDeposit(o: { amountMinor: number; microUsdPerXrp: number; swapBps: number }): DepositQuote {
  positive(o.amountMinor, 'amountMinor')
  positive(o.microUsdPerXrp, 'microUsdPerXrp')
  const swapFeeMinor = feeMinor(o.amountMinor, o.swapBps)
  const netMinor = o.amountMinor - swapFeeMinor
  const xrpDrops = Number((BigInt(netMinor) * MICROS_PER_CENT * DROPS_PER_XRP) / BigInt(o.microUsdPerXrp))
  return { swapFeeMinor, netMinor, xrpDrops, rateMinorPerXrp: rateMinorPerXrp(o.microUsdPerXrp) }
}

/** The rate in whole cents per XRP for the contract's quote (at least 1). */
export function rateMinorPerXrp(microUsdPerXrp: number): number {
  return Math.max(1, Number((BigInt(positive(microUsdPerXrp, 'microUsdPerXrp')) + MICROS_PER_CENT / 2n) / MICROS_PER_CENT))
}

/** Value of drops in cents at the rate, rounded down. */
export function dropsToUsdMinor(drops: number, microUsdPerXrp: number): number {
  int(drops, 'drops')
  positive(microUsdPerXrp, 'microUsdPerXrp')
  return Number((BigInt(drops) * BigInt(microUsdPerXrp)) / (MICROS_PER_CENT * DROPS_PER_XRP))
}

/** XRP -> dollars on the way out, with the same conversion fee. */
export function quoteWithdrawal(o: { drops: number; microUsdPerXrp: number; swapBps: number }): { grossMinor: number; swapFeeMinor: number; netMinor: number } {
  const grossMinor = dropsToUsdMinor(o.drops, o.microUsdPerXrp)
  const swapFeeMinor = feeMinor(grossMinor, o.swapBps)
  return { grossMinor, swapFeeMinor, netMinor: grossMinor - swapFeeMinor }
}

/**
 * The Core Vault payment for a deposit (ff.mjs): the smart account receives `net` FXRP (deposit + a rounding margin that
 * stays in the account), the payment adds the minting fee max(net * bips, minimum) and the executor fee.
 */
export function mintPlan(o: { depositUBA: bigint; marginUBA: bigint; feeBips: bigint; minFeeUBA: bigint; execFeeUBA: bigint }): { netUBA: bigint; mintFeeUBA: bigint; amountDrops: bigint } {
  const netUBA = o.depositUBA + o.marginUBA
  const pct = (netUBA * o.feeBips) / 10_000n
  const mintFeeUBA = pct > o.minFeeUBA ? pct : o.minFeeUBA
  return { netUBA, mintFeeUBA, amountDrops: netUBA + mintFeeUBA + o.execFeeUBA }
}

/** What the treasury sends so the wallet can make the payment and keep its reserve. 0 when it already has enough. */
export function fundingDrops(o: { paymentDrops: bigint; balanceDrops: bigint; reserveDrops: bigint; feeMarginDrops: bigint }): bigint {
  const need = o.reserveDrops + o.paymentDrops + o.feeMarginDrops - o.balanceDrops
  return need > 0n ? need : 0n
}

/** Zecca's share of the yield (EARN_FEE_BPS of what was earned), taken at withdrawal. Nothing on a loss. */
export function earnFeeDrops(o: { withdrawnDrops: number; costBasisDrops: number; feeBps: number }): number {
  const earned = int(o.withdrawnDrops, 'withdrawnDrops') - int(o.costBasisDrops, 'costBasisDrops')
  return earned > 0 ? feeMinor(earned, o.feeBps) : 0
}

/** Vault shares for an amount of drops, from the account's assets/shares (rounded down), capped at all its shares. */
export function sharesFor(o: { drops: number; assets: number; shares: number }): bigint {
  if (o.assets <= 0 || o.shares <= 0) return 0n
  if (o.drops >= o.assets) return BigInt(o.shares)
  return (BigInt(o.drops) * BigInt(o.shares)) / BigInt(o.assets)
}

/** "0.91263" -> 912630 micro-dollars. Plain decimals only; null when not a positive number. */
export function parseMicros(s: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(s.trim())
  if (!m) return null
  const v = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').slice(0, 6).padEnd(6, '0'))
  return v > 0 ? v : null
}
