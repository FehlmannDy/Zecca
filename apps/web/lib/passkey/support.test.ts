import { describe, expect, it } from 'vitest'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { deriveAddress, deriveKeypair, generateSeed, sign } from 'ripple-keypairs'
import { passkeyErrorMessage } from './errors'
import { fakeCredentials, fakePrivy } from './fake-privy'
import { installPasskeyMfa } from './install'
import { PasskeyMfaError } from './mfa-handler'
import { verifySignedBlob } from './verify'

describe('passkeyErrorMessage', () => {
  const ours = new PasskeyMfaError('mfa_canceled', 'Face ID was cancelled. Nothing was sent.')
  it('finds our message under the wallet errors that wrap it', () => {
    expect(passkeyErrorMessage(ours)).toBe('Face ID was cancelled. Nothing was sent.')
    const wrapped = Object.assign(new Error('Failed to sign transaction. Face ID was cancelled. Nothing was sent.'), { name: 'WalletError', code: 'SIGN_FAILED', originalError: ours })
    expect(passkeyErrorMessage(wrapped)).toBe('Face ID was cancelled. Nothing was sent.')
    expect(passkeyErrorMessage(Object.assign(new Error('x'), { cause: wrapped }))).toBe('Face ID was cancelled. Nothing was sent.')
  })
  it("turns the adapter's sign timeout into plain words", () => {
    const timeout = Object.assign(new Error('Privy hash signing timed out.'), { name: 'WalletError', code: 'OPERATION_TIMEOUT' })
    expect(passkeyErrorMessage(timeout)).toBe('The approval took too long. Nothing was sent. Try again.')
  })
  it('returns null for anything else', () => {
    expect(passkeyErrorMessage(new Error('boom'))).toBeNull()
    expect(passkeyErrorMessage(undefined)).toBeNull()
  })
})

describe('verifySignedBlob', () => {
  const seed = generateSeed({ algorithm: 'ecdsa-secp256k1' })
  const kp = deriveKeypair(seed)
  const tx = { TransactionType: 'AccountSet', Account: deriveAddress(kp.publicKey), Fee: '12', Sequence: 1, LastLedgerSequence: 1, SigningPubKey: kp.publicKey }
  const blob = encode({ ...tx, TxnSignature: sign(encodeForSigning(tx), kp.privateKey) })

  it("checks the signature against the blob's own SigningPubKey and the expected key", () => {
    expect(verifySignedBlob(blob, kp.publicKey)).toEqual({ ok: true, account: tx.Account, transactionType: 'AccountSet' })
  })
  it('fails for another key or a tampered blob', () => {
    const other = deriveKeypair(generateSeed({ algorithm: 'ecdsa-secp256k1' })).publicKey
    expect(verifySignedBlob(blob, other).ok).toBe(false)
    const tampered = encode({ ...tx, Fee: '13', TxnSignature: sign(encodeForSigning(tx), kp.privateKey) })
    expect(verifySignedBlob(tampered, kp.publicKey).ok).toBe(false)
  })
})

describe('installPasskeyMfa', () => {
  it('installs one handler per Privy client, and none before sign-in', () => {
    const p = fakePrivy({ enrolled: true })
    const adapter = { session: { client: p.client } }
    const a = installPasskeyMfa(adapter, { credentials: fakeCredentials() })
    const b = installPasskeyMfa({ adapter })
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(p.listenerCount()).toBe(1)
    expect(installPasskeyMfa({ session: {} })).toBeNull()
  })
  it('lets the page listen to prompts after install', async () => {
    const p = fakePrivy({ enrolled: true })
    const h = installPasskeyMfa({ session: { client: p.client } }, { credentials: fakeCredentials(), origin: 'https://zecca.test' })!
    const seen: string[] = []
    const off = h.subscribe((e) => e.type !== 'log' && seen.push(e.type))
    await p.sign()
    off()
    await p.sign()
    expect(seen).toEqual(['prompt', 'done'])
  })
})
