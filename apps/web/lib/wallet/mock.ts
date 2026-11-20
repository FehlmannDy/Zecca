// SIGNER_MODE=mock: a local key with the same raw_sign contract as Privy (hash in, 64-byte r||s out).
// The seed is kept in localStorage per email, so "signing in" with the same email restores the same account.
import { mockRawSigner, signMessage, type MockRawSigner } from '@zecca/xrpl-core/signer'
import type { User } from '@zecca/contracts'
import type { ApiClient } from '../api'
import type { KV, WalletSigner } from './types'

const seedKey = (email: string) => `zecca.mockseed.${email.trim().toLowerCase()}`

export type MockWalletSigner = WalletSigner & { kind: 'mock'; rawSign: MockRawSigner['rawSign'] }

export function mockSignerForEmail(email: string, storage: KV | null): MockWalletSigner {
  const key = seedKey(email)
  const saved = storage?.getItem(key) ?? undefined
  const s = mockRawSigner(saved)
  if (!saved) storage?.setItem(key, s.seed)
  return { kind: 'mock', address: s.address, publicKey: s.publicKey, rawSign: s.rawSign, sign: (tx) => s.sign(tx) }
}

/** POST /auth/nonce, sign SHA-512Half(message) through raw_sign, POST /auth/session. */
export async function signInMock({ api, email, storage }: { api: ApiClient; email: string; storage: KV | null }): Promise<{ signer: MockWalletSigner; token: string; user?: User }> {
  const signer = mockSignerForEmail(email, storage)
  const { nonce, message } = await api.call('authNonce', { body: { address: signer.address, publicKey: signer.publicKey } })
  const signature = await signMessage(signer.rawSign, message)
  const { token, user } = await api.call('authSession', { body: { address: signer.address, publicKey: signer.publicKey, nonce, signature } })
  return { signer, token, user }
}
