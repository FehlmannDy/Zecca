// Pure helpers for the Earn screen (UI.md §5.10). XRP amounts are integer drops from the API; formatted only here.
import type { EarnPosition, Fees } from '@zecca/contracts'

/** What GET /v1/earn/position carries beyond the contract (connector extras; contract request filed). */
export type EarnRate = { minorPerXrp: number; microUsdPerXrp: number; at: string; source: string }
export type EarnPositionView = EarnPosition & {
  mode?: 'live' | 'mock'
  rate?: EarnRate
  inFlight?: { status: 'funding' | 'opening'; xrpDrops: number; amountMinor: number; since: string; openedAt?: string }
  lastFailure?: string
  ledger?: { testnetAddress: string; smartAccount?: string; lastPaymentHash?: string }
  stale?: boolean
}
export type EarnQuoteView = { xrpDrops: number; rateMinorPerXrp: number; swapFeeMinor: number; microUsdPerXrp?: number; rateAt?: string; rateSource?: string }

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 10924471 -> "10.92" (rounded down), or "10.924471" exact. */
export function xrpText(drops: number, o: { exact?: boolean } = {}): string {
  if (!Number.isSafeInteger(drops)) throw new TypeError(`drops must be an integer, got ${drops}`)
  const whole = group(Math.floor(drops / 1_000_000).toString())
  const frac = (drops % 1_000_000).toString().padStart(6, '0')
  if (o.exact) {
    const t = frac.replace(/0+$/, '')
    return t ? `${whole}.${t}` : whole
  }
  return `${whole}.${frac.slice(0, 2)}`
}

/** Basis points as a short percentage: 30 -> "0.3%", 1000 -> "10%". */
export function percentText(bps: number): string {
  const whole = Math.floor(bps / 100)
  const frac = (bps % 100).toString().padStart(2, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}%` : `${whole}%`
}

export const feeLine = (f: Pick<Fees, 'earnSwapBps' | 'earnFeeBps'>) => `${percentText(f.earnSwapBps)} conversion. Zecca keeps ${percentText(f.earnFeeBps)} of what you earn.`

const when = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) })

/** "$0.9126 per XRP, CoinGecko, Nov 20, 10:28 PM" */
export function rateText(r: EarnRate, timeZone?: string): string {
  const cents = Math.floor(r.microUsdPerXrp / 100) // ten-thousandths of a dollar
  const dollars = Math.floor(cents / 10_000)
  const rest = (cents % 10_000).toString().padStart(4, '0')
  return `$${dollars}.${rest} per XRP, ${r.source}, ${when(r.at, timeZone)}`
}

export const timeText = when

/** The Peak Chart's series: real history points only (never the component's demo data). */
export function chartSeries(history: EarnPosition['history'], timeZone?: string): { data: number[]; labels: string[] } {
  return { data: history.map((p) => p.valueDrops), labels: history.map((p) => when(p.at, timeZone)) }
}

export function statusLine(p: Pick<EarnPositionView, 'status'>): string | null {
  if (p.status === 'funding') return 'Converting your dollars to XRP'
  if (p.status === 'opening') return 'Opening your Earn account on Flare. About 3 minutes.'
  return null
}

/** Refresh cadence: fast while money moves, slow while a withdrawal waits, none otherwise. */
export function pollEvery(p: Pick<EarnPositionView, 'status' | 'pendingWithdrawal'>): number | null {
  if (p.status === 'funding' || p.status === 'opening') return 5_000
  if (p.pendingWithdrawal) return 60_000
  return null
}

/** Expected wait for the arches while Flare executes (FLARE_REPORT: about 160 s from validation to the Flare block). */
export const OPENING_MS = 180_000

export const EXPLORERS = {
  testnetTx: 'https://testnet.xrpl.org/transactions/',
  coston2Address: 'https://coston2-explorer.flare.network/address/',
}
