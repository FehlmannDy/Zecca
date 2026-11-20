import { describe, expect, it } from 'vitest'
import { ApiError, PublicConfig } from '@zecca/contracts'
import { makeHarness } from './testing/harness'

describe('app', () => {
  it('GET /v1/config answers the PublicConfig contract with the addresses in use', async () => {
    const h = makeHarness()
    const { status, body } = await h.json('GET', '/v1/config')
    expect(status).toBe(200)
    expect(PublicConfig.safeParse(body).success).toBe(true)
    expect(body.addresses.pool).toBe(h.keystore.getWallet('pool').address)
    expect(body.issuanceId).toBe(h.ledger.issuanceId)
    expect(body.demoMode).toBe(true)
  })
  it('GET /v1/health', async () => {
    const { status, body } = await makeHarness().json('GET', '/v1/health')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, ledger: 'mock', version: '0.1.0' })
  })
  it('unknown routes answer an ApiError 404', async () => {
    const { status, body } = await makeHarness().json('GET', '/v1/nope')
    expect(status).toBe(404)
    expect(ApiError.safeParse(body).success).toBe(true)
  })
})
