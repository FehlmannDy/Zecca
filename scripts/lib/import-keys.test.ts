import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMemoryKeyStore } from '@zecca/keystore'
import xrpl from 'xrpl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatReport, importKeys, KNOWN_DEVNET, type ExpectedLedger } from './import-keys'

const gen = () => xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
const hex = (n: number) => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('')
const elg = () => ({ publicKey: '02' + hex(64), privateKey: hex(64) })
const CMPT = '00' + hex(46)

let dir: string
let probePath: string
let cardPath: string
let w: { issuer: xrpl.Wallet; sponsor: xrpl.Wallet; pool: xrpl.Wallet; treasury: xrpl.Wallet; standIn: xrpl.Wallet; relayer: xrpl.Wallet; user1: xrpl.Wallet; user2: xrpl.Wallet }
let keys: { issuerKey: ReturnType<typeof elg>; poolKey: ReturnType<typeof elg>; treasuryKey: ReturnType<typeof elg>; u1: ReturnType<typeof elg>; u2: ReturnType<typeof elg> }
let expected: ExpectedLedger
let secrets: string[]

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zecca-import-'))
  w = { issuer: gen(), sponsor: gen(), pool: gen(), treasury: gen(), standIn: gen(), relayer: gen(), user1: gen(), user2: gen() }
  keys = { issuerKey: elg(), poolKey: elg(), treasuryKey: elg(), u1: elg(), u2: elg() }
  probePath = path.join(dir, 'state.json')
  cardPath = path.join(dir, 'xrpl-state.json')
  writeFileSync(
    probePath,
    JSON.stringify({
      issuer: w.issuer.seed, sponsor: w.sponsor.seed, pool: w.pool.seed,
      issuerKey: keys.issuerKey, poolKey: keys.poolKey, CMPT,
      users: { [w.user1.classicAddress]: keys.u1, [w.user2.classicAddress]: keys.u2 },
    }),
  )
  writeFileSync(
    cardPath,
    JSON.stringify({ relayer: w.relayer.seed, treasury: w.treasury.seed, treasuryKey: keys.treasuryKey, treasuryReady: true, standIn: w.standIn.seed, standInFunded: true }),
  )
  expected = { sponsor: w.sponsor.classicAddress, issuer: w.issuer.classicAddress, pool: w.pool.classicAddress, cardSettlement: w.treasury.classicAddress, cmptIssuanceId: CMPT }
  secrets = [...Object.values(w).map((x) => x.seed!), ...Object.values(keys).map((k) => k.privateKey)]
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const noSecrets = (s: string) => {
  for (const x of secrets) expect(s).not.toContain(x)
}

describe('importKeys', () => {
  it('writes the four wallets, the ElGamal keys and the issuance id', () => {
    const ks = createMemoryKeyStore()
    const report = importKeys({ keystore: ks, probeStatePath: probePath, cardStatePath: cardPath, expected })
    for (const [role, wallet] of [['sponsor', w.sponsor], ['issuer', w.issuer], ['pool', w.pool], ['cardSettlement', w.treasury]] as const)
      expect(ks.getWallet(role)).toEqual({ address: wallet.classicAddress, seed: wallet.seed, algorithm: 'ecdsa-secp256k1' })
    expect(ks.getElGamal('issuer')).toEqual(keys.issuerKey)
    expect(ks.getElGamal('pool')).toEqual(keys.poolKey)
    expect(ks.getElGamal({ user: w.user1.classicAddress })).toEqual(keys.u1)
    expect(ks.getElGamal({ user: w.user2.classicAddress })).toEqual(keys.u2)
    expect(ks.getElGamal({ user: w.treasury.classicAddress })).toEqual(keys.treasuryKey)
    expect(ks.getMeta('cmptIssuanceId')).toBe(CMPT)
    // nothing else: no relayer, no stand-in
    expect(ks.hasWallet('relayer')).toBe(false)
    expect(report.wallets.map((x) => [x.role, x.address, x.status])).toEqual([
      ['sponsor', w.sponsor.classicAddress, 'added'],
      ['issuer', w.issuer.classicAddress, 'added'],
      ['pool', w.pool.classicAddress, 'added'],
      ['cardSettlement', w.treasury.classicAddress, 'added'],
    ])
    expect(report.elgamal.every((e) => e.status === 'added')).toBe(true)
    expect(report.elgamal).toHaveLength(5)
    noSecrets(JSON.stringify(report))
    noSecrets(formatReport(report))
    expect(formatReport(report)).toContain(`sponsor`)
    expect(formatReport(report)).toContain(w.sponsor.classicAddress)
  })

  it('is idempotent', () => {
    const ks = createMemoryKeyStore()
    importKeys({ keystore: ks, probeStatePath: probePath, cardStatePath: cardPath, expected })
    const before = ks.snapshot()
    const again = importKeys({ keystore: ks, probeStatePath: probePath, cardStatePath: cardPath, expected })
    expect(ks.snapshot()).toEqual(before)
    expect([...again.wallets, ...again.elgamal, ...again.meta].every((x) => x.status === 'unchanged')).toBe(true)
  })

  it('aborts before writing anything when an address is not the known one', () => {
    const ks = createMemoryKeyStore()
    let err: unknown
    try {
      importKeys({ keystore: ks, probeStatePath: probePath, cardStatePath: cardPath })
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/sponsor/)
    expect(String(err)).toContain(KNOWN_DEVNET.sponsor)
    expect(String(err)).toContain(w.sponsor.classicAddress)
    noSecrets(String(err))
    expect(ks.snapshot()).toEqual(createMemoryKeyStore().snapshot())
  })

  it('aborts when the issuance id is not the known one', () => {
    expect(() => importKeys({ keystore: createMemoryKeyStore(), probeStatePath: probePath, cardStatePath: cardPath, expected: { ...expected, cmptIssuanceId: '00'.repeat(24) } })).toThrow(/issuance/)
  })

  it('refuses to overwrite a different key already in the store, and writes nothing', () => {
    const ks = createMemoryKeyStore()
    const other = gen()
    ks.setWallet('pool', { address: other.classicAddress, seed: other.seed!, algorithm: 'ecdsa-secp256k1' })
    const before = ks.snapshot()
    let err: unknown
    try {
      importKeys({ keystore: ks, probeStatePath: probePath, cardStatePath: cardPath, expected })
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/pool/)
    expect(String(err)).toContain(other.classicAddress)
    noSecrets(String(err))
    expect(ks.snapshot()).toEqual(before)
    ks.setElGamal({ user: w.user1.classicAddress }, elg())
    ks.setWallet('pool', { address: w.pool.classicAddress, seed: w.pool.seed!, algorithm: 'ecdsa-secp256k1' })
    expect(() => importKeys({ keystore: ks, probeStatePath: probePath, cardStatePath: cardPath, expected })).toThrow(new RegExp(w.user1.classicAddress))
  })

  it('names the bad field without printing its value', () => {
    const bad = 'sNotAValidSeedAtAllxxxxxxxxxx'
    writeFileSync(probePath, JSON.stringify({ issuer: bad, sponsor: w.sponsor.seed, pool: w.pool.seed, issuerKey: keys.issuerKey, poolKey: keys.poolKey, CMPT, users: {} }))
    let err: unknown
    try {
      importKeys({ keystore: createMemoryKeyStore(), probeStatePath: probePath, cardStatePath: cardPath, expected })
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/issuer/)
    expect(String(err)).not.toContain(bad)
    noSecrets(String(err))

    writeFileSync(probePath, JSON.stringify({ issuer: w.issuer.seed, sponsor: w.sponsor.seed, pool: w.pool.seed, issuerKey: { publicKey: 'zz' }, poolKey: keys.poolKey, CMPT }))
    expect(() => importKeys({ keystore: createMemoryKeyStore(), probeStatePath: probePath, cardStatePath: cardPath, expected })).toThrow(/issuerKey/)

    writeFileSync(cardPath, JSON.stringify({ standIn: w.standIn.seed }))
    writeFileSync(probePath, JSON.stringify({ issuer: w.issuer.seed, sponsor: w.sponsor.seed, pool: w.pool.seed, issuerKey: keys.issuerKey, poolKey: keys.poolKey, CMPT }))
    expect(() => importKeys({ keystore: createMemoryKeyStore(), probeStatePath: probePath, cardStatePath: cardPath, expected })).toThrow(/treasury/)
  })

  it('knows the Devnet addresses from SPEC §2.2', () => {
    expect(KNOWN_DEVNET).toEqual({
      sponsor: 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT',
      issuer: 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3',
      pool: 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ',
      cardSettlement: 'rfPnRVpntUGgeaX64Z7DNy2XHkqL5qHZ8L',
      cmptIssuanceId: '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9',
    })
  })
})
