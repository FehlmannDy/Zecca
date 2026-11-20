import { describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createEudiVerifier, createMockVerifier, MOCK_IDENTITY } from './verifier'

const b64u = (x: string) => Buffer.from(x).toString('base64url')
const json64 = (o: unknown) => b64u(JSON.stringify(o))
function sdJwt(claims: Record<string, unknown>) {
  const ds = Object.entries(claims).map(([k, v]) => json64([randomBytes(8).toString('base64url'), k, v]))
  const payload = { iss: 'https://issuer.test', vct: 'urn:eudi:pid:1', _sd_alg: 'sha-256', _sd: ds.map((d) => createHash('sha256').update(d, 'ascii').digest('base64url')) }
  return `${json64({ alg: 'ES256' })}.${json64(payload)}.sig~${ds.join('~')}~kb`
}

type Call = { url: string; init?: RequestInit }
function backend(answer: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Call[] = []
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const a = answer(url, init)
    return { status: a.status, ok: a.status === 200, json: async () => a.body }
  }) as unknown as typeof fetch
  return { f, calls }
}
const capture = () => {
  const lines: string[] = []
  return { lines, log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } }
}

describe('mock verifier (IDENTITY_MODE=mock)', () => {
  it('answers a fixed test identity 3 s after the session started, pending before', async () => {
    let now = 1_000_000
    const v = createMockVerifier({ now: () => now })
    expect(v.mode).toBe('mock')
    const t = await v.start()
    expect(t.link).toMatch(/^eudi-openid4vp:\/\/\?client_id=/)
    const started = now
    now += 2_999
    expect(await v.poll(t.transactionId, started)).toEqual({ state: 'pending' })
    now += 1
    expect(await v.poll(t.transactionId, started)).toEqual({ state: 'verified', claims: MOCK_IDENTITY })
    expect(MOCK_IDENTITY).toEqual({ givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12' })
  })
})

describe('EUDI verifier (IDENTITY_MODE=eudi)', () => {
  const tx = { transaction_id: 'TX1', client_id: 'x509_san_dns:verifier-backend.eudiw.dev', request_uri: 'https://verifier-backend.eudiw.dev/wallet/request.jwt/TX1' }

  it('creates an SD-JWT PID request with TEST-01 and the EU test CAs as issuer_chain; the link uses eudi-openid4vp', async () => {
    const b = backend(() => ({ status: 200, body: tx }))
    const v = createEudiVerifier({ fetch: b.f, loadCas: async () => 'PEM-UT\nPEM-EU', extraCa: 'PEM-EXTRA' })
    const t = await v.start()
    expect(b.calls[0].url).toBe('https://verifier-backend.eudiw.dev/ui/presentations')
    const body = JSON.parse(String(b.calls[0].init!.body))
    expect(body).toMatchObject({ intended_use_id: 'TEST-01', response_mode: 'direct_post.jwt', request_uri_method: 'get', issuer_chain: 'PEM-UT\nPEM-EU\nPEM-EXTRA' })
    expect(body.dcql_query.credentials[0]).toMatchObject({ format: 'dc+sd-jwt', meta: { vct_values: ['urn:eudi:pid:1'] } })
    expect(body.dcql_query.credentials[0].claims.map((c: { path: string[] }) => c.path[0])).toEqual(['given_name', 'family_name', 'birthdate'])
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(t).toEqual({ transactionId: 'TX1', link: `eudi-openid4vp://?client_id=${encodeURIComponent(tx.client_id)}&request_uri=${encodeURIComponent(tx.request_uri)}&request_uri_method=get` })
  })

  it('still starts without the test CAs when they cannot be fetched (and says so in the log)', async () => {
    const b = backend(() => ({ status: 200, body: tx }))
    const c = capture()
    const v = createEudiVerifier({ fetch: b.f, loadCas: async () => Promise.reject(new Error('offline')), log: c.log })
    await v.start()
    expect(JSON.parse(String(b.calls[0].init!.body)).issuer_chain).toBeUndefined()
    expect(c.lines.join('\n')).toMatch(/test CAs/)
  })

  it('throws when the backend refuses the request', async () => {
    const b = backend(() => ({ status: 400, body: { error: 'invalid_request' } }))
    await expect(createEudiVerifier({ fetch: b.f, loadCas: async () => '' }).start()).rejects.toThrow(/400/)
  })

  it('verified: keeps only given name, family name and birth date; logs neither the values nor the presentation', async () => {
    const token = sdJwt({ given_name: 'Erika', family_name: 'Mustermann', birthdate: '1964-08-12', nationality: 'DE' })
    const b = backend((url) =>
      url.endsWith('/events') ? { status: 200, body: { events: [{ actor: 'Wallet', event: 'Wallet response posted' }] } } : { status: 200, body: { vp_token: { pid: [token] } } },
    )
    const c = capture()
    const v = createEudiVerifier({ fetch: b.f, loadCas: async () => '', log: c.log })
    const r = await v.poll('TX1', 0)
    expect(r).toEqual({ state: 'verified', claims: { givenName: 'Erika', familyName: 'Mustermann', birthDate: '1964-08-12' } })
    const logged = c.lines.join('\n')
    for (const secret of ['Erika', 'Mustermann', '1964-08-12', 'DE', token.slice(0, 20)]) expect(logged).not.toContain(secret)
  })

  it('pending, rejected and wallet errors; a network failure stays pending', async () => {
    const events = (ev: unknown[]) => backend((url) => (url.endsWith('/events') ? { status: 200, body: { events: ev } } : { status: 200, body: { error: 'access_denied' } }))
    expect(await createEudiVerifier({ fetch: events([]).f, loadCas: async () => '' }).poll('T', 0)).toEqual({ state: 'pending', requestFetched: false })
    expect(await createEudiVerifier({ fetch: events([{ actor: 'Wallet', event: 'Request object retrieved' }]).f, loadCas: async () => '' }).poll('T', 0)).toEqual({ state: 'pending', requestFetched: true })
    expect(await createEudiVerifier({ fetch: events([{ actor: 'Wallet', event: 'Wallet failed', cause: 'IssuerCertificateIsNotTrusted' }]).f, loadCas: async () => '' }).poll('T', 0)).toEqual({
      state: 'rejected',
      cause: 'IssuerCertificateIsNotTrusted',
    })
    expect(await createEudiVerifier({ fetch: events([{ actor: 'Wallet', event: 'Wallet response posted' }]).f, loadCas: async () => '' }).poll('T', 0)).toEqual({ state: 'error', cause: 'access_denied' })
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await createEudiVerifier({ fetch: down, loadCas: async () => '', log: capture().log }).poll('T', 0)).toEqual({ state: 'pending' })
  })

  it('a verified answer without a readable PID is an error, not a verification', async () => {
    const b = backend((url) => (url.endsWith('/events') ? { status: 200, body: { events: [{ actor: 'Wallet', event: 'Wallet response posted' }] } } : { status: 200, body: { vp_token: { pid: [42] } } }))
    expect(await createEudiVerifier({ fetch: b.f, loadCas: async () => '' }).poll('T', 0)).toEqual({ state: 'error', cause: 'unreadable_presentation' })
  })
})
