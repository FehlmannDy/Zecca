import { describe, expect, it } from 'vitest'
import { DEFAULTS, type Limits } from '@zecca/contracts'
import { ZeccaApiError } from '../../lib/api'
import { createWithdrawApi, depositRequest, isFinal, statusCopy, withdrawChips, type WithdrawalView } from './withdraw'

const limits: Limits = {
  txCapMinor: DEFAULTS.TX_CAP_MINOR,
  dailyCapMinor: DEFAULTS.DAILY_CAP_MINOR,
  tier0: { balanceCapMinor: DEFAULTS.TIER0_BALANCE_CAP_MINOR, txCapMinor: DEFAULTS.TIER0_TX_CAP_MINOR, monthlySendCapMinor: DEFAULTS.TIER0_MONTHLY_SEND_CAP_MINOR },
}

describe('withdrawChips: whole dollars from $25, within the balance and the per-payment cap', () => {
  it('tier 0: up to the $50 per-payment cap and the balance', () => {
    expect(withdrawChips({ tier: 0, availableMinor: 5000, limits })).toEqual([
      { minor: 2500, allowed: true },
      { minor: 5000, allowed: true },
      { minor: 10000, allowed: false, why: 'limit' },
    ])
    expect(withdrawChips({ tier: 0, availableMinor: 3000, limits }).map((c) => c.allowed)).toEqual([true, false, false])
    expect(withdrawChips({ tier: 0, availableMinor: 3000, limits })[1]).toEqual({ minor: 5000, allowed: false, why: 'balance' })
  })
  it('tier 1: the balance decides; unknown balance allows all (the API checks again)', () => {
    expect(withdrawChips({ tier: 1, availableMinor: 20000, limits }).every((c) => c.allowed)).toBe(true)
    expect(withdrawChips({ tier: 1, availableMinor: null, limits }).every((c) => c.allowed)).toBe(true)
  })
})

describe('depositRequest: what onInitiateDeposit hands us (amounts are left out: the API reads them from MoonPay)', () => {
  it('keeps the sale id and the deposit address and tag', () => {
    expect(
      depositRequest('ramp_1', { transactionId: 'mps-1', cryptoCurrency: { code: 'xrp' }, cryptoCurrencyAmount: '21.77', depositWalletAddress: 'rUZTCFB6zPyeEmDhrAVqVbBaLPWrzjKCQz', depositWalletAddressTag: 42 }),
    ).toEqual({ externalId: 'ramp_1', transactionId: 'mps-1', depositWalletAddress: 'rUZTCFB6zPyeEmDhrAVqVbBaLPWrzjKCQz', depositWalletAddressTag: 42 })
    expect(depositRequest('ramp_1', { transactionId: 'mps-1' })).toEqual({ externalId: 'ramp_1', transactionId: 'mps-1' })
  })
  it('refuses props without a sale id', () => {
    expect(depositRequest('ramp_1', {})).toBeNull()
    expect(depositRequest('ramp_1', null)).toBeNull()
  })
})

const view = (o: Partial<WithdrawalView>): WithdrawalView => ({ id: 'int_1', status: 'sending', amountMinor: 2500, refunded: false, sandbox: true, createdAt: '2026-11-21T09:00:00.000Z', ...o })

describe('statusCopy: Sent to MoonPay -> Paid out to your card / Failed', () => {
  it('says where the money is, in plain words', () => {
    expect(statusCopy(view({ status: 'sending' }))).toMatchObject({ title: 'Sending $25.00 to MoonPay.', arches: 'running' })
    expect(statusCopy(view({ status: 'sent' }))).toMatchObject({ title: 'Sent to MoonPay.', arches: 'done' })
    expect(statusCopy(view({ status: 'paid_out' }))).toMatchObject({ title: 'Paid out to your card.', arches: 'done' })
    expect(statusCopy(view({ status: 'failed', refunded: true, message: "This withdrawal didn't go through. The money is back in your balance." }))).toEqual({
      title: "This withdrawal didn't go through.",
      body: "This withdrawal didn't go through. The money is back in your balance.",
      arches: 'failed',
    })
  })
  it('keeps polling until paid out or failed', () => {
    expect(['approve', 'sending', 'sent', 'paid_out', 'failed'].map((s) => isFinal(s as WithdrawalView['status']))).toEqual([false, false, false, true, true])
  })
})

describe('createWithdrawApi', () => {
  it('posts the deposit with the session token and reads the status; API errors keep their message and code', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/v1/ramp/sell/int_1')) return new Response(JSON.stringify(view({ status: 'sent' })), { status: 200 })
      return new Response(JSON.stringify({ error: { code: 'limit_reached', message: 'Over the limit.', details: { limit: 'per_payment', capMinor: 5000 } } }), { status: 403 })
    }) as unknown as typeof fetch
    const api = createWithdrawApi({ origin: 'http://api.test/', getToken: () => 'tok', fetch: fetchImpl })
    expect((await api.status('int_1')).status).toBe('sent')
    const err = await api.deposit({ externalId: 'ramp_1', transactionId: 'mps-1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ZeccaApiError)
    expect(err).toMatchObject({ status: 403, code: 'limit_reached', message: 'Over the limit.', details: { limit: 'per_payment', capMinor: 5000 } })
    expect(calls[0]).toMatchObject({ url: 'http://api.test/v1/ramp/sell/int_1', init: { method: 'GET', headers: { authorization: 'Bearer tok' } } })
    expect(calls[1].url).toBe('http://api.test/v1/ramp/sell/deposit')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ externalId: 'ramp_1', transactionId: 'mps-1' })
  })
  it('turns a network failure into the offline message', async () => {
    const api = createWithdrawApi({ origin: 'http://api.test', getToken: () => undefined, fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch })
    await expect(api.status('x')).rejects.toMatchObject({ status: 0, code: 'upstream_error' })
  })
})
