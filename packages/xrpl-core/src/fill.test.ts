import { describe, expect, it } from 'vitest'
import { feeDrops, fillTx, MAX_USER_FEE_DROPS } from './fill'
import { decode } from 'ripple-binary-codec'
import fixtures from './fixtures/validated-devnet.json'

const fakeClient = (base = 1, ledger = 1000, seq = 33) => ({
  baseFeeDrops: async () => base,
  ledgerIndex: async () => ledger,
  nextSequence: async () => seq,
})

describe('feeDrops', () => {
  it('matches what validated on Devnet: confidential = 10 x base, Batch = 2 x base + inners + signers', () => {
    expect(feeDrops(decode(fixtures.sendToPoolBrowser.tx_blob) as never, 1)).toBe(10)
    expect(feeDrops(decode(fixtures.onboardingBrowser.tx_blob) as never, 1)).toBe(26)
    expect(feeDrops({ TransactionType: 'Payment' }, 12)).toBe(12)
  })
})

describe('fillTx', () => {
  it('a user tx: Sponsor + fee flag, Sequence, Fee, LastLedgerSequence = current + 150, SigningPubKey', async () => {
    const tx = await fillTx(fakeClient() as never, { TransactionType: 'ConfidentialMPTMergeInbox', Account: 'rUser' }, { sponsor: 'rSponsor', publicKey: '02AB' })
    expect(tx).toMatchObject({ Sponsor: 'rSponsor', SponsorFlags: 1, Sequence: 33, Fee: '10', LastLedgerSequence: 1150, SigningPubKey: '02AB' })
  })

  it('reserve sponsorship adds the reserve flag', async () => {
    const tx = await fillTx(fakeClient() as never, { TransactionType: 'CredentialAccept', Account: 'rUser' }, { sponsor: 'rSponsor', reserve: true })
    expect(tx.SponsorFlags).toBe(3)
  })

  it('our own tx: no sponsor, short window; keeps fields already set; does not mutate the input', async () => {
    const input = { TransactionType: 'Payment', Account: 'rPool', Sequence: 5, Fee: '20' }
    const tx = await fillTx(fakeClient() as never, input, {})
    expect(tx).toMatchObject({ Sequence: 5, Fee: '20', LastLedgerSequence: 1020 })
    expect(tx.Sponsor).toBeUndefined()
    expect(input).toEqual({ TransactionType: 'Payment', Account: 'rPool', Sequence: 5, Fee: '20' })
  })

  it('refuses a fee above 2 XRP (the Privy adapter refuses more)', async () => {
    await expect(fillTx(fakeClient(MAX_USER_FEE_DROPS) as never, { TransactionType: 'ConfidentialMPTSend', Account: 'rU' }, { sponsor: 'rS' })).rejects.toThrow(/fee/)
  })
})
