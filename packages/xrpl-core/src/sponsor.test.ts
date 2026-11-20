import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import { decode, encodeForSigning, encodeForSigningSponsor } from 'ripple-binary-codec'
import { mockRawSigner } from './signer'
import { cosignAsSponsor } from './sponsor'
import fixtures from './fixtures/validated-devnet.json'

const sponsor = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
const other = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)

async function userSigned(tx: Record<string, unknown>) {
  const user = mockRawSigner()
  const s = await user.sign({ Account: user.address, Fee: '10', Sequence: 5, LastLedgerSequence: 200, ...tx })
  return { user, ...s }
}

describe('cosignAsSponsor', () => {
  it('adds a SponsorSignature over the SPN-prefixed payload; the user signature still verifies; the hash changes', async () => {
    const { tx_blob, hash } = await userSigned({ TransactionType: 'AccountSet', Sponsor: sponsor.classicAddress, SponsorFlags: 1 })
    const out = cosignAsSponsor(sponsor, tx_blob)
    const tx = decode(out.tx_blob) as Record<string, any>
    expect(tx.SponsorSignature.SigningPubKey).toBe(sponsor.publicKey)
    expect(rk.verify(encodeForSigningSponsor(tx as never), tx.SponsorSignature.TxnSignature, sponsor.publicKey)).toBe(true)
    expect(rk.verify(encodeForSigning(tx as never), tx.TxnSignature, tx.SigningPubKey)).toBe(true)
    expect(out.hash).toBe(xrpl.hashes.hashSignedTx(out.tx_blob))
    expect(out.hash).not.toBe(hash)
  })

  it('co-signs Batch and confidential blobs (manual SPN fallback when xrpl.js validation refuses)', () => {
    for (const k of ['onboardingBrowser', 'sendToPoolBrowser'] as const) {
      const f = decode(fixtures[k].tx_blob) as Record<string, any>
      delete f.SponsorSignature
      f.Sponsor = sponsor.classicAddress
      const out = cosignAsSponsor(sponsor, xrpl.encode(f as never))
      const tx = decode(out.tx_blob) as Record<string, any>
      expect(tx.SponsorSignature.SigningPubKey).toBe(sponsor.publicKey)
      expect(rk.verify(encodeForSigningSponsor(tx as never), tx.SponsorSignature.TxnSignature, sponsor.publicKey)).toBe(true)
      expect(tx.TxnSignature).toBe(f.TxnSignature)
    }
  })

  it('reproduces the validated Devnet sponsor signature payload (onboarding Batch and confidential send)', () => {
    for (const k of ['onboardingBrowser', 'sendToPoolBrowser'] as const) {
      const tx = decode(fixtures[k].tx_blob) as Record<string, any>
      expect(rk.verify(encodeForSigningSponsor(tx as never), tx.SponsorSignature.TxnSignature, tx.SponsorSignature.SigningPubKey)).toBe(true)
    }
  })

  it('refuses a blob whose Sponsor is another account', async () => {
    const { tx_blob } = await userSigned({ TransactionType: 'AccountSet', Sponsor: other.classicAddress, SponsorFlags: 1 })
    expect(() => cosignAsSponsor(sponsor, tx_blob)).toThrow(/not sponsored by this backend/)
  })

  it('refuses a blob without a Sponsor', async () => {
    const { tx_blob } = await userSigned({ TransactionType: 'AccountSet' })
    expect(() => cosignAsSponsor(sponsor, tx_blob)).toThrow(/not sponsored by this backend/)
  })

  it('refuses a blob without the user TxnSignature', () => {
    const user = mockRawSigner()
    const blob = xrpl.encode({ TransactionType: 'AccountSet', Account: user.address, Fee: '10', Sequence: 1, SigningPubKey: user.publicKey, Sponsor: sponsor.classicAddress, SponsorFlags: 1 } as never)
    expect(() => cosignAsSponsor(sponsor, blob)).toThrow(/user signature missing/)
  })

  it('refuses a blob that is already co-signed', async () => {
    const { tx_blob } = await userSigned({ TransactionType: 'AccountSet', Sponsor: sponsor.classicAddress, SponsorFlags: 1 })
    const once = cosignAsSponsor(sponsor, tx_blob)
    expect(() => cosignAsSponsor(sponsor, once.tx_blob)).toThrow(/already co-signed/)
  })
})
