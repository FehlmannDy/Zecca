// "What the ledger shows" (UI.md §5.6), as data: the rows the person sees ("You") and the rows anyone reading the
// public ledger sees ("Everyone else"), built only from the real Activity the API returned. Plus the small
// helpers that keep an activity current from intent.updated events.
import { activityStatusOf, type Activity, type Intent, type Network, type PublicConfig } from '@zecca/contracts'
import { recipientShortName } from './send-rules'

export type LedgerMode = 'you' | 'everyone'

export type LedgerRow =
  | { key: string; label: string; kind: 'amount'; minor: number; direction?: 'in' | 'out' }
  | { key: string; label: string; kind: 'party'; text: string; sub?: string }
  | { key: string; label: string; kind: 'text'; text: string }
  | { key: string; label: string; kind: 'sealed'; preview?: string }
  | { key: string; label: string; kind: 'hash'; hash: string; href: string }
  | { key: string; label: string; kind: 'waiting'; text: string }

/** Kinds whose money goes into the pool and comes out to the recipient: two transactions. */
const POOL_PAYOUT_KINDS: ReadonlySet<string> = new Set(['p2p', 'merchant', 'topup'])

const PARTY_WITHOUT_PROFILE: Record<string, string> = {
  welcome: 'Zecca',
  topup: 'Top up',
  card_load: 'Your card',
  card_purchase: 'Your card',
  earn_deposit: 'Earn',
  market_buy: 'Metals',
  withdraw: 'Withdrawal',
}

export function explorerHref(explorer: PublicConfig['explorer'], network: Network, hash: string): string {
  const base = explorer[network]
  return `${base.replace(/\/+$/, '')}/${hash}`
}

/** A refund (back to the card balance) and a declined or cancelled card purchase: nothing moves on the ledger. */
const cardOffLedger = (a: Activity) => a.kind === 'card_purchase' && (a.direction === 'in' || a.status === 'failed')

export function ledgerRows(a: Activity, mode: LedgerMode, opts: { explorer: PublicConfig['explorer'] }): LedgerRow[] {
  const partyLabel = a.direction === 'in' ? 'From' : 'To'
  if (mode === 'you') {
    const party: LedgerRow = a.counterparty
      ? { key: 'party', label: partyLabel, kind: 'party', text: a.counterparty.displayName, sub: `@${a.counterparty.handle}` }
      : { key: 'party', label: partyLabel, kind: 'party', text: a.receipt?.shopName ?? PARTY_WITHOUT_PROFILE[a.kind] ?? 'Zecca' }
    return [
      { key: 'amount', label: 'Amount', kind: 'amount', minor: a.amountMinor, direction: a.direction },
      party,
      { key: 'fee', label: 'Fee', kind: 'amount', minor: a.feeMinor },
    ]
  }

  const failed = a.status === 'failed'
  const tx = (key: 'deposit' | 'payout', label: string, hash: string | undefined, waiting: string): LedgerRow =>
    hash
      ? { key, label, kind: 'hash', hash, href: explorerHref(opts.explorer, key === 'payout' ? (a.ledger.payoutNetwork ?? a.ledger.network) : a.ledger.network, hash) }
      : { key, label, kind: 'waiting', text: failed ? 'Not sent' : waiting }

  // A card purchase shows on the ledger as one payment out of the pool to the card network, once the purchase clears.
  if (cardOffLedger(a)) return []
  const card = a.kind === 'card_purchase'
  const rows: LedgerRow[] = [
    { key: 'amount', label: 'Amount', kind: 'sealed', ...(a.ledger.ciphertextPreview ? { preview: a.ledger.ciphertextPreview } : {}) },
    { key: 'party', label: card ? 'From' : partyLabel, kind: 'party', text: a.kind === 'welcome' ? 'Zecca' : 'Zecca pool' },
    { key: 'fee', label: 'Fee', kind: 'text', text: 'Not visible' },
  ]
  if (card) {
    rows.push(tx('payout', 'Out of the pool', a.ledger.payoutTxHash, 'When the purchase clears'))
    return rows
  }
  if (a.kind === 'welcome') {
    if (a.ledger.depositTxHash) rows.push(tx('deposit', 'Sign-up', a.ledger.depositTxHash, 'Waiting'))
    return rows
  }
  rows.push(tx('deposit', 'Into the pool', a.ledger.depositTxHash, 'Waiting'))
  if (POOL_PAYOUT_KINDS.has(a.kind)) rows.push(tx('payout', 'Out of the pool', a.ledger.payoutTxHash, 'On its way'))
  return rows
}

/**
 * The line above the rows. "Everyone else" claims only that the amount is hidden: addresses are public and timing can
 * link a deposit to its payout (SPEC §11), so it never says the ledger hides who paid whom.
 */
export function ledgerCaption(a: Activity, mode: LedgerMode): string {
  if (mode === 'you') return a.counterparty ? `What you and ${recipientShortName(a.counterparty)} see.` : 'What you see.'
  if (cardOffLedger(a)) return 'What anyone reading the public ledger sees: nothing. This stays on your card.'
  const seen =
    a.kind === 'welcome'
      ? 'a payment happened'
      : a.kind === 'card_purchase'
        ? 'a payment out of the Zecca pool'
        : POOL_PAYOUT_KINDS.has(a.kind)
          ? 'a payment into the Zecca pool and one out of it'
          : 'a payment into the Zecca pool'
  return `What anyone reading the public ledger sees: ${seen}, not how much.`
}

/** The status in words (never colour alone). */
export function statusWord(a: Activity): string {
  if (a.status === 'failed') return 'Failed'
  if (a.status === 'pending') return a.direction === 'in' ? 'Arriving' : 'Sending'
  if (a.direction === 'in') return 'Received'
  return a.kind === 'merchant' || a.kind === 'card_purchase' ? 'Paid' : 'Sent'
}

/** Take the latest status and hashes from an intent.updated event. Returns the same object when unrelated. */
export function applyIntent(a: Activity, i: Intent): Activity {
  if (a.intentId !== i.id) return a
  return {
    ...a,
    status: activityStatusOf(i.status),
    ledger: {
      ...a.ledger,
      ...(i.depositTxHash ? { depositTxHash: i.depositTxHash } : {}),
      ...(i.payoutTxHash ? { payoutTxHash: i.payoutTxHash } : {}),
    },
  }
}

/** Newest first: a new activity goes on top, a known one is replaced where it is. */
export function mergeActivity(list: readonly Activity[], a: Activity): Activity[] {
  const at = list.findIndex((x) => x.id === a.id)
  if (at === -1) return [a, ...list]
  const out = list.slice()
  out[at] = a
  return out
}

/** The detail page takes an activity id, or an intent id (what the send screen knows right after a payment). */
export function findActivity(list: readonly Activity[], id: string): Activity | undefined {
  return list.find((a) => a.id === id) ?? list.find((a) => a.intentId === id)
}
