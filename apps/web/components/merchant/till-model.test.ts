import { describe, expect, it } from 'vitest'
import type { PaymentRequest } from '@zecca/contracts'
import { expiresIn, isAndroid, mergeRequest, nfcAppUrl, tillPhase, tillStatusLine } from './till-model'

const pr = (status: PaymentRequest['status'], extra: Partial<PaymentRequest> = {}): PaymentRequest => ({
  id: 'pr_1',
  merchantId: 'usr_b',
  merchantName: 'Caffè Bruno',
  amountMinor: 450,
  status,
  url: 'https://zecca.example/pay/pr_1',
  expiresAt: '2026-11-21T09:10:00.000Z',
  ...extra,
})

describe('till view model', () => {
  it('phase follows the request: entry, creating, waiting, paying, paid, expired, cancelled', () => {
    expect(tillPhase(null, false)).toBe('entry')
    expect(tillPhase(null, true)).toBe('creating')
    expect(tillPhase(pr('created'), false)).toBe('waiting')
    expect(tillPhase(pr('opened'), false)).toBe('paying')
    expect(tillPhase(pr('paid'), false)).toBe('paid')
    expect(tillPhase(pr('expired'), false)).toBe('expired')
    expect(tillPhase(pr('cancelled'), false)).toBe('cancelled')
  })

  it('status lines are the UI copy', () => {
    expect(tillStatusLine('waiting')).toBe('Waiting for the customer')
    expect(tillStatusLine('paying')).toBe('Customer is paying')
    expect(tillStatusLine('paid')).toBe('Paid')
    expect(tillStatusLine('expired')).toBe('This request has expired.')
    expect(tillStatusLine('cancelled')).toBe('Charge cancelled.')
  })

  it('merging events never moves a request backwards and ignores other requests', () => {
    expect(mergeRequest(pr('created'), pr('opened')).status).toBe('opened')
    expect(mergeRequest(pr('paid', { paidAt: 'x' }), pr('opened')).status).toBe('paid')
    expect(mergeRequest(pr('opened'), pr('paid')).status).toBe('paid')
    expect(mergeRequest(pr('created'), pr('paid', { id: 'pr_2' })).status).toBe('created')
    expect(mergeRequest(null, pr('opened')).status).toBe('opened')
  })

  it('merging an unchanged copy keeps the current object, so a poll with no news does not re-render', () => {
    const current = pr('opened')
    expect(mergeRequest(current, pr('opened'))).toBe(current)
    expect(mergeRequest(current, pr('opened', { expiresAt: '2026-11-21T09:20:00.000Z' }))).not.toBe(current)
    const paid = pr('paid', { paidAt: '2026-11-21T09:01:00.000Z' })
    expect(mergeRequest(pr('opened'), paid)).toBe(paid)
  })

  it('NFC: the zecca-nfc:// deep link carries the encoded request url in its data (Firefox drops a data-less intent: link)', () => {
    expect(nfcAppUrl('https://zecca.example/pay/pr_1')).toBe('zecca-nfc://emit?url=https%3A%2F%2Fzecca.example%2Fpay%2Fpr_1')
    // The app splits the query on '&': the request url's own query stays inside the one url= parameter.
    expect(nfcAppUrl('https://zecca.example/pay/pr_1?a=1&b=2')).toBe('zecca-nfc://emit?url=https%3A%2F%2Fzecca.example%2Fpay%2Fpr_1%3Fa%3D1%26b%3D2')
  })

  it('Android detection from the user agent', () => {
    expect(isAndroid('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36')).toBe(true)
    expect(isAndroid('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15')).toBe(false)
  })

  it('expiresIn: m:ss left, never negative', () => {
    const at = Date.parse('2026-11-21T09:10:00.000Z')
    expect(expiresIn('2026-11-21T09:10:00.000Z', at - 581_000)).toBe('9:41')
    expect(expiresIn('2026-11-21T09:10:00.000Z', at - 5_000)).toBe('0:05')
    expect(expiresIn('2026-11-21T09:10:00.000Z', at + 5_000)).toBe('0:00')
  })
})
