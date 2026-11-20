import { describe, expect, it } from 'vitest'
import { PublicConfig } from '@zecca/contracts'
import { createApp } from './app'

describe('api skeleton', () => {
  it('GET /v1/config answers the PublicConfig contract', async () => {
    const app = createApp({ env: { LEDGER_MODE: 'mock', SIGNER_MODE: 'mock', DEMO_MODE: '1' } })
    const res = await app.request('/v1/config')
    expect(res.status).toBe(200)
    expect(PublicConfig.safeParse(await res.json()).success).toBe(true)
  })
  it('GET /v1/health', async () => {
    const res = await createApp({ env: {} }).request('/v1/health')
    expect(res.status).toBe(200)
  })
})
