// Devnet, throwaway system: a real deposit to the pool and a real payout from it; the amount proofs made from the pool key
// are checked by checkStatement through a plain public node (xrplReader), the way an outside reader would.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import { createLiveLedger, type LiveLedger } from '@zecca/xrpl-core'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { createDevnetSystem, type DevnetSystem } from '../../../../../packages/xrpl-core/src/test-devnet'
import { proveLine } from './amount-proof'
import { signStatement, statementKeyFrom } from './statement'
import { checkStatement } from './verify'
import { PUBLIC_NODES, xrplReader } from './ledger-reader'

let sys: DevnetSystem
let ledger: LiveLedger
const user = mockRawSigner()
const hashes: { deposit?: string; payout?: string } = {}

beforeAll(async () => {
  sys = await createDevnetSystem()
  await sys.client.close()
  ledger = createLiveLedger({ network: 'devnet', keystore: sys.keystore })
  await ledger.ensureAccount(user.address)
  sys.keystore.createUserElGamal(user.address)
  const onboarding = await ledger.buildOnboarding({ address: user.address, publicKey: user.publicKey, holderKey: sys.keystore.getElGamal({ user: user.address }), welcomeCreditMinor: 5000 })
  expect((await ledger.submitUserSigned((await user.sign(onboarding)).tx_blob)).engineResult).toBe('tesSUCCESS')

  const pool = sys.wallets.pool.classicAddress
  const dep = await ledger.buildSend({ from: user.address, to: pool, amountMinor: 1200, senderKey: sys.keystore.getElGamal({ user: user.address }), sponsored: true, publicKey: user.publicKey })
  const d = await ledger.submitUserSigned((await user.sign(dep)).tx_blob)
  expect(d.engineResult).toBe('tesSUCCESS')
  hashes.deposit = d.hash
  expect((await ledger.submitAs('pool', await ledger.buildMergeInbox({ account: pool, sponsored: false }))).engineResult).toBe('tesSUCCESS')
  const pay = await ledger.submitAs('pool', await ledger.buildSend({ from: pool, to: user.address, amountMinor: 995, senderKey: sys.poolKey, sponsored: false }))
  expect(pay.engineResult).toBe('tesSUCCESS')
  hashes.payout = pay.hash
  process.stderr.write(`\n[proofs evidence] deposit ${hashes.deposit} payout ${hashes.payout}\n`)
})

afterAll(async () => {
  await ledger?.close()
})

describe('amount proofs on Devnet', () => {
  it('proves the deposit and the payout from the pool key; a public node checks both', async () => {
    const pool = sys.wallets.pool.classicAddress
    const deps = { ledger, poolAddress: pool, poolKey: sys.poolKey, holderAddress: user.address }
    const outProof = await proveLine(deps, { direction: 'out', amountMinor: 1200, depositTxHash: hashes.deposit })
    const inProof = await proveLine(deps, { direction: 'in', amountMinor: 995, payoutTxHash: hashes.payout })
    expect(outProof).toMatch(/^mpt-dleq-v1:/)
    expect(inProof).toMatch(/^mpt-dleq-v1:/)
    expect(await proveLine(deps, { direction: 'out', amountMinor: 1201, depositTxHash: hashes.deposit })).toBeUndefined()

    const seed = rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })
    const key = statementKeyFrom({ address: rk.deriveAddress(rk.deriveKeypair(seed).publicKey), seed, algorithm: 'ecdsa-secp256k1' })
    const at = new Date().toISOString()
    const s = signStatement(
      {
        id: 'stm_ledger',
        createdAt: at,
        holder: { displayName: 'Ledger Test', handle: 'ledger_test', address: user.address },
        lines: [
          { activityId: 'act_out', date: at, counterparty: 'Carla', direction: 'out', amountMinor: 1200, feeMinor: 0, depositTxHash: hashes.deposit!, network: 'devnet', amountProof: outProof },
          { activityId: 'act_in', date: at, counterparty: 'Bruno', direction: 'in', amountMinor: 995, feeMinor: 5, payoutTxHash: hashes.payout!, network: 'devnet', amountProof: inProof },
        ],
        attestation: 'proof',
      },
      key,
    )
    const reader = xrplReader(new xrpl.Client(PUBLIC_NODES.devnet))
    try {
      const anchors = { signer: key.address, pool, issuanceId: ledger.issuanceId }
      const r = await checkStatement(s, reader, anchors)
      expect(r.lines).toMatchObject([
        { transactions: 'ok', amount: 'proven' },
        { transactions: 'ok', amount: 'proven' },
      ])
      expect(r.ok).toBe(true)
      const lie = signStatement({ ...s, lines: [{ ...s.lines[0], amountMinor: 120 }] }, key)
      expect((await checkStatement(lie, reader, anchors)).lines[0].amount).toBe('invalid')
    } finally {
      await reader.close()
    }
  })
})
