// Privy access token verification (DECISIONS #4): ES256 JWT against the app's JWKS, then the user's linked XRPL wallet via the Privy API.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export interface PrivyVerifier {
  /** Resolves with the Privy user id when the token is valid and `address` is one of that user's XRPL wallets. Throws otherwise. */
  verify(token: string, address: string): Promise<{ privyUserId: string }>
}

export class PrivyAuthError extends Error {
  override name = 'PrivyAuthError'
}

type LinkedAccount = { type?: string; chain_type?: string; address?: string }

export function createPrivyVerifier(opts: {
  appId: string
  appSecret: string
  /** Test hook: a local key set instead of the remote JWKS. */
  jwks?: JWTVerifyGetKey
  fetch?: typeof fetch
  apiBase?: string
}): PrivyVerifier {
  const base = opts.apiBase ?? 'https://auth.privy.io'
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(`${base}/api/v1/apps/${opts.appId}/jwks.json`))
  const doFetch = opts.fetch ?? fetch
  const basic = Buffer.from(`${opts.appId}:${opts.appSecret}`).toString('base64')

  return {
    async verify(token, address) {
      let sub: string | undefined
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer: 'privy.io', audience: opts.appId, algorithms: ['ES256'] })
        sub = payload.sub
      } catch (e) {
        throw new PrivyAuthError(`privy token refused: ${(e as Error).message}`)
      }
      if (!sub) throw new PrivyAuthError('privy token has no subject')

      const res = await doFetch(`${base}/api/v1/users/${encodeURIComponent(sub)}`, {
        headers: { 'privy-app-id': opts.appId, authorization: `Basic ${basic}` },
      })
      if (!res.ok) throw new PrivyAuthError(`privy user lookup failed: ${res.status}`)
      const user = (await res.json()) as { id?: string; linked_accounts?: LinkedAccount[] }
      const linked = (user.linked_accounts ?? []).some(
        (a) => a.type === 'wallet' && a.chain_type === 'xrpl' && a.address === address,
      )
      if (!linked) throw new PrivyAuthError('address is not a wallet of this Privy user')
      return { privyUserId: sub }
    },
  }
}
