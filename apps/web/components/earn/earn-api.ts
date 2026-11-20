// The three Earn routes, called without the contract parse of lib/api: zod's parse drops the connector's fields beyond the
// contract (position: mode, rate, inFlight, lastFailure, ledger, stale; quote: microUsdPerXrp, rateAt, rateSource), and the
// screen needs them. The contract part is still checked (a mismatch is logged, as lib/api does). Contract request filed;
// once the schemas carry these fields this file can go and the screen can use api.call.
import { ApiError, EarnDepositResponse, EarnPosition, EarnWithdrawResponse, routePath, routes, type Intent, type PreparedTx } from '@zecca/contracts'
import type { z } from 'zod'
import { ZeccaApiError } from '../../lib/api'
import type { EarnPositionView, EarnQuoteView } from './earn-model'

const OFFLINE = "Can't reach Zecca right now. Check your connection and try again."
const UNKNOWN = 'Something went wrong on our side. Try again in a moment.'

export type EarnApiOptions = { origin: string; getToken?: () => string | null | undefined; fetch?: typeof fetch; onUnauthorized?: () => void }
export type EarnDepositView = { intent: Intent; prepared: PreparedTx; quote: EarnQuoteView }

export function createEarnApi(o: EarnApiOptions) {
  const origin = o.origin.replace(/\/$/, '')
  async function call<T>(name: 'earnPosition' | 'earnDeposit' | 'earnWithdraw', schema: z.ZodType, body?: unknown): Promise<T> {
    const def = routes[name]
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = o.getToken?.()
    if (token) headers.authorization = `Bearer ${token}`
    if (def.method === 'POST') headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await (o.fetch ?? fetch)(origin + routePath(name), { method: def.method, headers, body: def.method === 'POST' ? JSON.stringify(body ?? {}) : undefined })
    } catch {
      throw new ZeccaApiError(0, { code: 'upstream_error', message: OFFLINE })
    }
    if (!res.ok) {
      if (res.status === 401) o.onUnauthorized?.()
      const parsed = ApiError.safeParse(await res.json().catch(() => null))
      throw new ZeccaApiError(res.status, parsed.success ? parsed.data.error : { code: res.status >= 500 ? 'internal' : 'bad_request', message: UNKNOWN })
    }
    const data: unknown = await res.json()
    const checked = schema.safeParse(data)
    if (!checked.success) console.warn(`[earn] ${name}: response does not match the contract`, checked.error.issues.slice(0, 3))
    return data as T
  }
  return {
    position: () => call<EarnPositionView>('earnPosition', EarnPosition),
    deposit: (amountMinor: number) => call<EarnDepositView>('earnDeposit', EarnDepositResponse, { amountMinor }),
    withdraw: (amountDrops: number) => call<{ status: 'requested'; claimableAt: string }>('earnWithdraw', EarnWithdrawResponse, { amountDrops }),
  }
}

export type EarnApi = ReturnType<typeof createEarnApi>
