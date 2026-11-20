// Lithic Auth Stream Access (ASA): signature check, request parsing, response shape. Port of card-issuer/src/lithic.js.
// Sources (accessed 2026-11-20):
//   request/response schema  https://docs.lithic.com/reference/cardauthorizationapprovalrequestwebhook
//   ASA (6 s deadline, HMAC) https://docs.lithic.com/docs/auth-stream-access-asa
//   signature scheme         https://docs.lithic.com/docs/events-api  ("Verifying Webhooks")
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** Lithic's reference code rejects timestamps outside +/- 5 minutes. */
export const TOLERANCE_S = 5 * 60

type Raw = string | Uint8Array

// The secret is "whsec_<base64>"; the HMAC key is the base64-decoded part after the prefix.
const keyOf = (secret: string) => Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
const sign = (id: string, ts: string | number, raw: Raw, secret: string) =>
  createHmac('sha256', keyOf(secret)).update(`${id}.${ts}.`).update(raw).digest('base64')

export type SignatureHeaders = Record<string, string | undefined>

/** Headers: webhook-id, webhook-timestamp, webhook-signature ("v1,<b64>" entries, space-separated). */
export function verifySignature(raw: Raw, headers: SignatureHeaders, secret: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const id = headers['webhook-id']
  const ts = headers['webhook-timestamp']
  const sigs = headers['webhook-signature']
  if (!secret || !id || !ts || !sigs) return false
  if (!(Math.abs(nowS - Number(ts)) <= TOLERANCE_S)) return false // also rejects NaN
  const want = Buffer.from(sign(id, ts, raw, secret))
  return sigs.split(' ').some((entry) => {
    const [version, sig] = entry.split(',')
    const got = Buffer.from(sig ?? '')
    return version === 'v1' && got.length === want.length && timingSafeEqual(got, want)
  })
}

/** What Lithic would send; used by tests and local drivers to sign with a TEST secret. */
export function signHeaders(raw: Raw, secret: string, { id = randomUUID(), ts = Math.floor(Date.now() / 1000) }: { id?: string; ts?: number } = {}) {
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sign(id, ts, raw, secret)}` }
}

// Only these statuses move money out of the card balance; credits and balance inquiries are approved without reserving anything.
const DEBIT_STATUSES = new Set(['AUTHORIZATION', 'FINANCIAL_AUTHORIZATION'])

export type ParsedAuthorization = {
  id: string
  cardToken: string | undefined
  /** amounts.cardholder.amount: the card's currency, smallest unit (cents for our USD program). */
  amount: number | undefined
  debitsFunds: boolean
  status: string | undefined
  merchant: string
}

// The body is Lithic's JSON, read defensively field by field.
export function parseAuthorization(body: any): ParsedAuthorization {
  return {
    id: body?.token,
    cardToken: body?.card?.token,
    // `amount` is deprecated; amounts.cardholder is in the card's currency, smallest unit.
    amount: body?.amounts?.cardholder?.amount,
    debitsFunds: DEBIT_STATUSES.has(body?.status),
    status: body?.status,
    merchant: typeof body?.merchant?.descriptor === 'string' ? body.merchant.descriptor : '',
  }
}

/** Response: HTTP 200 + JSON; `result` required, `token` echoes the request. Unknown cards are declined as INSUFFICIENT_FUNDS too. */
export const buildResponse = (auth: { id: string }, decision: { approved: boolean }) => ({
  token: auth.id,
  result: decision.approved ? 'APPROVED' : 'INSUFFICIENT_FUNDS',
})

/** A request body with every field the schema marks required, plus event_type. Values are illustrative and follow the schema types. */
export function sampleAuthorization({
  token,
  cardToken,
  amount,
  status = 'AUTHORIZATION',
  descriptor = 'HACKATHON COFFEE',
}: {
  token: string
  cardToken: string
  amount: number
  status?: string
  descriptor?: string
}) {
  return {
    event_type: 'card_authorization.approval_request',
    token,
    status,
    created: new Date().toISOString(),
    acquirer_fee: 0,
    amount, // deprecated
    authorization_amount: amount, // deprecated
    settled_amount: amount, // deprecated
    merchant_amount: amount, // deprecated
    merchant_currency: 'USD', // deprecated
    cardholder_currency: 'USD', // deprecated
    cash_amount: 0,
    amounts: {
      cardholder: { amount, conversion_rate: '1.000000', currency: 'USD' },
      merchant: { amount, currency: 'USD' },
      settlement: null,
      hold: { amount, currency: 'USD' },
    },
    avs: { address: '', zipcode: '', address_on_file_match: 'NOT_PRESENT' },
    card: { token: cardToken, last_four: '4242', memo: 'demo', spend_limit: 0, spend_limit_duration: 'TRANSACTION', state: 'OPEN', tags: {}, type: 'VIRTUAL' },
    merchant: {
      acceptor_id: '174030075991',
      acquiring_institution_id: '191231',
      city: 'ZURICH',
      country: 'CHE',
      descriptor,
      mcc: '5814',
      state: '',
      postal_code: null,
      street_address: null,
      phone_number: null,
    },
    name_validation: null,
    service_location: null,
    transaction_initiator: 'CARDHOLDER',
  }
}
