// One signer interface over the two implementations (config.signerMode): mock (local key) and privy (xrpl-connect).
export interface WalletSigner {
  kind: 'mock' | 'privy'
  address: string
  publicKey: string
  /** Signs a fully prepared tx (the API filled every field). Returns the signed blob. */
  sign(tx: Record<string, unknown>): Promise<{ tx_blob: string; hash: string }>
}

/** The subset of Storage the wallet code needs (localStorage in the browser, a Map in tests). */
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void }

/** localStorage, or null when it is blocked (private mode, SSR). */
export function browserStorage(): KV | null {
  try {
    if (typeof window === 'undefined') return null
    const k = '__zecca_probe__'
    window.localStorage.setItem(k, '1')
    window.localStorage.removeItem(k)
    return window.localStorage
  } catch {
    return null
  }
}
