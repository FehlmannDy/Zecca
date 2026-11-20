// Runs the bootstrap twice against a memory key store (never the real one): the first run creates every account,
// the issuance and the keys on Devnet + Testnet; the second run finds everything in place and creates nothing.
import { afterAll, describe, expect, it } from 'vitest'
import { createMemoryKeyStore } from '@zecca/keystore'
import { createClient, fetchIssuance, fetchMPToken } from '@zecca/xrpl-core'
import { bootstrapLedger, DEVNET_ROLES, RLUSD_CURRENCY_HEX, RLUSD_TESTNET_ISSUER } from './bootstrap-ledger'

const keystore = createMemoryKeyStore()
const devnet = createClient('devnet')
const testnet = createClient('testnet')
const lines: string[] = []
const log = (l: string) => lines.push(l)

afterAll(async () => {
  process.stderr.write(`\n[bootstrap log]\n${lines.join('\n')}\n`)
  await Promise.all([devnet.close(), testnet.close()])
})

describe('scripts/bootstrap-ledger', () => {
  it('first run creates every role, the CMPT issuance with its issuer key, and registers the pool and the demo shop', async () => {
    const r = await bootstrapLedger({ keystore, devnet, testnet, log })
    for (const role of DEVNET_ROLES) {
      expect(r.created).toContain(`wallet ${role}`)
      expect(await devnet.accountInfo(keystore.getWallet(role).address)).not.toBeNull()
    }
    expect(await testnet.accountInfo(keystore.getWallet('testnetTreasury').address)).not.toBeNull()
    expect(r.created).toContain('issuance')
    const id = keystore.getMeta('cmptIssuanceId')!
    const issuance = await fetchIssuance(devnet, id)
    expect(issuance.Issuer).toBe(keystore.getWallet('issuer').address)
    expect(issuance.Flags & (32 | 128)).toBe(32 | 128)
    expect(issuance.TransferFee ?? 0).toBe(0)
    expect(issuance.IssuerEncryptionKey).toBe(keystore.getElGamal('issuer').publicKey)
    const pool = await fetchMPToken(devnet, keystore.getWallet('pool').address, id)
    expect(pool?.HolderEncryptionKey).toBe(keystore.getElGamal('pool').publicKey)
    const shop = keystore.getWallet('demoShop').address
    expect((await fetchMPToken(devnet, shop, id))?.HolderEncryptionKey).toBe(keystore.getElGamal({ user: shop }).publicKey)
    const tl = await testnet.request({ command: 'account_lines', account: keystore.getWallet('testnetTreasury').address, peer: RLUSD_TESTNET_ISSUER, ledger_index: 'validated' })
    expect(tl.result.lines.map((l: { currency: string }) => l.currency)).toContain(RLUSD_CURRENCY_HEX)
    // prints role names and addresses only
    expect(lines.join('\n')).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{25,34}\b/)
  })

  it('second run creates nothing', async () => {
    const before = keystore.snapshot()
    const r = await bootstrapLedger({ keystore, devnet, testnet, log })
    expect(r.created).toEqual([])
    expect(keystore.snapshot()).toEqual(before)
  })
})
