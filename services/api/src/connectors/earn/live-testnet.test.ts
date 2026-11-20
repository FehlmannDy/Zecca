import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { createMemoryKeyStore } from '@zecca/keystore'
import { generateWalletSecret, type XrplClient } from '@zecca/xrpl-core'
import { createLiveTestnet } from './live-testnet'
import { FAUCET_GRANT_DROPS, FAUCET_ROUNDS, type Signed } from './sides'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A client whose open ledger works like rippled's 'current': an account's Sequence moves only when a tx is applied. */
function fakeClient() {
  const seq = new Map<string, number>()
  const bal = new Map<string, bigint>()
  const slots = new Set<string>()
  const queues = new Map<string, Promise<unknown>>()
  const outsideQueue: string[] = []
  const sent: string[] = []
  const client = {
    async autofill(tx: { Account: string }) {
      if (!slots.has(tx.Account)) outsideQueue.push('autofill')
      await sleep(5)
      return { ...tx, Sequence: seq.get(tx.Account) ?? 100, Fee: '12', LastLedgerSequence: 1000 }
    },
    serial<T>(account: string, fn: () => Promise<T>): Promise<T> {
      const run = (queues.get(account) ?? Promise.resolve()).then(async () => {
        slots.add(account)
        try {
          return await fn()
        } finally {
          slots.delete(account)
        }
      })
      queues.set(account, run.catch(() => {}))
      return run
    },
    async submitAndWait(blob: string) {
      const d = xrpl.decode(blob) as { Account: string; Sequence: number }
      if (!slots.has(d.Account)) outsideQueue.push('submit')
      const hash = xrpl.hashes.hashSignedTx(blob)
      sent.push(hash)
      await sleep(20)
      if (d.Sequence < (seq.get(d.Account) ?? 100)) return { validated: false, engineResult: 'tefPAST_SEQ', hash }
      seq.set(d.Account, d.Sequence + 1)
      return { validated: true, engineResult: 'tesSUCCESS', hash }
    },
    async accountInfo(a: string) {
      const b = bal.get(a)
      return b === undefined ? null : { Balance: String(b) }
    },
  }
  return { client: client as unknown as XrplClient, bal, outsideQueue, sent }
}

const keystore = () => {
  const ks = createMemoryKeyStore({ generateElGamal: () => ({ publicKey: '02' + '1'.repeat(64), privateKey: '2'.repeat(64) }) })
  ks.setWallet('testnetTreasury', generateWalletSecret())
  return ks
}
const dest = () => xrpl.Wallet.generate().classicAddress

describe('live Testnet side', () => {
  it('two treasury payments at once get two sequences: fill, sign, persist and submit share one queue slot', async () => {
    const f = fakeClient()
    const side = createLiveTestnet({ keystore: keystore(), client: f.client })
    const stored: Signed[] = []
    const persist = (s: Signed) => {
      expect(f.sent).not.toContain(s.hash) // stored before it can reach the ledger
      stored.push(s)
    }
    const out = await Promise.all([dest(), dest()].map((d) => side.pay('treasury', { Destination: d, Amount: '1000000' }, persist)))
    expect(out.map((o) => o.engineResult)).toEqual(['tesSUCCESS', 'tesSUCCESS'])
    expect(stored.map((s) => (xrpl.decode(s.blob) as { Sequence: number }).Sequence)).toEqual([100, 101])
    expect(out.map((o) => o.hash)).toEqual(stored.map((s) => s.hash))
    expect(f.outsideQueue).toEqual([])
  })

  it("a user wallet's payment and the resubmission of a stored blob also run in the account's queue", async () => {
    const f = fakeClient()
    const ks = keystore()
    const side = createLiveTestnet({ keystore: ks, client: f.client })
    let first: Signed | undefined
    await side.pay({ user: 'rUserOnDevnet' }, { Destination: dest(), Amount: '300000' }, (s) => void (first = s))
    expect((await side.submit(first!.blob)).engineResult).toBe('tefPAST_SEQ')
    expect(f.outsideQueue).toEqual([])
  })

  it('tops the treasury up with as many faucet grants as it needs, within the bound', async () => {
    const f = fakeClient()
    const ks = keystore()
    const t = ks.getWallet('testnetTreasury').address
    f.bal.set(t, 10_000_000n)
    let asked = 0
    const faucet = async (a: string) => {
      asked++
      f.bal.set(a, (f.bal.get(a) ?? 0n) + FAUCET_GRANT_DROPS)
    }
    const side = createLiveTestnet({ keystore: ks, client: f.client, faucet, pollMs: 1 })
    expect(await side.fundableDrops()).toBe(10_000_000n + BigInt(FAUCET_ROUNDS) * FAUCET_GRANT_DROPS)
    await side.topUpTreasury(250_000_000n)
    expect(asked).toBe(3)
    expect(await side.balanceDrops(t)).toBe(310_000_000n)
    await side.topUpTreasury(250_000_000n)
    expect(asked).toBe(3)
  })

  it('gives up with an error once the faucet grants are used up', async () => {
    const f = fakeClient()
    const ks = keystore()
    f.bal.set(ks.getWallet('testnetTreasury').address, 10_000_000n)
    let asked = 0
    const side = createLiveTestnet({ keystore: ks, client: f.client, faucet: async () => void asked++, pollMs: 1 })
    await expect(side.topUpTreasury(50_000_000n)).rejects.toThrow(/treasury/)
    expect(asked).toBe(FAUCET_ROUNDS)
  })
})
