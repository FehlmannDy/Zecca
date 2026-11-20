// XRPL Testnet for Earn, through xrpl-core's client (BUILD §8 rule 6): the testnetTreasury role and the users'
// custodial wallets. Each payment is autofilled, signed, recorded and submitted inside its account's xrpl-core queue
// (rule 7), like xrpl-core's submitAs; the payment helper itself is a contract request to move into xrpl-core.
import xrpl from 'xrpl'
import type { KeyStore } from '@zecca/contracts'
import { createClient, fund, walletFrom, type XrplClient } from '@zecca/xrpl-core'
import { FAUCET_GRANT_DROPS, FAUCET_ROUNDS, type PaymentSpec, type TestnetSide } from './sides'
import { testnetWalletSecret } from './wallets'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Balance reads after a faucet grant before asking again (a grant lands with the next ledger, ~4 s). */
const GRANT_READS = 30

export function createLiveTestnet(o: {
  keystore: KeyStore
  client?: XrplClient
  log?: (m: string) => void
  /** Injected in tests; the Testnet faucet otherwise. */
  faucet?: (address: string) => Promise<void>
  pollMs?: number
}): TestnetSide & { client: XrplClient } {
  const client = o.client ?? createClient('testnet', { log: o.log })
  const faucet = o.faucet ?? ((address: string) => fund(address, 'testnet'))
  const pollMs = o.pollMs ?? 2_000
  const treasury = () => walletFrom(o.keystore.getWallet('testnetTreasury'))
  const userWallet = (userAddress: string) => walletFrom(testnetWalletSecret(o.keystore, userAddress))

  const side: TestnetSide & { client: XrplClient } = {
    mode: 'live',
    client,
    treasuryAddress: () => treasury().classicAddress,
    walletFor: (userAddress) => testnetWalletSecret(o.keystore, userAddress).address,
    async balanceDrops(address) {
      const a = await client.accountInfo(address)
      return a ? BigInt(String(a.Balance)) : 0n
    },
    async reserveDrops() {
      const info = (await client.request({ command: 'server_info' })).result.info
      return BigInt(Math.round(Number(info.validated_ledger?.reserve_base_xrp ?? 1) * 1_000_000))
    },
    pay(from, p: PaymentSpec, onSigned) {
      const w = from === 'treasury' ? treasury() : userWallet(from.user)
      return client.serial(w.classicAddress, async () => {
        const tx = await client.autofill({ TransactionType: 'Payment', Account: w.classicAddress, Destination: p.Destination, Amount: p.Amount, ...(p.Memos ? { Memos: p.Memos } : {}) })
        const signed = w.sign(tx as never)
        await onSigned({ hash: signed.hash, blob: signed.tx_blob })
        return client.submitAndWait(signed.tx_blob)
      })
    },
    submit: (blob) => client.serial(String((xrpl.decode(blob) as { Account: string }).Account), () => client.submitAndWait(blob)),
    async txResult(hash) {
      try {
        const r = (await client.request({ command: 'tx', transaction: hash })).result
        return { validated: Boolean(r.validated), engineResult: String(r.meta?.TransactionResult ?? 'unknown') }
      } catch (e) {
        if ((e as { data?: { error?: string } })?.data?.error === 'txnNotFound') return null
        throw e
      }
    },
    async fundableDrops() {
      return (await side.balanceDrops(treasury().classicAddress)) + BigInt(FAUCET_ROUNDS) * FAUCET_GRANT_DROPS
    },
    async topUpTreasury(minDrops) {
      const t = treasury().classicAddress
      for (let round = 0; round < FAUCET_ROUNDS; round++) {
        const before = await side.balanceDrops(t)
        if (before >= minDrops) return
        o.log?.(`[earn] treasury ${t} below ${xrpl.dropsToXrp(minDrops.toString())} XRP: asking the Testnet faucet (${round + 1}/${FAUCET_ROUNDS})`)
        await faucet(t)
        for (let i = 0; i < GRANT_READS && (await side.balanceDrops(t)) <= before; i++) await sleep(pollMs)
      }
      const left = await side.balanceDrops(t)
      if (left < minDrops) throw new Error(`treasury ${t} holds ${left} drops after ${FAUCET_ROUNDS} faucet grants, below ${minDrops}`)
    },
  }
  return side
}
