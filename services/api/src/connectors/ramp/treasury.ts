// The Testnet treasury paying MoonPay for a withdrawal (MoonPay sell), through @zecca/xrpl-core's client (BUILD §8 rule 6).
// Each payment is autofilled, signed, handed to `onSigned` (the caller stores its hash and LastLedgerSequence) and only then
// submitted, inside the treasury's serial queue (rule 7). Unit tests pass a fake; the live one is tried by the ledger test.
import type { KeyStore, SubmitResult } from '@zecca/contracts'
import { createClient, walletFrom, type XrplClient } from '@zecca/xrpl-core'
import { RLUSD_HEX, RLUSD_TESTNET_ISSUER } from './delivery'
import type { TreasuryAmount } from './sell'

export type SignedPayment = { hash: string; lastLedgerSequence: number }

export interface TreasuryPayer {
  /** True when the treasury holds `amount` above what it must keep (XRP: reserve and a fee margin; RLUSD: its trust line balance). */
  canPay(amount: TreasuryAmount): Promise<boolean>
  pay(p: { destination: string; tag?: number; amount: TreasuryAmount }, onSigned: (s: SignedPayment) => void): Promise<SubmitResult>
  /**
   * A payment as the ledger knows it: `final` once it is in a validated ledger (its engineResult then decides: only tesSUCCESS
   * delivered; a validated tec did not), { final: false } while pending, null when the ledger does not know it.
   */
  txResult(hash: string): Promise<{ final: boolean; engineResult: string } | null>
  /** Last validated ledger index (a payment not found once this passes its LastLedgerSequence never applied). */
  ledgerIndex(): Promise<number>
}

/** Fee margin kept above the reserve for XRP payments, in drops. */
const FEE_MARGIN_DROPS = 100_000n

/** a >= b for two non-negative decimal strings. */
function decGte(a: string, b: string): boolean {
  const parse = (s: string) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim())
    if (!m) return null
    return { n: BigInt(m[1] + (m[2] ?? '')), f: (m[2] ?? '').length }
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  const f = Math.max(x.f, y.f)
  return x.n * 10n ** BigInt(f - x.f) >= y.n * 10n ** BigInt(f - y.f)
}

export function createLiveTreasuryPayer(o: { keystore: KeyStore; client?: XrplClient; log?: (m: string) => void }): TreasuryPayer & { client: XrplClient } {
  const client = o.client ?? createClient('testnet', { log: o.log })
  const wallet = () => walletFrom(o.keystore.getWallet('testnetTreasury'))
  return {
    client,
    async canPay(amount) {
      const w = wallet()
      if (typeof amount === 'string') {
        const info = await client.accountInfo(w.classicAddress)
        if (!info) return false
        const server = (await client.request({ command: 'server_info' })).result.info
        const drops = (xrp: unknown) => BigInt(Math.round(Number(xrp ?? 0) * 1_000_000))
        const reserve = drops(server.validated_ledger?.reserve_base_xrp ?? 1) + BigInt(Number(info.OwnerCount ?? 0)) * drops(server.validated_ledger?.reserve_inc_xrp ?? 0.2)
        return BigInt(String(info.Balance)) - reserve - FEE_MARGIN_DROPS >= BigInt(amount)
      }
      const lines = (await client.request({ command: 'account_lines', account: w.classicAddress, peer: RLUSD_TESTNET_ISSUER, ledger_index: 'validated' })).result.lines ?? []
      const line = (lines as { currency: string; balance: string }[]).find((l) => l.currency === RLUSD_HEX)
      return !!line && decGte(line.balance, amount.value)
    },
    pay(p, onSigned) {
      const w = wallet()
      return client.serial(w.classicAddress, async () => {
        const tx = await client.autofill({
          TransactionType: 'Payment',
          Account: w.classicAddress,
          Destination: p.destination,
          Amount: p.amount,
          ...(p.tag !== undefined ? { DestinationTag: p.tag } : {}),
        })
        const signed = w.sign(tx as never)
        onSigned({ hash: signed.hash, lastLedgerSequence: Number((tx as { LastLedgerSequence?: number }).LastLedgerSequence) })
        return client.submitAndWait(signed.tx_blob)
      })
    },
    async txResult(hash) {
      try {
        const r = (await client.request({ command: 'tx', transaction: hash })).result
        return { final: Boolean(r.validated), engineResult: String(r.meta?.TransactionResult ?? 'unknown') }
      } catch (e) {
        if ((e as { data?: { error?: string } })?.data?.error === 'txnNotFound') return null
        throw e
      }
    },
    ledgerIndex: () => client.ledgerIndex(),
  }
}
