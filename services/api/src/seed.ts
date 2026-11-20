// Seeds the demo shop's merchant account ('Sette Archi', SPEC §4.14) from the key store's 'demoShop' wallet. Idempotent.
import * as rk from 'ripple-keypairs'
import type { Core } from './core'
import { users } from './users'

export const DEMO_SHOP = { handle: 'settearchi', businessName: 'Sette Archi', displayName: 'Sette Archi' } as const

export async function seedDemoShop(core: Core): Promise<string | undefined> {
  if (!core.keystore.hasWallet('demoShop')) {
    core.log.warn('[seed] no demoShop wallet in the key store: the demo shop has no merchant')
    return undefined
  }
  const w = core.keystore.getWallet('demoShop')
  const existing = users.byAddress(core, w.address)
  if (existing) return existing.id
  if (users.byHandle(core, DEMO_SHOP.handle)) {
    core.log.warn(`[seed] @${DEMO_SHOP.handle} is taken by another account: the demo shop is not seeded`)
    return undefined
  }
  if (!(await core.ledger.accountExists(w.address))) core.log.warn(`[seed] the demo shop account ${w.address} is not on the ledger yet (run the bootstrap script)`)
  if (!core.keystore.has({ user: w.address })) core.keystore.createUserElGamal(w.address)
  const id = core.id('usr')
  const at = core.iso()
  users.insert(core, {
    id,
    address: w.address,
    publicKey: rk.deriveKeypair(w.seed).publicKey.toUpperCase(),
    handle: DEMO_SHOP.handle,
    displayName: DEMO_SHOP.displayName,
    roles: ['user', 'merchant'],
    // Verified business: the tier-0 balance cap would stop the shop after a few sales.
    tier: 1,
    businessName: DEMO_SHOP.businessName,
    feeBps: core.settings.merchantFeeBps,
    status: 'active',
    createdAt: at,
    activatedAt: at,
  })
  core.log.info(`[seed] demo shop @${DEMO_SHOP.handle} (${w.address})`)
  return id
}
