import { describe, expect, it } from 'vitest'
import { makeHarness } from './testing/harness'
import { seedDemoShop } from './seed'

describe('seedDemoShop', () => {
  it('still seeds the shop when the ledger cannot answer at startup (e.g. Devnet notSynced)', async () => {
    const h = makeHarness()
    h.ledger.accountExists = async () => {
      throw new Error('notSynced')
    }
    const id = await seedDemoShop(h.app.core)
    expect(id).toMatch(/^usr_/)
  })
})
