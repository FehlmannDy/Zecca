// Sign-up (SPEC §2.4): POST /v1/onboarding/prepare, and the effects of the validated onboarding Batch.
import type { Hono } from 'hono'
import type { Core } from './core'
import { Err } from './errors'
import { mount } from './http'
import { storePrepared } from './prepared/store'
import { addActivity, adjustBalance, claimEffect, emitActivity, emitBalance } from './books'
import { intents, ZECCA } from './intents/repo'
import { toUser, users, type UserRow } from './users'
import { handleStatus } from './directory'

export function mountOnboarding(app: Hono, core: Core): void {
  mount(app, core, 'onboardingPrepare', async ({ body, session }) => {
    const s = session!
    const publicKey = body.publicKey.toUpperCase()
    if (body.address !== s.address || publicKey !== s.publicKey.toUpperCase()) throw Err.forbidden('Sign up with the account you signed in with.')

    const existing = users.byAddress(core, s.address)
    if (existing?.status === 'active') throw Err.alreadySignedUp()
    if (s.privyUserId) {
      const other = users.byPrivyId(core, s.privyUserId)
      if (other && other.address !== s.address) throw Err.alreadySignedUp()
    }
    const handle = body.handle.toLowerCase()
    const hs = handleStatus(core, handle, s.address)
    if (!hs.available) throw Err.handleTaken()
    if (body.role === 'merchant' && !body.businessName) throw Err.badRequest('Add your business name.')
    core.rateLimit(s.address)

    const row: UserRow = {
      id: existing?.id ?? core.id('usr'),
      address: s.address,
      publicKey,
      handle,
      displayName: body.displayName.trim(),
      roles: body.role === 'merchant' ? ['user', 'merchant'] : ['user'],
      email: body.email?.toLowerCase(),
      tier: 0,
      businessName: body.role === 'merchant' ? body.businessName!.trim() : undefined,
      feeBps: body.role === 'merchant' ? core.settings.merchantFeeBps : undefined,
      privyUserId: s.privyUserId,
      status: 'pending',
      createdAt: core.iso(),
    }
    core.db.transaction(() => {
      if (hs.staleHolderId) users.remove(core, hs.staleHolderId)
      if (existing) users.remove(core, existing.id)
      users.insert(core, row)
    })()

    await core.ledger.ensureAccount(s.address)
    core.keystore.createUserElGamal(s.address)
    const holderKey = core.keystore.getElGamal({ user: s.address })
    const delegateMergeTo = core.keystore.hasWallet('relayer') ? core.keystore.getWallet('relayer').address : undefined
    const tx = await core.ledger.buildOnboarding({
      address: s.address,
      publicKey,
      holderKey,
      welcomeCreditMinor: core.settings.welcomeCreditMinor,
      delegateMergeTo,
    })
    return storePrepared(core, { address: s.address, publicKey, kind: 'onboarding', tx })
  })

  core.submitHandlers.set('onboarding', {
    before(core, p) {
      const u = users.byAddress(core, p.address)
      if (!u) throw Err.policy('Start signing up again.')
      if (u.status === 'active') throw Err.alreadySignedUp()
    },
    after(core, p, r) {
      const u = users.byAddress(core, p.address)!
      if (!r.validated) return {}
      const welcome = core.settings.welcomeCreditMinor
      let activityId: string | undefined
      core.db.transaction(() => {
        users.activate(core, u.id, core.iso())
        if (welcome > 0 && claimEffect(core, `welcome:${u.id}`)) {
          const intentId = core.id('int')
          intents.insert(core, {
            id: intentId,
            kind: 'welcome',
            status: 'paid_out',
            fromUserId: ZECCA,
            toUserId: u.id,
            amountMinor: welcome,
            feeMinor: 0,
            note: 'Demo credit',
            depositTxHash: r.hash,
            submittedAt: core.iso(),
          })
          adjustBalance(core, u.id, { available: welcome })
          activityId = addActivity(core, { userId: u.id, intentId, direction: 'in', kind: 'welcome', amountMinor: welcome, feeMinor: 0, note: 'Demo credit' })
        }
      })()
      emitBalance(core, u.id)
      emitActivity(core, activityId)
      core.log.info(`[onboarding] ${u.handle} active (${r.hash})`)
      return { user: toUser(users.byId(core, u.id)!) }
    },
  })
}
