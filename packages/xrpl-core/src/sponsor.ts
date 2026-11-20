// Sponsor co-signature (XLS-68). Ported from privy-xrpl-probe probe.mjs:37 sponsorCosign / web/server.mjs:109 cosignAndSubmit.
// The user signs first; the sponsor signs after, over the SPN\0-prefixed payload (SponsorSignature is not a signing field).
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import { decode, encode, encodeForSigningSponsor } from 'ripple-binary-codec'

export function cosignAsSponsor(sponsorWallet: xrpl.Wallet, userSignedBlob: string): { tx_blob: string; hash: string } {
  const tx = decode(userSignedBlob) as Record<string, unknown>
  if (tx.Sponsor !== sponsorWallet.classicAddress) throw new Error('tx is not sponsored by this backend')
  if (!tx.TxnSignature) throw new Error('user signature missing')
  if (tx.SponsorSignature) throw new Error('tx is already co-signed by a sponsor')
  try {
    const s = xrpl.signAsSponsor(sponsorWallet, userSignedBlob)
    return { tx_blob: s.tx_blob, hash: s.hash }
  } catch {
    // xrpl.js validation refuses some shapes (confidential, Batch): sign the same SPN-prefixed bytes by hand.
    tx.SponsorSignature = {
      SigningPubKey: sponsorWallet.publicKey,
      TxnSignature: rk.sign(encodeForSigningSponsor(tx as never), sponsorWallet.privateKey),
    }
    const out = encode(tx as never)
    return { tx_blob: out, hash: xrpl.hashes.hashSignedTx(out) }
  }
}
