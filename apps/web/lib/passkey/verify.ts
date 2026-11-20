// Check a signed blob the way a validator would: the signature over the signing encoding, with the blob's
// SigningPubKey, which must be the key we expect. Used by the /dev/passkey page and the Playwright run.
import { decode, encodeForSigning } from 'ripple-binary-codec'
import { verify } from 'ripple-keypairs'

export function verifySignedBlob(txBlob: string, expectedPublicKey: string): { ok: boolean; account?: string; transactionType?: string } {
  try {
    const tx = decode(txBlob) as Record<string, unknown>
    const { TxnSignature, ...unsigned } = tx
    const key = String(tx.SigningPubKey ?? '')
    if (typeof TxnSignature !== 'string' || key.toUpperCase() !== expectedPublicKey.toUpperCase()) return { ok: false }
    const ok = verify(encodeForSigning(unsigned as never), TxnSignature, key)
    return ok ? { ok, account: String(tx.Account), transactionType: String(tx.TransactionType) } : { ok: false }
  } catch {
    return { ok: false }
  }
}
