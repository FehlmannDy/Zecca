import { describe, expect, it } from 'vitest'
import { createTillsApi, formatCode, newTillAfter, tillSubtitle, type TillView } from './pair-model'

const t = (id: string, name = 'Till', pairedAt = '2026-11-21T09:00:00.000Z', lastSeenAt?: string): TillView => ({ id, name, pairedAt, ...(lastSeenAt ? { lastSeenAt } : {}) })

describe('pair a till: model', () => {
  it('shows the code in two groups of four', () => {
    expect(formatCode('ABCD2345')).toBe('ABCD 2345')
    expect(formatCode('ABC')).toBe('ABC')
  })

  it('finds the till that just paired', () => {
    expect(newTillAfter([t('a')], [t('b', 'Pixel 8'), t('a')])?.name).toBe('Pixel 8')
    expect(newTillAfter([t('a')], [t('a')])).toBeUndefined()
  })

  it('says when a till was paired and last used, in plain words', () => {
    const now = Date.parse('2026-11-21T09:30:00.000Z')
    expect(tillSubtitle(t('a', 'Pixel 8', '2026-11-21T09:29:40.000Z'), now)).toBe('Paired just now')
    expect(tillSubtitle(t('a', 'Pixel 8', '2026-11-21T09:00:00.000Z', '2026-11-21T09:25:00.000Z'), now)).toBe('Paired 30 min ago · Used 5 min ago')
    expect(tillSubtitle(t('a', 'Pixel 8', '2026-11-21T06:00:00.000Z'), now)).toBe('Paired 3 h ago')
  })

  it('calls the till routes with the session and turns errors into their English message', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/v1/merchant/tills') && init.method === 'POST')
        return new Response(JSON.stringify({ pairingCode: 'ABCD2345', qrPayload: 'zecca-till://pair?api=x&code=ABCD2345', expiresAt: '2026-11-21T09:10:00.000Z' }), { status: 200 })
      if (url.endsWith('/v1/merchant/tills')) return new Response(JSON.stringify({ items: [t('a')] }), { status: 200 })
      return new Response(JSON.stringify({ error: { code: 'not_found', message: "We couldn't find this till." } }), { status: 404 })
    }) as unknown as typeof fetch
    const api = createTillsApi({ origin: 'http://api.test/', getToken: () => 'tok', fetch: fetchImpl })
    expect((await api.newCode()).pairingCode).toBe('ABCD2345')
    expect((await api.list()).items).toHaveLength(1)
    await expect(api.revoke('till_x')).rejects.toThrow("We couldn't find this till.")
    expect(calls[0]).toMatchObject({ url: 'http://api.test/v1/merchant/tills', init: { method: 'POST', headers: { authorization: 'Bearer tok' } } })
    expect(calls[2].url).toBe('http://api.test/v1/merchant/tills/till_x/revoke')

    const offline = createTillsApi({ origin: 'http://api.test', getToken: () => 'tok', fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch })
    await expect(offline.list()).rejects.toThrow("Can't reach Zecca right now. Check your connection and try again.")
  })
})
