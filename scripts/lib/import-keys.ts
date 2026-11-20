// Moves the existing Devnet keys from the probe folders into the Zecca key store (SPEC §2.2, §4.2).
// Reads ../privy-xrpl-probe/web/state.json and ../card-issuer/data/xrpl-state.json; never modifies them.
// Checks every derived address against the known one and every key already in the store, then writes all or nothing.
// Errors and the report name roles, fields and addresses only — never a seed or a private key.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElGamalKeyPair, ElGamalOwner, KeyStore, WalletRole } from '@zecca/contracts'
import xrpl from 'xrpl'

export type ExpectedLedger = { sponsor: string; issuer: string; pool: string; cardSettlement: string; cmptIssuanceId: string }

/** SPEC §2.2. */
export const KNOWN_DEVNET: ExpectedLedger = {
  sponsor: 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT',
  issuer: 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3',
  pool: 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ',
  cardSettlement: 'rfPnRVpntUGgeaX64Z7DNy2XHkqL5qHZ8L',
  cmptIssuanceId: '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9',
}

export type ImportStatus = 'added' | 'unchanged'
export type ImportReport = {
  wallets: { role: WalletRole; address: string; status: ImportStatus }[]
  elgamal: { owner: string; status: ImportStatus }[]
  meta: { key: string; value: string; status: ImportStatus }[]
}

type Fields = Record<string, unknown>

function readJson(file: string): Fields {
  let v: unknown
  try {
    v = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`import: cannot read ${path.basename(file)} as JSON`)
  }
  if (!v || typeof v !== 'object') throw new Error(`import: ${path.basename(file)} is not a JSON object`)
  return v as Fields
}

function walletFrom(f: Fields, field: string, file: string) {
  const seed = f[field]
  if (typeof seed !== 'string' || !seed) throw new Error(`import: field ${field} is missing in ${path.basename(file)}`)
  try {
    const w = xrpl.Wallet.fromSeed(seed, { algorithm: xrpl.ECDSA.secp256k1 })
    return { address: w.classicAddress, seed, algorithm: 'ecdsa-secp256k1' as const }
  } catch {
    throw new Error(`import: field ${field} in ${path.basename(file)} is not a valid secp256k1 seed`)
  }
}

function keyPairFrom(v: unknown, field: string, file: string): ElGamalKeyPair {
  const k = v as ElGamalKeyPair
  if (!k || typeof k !== 'object' || typeof k.publicKey !== 'string' || typeof k.privateKey !== 'string' || !/^[0-9A-Fa-f]{66}$/.test(k.publicKey) || !/^[0-9A-Fa-f]{64}$/.test(k.privateKey))
    throw new Error(`import: field ${field} in ${path.basename(file)} is not an ElGamal key pair`)
  return { publicKey: k.publicKey, privateKey: k.privateKey }
}

const ownerName = (o: ElGamalOwner) => (typeof o === 'string' ? o : `user ${o.user}`)

export function importKeys(input: { keystore: KeyStore; probeStatePath: string; cardStatePath: string; expected?: ExpectedLedger }): ImportReport {
  const { keystore: ks, probeStatePath, cardStatePath } = input
  const expected = input.expected ?? KNOWN_DEVNET
  const probe = readJson(probeStatePath)
  const card = readJson(cardStatePath)

  // 1. read and check everything
  const wallets: [WalletRole, ReturnType<typeof walletFrom>][] = [
    ['sponsor', walletFrom(probe, 'sponsor', probeStatePath)],
    ['issuer', walletFrom(probe, 'issuer', probeStatePath)],
    ['pool', walletFrom(probe, 'pool', probeStatePath)],
    ['cardSettlement', walletFrom(card, 'treasury', cardStatePath)],
  ]
  const cmpt = probe.CMPT
  if (typeof cmpt !== 'string' || !/^[0-9A-Fa-f]{48}$/.test(cmpt)) throw new Error(`import: field CMPT in ${path.basename(probeStatePath)} is not an issuance id`)

  const elgamal: [ElGamalOwner, ElGamalKeyPair][] = [
    ['issuer', keyPairFrom(probe.issuerKey, 'issuerKey', probeStatePath)],
    ['pool', keyPairFrom(probe.poolKey, 'poolKey', probeStatePath)],
  ]
  const users = probe.users ?? {}
  if (typeof users !== 'object') throw new Error(`import: field users in ${path.basename(probeStatePath)} is not an object`)
  for (const [address, kp] of Object.entries(users as Fields)) {
    if (!xrpl.isValidClassicAddress(address)) throw new Error(`import: users in ${path.basename(probeStatePath)} has a key that is not an address`)
    elgamal.push([{ user: address }, keyPairFrom(kp, `users.${address}`, probeStatePath)])
  }
  // The card settlement account holds a confidential balance; its key is stored like a holder's, by address.
  const settlement = wallets[3][1].address
  if (card.treasuryKey !== undefined) elgamal.push([{ user: settlement }, keyPairFrom(card.treasuryKey, 'treasuryKey', cardStatePath)])

  const problems: string[] = []
  for (const [role, w] of wallets) {
    const want = expected[role as keyof ExpectedLedger]
    if (w.address !== want) problems.push(`${role}: the seed gives ${w.address}, expected ${want}`)
  }
  if (cmpt.toUpperCase() !== expected.cmptIssuanceId.toUpperCase()) problems.push(`CMPT issuance: found ${cmpt}, expected ${expected.cmptIssuanceId}`)
  if (problems.length) throw new Error(`import: these are not the known Devnet accounts, nothing written:\n  ${problems.join('\n  ')}`)

  // 2. compare with what the store already holds; refuse to replace anything
  const report: ImportReport = { wallets: [], elgamal: [], meta: [] }
  for (const [role, w] of wallets) {
    if (!ks.hasWallet(role)) report.wallets.push({ role, address: w.address, status: 'added' })
    else {
      const cur = ks.getWallet(role)
      if (cur.address !== w.address || cur.seed !== w.seed || cur.algorithm !== w.algorithm) problems.push(`${role}: the store already holds a different wallet (${cur.address})`)
      else report.wallets.push({ role, address: w.address, status: 'unchanged' })
    }
  }
  for (const [owner, kp] of elgamal) {
    if (!ks.has(owner)) report.elgamal.push({ owner: ownerName(owner), status: 'added' })
    else {
      const cur = ks.getElGamal(owner)
      if (cur.publicKey !== kp.publicKey || cur.privateKey !== kp.privateKey) problems.push(`ElGamal ${ownerName(owner)}: the store already holds a different key`)
      else report.elgamal.push({ owner: ownerName(owner), status: 'unchanged' })
    }
  }
  const curCmpt = ks.getMeta('cmptIssuanceId')
  if (curCmpt === undefined) report.meta.push({ key: 'cmptIssuanceId', value: cmpt, status: 'added' })
  else if (curCmpt !== cmpt) problems.push(`meta cmptIssuanceId: the store already holds ${curCmpt}`)
  else report.meta.push({ key: 'cmptIssuanceId', value: cmpt, status: 'unchanged' })
  if (problems.length) throw new Error(`import: refusing to overwrite the key store, nothing written:\n  ${problems.join('\n  ')}`)

  // 3. write
  for (const [role, w] of wallets) if (!ks.hasWallet(role)) ks.setWallet(role, w)
  for (const [owner, kp] of elgamal) if (!ks.has(owner)) ks.setElGamal(owner, kp)
  if (curCmpt === undefined) ks.setMeta('cmptIssuanceId', cmpt)
  return report
}

/** Role names, addresses and the issuance id only. */
export function formatReport(r: ImportReport): string {
  const lines = [
    ...r.wallets.map((w) => `wallet  ${w.role.padEnd(15)} ${w.address}  ${w.status}`),
    ...r.elgamal.map((e) => `elgamal ${e.owner.padEnd(15)} ${e.status}`),
    ...r.meta.map((m) => `meta    ${m.key.padEnd(15)} ${m.value}  ${m.status}`),
  ]
  return lines.join('\n')
}
