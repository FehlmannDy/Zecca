// The identity verifier behind one interface: the public EUDI reference verifier (live) or a fixed test identity (mock).
// Only three facts ever leave this module: given name, family name, birth date. The presentation itself is read here
// and dropped; it is never logged, stored or returned.
import { randomBytes } from 'node:crypto'
import type { Logger } from '../../core'
import {
  buildPresentationRequest,
  createTransaction,
  DEFAULT_INTENDED_USE_ID,
  DEFAULT_VERIFIER,
  eudiTestCas,
  PID_VCT,
  pollTransaction,
  qrUrl,
  readIdentity,
} from './lib'

export type Claims = { givenName: string | null; familyName: string | null; birthDate: string | null }

export type VerifierStatus =
  | { state: 'pending'; requestFetched?: boolean }
  | { state: 'verified'; claims: Claims }
  | { state: 'rejected'; cause: string }
  | { state: 'error'; cause: string }

export interface IdentityVerifier {
  readonly mode: 'live' | 'mock'
  /** Creates a presentation request. `link` is the wallet link under the eudi-openid4vp scheme. */
  start(): Promise<{ transactionId: string; link: string }>
  /** `startedAtMs`: when the session was created (the mock answers 3 s later). */
  poll(transactionId: string, startedAtMs: number): Promise<VerifierStatus>
}

/** SPEC §4.8: the fixed test identity of IDENTITY_MODE=mock. */
export const MOCK_IDENTITY: Claims = { givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12' }
export const MOCK_DELAY_MS = 3_000

export function createMockVerifier(o: { now: () => number; delayMs?: number }): IdentityVerifier {
  const delay = o.delayMs ?? MOCK_DELAY_MS
  return {
    mode: 'mock',
    async start() {
      const id = `mock_${randomBytes(12).toString('hex')}`
      const link = qrUrl('eudi-openid4vp', { clientId: 'x509_san_dns:test-identity.zecca.invalid', requestUri: `https://test-identity.zecca.invalid/request/${id}`, requestUriMethod: 'get' })
      return { transactionId: id, link }
    },
    async poll(_tx, startedAtMs) {
      return o.now() - startedAtMs >= delay ? { state: 'verified', claims: { ...MOCK_IDENTITY } } : { state: 'pending' }
    },
  }
}

const quiet: Logger = { info() {}, warn() {}, error() {} }

export function createEudiVerifier(o: {
  fetch?: typeof fetch
  backend?: string
  intendedUseId?: string
  vcts?: string[]
  /** PEM of the CAs sent as issuer_chain. Default: the EU test PID CAs, fetched once. */
  loadCas?: () => Promise<string>
  /** One more issuer CA (PEM), e.g. a test issuer's own CA. */
  extraCa?: string
  log?: Logger
}): IdentityVerifier {
  const f = o.fetch ?? fetch
  const backend = (o.backend ?? DEFAULT_VERIFIER).replace(/\/+$/, '')
  const intendedUseId = o.intendedUseId ?? DEFAULT_INTENDED_USE_ID
  const vcts = o.vcts?.length ? o.vcts : [PID_VCT]
  const loadCas = o.loadCas ?? (() => eudiTestCas(f))
  const log = o.log ?? quiet
  const short = (tx: string) => `${tx.slice(0, 8)}…`

  return {
    mode: 'live',
    async start() {
      const testCas = await loadCas().catch((e: unknown) => {
        log.warn(`[identity] EU test CAs not fetched, the request goes without them: ${(e as Error)?.message ?? e}`)
        return ''
      })
      const chain = [testCas, o.extraCa ?? ''].map((s) => s.trim()).filter(Boolean).join('\n')
      const request = buildPresentationRequest({ format: 'sd-jwt', vcts, nonce: randomBytes(16).toString('base64url'), intendedUseId, ...(chain ? { issuerChain: chain } : {}) })
      const t = await createTransaction(f, backend, request)
      log.info(`[identity] request ${short(t.transactionId)} created (${chain ? chain.split('BEGIN CERTIFICATE').length - 1 : 0} trusted CA cert(s))`)
      return { transactionId: t.transactionId, link: qrUrl('eudi-openid4vp', t) }
    },
    async poll(tx) {
      let r
      try {
        r = await pollTransaction(f, backend, tx)
      } catch (e) {
        log.warn(`[identity] ${short(tx)} verifier unreachable: ${(e as Error & { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.message}`)
        return { state: 'pending' }
      }
      if (r.state === 'pending') return r.requestFetched === undefined ? { state: 'pending' } : { state: 'pending', requestFetched: r.requestFetched }
      if (r.state === 'rejected') {
        log.info(`[identity] ${short(tx)} rejected: ${r.cause}`)
        return { state: 'rejected', cause: r.cause }
      }
      if (r.state === 'wallet_error') {
        log.info(`[identity] ${short(tx)} wallet error: ${r.cause}`)
        return { state: 'error', cause: r.cause }
      }
      let id
      try {
        id = readIdentity(r.vpToken)
      } catch {
        id = null
      }
      if (!id) {
        log.warn(`[identity] ${short(tx)} verified, but the presentation could not be read`)
        return { state: 'error', cause: 'unreadable_presentation' }
      }
      // Claim names only, never their values.
      log.info(`[identity] ${short(tx)} verified (${id.format}, disclosed: ${id.disclosed.join(',')})`)
      return { state: 'verified', claims: { givenName: id.givenName, familyName: id.familyName, birthDate: id.birthDate } }
    },
  }
}
