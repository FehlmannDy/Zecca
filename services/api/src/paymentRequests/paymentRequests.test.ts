import { describe, expect, it } from 'vitest'
import { PaymentRequest, SalesResponse, feeMinor } from '@zecca/contracts'
import { createFakePool } from '../testing/fakes'
import { eventually, makeHarness } from '../testing/harness'
import { salesCsv } from './routes'

async function shop(o: Parameters<typeof makeHarness>[0] = {}) {
  const h = makeHarness(o)
  const bruno = await h.signUp('caffebruno', { role: 'merchant', businessName: 'Caffè Bruno', displayName: 'Bruno Esposito' })
  const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
  const create = async (amountMinor = 450, reference?: string) => {
    const r = await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor, ...(reference ? { reference } : {}) } })
    expect(r.status).toBe(200)
    return PaymentRequest.parse(r.body)
  }
  return { h, bruno, ana, create }
}

describe('payment requests', () => {
  it('create: url on WEB_ORIGIN, 10 minute expiry, merchant name', async () => {
    const { h, create } = await shop()
    const pr = await create(450, 'Table 4')
    expect(pr).toMatchObject({ status: 'created', merchantName: 'Caffè Bruno', amountMinor: 450, reference: 'Table 4', url: `http://localhost:3100/pay/${pr.id}` })
    expect(Date.parse(pr.expiresAt) - h.clock.now).toBe(600_000)
  })

  it('only merchants create requests', async () => {
    const { h, ana } = await shop()
    const r = await h.json('POST', '/v1/payment-requests', { token: ana.token, body: { amountMinor: 100 } })
    expect(r.status).toBe(403)
  })

  it('the first public read (or a non-merchant session) sets opened; the merchant reading does not', async () => {
    const { h, bruno, create } = await shop()
    const pr = await create()
    expect((await h.json('GET', `/v1/payment-requests/${pr.id}`, { token: bruno.token })).body.status).toBe('created')
    const pub = await h.json('GET', `/v1/payment-requests/${pr.id}`)
    expect(pub.status).toBe(200)
    expect(pub.body.status).toBe('opened')
    expect(h.app.core.bus.history().some((x) => x.to === `user:${bruno.user.id}` && x.event.type === 'payment_request.updated')).toBe(true)
  })

  it('pay: merchant intent with the fee, prepared send to the pool; Paid at received (D4), sale with fee and net', async () => {
    const pool = createFakePool({ auto: false })
    const { h, bruno, ana, create } = await shop({ pool })
    const pr = await create(450, 'Table 4')
    const p = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    expect(p.status).toBe(200)
    expect(p.body.intent).toMatchObject({ kind: 'merchant', amountMinor: 450, feeMinor: feeMinor(450, 50), paymentRequestId: pr.id, toUserId: bruno.user.id })
    expect(p.body.prepared.tx.Destination).toBe(h.keystore.getWallet('pool').address)

    const s = await h.submit(ana, p.body.prepared)
    expect(s.body.status).toBe('validated')
    // Not paid yet: the deposit is not verified.
    expect((await h.json('GET', `/v1/payment-requests/${pr.id}`)).body.status).not.toBe('paid')

    pool.emit({ type: 'received', intentId: p.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 450 })
    const paid = await eventually(async () => {
      const r = (await h.json('GET', `/v1/payment-requests/${pr.id}`)).body
      expect(r.status).toBe('paid')
      return r
    })
    expect(paid.intentId).toBe(p.body.intent.id)
    expect(paid.paidAt).toBeDefined()

    let sales = SalesResponse.parse((await h.json('GET', '/v1/merchant/sales', { token: bruno.token })).body)
    expect(sales.items[0]).toMatchObject({ paymentRequestId: pr.id, amountMinor: 450, feeMinor: 2, netMinor: 448, reference: 'Table 4', payer: { handle: 'ana' } })
    expect(sales.totals).toEqual({ grossMinor: 450, feeMinor: 2, netMinor: 448, count: 1 })

    await h.settle()
    expect(pool.payouts[0]).toMatchObject({ to: bruno.user.address, amountMinor: 448 })
    sales = SalesResponse.parse((await h.json('GET', '/v1/merchant/sales', { token: bruno.token })).body)
    expect(sales.items[0].payoutStatus).toBe('done')
    expect((await h.json('GET', '/v1/balance', { token: bruno.token })).body.availableMinor).toBe(5000 + 448)
    const act = (await h.json('GET', '/v1/activity', { token: bruno.token })).body.items[0]
    expect(act).toMatchObject({ direction: 'in', kind: 'merchant', amountMinor: 448, feeMinor: 2, note: 'Table 4', counterparty: { handle: 'ana' } })
    const anaAct = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items[0]
    expect(anaAct).toMatchObject({ direction: 'out', kind: 'merchant', amountMinor: 450, feeMinor: 0, counterparty: { displayName: 'Caffè Bruno', isMerchant: true } })
  })

  it('a second payment of a paid request gets 409 already_paid with the pay page copy', async () => {
    const { h, ana, create } = await shop()
    const pr = await create()
    const p = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    await h.submit(ana, p.body.prepared)
    await h.settle()
    const carla = await h.signUp('carla')
    const again = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: carla.token })
    expect(again.status).toBe(409)
    expect(again.body.error).toEqual({ code: 'already_paid', message: 'This request has already been paid.' })
  })

  it('only one intent can pay: two customers prepare, the second submit is refused', async () => {
    const pool = createFakePool({ auto: false })
    const { h, ana, create } = await shop({ pool })
    const carla = await h.signUp('carla')
    const pr = await create()
    const a = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    const c = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: carla.token })
    expect((await h.submit(ana, a.body.prepared)).body.status).toBe('validated')
    const r = await h.submit(carla, c.body.prepared)
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('already_paid')
    expect((await h.json('GET', '/v1/balance', { token: carla.token })).body.availableMinor).toBe(5000)
  })

  it('expired requests refuse payment with "This request has expired. Ask the merchant for a new one."', async () => {
    const { h, ana, create } = await shop()
    const pr = await create()
    h.clock.advance(601_000)
    const r = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    expect(r.status).toBe(409)
    expect(r.body.error).toEqual({ code: 'expired', message: 'This request has expired. Ask the merchant for a new one.' })
    expect((await h.json('GET', `/v1/payment-requests/${pr.id}`)).body.status).toBe('expired')
  })

  it('a request prepared before expiry but submitted after is refused and refunded', async () => {
    const { h, ana, create } = await shop()
    const pr = await create()
    h.clock.advance(500_000)
    const p = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    expect(p.status).toBe(200)
    h.clock.advance(101_000)
    const r = await h.submit(ana, p.body.prepared)
    expect(r.status).toBe(409)
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(5000)
  })

  it('the background job expires requests and tells the merchant', async () => {
    const { h, bruno, create } = await shop()
    const pr = await create()
    h.clock.advance(601_000)
    await h.app.jobs.tick()
    expect(h.app.core.bus.history().some((x) => x.to === `user:${bruno.user.id}` && x.event.type === 'payment_request.updated' && x.event.data.status === 'expired')).toBe(true)
    expect((await h.json('GET', `/v1/payment-requests/${pr.id}`)).body.status).toBe('expired')
  })

  it('cancel: merchant only; a cancelled request cannot be paid', async () => {
    const { h, bruno, ana, create } = await shop()
    const pr = await create()
    expect((await h.json('POST', `/v1/payment-requests/${pr.id}/cancel`, { token: ana.token })).status).toBe(403)
    const c = await h.json('POST', `/v1/payment-requests/${pr.id}/cancel`, { token: bruno.token })
    expect(c.status).toBe(200)
    expect(c.body.status).toBe('cancelled')
    const r = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toMatch(/cancelled/)
  })

  it('a merchant cannot pay their own request; unknown requests are 404', async () => {
    const { h, bruno, create } = await shop()
    const pr = await create()
    expect((await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: bruno.token })).status).toBe(400)
    expect((await h.json('GET', '/v1/payment-requests/pr_nope')).status).toBe(404)
  })

  it('sales filter by from/to; CSV has English headers and dollar amounts', async () => {
    const { h, bruno, ana, create } = await shop()
    const pr = await create(1234, 'Two "big" coffees, to go')
    const p = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    expect(p.status).toBe(200)
    expect((await h.submit(ana, p.body.prepared)).body.status).toBe('validated')
    await h.settle()
    const later = new Date(h.clock.now + 3_600_000).toISOString()
    expect((await h.json('GET', `/v1/merchant/sales?from=${encodeURIComponent(later)}`, { token: bruno.token })).body.totals.count).toBe(0)
    const res = await h.call('GET', '/v1/merchant/sales.csv', { token: bruno.token })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    const csv = await res.text()
    const [head, row] = csv.trim().split('\r\n')
    expect(head).toBe('Date (UTC),Reference,Customer,Amount,Fee,Net,Payout')
    expect(row).toContain('"Two ""big"" coffees, to go"')
    expect(row).toContain('$12.34,$0.06,$12.28,Paid out')
    expect(row).toContain('Ana Ferri (@ana)')
  })

  it('salesCsv formats an empty list as the header line only', () => {
    expect(salesCsv([])).toBe('Date (UTC),Reference,Customer,Amount,Fee,Net,Payout\r\n')
  })
})
