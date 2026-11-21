// Ledger layer (real XRPL Testnet): the withdrawal's treasury payer, with a fresh faucet-funded treasury (never the real key
// store). It reads what it can pay, pays 1 drop with a destination tag to the probe wallet (hash handed over before submit),
// reads the outcome back by hash, and a payment it cannot make (RLUSD without a trust line) fails final, as the refund expects.
// Run: npm run test:ledger -- services/api/src/connectors/ramp/treasury  (unsandboxed)
import { afterAll, describe, expect, it } from 'vitest'
import { fund, generateWalletSecret } from '@zecca/xrpl-core'
import { fakeKeyStore } from '../../testing/fakes'
import { paymentAmount } from './sell'
import { createLiveTreasuryPayer, type SignedPayment } from './treasury'

const PROBE_WALLET = 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS'

describe('Testnet treasury payer (withdrawal)', () => {
  const keystore = fakeKeyStore()
  const secret = generateWalletSecret('ed25519')
  keystore.setWallet('testnetTreasury', secret)
  const payer = createLiveTreasuryPayer({ keystore, log: (m) => process.stderr.write(`${m}\n`) })
  afterAll(() => payer.client.close())

  it('pays MoonPay-style (XRP, destination tag), hash known before submit, outcome readable by hash; RLUSD it does not hold fails final', async () => {
    await fund(secret.address, 'testnet')
    for (let i = 0; i < 20 && !(await payer.client.accountInfo(secret.address)); i++) await new Promise((r) => setTimeout(r, 2000))
    expect(await payer.canPay(paymentAmount('XRP', '0.000001'))).toBe(true)
    expect(await payer.canPay(paymentAmount('XRP', '1000000'))).toBe(false)
    expect(await payer.canPay(paymentAmount('RLUSD', '19.65'))).toBe(false)

    let signed: SignedPayment | undefined
    const r = await payer.pay({ destination: PROBE_WALLET, tag: 424242, amount: paymentAmount('XRP', '0.000001') }, (s) => (signed = s))
    expect(r).toMatchObject({ validated: true, engineResult: 'tesSUCCESS' })
    expect(signed?.hash).toBe(r.hash)
    expect(signed!.lastLedgerSequence).toBeGreaterThan(0)
    expect(await payer.txResult(r.hash)).toEqual({ validated: true, engineResult: 'tesSUCCESS' })
    expect(await payer.txResult('0'.repeat(63) + '1')).toBeNull()
    expect(await payer.ledgerIndex()).toBeGreaterThanOrEqual(r.ledgerIndex!)

    const bad = await payer.pay({ destination: PROBE_WALLET, amount: paymentAmount('RLUSD', '1') }, () => {})
    expect(bad.validated).toBe(false)
    expect(bad.engineResult).toMatch(/^tec/)
  })
})
