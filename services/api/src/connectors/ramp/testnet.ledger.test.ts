// Ledger layer (real XRPL Testnet, read only): the live reader fetches the real MoonPay sandbox delivery of 2026-11-20 and the
// check the credit path runs accepts it for the wallet it went to, and refuses it for any other treasury.
import { afterAll, describe, expect, it } from 'vitest'
import { checkDelivery, creditMinor } from './delivery'
import { createLiveTestnetReader } from './testnet'

const DELIVERY = '548D695E91F1F48720D64F0380C084DE3E0A6A4F97CA1599B79324FB5A1F8939'
const PROBE_WALLET = 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS'

describe('Testnet reader + delivery check (real MoonPay sandbox delivery)', () => {
  const reader = createLiveTestnetReader()
  afterAll(() => reader.close())

  it('confirms 0.2852 RLUSD from Ripple testnet issuer, credited as $28.52 with the sandbox scale 100', async () => {
    const r = await reader.tx(DELIVERY)
    const c = checkDelivery(r, { hash: DELIVERY, treasury: PROBE_WALLET, currency: 'RLUSD' })
    expect(c).toEqual({ ok: true, currency: 'RLUSD', value: '0.2852' })
    expect(c.ok && creditMinor(c, 100)).toBe(2852)
    expect(checkDelivery(r, { hash: DELIVERY, treasury: 'rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p', currency: 'RLUSD' })).toMatchObject({ ok: false, final: true })
  })

  it('answers null for a hash the ledger does not know', async () => {
    expect(await reader.tx('0'.repeat(63) + '1')).toBeNull()
  })
})
