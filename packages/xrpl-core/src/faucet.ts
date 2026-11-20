// Test-network faucets. Ported from privy-xrpl-probe web/server.mjs faucetPost + waitAccount (node:https, so the
// dev-laptop dnsfix preload applies), with a retry for a busy faucet.
import https from 'node:https'
import type { Network } from '@zecca/contracts'

export const FAUCET_URLS: Record<Network, string> = {
  devnet: 'https://faucet.devnet.rippletest.net/accounts',
  testnet: 'https://faucet.altnet.rippletest.net/accounts',
}

type Post = (url: string, body: unknown) => Promise<number>

const httpsPost: Post = (url, body) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 30_000 }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('faucet timeout')))
    req.end(JSON.stringify(body))
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Asks the faucet to fund (or create) `address`. Does not wait for the account: see waitForAccount. */
export async function fund(address: string, network: Network, opts: { post?: Post; attempts?: number; retryMs?: number } = {}): Promise<void> {
  const post = opts.post ?? httpsPost
  const attempts = opts.attempts ?? 4
  let last = ''
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep((opts.retryMs ?? 3000) * i)
    try {
      const status = await post(FAUCET_URLS[network], { destination: address })
      if (status === 200) return
      last = `faucet ${status}`
    } catch (e) {
      last = `faucet ${String((e as Error).message)}`
    }
  }
  throw new Error(`${last} (${network}, ${address})`)
}

export async function waitForAccount(
  client: { accountInfo(address: string): Promise<unknown | null> },
  address: string,
  opts: { tries?: number; intervalMs?: number } = {},
): Promise<void> {
  const tries = opts.tries ?? 30
  for (let i = 0; i < tries; i++) {
    if (await client.accountInfo(address)) return
    await sleep(opts.intervalMs ?? 2000)
  }
  throw new Error(`account not visible ${address}`)
}
