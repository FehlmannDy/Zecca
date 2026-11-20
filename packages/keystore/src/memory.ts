import type { ElGamalKeyPair, ElGamalOwner, KeyStore, WalletRole, WalletSecret } from '@zecca/contracts'
import xrpl from 'xrpl'

export type KeyStoreState = {
  wallets: Partial<Record<WalletRole, WalletSecret>>
  elgamal: { issuer?: ElGamalKeyPair; pool?: ElGamalKeyPair; users: Record<string, ElGamalKeyPair> }
  meta: Record<string, string>
}

export type KeyStoreOptions = {
  /** Defaults to xrpl.deriveConfidentialKeypair(). */
  generateElGamal?: () => ElGamalKeyPair
  initial?: KeyStoreState
  /** Called after every write (the file store persists here). */
  onChange?: (state: KeyStoreState) => void
}

export const emptyState = (): KeyStoreState => ({ wallets: {}, elgamal: { users: {} }, meta: {} })

const ownerName = (o: ElGamalOwner) => (typeof o === 'string' ? o : `user ${o.user}`)

/** In-memory KeyStore (tests, and the core of the encrypted-file store). */
export function createMemoryKeyStore(opts: KeyStoreOptions = {}): KeyStore & { snapshot(): KeyStoreState } {
  const state: KeyStoreState = opts.initial ? structuredClone(opts.initial) : emptyState()
  state.elgamal.users ??= {}
  const gen = opts.generateElGamal ?? (() => xrpl.deriveConfidentialKeypair() as ElGamalKeyPair)
  const changed = () => opts.onChange?.(state)

  const getKp = (o: ElGamalOwner): ElGamalKeyPair | undefined =>
    typeof o === 'string' ? state.elgamal[o] : state.elgamal.users[o.user]

  return {
    getWallet(role) {
      const w = state.wallets[role]
      if (!w) throw new Error(`key store: no wallet for role ${role}`)
      return w
    },
    hasWallet: (role) => Boolean(state.wallets[role]),
    setWallet(role, secret) {
      state.wallets[role] = { ...secret }
      changed()
    },
    getElGamal(owner) {
      const kp = getKp(owner)
      if (!kp) throw new Error(`key store: no ElGamal key for ${ownerName(owner)}`)
      return kp
    },
    setElGamal(owner, kp) {
      if (typeof owner === 'string') state.elgamal[owner] = { ...kp }
      else state.elgamal.users[owner.user] = { ...kp }
      changed()
    },
    createUserElGamal(address) {
      const existing = state.elgamal.users[address]
      if (existing) return existing.publicKey
      const kp = gen()
      state.elgamal.users[address] = { publicKey: kp.publicKey, privateKey: kp.privateKey }
      changed()
      return kp.publicKey
    },
    has: (owner) => Boolean(getKp(owner)),
    getMeta: (key) => state.meta[key],
    setMeta(key, value) {
      state.meta[key] = value
      changed()
    },
    snapshot: () => structuredClone(state),
  }
}
