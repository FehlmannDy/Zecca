// The approve step of a send, and what "Try again" does. A submit whose answer was lost may still land: the API keeps
// the reservation and settles it from the ledger (services/api/src/prepared/submit.ts). So "Try again" asks the API
// where the transfer is first, and never makes a second payment while the first one can still go through.
import type { Intent, IntentStatus, PreparedTx } from '@zecca/contracts'

export type Transfer = { intent: Intent; prepared: PreparedTx }

export type ApproveDeps = {
  /** GET /v1/transfers/:id */
  getIntent(id: string): Promise<Intent>
  /** POST /v1/transfers again, same recipient, amount and note. */
  create(): Promise<Transfer>
  /** Sign the prepared tx and POST /v1/tx/submit. Resolves with the updated intent when the API sends it. */
  submit(prepared: PreparedTx): Promise<Intent | undefined>
  /** A new transfer replaced the old one. */
  onTransfer(t: Transfer): void
  /** The payment may still land: follow it instead of offering another one. Called before the error is rethrown. */
  onUnsure(intent: Intent, message: string): void
}

export const STILL_ON_ITS_WAY = "We haven't heard back yet, so this payment may still go through. It will update here by itself."

/** Only an answer of the API client (ZeccaApiError, by name: this file stays free of browser code) says anything. */
type ErrLike = { status?: unknown; code?: unknown; message?: unknown }
const asErr = (e: unknown): ErrLike => (e instanceof Error && e.name === 'ZeccaApiError' ? (e as ErrLike) : {})

/** What "Try again" does with the transfer we already have, from its status on the API. */
export function retryStep(status: IntentStatus): 'done' | 'resubmit' | 'new' {
  if (status === 'submitted' || status === 'received' || status === 'paid_out') return 'done'
  if (status === 'created') return 'resubmit'
  return 'new'
}

/**
 * What a failed submit says. 'unsure': it may still land (no answer, a dropped connection, a server error, or, when sending
 * the same approval again, the API saying it was already used). 'expired': the approval expired unused (the API checks
 * "used" first). 'final': it did not happen.
 */
export function submitFailure(e: unknown, again: boolean): { kind: 'unsure'; message: string } | { kind: 'expired' } | { kind: 'final' } {
  const { status, code, message } = asErr(e)
  if (typeof status !== 'number') return { kind: 'final' }
  if (status === 502 && code === 'ledger_error' && typeof message === 'string' && message) return { kind: 'unsure', message }
  if (status === 0 || status >= 500) return { kind: 'unsure', message: STILL_ON_ITS_WAY }
  if (again && code === 'policy_refused') return typeof message === 'string' && /expired/i.test(message) ? { kind: 'expired' } : { kind: 'unsure', message: STILL_ON_ITS_WAY }
  return { kind: 'final' }
}

/** Approve (retry false) or "Try again" (retry true). Resolves with the intent to follow; throws the error to show. */
export async function approveTransfer(t: Transfer, retry: boolean, d: ApproveDeps): Promise<Intent> {
  if (!retry) return submit(t, false, d)
  const now = await d.getIntent(t.intent.id)
  const step = retryStep(now.status)
  if (step === 'done') return now
  if (step === 'resubmit') return submit(t, true, d)
  return submit(await renew(d), false, d)
}

async function renew(d: ApproveDeps): Promise<Transfer> {
  const t = await d.create()
  d.onTransfer(t)
  return t
}

async function submit(t: Transfer, again: boolean, d: ApproveDeps): Promise<Intent> {
  try {
    return (await d.submit(t.prepared)) ?? t.intent
  } catch (e) {
    const f = submitFailure(e, again)
    if (f.kind === 'expired') return submit(await renew(d), false, d)
    if (f.kind === 'unsure') d.onUnsure(t.intent, f.message)
    throw e
  }
}
