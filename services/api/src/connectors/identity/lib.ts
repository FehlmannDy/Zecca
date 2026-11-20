// Client for the public EUDI reference verifier backend (OpenID4VP 1.0 + DCQL) and the decoding of what it returns.
// Ported from ../identity/lib.mjs (itself adapted from bsa-sentry eudiw.ts and eudi-verifier-test): same behaviour,
// typed, plus isOver18 and withScheme. Pure functions; the client functions take the fetch to use.
// The backend already verified signatures, holder binding and the nonce; this only reads the disclosed values.
import { createHash, X509Certificate } from 'node:crypto'

export const PID_VCT = 'urn:eudi:pid:1'
export const PID_DOCTYPE = 'eu.europa.ec.eudi.pid.1'
export const DEFAULT_VERIFIER = 'https://verifier-backend.eudiw.dev'
/** The public backend refuses transactions without one; TEST-01 is the one it advertises at GET /ui/intended-uses. */
export const DEFAULT_INTENDED_USE_ID = 'TEST-01'

/** EU test PID issuer CAs (UT 02, EU 02). CA 01 answers 404. Sent as issuer_chain so test PIDs are trusted. */
export const EUDI_TEST_CAS = [
  'https://preprod.pki.eudiw.dev/aia/PIDIssuerCA02-UT.cacert.pem',
  'https://preprod.pki.eudiw.dev/aia/PIDIssuerCA02-EU.cacert.pem',
]

/** Link schemes wallets register. EUDI reference wallet: eudi-openid4vp (or haip-vp). Paradym, Procivis: openid4vp. */
export const SCHEMES = ['openid4vp', 'haip-vp', 'eudi-openid4vp'] as const
export type Scheme = (typeof SCHEMES)[number]

export type Format = 'sd-jwt' | 'mdoc'
type DcqlClaim = { path: string[] }
export type Dcql = { credentials: Array<{ id: string; format: string; meta: Record<string, unknown>; claims: DcqlClaim[] }> }

/**
 * DCQL for the three facts. Claim names differ per format:
 *   dc+sd-jwt (vct urn:eudi:pid:1): given_name, family_name, birthdate
 *   mso_mdoc  (eu.europa.ec.eudi.pid.1): given_name, family_name, birth_date (namespaced path)
 * Plain claim paths, no claim_sets: Procivis answered "credential missing" to claim_sets.
 */
export function buildDcql(format: Format = 'sd-jwt', vcts: string[] = [PID_VCT]): Dcql {
  if (format === 'mdoc') {
    return {
      credentials: [
        {
          id: 'pid',
          format: 'mso_mdoc',
          meta: { doctype_value: PID_DOCTYPE },
          claims: ['given_name', 'family_name', 'birth_date'].map((c) => ({ path: [PID_DOCTYPE, c] })),
        },
      ],
    }
  }
  return {
    credentials: [{ id: 'pid', format: 'dc+sd-jwt', meta: { vct_values: vcts }, claims: ['given_name', 'family_name', 'birthdate'].map((c) => ({ path: [c] })) }],
  }
}

export type PresentationRequest = {
  dcql_query: Dcql
  nonce: string
  jar_mode: 'by_reference'
  request_uri_method: 'get'
  response_mode: 'direct_post.jwt'
  profile: 'openid4vp'
  intended_use_id: string
  issuer_chain?: string
}

export function buildPresentationRequest(o: { format?: Format; vcts?: string[]; nonce: string; intendedUseId: string; issuerChain?: string }): PresentationRequest {
  return {
    dcql_query: buildDcql(o.format, o.vcts),
    nonce: o.nonce,
    jar_mode: 'by_reference',
    request_uri_method: 'get',
    response_mode: 'direct_post.jwt',
    profile: 'openid4vp',
    intended_use_id: o.intendedUseId,
    ...(o.issuerChain ? { issuer_chain: o.issuerChain } : {}),
  }
}

export type Transaction = { transactionId: string; clientId: string; requestUri: string; requestUriMethod: string }

export async function createTransaction(fetchImpl: typeof fetch, backend: string, body: unknown): Promise<Transaction> {
  const res = await fetchImpl(`${backend}/ui/presentations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as Record<string, string | undefined>
  if (res.status !== 200) throw new Error(`EUDI verifier refused the transaction: ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  return { transactionId: String(json.transaction_id), clientId: String(json.client_id), requestUri: String(json.request_uri), requestUriMethod: json.request_uri_method ?? 'get' }
}

export function qrUrl(scheme: Scheme, t: Pick<Transaction, 'clientId' | 'requestUri' | 'requestUriMethod'>): string {
  const q = new URLSearchParams({ client_id: t.clientId, request_uri: t.requestUri, request_uri_method: t.requestUriMethod })
  return `${scheme}://?${q.toString()}`
}

/** The same request under another wallet's scheme (the query does not depend on the scheme). */
export function withScheme(link: string, scheme: Scheme): string {
  return link.replace(/^[a-z][a-z0-9+.-]*:/i, `${scheme}:`)
}

type VerifierEvent = { actor?: string; event?: string; cause?: string; vp_token?: unknown }
/** Polling the result endpoint early makes the backend log this; it is not a wallet event. */
const isPollNoise = (e: VerifierEvent) => e?.event === 'Verifier failed to get wallet' && /should be in Submitted state/.test(e?.cause ?? '')

export type PollResult =
  | { state: 'pending'; requestFetched?: boolean; note?: string }
  | { state: 'verified'; vpToken: Record<string, unknown> }
  | { state: 'rejected'; cause: string; rejectedVpToken?: unknown }
  | { state: 'wallet_error'; cause: string; description?: string }

/**
 * Events first, then the result:
 *   no wallet event (beyond "Request object retrieved") -> pending
 *   "Wallet response posted" -> GET the result: vp_token -> verified, else wallet_error
 *   any other wallet event (e.g. IssuerCertificateIsNotTrusted) -> rejected
 */
export async function pollTransaction(fetchImpl: typeof fetch, backend: string, tx: string): Promise<PollResult> {
  const id = encodeURIComponent(tx)
  const evRes = await fetchImpl(`${backend}/ui/presentations/${id}/events`)
  const ev = (await evRes.json().catch(() => ({}))) as { events?: VerifierEvent[] }
  if (evRes.status !== 200) return { state: 'pending', note: `events endpoint answered ${evRes.status}` }
  const events = (ev.events ?? []).filter((e) => !isPollNoise(e))
  const requestFetched = events.some((e) => e.event === 'Request object retrieved')
  const lastWallet = events.filter((e) => e.actor === 'Wallet' && e.event !== 'Request object retrieved').at(-1)
  if (!lastWallet) return { state: 'pending', requestFetched }
  if (lastWallet.event !== 'Wallet response posted') return { state: 'rejected', cause: String(lastWallet.cause ?? lastWallet.event), rejectedVpToken: lastWallet.vp_token }
  const res = await fetchImpl(`${backend}/ui/presentations/${id}`)
  const result = (await res.json().catch(() => ({}))) as { vp_token?: Record<string, unknown>; error?: string; error_description?: string }
  if (res.status === 200 && result.vp_token) return { state: 'verified', vpToken: result.vp_token }
  if (res.status === 200) return { state: 'wallet_error', cause: String(result.error ?? 'no vp_token'), description: result.error_description }
  return { state: 'pending', note: `result endpoint answered ${res.status}` }
}

// ---------------------------------------------------------------------------------------------
// Reading the claims
// ---------------------------------------------------------------------------------------------

const b64json = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** Minimal SD-JWT resolution: only disclosures whose digest the signed payload lists count. */
export function resolveSdJwt(token: string, { disclosedOnly = true }: { disclosedOnly?: boolean } = {}): Record<string, Json> {
  const parts = token.split('~')
  const payload = b64json(parts[0].split('.')[1]) as Record<string, Json>
  const alg = String(payload._sd_alg ?? 'sha-256').replace('-', '')
  const byDigest = new Map<string, Json[]>()
  for (const d of parts.slice(1).filter(Boolean)) {
    try {
      const decoded = b64json(d)
      if (Array.isArray(decoded)) byDigest.set(createHash(alg).update(d, 'ascii').digest('base64url'), decoded as Json[])
    } catch {
      /* the trailing KB-JWT, or junk */
    }
  }
  const isLeaf = (v: Json) => v === null || typeof v !== 'object'
  const resolve = (node: Json, shown: boolean): Json => {
    if (Array.isArray(node)) {
      return node.flatMap((el) => {
        const dgst = el && typeof el === 'object' && !Array.isArray(el) ? el['...'] : undefined
        if (typeof dgst !== 'string') return !shown && isLeaf(el) ? [] : [resolve(el, shown)]
        const d = byDigest.get(dgst)
        return d && d.length === 2 ? [resolve(d[1], true)] : []
      })
    }
    if (node && typeof node === 'object') {
      const out: Record<string, Json> = {}
      for (const [k, v] of Object.entries(node)) if (k !== '_sd' && k !== '_sd_alg' && (shown || !isLeaf(v))) out[k] = resolve(v, shown)
      const sd = Array.isArray(node._sd) ? node._sd : []
      for (const dgst of sd) {
        const d = typeof dgst === 'string' ? byDigest.get(dgst) : undefined
        if (d && d.length === 3) out[String(d[1])] = resolve(d[2], true)
      }
      return out
    }
    return node
  }
  return resolve(payload, !disclosedOnly) as Record<string, Json>
}

/** The issuer JWT's x5c chain (base64 DER), from an SD-JWT presentation. */
export function sdJwtX5c(token: string): string[] | null {
  try {
    return (JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { x5c?: string[] }).x5c ?? null
  } catch {
    return null
  }
}

/**
 * Minimal CBOR reader for an mdoc DeviceResponse: definite and indefinite lengths, tags (tag 24 = embedded CBOR is decoded,
 * other tags return their content, e.g. 1004 full-date -> "YYYY-MM-DD").
 */
export function cborDecode(buf: Buffer): unknown {
  let i = 0
  const BREAK = Symbol('break')
  const uint = (n: number) => {
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + buf[i++]
    return v
  }
  const arg = (ai: number) => (ai < 24 ? ai : ai === 24 ? uint(1) : ai === 25 ? uint(2) : ai === 26 ? uint(4) : ai === 27 ? uint(8) : -1)
  const item = (): unknown => {
    const b = buf[i++]
    const mt = b >> 5
    const ai = b & 31
    if (mt === 7) {
      if (ai === 20) return false
      if (ai === 21) return true
      if (ai === 22 || ai === 23) return null
      if (ai === 25) {
        const h = uint(2)
        const e = (h >> 10) & 31
        const m = h & 1023
        const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (m + 1024) * 2 ** (e - 25)
        return h & 0x8000 ? -v : v
      }
      if (ai === 26) {
        const v = buf.readFloatBE(i)
        i += 4
        return v
      }
      if (ai === 27) {
        const v = buf.readDoubleBE(i)
        i += 8
        return v
      }
      if (ai === 31) return BREAK
      return undefined
    }
    const n = arg(ai)
    switch (mt) {
      case 0:
        return n
      case 1:
        return -1 - n
      case 2:
      case 3: {
        let bytes: Buffer
        if (n < 0) {
          const chunks: Buffer[] = []
          for (let c = item(); c !== BREAK; c = item()) chunks.push(Buffer.from(c as Buffer))
          bytes = Buffer.concat(chunks)
        } else {
          bytes = buf.subarray(i, i + n)
          i += n
        }
        return mt === 2 ? bytes : bytes.toString('utf8')
      }
      case 4: {
        const a: unknown[] = []
        if (n < 0) for (let v = item(); v !== BREAK; v = item()) a.push(v)
        else for (let k = 0; k < n; k++) a.push(item())
        return a
      }
      case 5: {
        const o: Record<string, unknown> = {}
        const pair = (k: unknown) => {
          o[typeof k === 'string' ? k : String(k)] = item()
        }
        if (n < 0) for (let k = item(); k !== BREAK; k = item()) pair(k)
        else for (let k = 0; k < n; k++) pair(item())
        return o
      }
      case 6: {
        const v = item()
        return n === 24 && Buffer.isBuffer(v) ? cborDecode(v) : v
      }
    }
    throw new Error(`bad CBOR major type ${mt}`)
  }
  return item()
}

/** Disclosed elements of the PID namespace from a base64url mdoc DeviceResponse. */
export function readMdoc(b64: string): Record<string, unknown> {
  const resp = cborDecode(Buffer.from(b64, 'base64url')) as { documents?: Array<{ issuerSigned?: { nameSpaces?: Record<string, unknown[]> } }> }
  const out: Record<string, unknown> = {}
  for (const doc of resp.documents ?? []) {
    for (const el of doc.issuerSigned?.nameSpaces?.[PID_DOCTYPE] ?? []) {
      if (el && typeof el === 'object' && 'elementIdentifier' in el) {
        const e = el as { elementIdentifier: unknown; elementValue: unknown }
        out[String(e.elementIdentifier)] = e.elementValue
      }
    }
  }
  return out
}

const asText = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === 'string' ? v : Buffer.isBuffer(v) ? null : JSON.stringify(v))

export type ReadIdentity = {
  queryId: string
  format: 'dc+sd-jwt' | 'mso_mdoc'
  givenName: string | null
  familyName: string | null
  birthDate: string | null
  birthDateClaim: 'birthdate' | 'birth_date' | null
  disclosed: string[]
  issuer: { subject: string; issuer: string; validTo: string } | null
}

/**
 * Name and birth date from a verified vp_token `{ pid: [presentation] }`. SD-JWT reads only selectively disclosed values;
 * it accepts `birthdate` (SD-JWT PID) and `birth_date` (older issuers, mdoc naming) and reports which name it found.
 */
export function readIdentity(vpToken: Record<string, unknown> | null | undefined): ReadIdentity | null {
  for (const [queryId, presentations] of Object.entries(vpToken ?? {})) {
    for (const p of ([] as unknown[]).concat(presentations)) {
      if (typeof p !== 'string') continue
      let claims: Record<string, unknown>
      let format: ReadIdentity['format']
      if (p.includes('~')) {
        claims = resolveSdJwt(p, { disclosedOnly: true })
        format = 'dc+sd-jwt'
      } else {
        claims = readMdoc(p)
        format = 'mso_mdoc'
      }
      const birthKey = claims.birthdate !== undefined ? 'birthdate' : claims.birth_date !== undefined ? 'birth_date' : null
      return {
        queryId,
        format,
        givenName: asText(claims.given_name),
        familyName: asText(claims.family_name),
        birthDate: birthKey ? asText(claims[birthKey]) : null,
        birthDateClaim: birthKey,
        disclosed: Object.keys(claims)
          .filter((k) => !['iss', 'iat', 'exp', 'vct', 'cnf', 'status', 'nbf'].includes(k))
          .sort(),
        issuer: format === 'dc+sd-jwt' ? certSummary(sdJwtX5c(p)) : null,
      }
    }
  }
  return null
}

export function certSummary(x5c: string[] | null | undefined): ReadIdentity['issuer'] {
  if (!x5c?.length) return null
  try {
    const x = new X509Certificate(Buffer.from(x5c[0], 'base64'))
    return { subject: x.subject.replace(/\n/g, ', '), issuer: x.issuer.replace(/\n/g, ', '), validTo: x.validTo }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Trust: issuer_chain
// ---------------------------------------------------------------------------------------------

let caPem: Promise<string> | undefined
/** The EUDI test CAs (UT 02 + EU 02) as one PEM string, fetched once (retried after a failure). */
export function eudiTestCas(fetchImpl: typeof fetch = fetch): Promise<string> {
  caPem ??= Promise.all(
    EUDI_TEST_CAS.map(async (u) => {
      const r = await fetchImpl(u)
      if (!r.ok) throw new Error(`${u} -> ${r.status}`)
      return new X509Certificate(Buffer.from(await r.arrayBuffer())).toString().trim()
    }),
  )
    .then((pems) => pems.join('\n'))
    .catch((e: unknown) => {
      caPem = undefined
      throw e
    })
  return caPem
}

// ---------------------------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------------------------

/**
 * True when the person born on `birthDate` (YYYY-MM-DD, optionally with a time) is 18 or older at `nowMs`, counted in UTC.
 * A 29 February birthday turns 18 on 1 March in a non-leap year. Junk or impossible dates are never over 18.
 */
export function isOver18(birthDate: string, nowMs: number): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate ?? '')
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const born = new Date(Date.UTC(y, mo - 1, d))
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== mo - 1 || born.getUTCDate() !== d) return false
  // Date.UTC rolls 29 Feb of a non-leap year over to 1 March, which is the rule we want.
  return nowMs >= Date.UTC(y + 18, mo - 1, d)
}
