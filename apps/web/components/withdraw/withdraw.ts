// Withdraw to a card (MoonPay sell, FEATURE_WITHDRAW): the amount chips, what the widget's onInitiateDeposit hands the API,
// the status copy ("Sent to MoonPay" -> "Paid out to your card" / failed), and a small client for the two withdrawal
// routes, which are not in the contracts' route table yet (the typed client only knows that table).
import { ApiError, formatUsd, type Intent, type Limits, type PreparedTx, type Tier } from '@zecca/contracts'
import { ZeccaApiError } from '../../lib/api'

/** $25, $50, $100. MoonPay's sell minimum is about $20 (19.65 RLUSD), so the smallest chip clears it. */
export const WITHDRAW_CHIPS = [2500, 5000, 10000] as const

export type WithdrawChip = { minor: number; allowed: boolean; why?: 'limit' | 'balance' }

/** Which chips fit the per-payment cap (tier 0: $50) and the available balance. An unknown balance allows them (the API checks). */
export function withdrawChips(o: { tier: Tier; availableMinor: number | null; limits: Limits }): WithdrawChip[] {
  const cap = o.tier === 0 ? o.limits.tier0.txCapMinor : o.limits.txCapMinor
  return WITHDRAW_CHIPS.map((minor) =>
    minor > cap ? { minor, allowed: false, why: 'limit' } : o.availableMinor !== null && minor > o.availableMinor ? { minor, allowed: false, why: 'balance' } : { minor, allowed: true },
  )
}

/** The withdrawal as GET /v1/ramp/sell/:id returns it. */
export type WithdrawalView = {
  id: string
  status: 'approve' | 'sending' | 'sent' | 'paid_out' | 'failed'
  amountMinor: number
  refunded: boolean
  message?: string
  moonpayStatus?: string
  sandbox: true
  createdAt: string
}

export type DepositRequest = { externalId: string; transactionId: string; depositWalletAddress?: string; depositWalletAddressTag?: string | number }
export type DepositResponse = { intent: Intent; prepared: PreparedTx; withdrawal: WithdrawalView }

/**
 * The widget's onInitiateDeposit props -> the deposit request. Only the sale id and where to deposit: the API reads the
 * amount and currency from MoonPay itself.
 */
export function depositRequest(externalId: string, props: unknown): DepositRequest | null {
  const p = props && typeof props === 'object' ? (props as Record<string, unknown>) : null
  if (!p || typeof p.transactionId !== 'string' || !p.transactionId) return null
  const tag = p.depositWalletAddressTag
  return {
    externalId,
    transactionId: p.transactionId,
    ...(typeof p.depositWalletAddress === 'string' && p.depositWalletAddress ? { depositWalletAddress: p.depositWalletAddress } : {}),
    ...((typeof tag === 'string' && tag !== '') || typeof tag === 'number' ? { depositWalletAddressTag: tag } : {}),
  }
}

export const isFinal = (s: WithdrawalView['status']) => s === 'paid_out' || s === 'failed'

export function statusCopy(v: WithdrawalView): { title: string; body: string; arches: 'running' | 'done' | 'failed' } {
  switch (v.status) {
    case 'approve':
    case 'sending':
      return { title: `Sending ${formatUsd(v.amountMinor)} to MoonPay.`, body: 'This takes a few seconds.', arches: 'running' }
    case 'sent':
      return { title: 'Sent to MoonPay.', body: 'MoonPay pays it out to your card, usually within minutes.', arches: 'done' }
    case 'paid_out':
      return { title: 'Paid out to your card.', body: `MoonPay has paid out ${formatUsd(v.amountMinor)}, minus its fees.`, arches: 'done' }
    case 'failed':
      return { title: "This withdrawal didn't go through.", body: v.message ?? (v.refunded ? 'The money is back in your balance.' : 'Our team has been told.'), arches: 'failed' }
  }
}

const OFFLINE = "Can't reach Zecca right now. Check your connection and try again."
const UNKNOWN = 'Something went wrong on our side. Try again in a moment.'

export function createWithdrawApi(o: { origin: string; getToken: () => string | null | undefined; fetch?: typeof fetch }) {
  const origin = o.origin.replace(/\/$/, '')
  async function req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = o.getToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await (o.fetch ?? fetch)(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch {
      throw new ZeccaApiError(0, { code: 'upstream_error', message: OFFLINE })
    }
    if (!res.ok) {
      const parsed = ApiError.safeParse(await res.json().catch(() => null))
      throw new ZeccaApiError(res.status, parsed.success ? parsed.data.error : { code: res.status >= 500 ? 'internal' : 'bad_request', message: UNKNOWN })
    }
    return (await res.json()) as T
  }
  return {
    deposit: (b: DepositRequest) => req<DepositResponse>('POST', '/v1/ramp/sell/deposit', b),
    status: (id: string) => req<WithdrawalView>('GET', `/v1/ramp/sell/${encodeURIComponent(id)}`),
  }
}
