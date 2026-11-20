// SIGNER_MODE=privy: xrpl-connect's WalletManager with the Privy adapter, as run in privy-xrpl-probe/web/main.js.
// Browser only: everything is loaded with dynamic import, never during server rendering.
import type { WalletManager } from 'xrpl-connect'
import type { PrivyAdapter } from '@xrpl-commons/xrpl-connect-privy'
import type { WalletSigner } from './types'

export type PrivyHandle = { manager: WalletManager; adapter: PrivyAdapter }

let handle: Promise<PrivyHandle> | null = null

/** The one manager for the page (also used by /wallet/privy, which must reconnect the same instance). */
export function getPrivy(appId: string): Promise<PrivyHandle> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Privy runs in the browser only'))
  handle ??= (async () => {
    const [{ WalletManager }, { PrivyAdapter }] = await Promise.all([import('xrpl-connect'), import('@xrpl-commons/xrpl-connect-privy')])
    const adapter = new PrivyAdapter({ appId, redirectUri: `${window.location.origin}/wallet/privy` })
    const manager = new WalletManager({ adapters: [adapter], network: 'devnet', autoConnect: false })
    return { manager, adapter }
  })()
  return handle
}

/**
 * The Privy access token the API verifies (DECISIONS #4). The adapter (pinned at 1.1.0-rc.0) has no public
 * accessor; its js-sdk-core client is reachable at runtime.
 */
export async function privyAccessToken(adapter: PrivyAdapter): Promise<string> {
  const client = (adapter as unknown as { session?: { client?: { getAccessToken?: () => Promise<string | null> } } }).session?.client
  const token = await client?.getAccessToken?.()
  if (!token) throw new Error("We couldn't finish signing you in. Try again.")
  return token
}

/** manager.sign leaves a fully prepared tx untouched (DECISIONS #5) and returns the signed blob. */
export function privySigner(manager: WalletManager): WalletSigner {
  const account = manager.account
  if (!account?.publicKey) throw new Error('Sign in again to approve.')
  return {
    kind: 'privy',
    address: account.address,
    publicKey: account.publicKey,
    async sign(tx) {
      const signed = await manager.sign(tx as never)
      const out = signed as unknown as { tx_blob?: string; hash?: string }
      if (!out.tx_blob || !out.hash) throw new Error('The approval did not complete. Try again.')
      return { tx_blob: out.tx_blob, hash: out.hash }
    },
  }
}
