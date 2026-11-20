import { describe, expect, it } from 'vitest'
import type { PaymentRequest } from '@zecca/contracts'
import { ZeccaApiError } from '../../lib/api'
import { paidAnnouncement, payErrorView, payHrefs, payLinkTarget, payState, payTitle } from './pay-model'

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

describe('pay page view model', () => {
  it('copy: the title and the screen reader announcement', () => {
    expect(payTitle(pr('opened'))).toBe('Pay $4.50 to Caffè Bruno')
    expect(paidAnnouncement(pr('paid'))).toBe('Paid, 4 dollars 50 to Caffè Bruno')
  })

  it('state: loading, load error, sign in, ready', () => {
    expect(payState({ request: null, signedIn: false }).kind).toBe('loading')
    expect(payState({ request: null, loadError: "We couldn't find this request.", signedIn: false })).toEqual({ kind: 'error', message: "We couldn't find this request." })
    expect(payState({ request: pr('opened'), signedIn: false }).kind).toBe('signin')
    expect(payState({ request: pr('created'), signedIn: true }).kind).toBe('ready')
  })

  it('state: the merchant opening their own request sees it, cannot pay it', () => {
    expect(payState({ request: pr('created'), signedIn: true, userId: 'usr_b' }).kind).toBe('own')
  })

  it('state: working while approving; paid when the request turns paid during our payment', () => {
    expect(payState({ request: pr('opened'), signedIn: true, paying: true }).kind).toBe('working')
    expect(payState({ request: pr('paid', { paidAt: '2026-11-21T09:01:00.000Z' }), signedIn: true, paying: true, paidByMe: true })).toEqual({
      kind: 'paid',
      at: '2026-11-21T09:01:00.000Z',
    })
  })

  it('state: the paid event can beat our submit answer; while our approval runs it is not "already paid"', () => {
    const paid = pr('paid', { paidAt: '2026-11-21T09:01:00.000Z' })
    expect(payState({ request: paid, signedIn: true, paying: true, paidByMe: false }).kind).toBe('working')
    // Our approval failed (someone else paid it): now it is.
    expect(payState({ request: paid, signedIn: true, paying: false, paidByMe: false }).kind).toBe('already_paid')
  })

  it('hrefs: sign in and top up both come back to this request, keeping the shop return path', () => {
    expect(payHrefs('pr_1', null)).toEqual({ signIn: '/app/signup?next=%2Fpay%2Fpr_1', topUp: '/app/topup?next=%2Fpay%2Fpr_1' })
    const back = '/demo/shop/checkout/ord_1'
    const here = `/pay/pr_1?return=${encodeURIComponent(back)}`
    expect(payHrefs('pr_1', back)).toEqual({ signIn: `/app/signup?next=${encodeURIComponent(here)}`, topUp: `/app/topup?next=${encodeURIComponent(here)}` })
  })

  it('state: terminal requests win over sign-in (expired, cancelled, already paid)', () => {
    expect(payState({ request: pr('expired'), signedIn: false }).kind).toBe('expired')
    expect(payState({ request: pr('cancelled'), signedIn: true }).kind).toBe('cancelled')
    expect(payState({ request: pr('paid', { paidAt: 'x' }), signedIn: true }).kind).toBe('already_paid')
  })

  it('state: a pay error shows its view, and the request state still wins when terminal', () => {
    const short = payErrorView(new ZeccaApiError(409, { code: 'insufficient_funds', message: 'You need $1.20 more.', details: { shortMinor: 120 } }))
    expect(short).toEqual({ kind: 'short', shortMinor: 120, message: 'You need $1.20 more.' })
    expect(payState({ request: pr('opened'), signedIn: true, failure: short }).kind).toBe('short')
    expect(payState({ request: pr('expired'), signedIn: true, failure: short }).kind).toBe('expired')
  })

  it('payErrorView maps the API codes', () => {
    const e = (code: ConstructorParameters<typeof ZeccaApiError>[1]['code'], message = 'm', details?: object) => new ZeccaApiError(409, { code, message, details })
    expect(payErrorView(e('limit_reached', 'cap', { limit: 'per_payment' }))).toEqual({ kind: 'limit', details: { limit: 'per_payment' }, message: 'cap' })
    expect(payErrorView(e('expired')).kind).toBe('expired')
    expect(payErrorView(e('already_paid')).kind).toBe('already_paid')
    expect(payErrorView(e('ledger_error', "The payment network didn't answer."))).toEqual({ kind: 'message', message: "The payment network didn't answer." })
    expect(payErrorView(new Error('Sign in again to approve.'))).toEqual({ kind: 'message', message: 'Sign in again to approve.' })
  })

  it('payLinkTarget: a pasted or scanned link (any origin) or a bare id becomes our /pay/<id>', () => {
    expect(payLinkTarget('https://zecca.example/pay/pr_01jdx5')).toBe('/pay/pr_01jdx5')
    expect(payLinkTarget('  http://localhost:3100/pay/pr_abc?x=1 ')).toBe('/pay/pr_abc')
    expect(payLinkTarget('pr_abc123')).toBe('/pay/pr_abc123')
    expect(payLinkTarget('https://evil.example/elsewhere')).toBeNull()
    expect(payLinkTarget('javascript:alert(1)')).toBeNull()
    expect(payLinkTarget('')).toBeNull()
    expect(payLinkTarget('/pay/../../x')).toBeNull()
  })
})
