import { describe, expect, it } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { createPrivyVerifier } from './privy'

const APP = 'cmtestapp00000000000000'
const ADDR = 'r9PTtbEVNxpEhXEnKg7N8nddMzmJccmhbd'
const DID = 'did:privy:cm123'

async function setup(linked: unknown[] = [{ type: 'wallet', chain_type: 'xrpl', address: ADDR }]) {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }
  const jwks = createLocalJWKSet({ keys: [jwk] })
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> })
    return new Response(JSON.stringify({ id: DID, linked_accounts: linked }), { status: 200 })
  }) as unknown as typeof fetch
  const sign = (claims: { iss?: string; aud?: string; sub?: string; exp?: number } = {}) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(claims.iss ?? 'privy.io')
      .setAudience(claims.aud ?? APP)
      .setSubject(claims.sub ?? DID)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey)
  const verifier = createPrivyVerifier({ appId: APP, appSecret: 'test-secret', jwks, fetch: fakeFetch })
  return { verifier, sign, calls }
}

describe('privy verifier', () => {
  it('accepts a valid token whose user has this XRPL wallet, and calls the users API with app id + basic auth', async () => {
    const { verifier, sign, calls } = await setup()
    await expect(verifier.verify(await sign(), ADDR)).resolves.toEqual({ privyUserId: DID })
    expect(calls[0].url).toBe(`https://auth.privy.io/api/v1/users/${encodeURIComponent(DID)}`)
    expect(calls[0].headers['privy-app-id']).toBe(APP)
    expect(calls[0].headers.authorization).toBe('Basic ' + Buffer.from(`${APP}:test-secret`).toString('base64'))
  })
  it('refuses another audience, another issuer, an expired token', async () => {
    const { verifier, sign } = await setup()
    await expect(verifier.verify(await sign({ aud: 'other' }), ADDR)).rejects.toThrow(/refused/)
    await expect(verifier.verify(await sign({ iss: 'evil.io' }), ADDR)).rejects.toThrow(/refused/)
    await expect(verifier.verify(await sign({ exp: Math.floor(Date.now() / 1000) - 10 }), ADDR)).rejects.toThrow(/refused/)
  })
  it('refuses a token signed by another key', async () => {
    const { verifier } = await setup()
    const other = await setup()
    await expect(verifier.verify(await other.sign(), ADDR)).rejects.toThrow(/refused/)
  })
  it('refuses when the address is not a linked XRPL wallet', async () => {
    const { verifier, sign } = await setup([{ type: 'wallet', chain_type: 'ethereum', address: ADDR }, { type: 'email', address: 'a@b.c' }])
    await expect(verifier.verify(await sign(), ADDR)).rejects.toThrow(/not a wallet/)
  })
})
