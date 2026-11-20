// Port of ../identity/test/lib.test.mjs (hand-made fixtures only, no real PID data), plus the over-18 maths.
import { describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  buildDcql,
  buildPresentationRequest,
  cborDecode,
  createTransaction,
  isOver18,
  pollTransaction,
  qrUrl,
  readIdentity,
  resolveSdJwt,
  withScheme,
} from './lib'

const b64u = (x: string | Buffer) => Buffer.from(x).toString('base64url')
const json64 = (o: unknown) => b64u(JSON.stringify(o))
const dg = (d: string) => createHash('sha256').update(d, 'ascii').digest('base64url')

function sdJwt(claims: Record<string, unknown>, { undisclosedPlain = {} }: { undisclosedPlain?: Record<string, unknown> } = {}) {
  const ds = Object.entries(claims).map(([k, v]) => json64([b64u(randomBytes(8)), k, v]))
  const payload = { iss: 'https://issuer.test', vct: 'urn:eudi:pid:1', _sd_alg: 'sha-256', _sd: ds.map(dg), ...undisclosedPlain }
  return `${json64({ alg: 'ES256', typ: 'dc+sd-jwt' })}.${json64(payload)}.sig~${ds.join('~')}~kb.jwt.here`
}

// --- tiny CBOR encoder for the mdoc fixture ---
type Tagged = { tag: number; value: unknown }
function head(mt: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(mt << 5) | n])
  if (n < 256) return Buffer.from([(mt << 5) | 24, n])
  if (n < 65536) {
    const b = Buffer.alloc(3)
    b[0] = (mt << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = (mt << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}
function enc(v: unknown): Buffer {
  if (v && typeof v === 'object' && 'tag' in v) return Buffer.concat([head(6, (v as Tagged).tag), enc((v as Tagged).value)])
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8')
    return Buffer.concat([head(3, s.length), s])
  }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'boolean') return Buffer.from([v ? 0xf5 : 0xf4])
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)])
  const e = Object.entries(v as Record<string, unknown>)
  return Buffer.concat([head(5, e.length), ...e.flatMap(([k, x]) => [enc(k), enc(x)])])
}
const item = (id: string, value: unknown): Tagged => ({ tag: 24, value: enc({ digestID: 1, random: randomBytes(16), elementIdentifier: id, elementValue: value }) })

type FakeRes = { status: number; json: () => Promise<unknown> }
const fakeFetch = (events: unknown[], result: unknown = {}, status = 200) =>
  (async (url: string): Promise<FakeRes> => ({
    status: url.endsWith('/events') ? 200 : status,
    json: async () => (url.endsWith('/events') ? { events } : result),
  })) as unknown as typeof fetch

describe('identity lib (port of identity/lib.mjs)', () => {
  it('DCQL: SD-JWT asks birthdate, mdoc asks birth_date in the PID namespace', () => {
    expect(buildDcql('sd-jwt').credentials[0].claims.map((c) => c.path)).toEqual([['given_name'], ['family_name'], ['birthdate']])
    const m = buildDcql('mdoc').credentials[0]
    expect(m.format).toBe('mso_mdoc')
    expect(m.claims.map((c) => c.path)).toEqual([
      ['eu.europa.ec.eudi.pid.1', 'given_name'],
      ['eu.europa.ec.eudi.pid.1', 'family_name'],
      ['eu.europa.ec.eudi.pid.1', 'birth_date'],
    ])
    const req = buildPresentationRequest({ format: 'sd-jwt', vcts: ['urn:eudi:pid:1'], nonce: 'n', intendedUseId: 'TEST-01' })
    expect(req.intended_use_id).toBe('TEST-01')
    expect(req.issuer_chain).toBeUndefined()
    expect(req).toMatchObject({ jar_mode: 'by_reference', request_uri_method: 'get', response_mode: 'direct_post.jwt' })
    expect(buildPresentationRequest({ format: 'sd-jwt', nonce: 'n', intendedUseId: 'TEST-01', issuerChain: 'PEM' }).issuer_chain).toBe('PEM')
  })

  it('qrUrl builds the wallet deep link; withScheme swaps only the scheme', () => {
    const u = qrUrl('openid4vp', { clientId: 'x509_hash:abc', requestUri: 'https://v/wallet/request.jwt/x', requestUriMethod: 'get' })
    expect(u).toBe('openid4vp://?client_id=x509_hash%3Aabc&request_uri=https%3A%2F%2Fv%2Fwallet%2Frequest.jwt%2Fx&request_uri_method=get')
    expect(withScheme(u, 'eudi-openid4vp')).toBe(u.replace(/^openid4vp:/, 'eudi-openid4vp:'))
    expect(withScheme(withScheme(u, 'haip-vp'), 'openid4vp')).toBe(u)
  })

  it('SD-JWT: reads the disclosed name and birthdate only', () => {
    const t = sdJwt({ given_name: 'Alex', family_name: 'Muster', birthdate: '1990-01-01' }, { undisclosedPlain: { given_name: 'NOT-DISCLOSED' } })
    const id = readIdentity({ pid: [t] })!
    expect(id.format).toBe('dc+sd-jwt')
    expect([id.givenName, id.familyName, id.birthDate, id.birthDateClaim]).toEqual(['Alex', 'Muster', '1990-01-01', 'birthdate'])
  })

  it('SD-JWT: a disclosure the payload does not list is ignored', () => {
    const t = sdJwt({ given_name: 'Alex' })
    const forged = `${t.split('~')[0]}~${t.split('~')[1]}~${json64(['s', 'birthdate', '2000-01-01'])}~`
    expect(resolveSdJwt(forged).birthdate).toBeUndefined()
  })

  it('SD-JWT: falls back to birth_date and says so', () => {
    const id = readIdentity({ pid: [sdJwt({ given_name: 'A', family_name: 'B', birth_date: '1985-05-05' })] })!
    expect(id.birthDate).toBe('1985-05-05')
    expect(id.birthDateClaim).toBe('birth_date')
  })

  it('mdoc: reads given_name, family_name and the tag-1004 birth_date from a DeviceResponse', () => {
    const resp = {
      version: '1.0',
      documents: [
        {
          docType: 'eu.europa.ec.eudi.pid.1',
          issuerSigned: {
            nameSpaces: { 'eu.europa.ec.eudi.pid.1': [item('given_name', 'Erika'), item('family_name', 'Mustermann'), item('birth_date', { tag: 1004, value: '1964-08-12' })] },
            issuerAuth: [Buffer.from([0xa0]), {}, Buffer.alloc(0), Buffer.alloc(64)],
          },
        },
      ],
      status: 0,
    }
    const id = readIdentity({ pid: [b64u(enc(resp))] })!
    expect(id.format).toBe('mso_mdoc')
    expect([id.givenName, id.familyName, id.birthDate, id.birthDateClaim]).toEqual(['Erika', 'Mustermann', '1964-08-12', 'birth_date'])
  })

  it('cborDecode: indefinite arrays/maps and half floats', () => {
    expect(cborDecode(Buffer.from([0x9f, 0x01, 0x02, 0xff]))).toEqual([1, 2])
    expect(cborDecode(Buffer.from([0xbf, 0x61, 0x61, 0x01, 0xff]))).toEqual({ a: 1 })
    expect(cborDecode(Buffer.from([0xf9, 0x3c, 0x00]))).toBe(1)
  })

  it('pollTransaction: pending, verified, rejected, wallet_error (events read before the result)', async () => {
    const noise = { actor: 'Verifier', event: 'Verifier failed to get wallet', cause: 'Presentation should be in Submitted state' }
    expect(await pollTransaction(fakeFetch([noise]), 'b', 't')).toEqual({ state: 'pending', requestFetched: false })
    expect(await pollTransaction(fakeFetch([{ actor: 'Wallet', event: 'Request object retrieved' }]), 'b', 't')).toEqual({ state: 'pending', requestFetched: true })
    const posted = [{ actor: 'Wallet', event: 'Wallet response posted' }]
    expect(await pollTransaction(fakeFetch(posted, { vp_token: { pid: ['x~'] } }), 'b', 't')).toEqual({ state: 'verified', vpToken: { pid: ['x~'] } })
    expect((await pollTransaction(fakeFetch(posted, { error: 'access_denied' }), 'b', 't')).state).toBe('wallet_error')
    const r = await pollTransaction(fakeFetch([{ actor: 'Wallet', event: 'Wallet failed to post response', cause: 'IssuerCertificateIsNotTrusted' }]), 'b', 't')
    expect(r).toMatchObject({ state: 'rejected', cause: 'IssuerCertificateIsNotTrusted' })

    // Never asks for the result before the events say the wallet posted (the backend logs noise otherwise).
    const urls: string[] = []
    const spy = (async (url: string) => (urls.push(url), { status: 200, json: async () => ({ events: [] }) })) as unknown as typeof fetch
    await pollTransaction(spy, 'https://v', 'tx 1')
    expect(urls).toEqual(['https://v/ui/presentations/tx%201/events'])
  })

  it('createTransaction posts the request and maps the answer; throws on non-200', async () => {
    let seen: { url: string; body: unknown } | undefined
    const ok = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) }
      return { status: 200, json: async () => ({ transaction_id: 'T', client_id: 'C', request_uri: 'https://v/r/T' }) }
    }) as unknown as typeof fetch
    expect(await createTransaction(ok, 'https://v', { nonce: 'n' })).toEqual({ transactionId: 'T', clientId: 'C', requestUri: 'https://v/r/T', requestUriMethod: 'get' })
    expect(seen).toEqual({ url: 'https://v/ui/presentations', body: { nonce: 'n' } })
    const bad = (async () => ({ status: 400, json: async () => ({ error: 'invalid' }) })) as unknown as typeof fetch
    await expect(createTransaction(bad, 'https://v', {})).rejects.toThrow(/400/)
  })
})

describe('isOver18 (from the birth date, never a claim)', () => {
  const at = (iso: string) => Date.parse(iso)
  it('turns 18 on the birthday itself, not the day before (UTC)', () => {
    expect(isOver18('2008-11-21', at('2026-11-21T00:00:00Z'))).toBe(true)
    expect(isOver18('2008-11-21', at('2026-11-20T23:59:59Z'))).toBe(false)
    expect(isOver18('2008-11-22', at('2026-11-21T12:00:00Z'))).toBe(false)
    expect(isOver18('1994-03-12', at('2026-11-21T09:00:00Z'))).toBe(true)
  })
  it('a 29 February birthday counts from 1 March in a non-leap year', () => {
    expect(isOver18('2008-02-29', at('2026-02-28T12:00:00Z'))).toBe(false)
    expect(isOver18('2008-02-29', at('2026-03-01T00:00:00Z'))).toBe(true)
  })
  it('accepts a full timestamp but refuses junk and impossible dates', () => {
    expect(isOver18('1990-01-01T00:00:00Z', at('2026-01-01T00:00:00Z'))).toBe(true)
    expect(isOver18('not a date', at('2026-01-01T00:00:00Z'))).toBe(false)
    expect(isOver18('1990-02-30', at('2026-01-01T00:00:00Z'))).toBe(false)
    expect(isOver18('', at('2026-01-01T00:00:00Z'))).toBe(false)
  })
})
