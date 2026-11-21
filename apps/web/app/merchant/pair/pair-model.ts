// "Pair a till" (apps/merchant-till): the API calls behind /merchant/pair and the words on the screen.
// The till routes are not in the shared route table (a till token is its own kind of auth), so this is a small client of its own.
import { ApiError } from '@zecca/contracts'
import { ZeccaApiError } from '../../../lib/api'

export type PairingCode = { pairingCode: string; qrPayload: string; expiresAt: string }
export type TillView = { id: string; name: string; pairedAt: string; lastSeenAt?: string }

/** The Android app, as committed in the public repository. */
export const TILL_APK_URL = 'https://github.com/FehlmannDy/Zecca/raw/main/apps/merchant-till/release/zecca-till.apk'

const OFFLINE = "Can't reach Zecca right now. Check your connection and try again."
const UNKNOWN = 'Something went wrong on our side. Try again in a moment.'

export function createTillsApi(o: { origin: string; getToken: () => string | null | undefined; fetch?: typeof fetch }) {
  const origin = o.origin.replace(/\/$/, '')
  async function req<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = o.getToken()
    if (token) headers.authorization = `Bearer ${token}`
    let res: Response
    try {
      res = await (o.fetch ?? fetch)(origin + path, { method, headers })
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
    newCode: () => req<PairingCode>('POST', '/v1/merchant/tills'),
    list: () => req<{ items: TillView[] }>('GET', '/v1/merchant/tills'),
    revoke: (id: string) => req<{ ok: true }>('POST', `/v1/merchant/tills/${encodeURIComponent(id)}/revoke`),
  }
}

/** "ABCD2345" -> "ABCD 2345": easier to read across a counter. */
export const formatCode = (code: string): string => (code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code)

/** The till in `after` that was not in `before`: the one that just paired. */
export function newTillAfter(before: TillView[], after: TillView[]): TillView | undefined {
  const known = new Set(before.map((t) => t.id))
  return after.find((t) => !known.has(t.id))
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `on ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/** "Paired 30 min ago · Used 5 min ago" */
export function tillSubtitle(t: TillView, now: number): string {
  return `Paired ${ago(t.pairedAt, now)}` + (t.lastSeenAt ? ` · Used ${ago(t.lastSeenAt, now)}` : '')
}
