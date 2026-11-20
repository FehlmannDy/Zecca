// bootstrap-market against an in-memory Devnet stand-in: creates the three metal issuances once, finds them again
// (by key store meta, or by their metadata ticker when the meta is gone), refuses an id issued by someone else.
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { decode } from 'ripple-binary-codec'
import { createMemoryKeyStore } from '@zecca/keystore'
import type { XrplClient } from '@zecca/xrpl-core'
import { issuanceIdFrom } from '../services/api/src/connectors/market/metals'
import { bootstrapMarket } from './bootstrap-market'

function fakeDevnet() {
  const issuances = new Map<string, Record<string, unknown>>()
  const seqs = new Map<string, number>()
  const submitted: Record<string, unknown>[] = []
  const notFound = () => Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
  const client = {
    network: 'devnet',
    async request(r: Record<string, any>) {
      if (r.command === 'ledger_entry') {
        const n = issuances.get(String(r.mpt_issuance).toUpperCase())
        if (!n) throw notFound()
        return { result: { node: n } }
      }
      if (r.command === 'account_objects') return { result: { account_objects: [...issuances.values()].filter((n) => n.Issuer === r.account) } }
      throw new Error(`unexpected ${r.command}`)
    },
    async accountInfo() {
      return { Balance: '100000000' }
    },
    async baseFeeDrops() {
      return 10
    },
    async ledgerIndex() {
      return 100
    },
    async nextSequence(a: string) {
      return seqs.get(a) ?? 5
    },
    async submitAndWait(blob: string) {
      const tx = decode(blob) as Record<string, any>
      submitted.push(tx)
      seqs.set(tx.Account, tx.Sequence + 1)
      const id = issuanceIdFrom(tx.Sequence, tx.Account)
      issuances.set(id, { LedgerEntryType: 'MPTokenIssuance', Issuer: tx.Account, AssetScale: tx.AssetScale ?? 0, MPTokenMetadata: tx.MPTokenMetadata, mpt_issuance_id: id })
      return { validated: true, engineResult: 'tesSUCCESS', hash: 'AB'.repeat(32), meta: { mpt_issuance_id: id } }
    },
    async close() {},
  }
  return { client: client as unknown as XrplClient, issuances, submitted }
}

function keystoreWithIssuer() {
  const ks = createMemoryKeyStore()
  const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
  ks.setWallet('marketIssuer', { address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
  return ks
}

describe('scripts/bootstrap-market', () => {
  it('creates the three metals once (AssetScale 0, ticker in the metadata) and stores their ids', async () => {
    const { client, submitted } = fakeDevnet()
    const keystore = keystoreWithIssuer()
    const lines: string[] = []
    const r = await bootstrapMarket({ keystore, devnet: client, log: (l) => lines.push(l) })
    expect(r.created).toEqual(['XAU', 'XAG', 'XPD'])
    expect(submitted.map((t) => t.TransactionType)).toEqual(['MPTokenIssuanceCreate', 'MPTokenIssuanceCreate', 'MPTokenIssuanceCreate'])
    expect(submitted.every((t) => t.Account === keystore.getWallet('marketIssuer').address && (t.AssetScale ?? 0) === 0)).toBe(true)
    for (const s of ['XAU', 'XAG', 'XPD']) expect(keystore.getMeta(`metal:${s}`)).toBe(r.ids[s as 'XAU'])
    // ids and addresses only
    expect(lines.join('\n')).toContain(keystore.getWallet('marketIssuer').address)
    expect(lines.join('\n')).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{25,34}\b/)

    const again = await bootstrapMarket({ keystore, devnet: client, log: () => {} })
    expect(again.created).toEqual([])
    expect(submitted).toHaveLength(3)
  })

  it('finds an existing issuance by its ticker when the key store lost the id', async () => {
    const { client, submitted } = fakeDevnet()
    const keystore = keystoreWithIssuer()
    const first = await bootstrapMarket({ keystore, devnet: client, log: () => {} })
    const fresh = createMemoryKeyStore()
    fresh.setWallet('marketIssuer', keystore.getWallet('marketIssuer'))
    const r = await bootstrapMarket({ keystore: fresh, devnet: client, log: () => {} })
    expect(r.created).toEqual([])
    expect(r.ids).toEqual(first.ids)
    expect(submitted).toHaveLength(3)
  })

  it('refuses a stored id that another account issued', async () => {
    const { client, issuances } = fakeDevnet()
    const keystore = keystoreWithIssuer()
    const other = xrpl.Wallet.generate().classicAddress
    const id = issuanceIdFrom(9, other)
    issuances.set(id, { Issuer: other, mpt_issuance_id: id })
    keystore.setMeta('metal:XAU', id)
    await expect(bootstrapMarket({ keystore, devnet: client, log: () => {} })).rejects.toThrow(/not issued by/)
  })
})
