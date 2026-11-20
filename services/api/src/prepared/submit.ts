// POST /v1/tx/submit: policy check, mark used BEFORE submitting, sponsor co-sign + submit (in the Ledger), then the kind's effects.
import type { Hono } from 'hono'
import type { Intent, SubmitResult, User } from '@zecca/contracts'
import type { Core } from '../core'
import { Err } from '../errors'
import { mount } from '../http'
import type { Session } from '../auth/sessions'
import { checkSubmission, markUsed, recordResult, type PreparedRow, POLICY_COPY } from './store'

export type SubmitHandler = {
  /** Last checks before the transaction is sent (throw an ApiErr to refuse; nothing is marked used then). May reserve funds. */
  before?(core: Core, p: PreparedRow, session: Session): Promise<void> | void
  /** Undo what `before` reserved when the submit throws (network) or fails on the ledger. */
  undo?(core: Core, p: PreparedRow, session: Session, reason: { engineResult: string }): Promise<void> | void
  /** Effects once the ledger answered. */
  after(core: Core, p: PreparedRow, r: SubmitResult, session: Session): Promise<{ intent?: Intent; user?: User }> | { intent?: Intent; user?: User }
}

export function mountSubmit(app: Hono, core: Core): void {
  mount(app, core, 'txSubmit', async ({ body, session }) => {
    const p = await checkSubmission(core, session!, body.prepareId, body.txBlob)
    const h = core.submitHandlers.get(p.kind)
    if (!h) throw Err.policy("This kind of approval isn't accepted yet.")
    await h.before?.(core, p, session!)
    if (!markUsed(core, p.id)) {
      await h.undo?.(core, p, session!, { engineResult: 'ALREADY_USED' })
      throw Err.policy(POLICY_COPY.used)
    }

    let r: SubmitResult
    try {
      r = await core.ledger.submitUserSigned(body.txBlob)
    } catch (e) {
      core.log.error(`[submit] ${p.kind} ${p.id} failed to reach the ledger: ${(e as Error).message}`)
      recordResult(core, p.id, { engineResult: 'SUBMIT_ERROR' })
      await h.undo?.(core, p, session!, { engineResult: 'SUBMIT_ERROR' })
      throw Err.ledger()
    }
    recordResult(core, p.id, r)
    const ok = r.validated && r.engineResult === 'tesSUCCESS'
    if (!ok) {
      core.log.warn(`[submit] ${p.kind} ${p.id} ${r.engineResult}`)
      await h.undo?.(core, p, session!, { engineResult: r.engineResult })
    }
    const extra = await h.after(core, p, { ...r, validated: ok }, session!)
    return { status: ok ? ('validated' as const) : ('failed' as const), hash: r.hash, engineResult: r.engineResult, ...extra }
  })
}
