import type { IntentStatus, PaymentRequestStatus } from './domain'

// SPEC §8. The only allowed transitions. Effects on `received` are idempotent, keyed by intent id.
export const INTENT_TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  created: ['submitted', 'expired', 'failed'],
  submitted: ['received', 'failed'],
  received: ['paid_out', 'failed'],
  paid_out: [],
  failed: [],
  expired: [],
}

export const PAYMENT_REQUEST_TRANSITIONS: Record<PaymentRequestStatus, readonly PaymentRequestStatus[]> = {
  created: ['opened', 'paid', 'expired', 'cancelled'],
  opened: ['paid', 'expired', 'cancelled'],
  paid: [],
  expired: [],
  cancelled: [],
}

export function canTransitionIntent(from: IntentStatus, to: IntentStatus): boolean {
  return INTENT_TRANSITIONS[from].includes(to)
}

export function canTransitionPaymentRequest(from: PaymentRequestStatus, to: PaymentRequestStatus): boolean {
  return PAYMENT_REQUEST_TRANSITIONS[from].includes(to)
}

export class InvalidTransition extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`${entity}: ${from} -> ${to} is not allowed`)
    this.name = 'InvalidTransition'
  }
}

export function assertIntentTransition(from: IntentStatus, to: IntentStatus): void {
  if (!canTransitionIntent(from, to)) throw new InvalidTransition('intent', from, to)
}

export function assertPaymentRequestTransition(from: PaymentRequestStatus, to: PaymentRequestStatus): void {
  if (!canTransitionPaymentRequest(from, to)) throw new InvalidTransition('payment request', from, to)
}

/** What the user sees of an intent's status. */
export function activityStatusOf(status: IntentStatus): 'pending' | 'done' | 'failed' {
  if (status === 'failed' || status === 'expired') return 'failed'
  if (status === 'received' || status === 'paid_out') return 'done'
  return 'pending'
}
