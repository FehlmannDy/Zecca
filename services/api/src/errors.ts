// API errors. Every message is English and fit to show to a user as is (SPEC §5, UI.md §5).
import type { ApiError, ErrorCode, LimitName } from '@zecca/contracts'
import { formatUsd } from '@zecca/contracts'

type Details = NonNullable<ApiError['error']['details']>

export class ApiErr extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 | 502 | 503,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Details,
  ) {
    super(message)
    this.name = 'ApiErr'
  }
  body(): ApiError {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } }
  }
}

export const COPY = {
  handleTaken: 'Taken, try another.',
  expiredRequest: 'This request has expired. Ask the merchant for a new one.',
  alreadyPaid: 'This request has already been paid.',
  cancelledRequest: 'This request was cancelled. Ask the merchant for a new one.',
  tier0Limit: "You've reached the limit for unverified accounts. Verify your identity to lift it.",
  notSignedUp: 'Finish signing up first.',
  unauthorized: 'Please sign in again.',
  rateLimited: 'Too many attempts. Wait a minute and try again.',
  notFound: 'Not found.',
  featureOff: 'This feature is not available yet.',
} as const

export const Err = {
  badRequest: (message = 'Some details are missing or not valid.') => new ApiErr(400, 'bad_request', message),
  unauthorized: (message: string = COPY.unauthorized) => new ApiErr(401, 'unauthorized', message),
  forbidden: (message = "You can't do that from this account.") => new ApiErr(403, 'forbidden', message),
  notFound: (message: string = COPY.notFound) => new ApiErr(404, 'not_found', message),
  featureOff: () => new ApiErr(404, 'feature_off', COPY.featureOff),
  notSignedUp: () => new ApiErr(403, 'not_signed_up', COPY.notSignedUp),
  alreadySignedUp: () => new ApiErr(409, 'already_signed_up', 'You already have an account. Sign in instead.'),
  handleTaken: () => new ApiErr(409, 'handle_taken', COPY.handleTaken),
  conflict: (message: string) => new ApiErr(409, 'conflict', message),
  expired: (message: string = COPY.expiredRequest) => new ApiErr(409, 'expired', message),
  alreadyPaid: () => new ApiErr(409, 'already_paid', COPY.alreadyPaid),
  policy: (message: string) => new ApiErr(403, 'policy_refused', message),
  signature: (message = "The approval signature doesn't match your account.") => new ApiErr(403, 'signature_invalid', message),
  rateLimited: () => new ApiErr(429, 'rate_limited', COPY.rateLimited),
  ledger: (message = "The payment network didn't answer. Try again in a moment.") => new ApiErr(502, 'ledger_error', message),
  upstream: (message: string) => new ApiErr(502, 'upstream_error', message),
  internal: (message = 'Something went wrong on our side. Try again.') => new ApiErr(500, 'internal', message),
  insufficient: (shortMinor: number) =>
    new ApiErr(409, 'insufficient_funds', `You need ${formatUsd(shortMinor)} more.`, { shortMinor }),
  limit: (limit: LimitName, capMinor: number, usedMinor: number, message: string) =>
    new ApiErr(403, 'limit_reached', message, { limit, capMinor, usedMinor }),
}
