// XRPL Testnet for Earn, through xrpl-core's client (BUILD §8 rule 6): the testnetTreasury role and the users'
// custodial wallets. Payments are autofilled and signed here, then submitted and awaited by xrpl-core.
import xrpl from 'xrpl'
import type { KeyStore } from '@zecca/contracts'
import { createClient, fund, waitForAccount, walletFrom, type XrplClient } from '@zecca/xrpl-core'
import type { PaymentSpec, TestnetSide } from './sides'
import { testnetWalletSecret } from './wallets'

export function createLiveTestnet(o: { keystore: KeyStore; client?: XrplClient; log?: (m: string) => void }): TestnetSide & { client: XrplClient } {
  const client = o.client ?? createClient('testnet', { log: o.log })
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
    async sign(from, p: PaymentSpec) {
      const w = from === 'treasury' ? treasury() : userWallet(from.user)
      // One sequence at a time per account: sign under the account's queue so two payments never share a Sequence.
      return client.serial(`sign:${w.classicAddress}`, async () => {
        const tx = await client.autofill({ TransactionType: 'Payment', Account: w.classicAddress, Destination: p.Destination, Amount: p.Amount, ...(p.Memos ? { Memos: p.Memos } : {}) })
        const signed = w.sign(tx as never)
        return { hash: signed.hash, blob: signed.tx_blob }
      })
    },
    submit: (blob) => client.submitAndWait(blob),
    async txResult(hash) {
      try {
        const r = (await client.request({ command: 'tx', transaction: hash })).result
        return { validated: Boolean(r.validated), engineResult: String(r.meta?.TransactionResult ?? 'unknown') }
      } catch (e) {
        if ((e as { data?: { error?: string } })?.data?.error === 'txnNotFound') return null
        throw e
      }
    },
    async topUpTreasury(minDrops) {
      const t = treasury().classicAddress
      if ((await side.balanceDrops(t)) >= minDrops) return
      o.log?.(`[earn] treasury ${t} below ${xrpl.dropsToXrp(minDrops.toString())} XRP: asking the Testnet faucet`)
      await fund(t, 'testnet')
      await waitForAccount(client, t)
    },
  }
  return side
}
