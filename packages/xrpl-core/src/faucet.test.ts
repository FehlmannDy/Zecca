import { describe, expect, it } from 'vitest'
import { FAUCET_URLS, fund, waitForAccount } from './faucet'

describe('faucet', () => {
  it('posts the destination to the network faucet', async () => {
    const calls: [string, unknown][] = []
    await fund('rDest', 'devnet', { post: async (url, body) => (calls.push([url, body]), 200), retryMs: 0 })
    await fund('rDest2', 'testnet', { post: async (url, body) => (calls.push([url, body]), 200), retryMs: 0 })
    expect(calls).toEqual([
      ['https://faucet.devnet.rippletest.net/accounts', { destination: 'rDest' }],
      ['https://faucet.altnet.rippletest.net/accounts', { destination: 'rDest2' }],
    ])
    expect(FAUCET_URLS.devnet).toBe('https://faucet.devnet.rippletest.net/accounts')
  })

  it('retries a busy faucet, then fails with the status', async () => {
    let n = 0
    await fund('r1', 'devnet', { post: async () => (++n < 3 ? 503 : 200), retryMs: 0 })
    expect(n).toBe(3)
    await expect(fund('r1', 'devnet', { post: async () => 429, retryMs: 0, attempts: 2 })).rejects.toThrow(/faucet 429/)
  })

  it('waitForAccount polls until the account is visible', async () => {
    let n = 0
    const client = { accountInfo: async () => (++n < 3 ? null : { Sequence: 1 }) }
    await waitForAccount(client, 'rX', { intervalMs: 0 })
    expect(n).toBe(3)
    await expect(waitForAccount({ accountInfo: async () => null }, 'rY', { intervalMs: 0, tries: 2 })).rejects.toThrow(/not visible/)
  })
})
