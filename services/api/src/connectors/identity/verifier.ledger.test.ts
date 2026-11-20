// Network check against the public EU reference verifier: one real request (HTTP 200), then one poll (pending, no wallet).
// Never fetches the request_uri itself: that would consume the transaction. A real wallet scan is a human step.
import { describe, expect, it } from 'vitest'
import { createEudiVerifier } from './verifier'

describe('EUDI verifier (live, public backend)', () => {
  it('creates a presentation request with the EU test CAs, and it reads as pending', async () => {
    const lines: string[] = []
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) }
    const v = createEudiVerifier({ log })
    const t = await v.start()
    expect(t.transactionId).toMatch(/\S{8,}/)
    expect(t.link).toMatch(/^eudi-openid4vp:\/\/\?client_id=.+&request_uri=https%3A%2F%2Fverifier-backend\.eudiw\.dev%2F/)
    expect(lines.join('\n')).toMatch(/[1-9]\d* trusted CA cert/)
    expect(await v.poll(t.transactionId, Date.now())).toMatchObject({ state: 'pending' })
  })
})
