// The devnet factory, with the live ledger and the file key store replaced: no network, no key file.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ created: [] as Record<string, unknown>[] }))
vi.mock('@zecca/xrpl-core', () => ({
  createLiveLedger: (o: Record<string, unknown>) => {
    h.created.push(o)
    return { close: async () => {} }
  },
}))
vi.mock('@zecca/keystore', async (orig) => ({ ...(await orig<typeof import('@zecca/keystore')>()), openKeyStoreFromEnv: () => ({}) }))

describe('devnet pool deps', () => {
  it("passes the thread's log to the live ledger, so its connection diagnostics are not dropped", async () => {
    const { createPoolDeps } = await import('./live-deps')
    const log = (_m: string) => {}
    const deps = await createPoolDeps({ POOL_DB_PATH: ':memory:' }, { log })
    expect(h.created).toEqual([expect.objectContaining({ network: 'devnet', log })])
    await deps.close?.()
  })
})
