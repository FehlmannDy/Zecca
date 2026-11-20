// Identity connector (EUDI), SPEC §4.8 and §6.3. Behind FEATURE_IDENTITY.
//   POST /v1/identity/sessions      -> a presentation request (live: the public EU verifier; mock: a test identity after 3 s)
//   GET  /v1/identity/sessions/:id  -> pending | verified (+ the CredentialAccept to approve) | rejected | error
// On verified and over 18: CredentialCreate by the KYC issuer to the user, then a sponsored CredentialAccept (fee + reserve)
// the user approves (probe case k). Once that validates: tier 1, a balance/limits refresh, and the verified name as the
// display name if the user only had their handle. Nothing personal goes on the ledger; the presentation is never logged.
import type { Hono } from 'hono'
import type { PreparedTx, VerifiedIdentity } from '@zecca/contracts'
import type { Core, Logger } from '../../core'
import type { Env } from '../../config'
import { Err } from '../../errors'
import { mount } from '../../http'
import { emitBalance } from '../../books'
import { preparedById, storePrepared, type PreparedRow } from '../../prepared/store'
import { users, toUser, type UserRow } from '../../users'
import { isOver18 } from './lib'
import { createEudiVerifier, createMockVerifier, type IdentityVerifier, type VerifierStatus } from './verifier'
import {
  endSession,
  ensureSchema,
  insertSession,
  markAccepted,
  markVerified,
  preparedOutcome,
  sessionById,
  sessionByPrepareId,
  setCredentialHash,
  setPrepareId,
  type IdentitySessionRow,
} from './store'

/** CredentialType on the ledger: hex of "ZeccaKYC". It says that Zecca checked the person, nothing about who they are. */
export const CREDENTIAL_TYPE = Buffer.from('ZeccaKYC').toString('hex').toUpperCase()
/** How long a wallet has to answer (the probe page stopped polling after 10 minutes too). */
export const SESSION_TTL_MS = 10 * 60_000

const COPY = {
  upstream: "The identity check isn't answering right now. Try again in a moment.",
  expired: 'This check has expired. Start again.',
  untrustedIssuer: "The verifier doesn't accept the issuer of the identity in your wallet. Try a wallet with an EU test identity.",
  rejected: "The verifier couldn't accept what your wallet sent. Start again.",
  declined: "You declined to share in your wallet. Start again when you're ready.",
  walletError: "Your wallet didn't share your details. Start again.",
  missingClaims: "Your wallet didn't share your name and date of birth. Start again and allow both.",
  under18: 'You need to be 18 or older to lift the limits.',
  alreadyVerified: 'Your identity is already verified.',
  notSetUp: 'Identity checks are not set up yet.',
  credentialFailed: "We couldn't record your verification. Try again in a moment.",
  confirming: 'Your approval is being confirmed. This takes a few seconds, sometimes a few minutes.',
  startAgain: 'Start the identity check again.',
} as const

/**
 * IDENTITY_MODE: unset or 'mock' = the fixed test identity; 'eudi' (or 'live') = the public EU reference verifier
 * (https://verifier-backend.eudiw.dev, intended use TEST-01). Any other value throws: a typo must not mean the test identity.
 */
export function verifierFromEnv(env: Env, o: { now: () => number; fetch?: typeof fetch; log?: Logger }): IdentityVerifier {
  const mode = (env.IDENTITY_MODE ?? '').trim().toLowerCase()
  if (mode === '' || mode === 'mock') return createMockVerifier({ now: o.now })
  if (mode === 'eudi' || mode === 'live') {
    return createEudiVerifier({
      fetch: o.fetch,
      // A public CA certificate (PEM, base64), e.g. the test issuer a Paradym wallet got its PID from.
      extraCa: env.IDENTITY_EXTRA_CA_B64 ? Buffer.from(env.IDENTITY_EXTRA_CA_B64, 'base64').toString('utf8') : undefined,
      log: o.log,
    })
  }
  throw new Error(`IDENTITY_MODE must be mock or eudi (or live), not "${env.IDENTITY_MODE}".`)
}

/** tecDUPLICATE on a CredentialAccept: the credential is already accepted (XLS-70), e.g. by an earlier approval of this check. */
const ACCEPTED = new Set(['tesSUCCESS', 'tecDUPLICATE'])

/** A used approval is done with only once its submit has a final answer that is not an acceptance; until then it is being confirmed. */
function spent(core: Core, p: PreparedRow): boolean {
  return preparedOutcome(core, p.id) === 'final' && !ACCEPTED.has(p.engineResult ?? '')
}

function rejectionCopy(st: Extract<VerifierStatus, { state: 'rejected' | 'error' }>): string {
  if (st.state === 'rejected') return /IssuerCertificateIsNotTrusted/i.test(st.cause) ? COPY.untrustedIssuer : COPY.rejected
  return /access_denied|declined|cancel/i.test(st.cause) ? COPY.declined : COPY.walletError
}

const identityOf = (r: IdentitySessionRow): VerifiedIdentity => ({ givenName: r.givenName!, familyName: r.familyName!, birthDate: r.birthDate!, over18: r.over18 === true })

/**
 * Tier 1 for the session's user, once: tier, display name (only when it was empty or the handle), session accepted,
 * a balance event so open screens refresh their limits. Calling it again changes nothing.
 */
export function liftTier(core: Core, row: Pick<IdentitySessionRow, 'userId'> & Partial<IdentitySessionRow>, acceptHash: string): UserRow {
  const before = users.byId(core, row.userId)
  if (!before) throw Err.notFound()
  const first = before.tier !== 1
  core.db.transaction(() => {
    if (first) {
      users.setTier(core, before.id, 1)
      const verifiedName = `${row.givenName ?? ''} ${row.familyName ?? ''}`.trim().slice(0, 60)
      const current = before.displayName.trim().toLowerCase()
      if (verifiedName && (!current || current === before.handle.toLowerCase())) {
        core.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(verifiedName, before.id)
      }
    }
    if (row.id) markAccepted(core, row.id, acceptHash)
  })()
  const after = users.byId(core, before.id)!
  if (first) {
    emitBalance(core, after.id)
    core.log.info(`[identity] @${after.handle} verified, tier 1 (${acceptHash})`)
  }
  return after
}

export function mountIdentity(app: Hono, core: Core, o: { verifier?: IdentityVerifier; fetch?: typeof fetch } = {}): void {
  ensureSchema(core)
  // With the flag off nothing is ever asked, so a bad IDENTITY_MODE only stops the start when the feature is on.
  const verifier =
    o.verifier ??
    (core.settings.features.identity ? verifierFromEnv(core.env, { now: () => core.now(), fetch: o.fetch, log: core.log }) : createMockVerifier({ now: () => core.now() }))
  const inflight = new Map<string, Promise<PreparedTx | undefined>>()

  /**
   * CredentialCreate (once per session), then a still valid or a fresh CredentialAccept to approve. Single flight per session.
   * Undefined while the approval already sent is being confirmed: a second one could not apply (same sequence, or already
   * accepted), so a new one is prepared only once the first has finally failed.
   */
  async function approvalFor(sessionId: string, u: UserRow): Promise<PreparedTx | undefined> {
    const kyc = core.keystore.getWallet('kycIssuer').address
    const row = sessionById(core, sessionId)!
    if (!row.credentialHash) {
      const r = await core.ledger.submitAs('kycIssuer', { TransactionType: 'CredentialCreate', Account: kyc, Subject: u.address, CredentialType: CREDENTIAL_TYPE })
      if (r.engineResult === 'tecDUPLICATE') setCredentialHash(core, row.id, 'existing')
      else if (r.validated && r.engineResult === 'tesSUCCESS') setCredentialHash(core, row.id, r.hash)
      else {
        core.log.warn(`[identity] CredentialCreate for @${u.handle} failed: ${r.engineResult}`)
        throw Err.ledger(COPY.credentialFailed)
      }
    }
    const p = row.prepareId ? preparedById(core, row.prepareId) : undefined
    if (p?.usedAt && !spent(core, p)) return undefined
    const live = p && !p.usedAt && Date.parse(p.expiresAt) > core.now() && (p.lastLedgerSequence === undefined || (await core.ledger.ledgerIndex()) <= p.lastLedgerSequence)
    if (p && live) return { prepareId: p.id, kind: p.kind, tx: p.tx as PreparedTx['tx'], expiresAt: p.expiresAt }
    const tx = await core.ledger.prepareSponsored(
      { TransactionType: 'CredentialAccept', Account: u.address, Issuer: kyc, CredentialType: CREDENTIAL_TYPE },
      { reserve: true, publicKey: u.publicKey },
    )
    const prepared = await storePrepared(core, { address: u.address, publicKey: u.publicKey, kind: 'credential_accept', tx })
    setPrepareId(core, row.id, prepared.prepareId)
    return prepared
  }

  async function respond(row: IdentitySessionRow, userId: string) {
    if (row.status === 'pending') return { status: 'pending' as const }
    if (row.status === 'rejected' || row.status === 'error') return { status: row.status, message: row.message ?? COPY.rejected }
    const identity = identityOf(row)
    if (row.status === 'accepted') return { status: 'verified' as const, identity }
    if (!identity.over18) return { status: 'verified' as const, identity, message: COPY.under18 }
    const u = users.byId(core, userId)!
    if (u.tier === 1) return { status: 'verified' as const, identity, message: COPY.alreadyVerified }
    if (!core.keystore.hasWallet('kycIssuer')) {
      core.log.error('[identity] no kycIssuer wallet in the key store: cannot issue the credential')
      return { status: 'error' as const, message: COPY.notSetUp }
    }
    let p = inflight.get(row.id)
    if (!p) {
      p = approvalFor(row.id, u).finally(() => inflight.delete(row.id))
      inflight.set(row.id, p)
    }
    const prepared = await p
    return prepared ? { status: 'verified' as const, identity, prepared } : { status: 'verified' as const, identity, message: COPY.confirming }
  }

  mount(app, core, 'identitySessionCreate', async ({ user }) => {
    const u = user!
    core.rateLimit(`identity:${u.id}`)
    let t: { transactionId: string; link: string }
    try {
      t = await verifier.start()
    } catch (e) {
      core.log.warn(`[identity] could not start a check: ${(e as Error)?.message ?? e}`)
      throw Err.upstream(COPY.upstream)
    }
    const now = core.now()
    const id = core.id('idv')
    const expiresAt = core.iso(now + SESSION_TTL_MS)
    insertSession(core, { id, userId: u.id, mode: verifier.mode, transactionId: t.transactionId, link: t.link, createdAt: core.iso(now), expiresAt })
    return { id, qrUrl: t.link, deepLink: t.link, expiresAt, mode: verifier.mode }
  })

  mount(app, core, 'identitySessionGet', async ({ params, user }) => {
    const u = user!
    const row = sessionById(core, params.id)
    if (!row || row.userId !== u.id) throw Err.notFound()
    if (row.status === 'pending') {
      if (Date.parse(row.expiresAt) <= core.now()) endSession(core, row.id, 'error', COPY.expired)
      else {
        const st = await verifier.poll(row.transactionId, Date.parse(row.createdAt))
        if (st.state === 'rejected' || st.state === 'error') endSession(core, row.id, st.state, rejectionCopy(st))
        else if (st.state === 'verified') {
          const { givenName, familyName, birthDate } = st.claims
          if (!givenName || !familyName || !birthDate) endSession(core, row.id, 'error', COPY.missingClaims)
          else markVerified(core, row.id, { givenName, familyName, birthDate, over18: isOver18(birthDate, core.now()) }, core.iso())
        }
      }
    }
    return respond(sessionById(core, row.id)!, u.id)
  })
}

export function registerIdentity(core: Core): void {
  ensureSchema(core)
  core.submitHandlers.set('credential_accept', {
    before(core, p) {
      if (!core.settings.features.identity) throw Err.featureOff()
      const row = sessionByPrepareId(core, p.id)
      const u = users.byAddress(core, p.address)
      if (!row || !u || row.userId !== u.id || row.status !== 'verified') throw Err.policy(COPY.startAgain)
    },
    after(core, p, r) {
      // finish() passes a validated tec as not validated: tecDUPLICATE (already accepted) still means the check stands.
      if (!r.validated && r.engineResult !== 'tecDUPLICATE') return {}
      const row = sessionByPrepareId(core, p.id)
      if (row) return { user: toUser(liftTier(core, row, r.hash)) }
      // Not expected (every approval is kept with its session), but the credential is accepted on the ledger: lift the account.
      core.log.error(`[identity] approval ${p.id} accepted without a session; lifting the account's tier`)
      const u = users.byAddress(core, p.address)
      return u ? { user: toUser(liftTier(core, { userId: u.id }, r.hash)) } : {}
    },
  })
}
