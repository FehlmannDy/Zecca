// POST /v1/webhooks/lithic/asa: Lithic asks "approve this purchase?" and has 6 s (3 s recommended) for the answer.
// Signature first (never weakened), then the decision from the card balance in the database, no ledger on this path.
// The ledger comes after the answer, at the clearing (sync.ts): the pool pays what was taken to the card settlement
// account (SPEC §4.6). Settling later than the answer leaves nothing to undo on the ledger for a void or a late decline.
import type { Context } from 'hono'
import type { Core } from '../../core'
import { ApiErr, Err } from '../../errors'
import { asaSecret, displayMerchant, emitAuthorization, type CardCtx } from './context'
import { buildResponse, parseAuthorization, verifySignature } from './lithic-sig'
import type { HoldRow } from './store'

export async function handleAsa(core: Core, ctx: CardCtx, c: Context): Promise<{ token: string; result: string }> {
  if (!core.settings.features.card) throw Err.featureOff()
  const t0 = performance.now()
  const raw = Buffer.from(await c.req.arrayBuffer())
  const secret = await asaSecret(core, ctx).catch((e) => {
    core.log.error(`[card] asa: could not read the ASA secret: ${(e as Error).message}`)
    return undefined
  })
  if (!secret) throw new ApiErr(503, 'upstream_error', 'Card authorizations are not set up yet.')
  const headers = { 'webhook-id': c.req.header('webhook-id'), 'webhook-timestamp': c.req.header('webhook-timestamp'), 'webhook-signature': c.req.header('webhook-signature') }
  if (!verifySignature(raw, headers, secret, Math.floor(core.now() / 1000))) {
    // Presence only, never values: tells whether Lithic has started signing yet (a few minutes after setup).
    core.log.warn(`[card] asa 401 bad signature (signature headers ${headers['webhook-signature'] ? 'present' : 'absent'})`)
    throw Err.unauthorized('Bad signature.')
  }
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    throw Err.badRequest('The request body must be JSON.')
  }
  const auth = parseAuthorization(body)
  if (typeof auth.id !== 'string' || !auth.id) throw Err.badRequest('token is missing.')

  const card = auth.cardToken ? ctx.store.cardByToken(auth.cardToken) : undefined
  const merchant = displayMerchant(auth.merchant)
  let approved = false
  let hold: HoldRow | undefined
  let fresh = false
  if (!card) approved = false // unknown card: no balance behind it
  else if (!auth.debitsFunds) approved = true // credits and balance inquiries: nothing to spend
  else if (!Number.isSafeInteger(auth.amount) || (auth.amount as number) < 0) approved = false
  else if (auth.amount === 0) approved = true // a $0 card check
  else {
    const d = ctx.store.authorize({
      authToken: auth.id,
      userId: card.userId,
      cardToken: card.token,
      amountMinor: auth.amount as number,
      merchant,
      frozen: card.state !== 'OPEN',
    })
    approved = d.approved
    hold = d.hold
    fresh = !d.duplicate
  }
  const res = buildResponse(auth, { approved })
  core.log.info(
    `[card] asa ${auth.id} ${auth.status ?? '-'} amount=${auth.amount ?? '-'} card=${card ? 'known' : 'unknown'} -> ${res.result} in ${(performance.now() - t0).toFixed(1)} ms`,
  )
  if (fresh && hold) emitAuthorization(core, hold)
  return res
}
