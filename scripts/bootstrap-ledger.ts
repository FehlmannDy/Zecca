// Creates, from nothing and idempotently, every ledger account, the CMPT issuance and the keys Zecca needs (D14):
//   Devnet (faucet): sponsor, issuer, pool, relayer, cardSettlement, kycIssuer, marketIssuer, oracle, demoShop
//   Testnet (faucet): testnetTreasury + RLUSD trust line to Ripple's testnet issuer
//   CMPT issuance (Flags 32|128, TransferFee 0) + issuer encryption key; pool, demo shop and card settlement
//   registered as confidential holders (authorize + key registered with a Convert of 0).
//   ISSUER_TICKETS issuer Tickets, topped up on each run: the sign-up's welcome credit uses one, so a mint or another
//   sign-up landing meanwhile cannot invalidate it. A TicketCreate moves the issuer's Sequence: run the top-up with the
//   API and the pool worker stopped.
// Checks the key store and the ledger first, so a second run creates nothing. Prints role names and addresses only.
// Run from zecca/ (unsandboxed, the faucets need the network):
//   node -r ./scripts/dev/dnsfix.cjs node_modules/tsx/dist/cli.mjs scripts/bootstrap-ledger.ts
// It uses the key store named by KEYSTORE_PATH / KEYSTORE_PASSPHRASE (zecca/.env).
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import xrpl from 'xrpl'
import type { ElGamalKeyPair, ElGamalOwner, KeyStore, WalletRole } from '@zecca/contracts'
import { openKeyStoreFromEnv } from '@zecca/keystore'
import { buildConvert, createClient, fetchIssuance, fetchMPToken, fillTx, fund, generateWalletSecret, listTickets, waitForAccount, walletFrom, type XrplClient } from '@zecca/xrpl-core'

export const DEVNET_ROLES = ['sponsor', 'issuer', 'pool', 'relayer', 'cardSettlement', 'kycIssuer', 'marketIssuer', 'oracle', 'demoShop'] as const satisfies readonly WalletRole[]
export const RLUSD_TESTNET_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'
/** "RLUSD" as a 160-bit currency code. */
export const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000'
const CMPT_FLAGS = 32 | 128
const CMPT_MAXIMUM = '1000000000'
/** One per sign-up with a welcome credit; each holds 0.2 XRP of the issuer's reserve on Devnet (50: 10 XRP). */
export const ISSUER_TICKETS = 50

export type BootstrapOptions = { keystore: KeyStore; devnet?: XrplClient; testnet?: XrplClient; log?: (line: string) => void }

export async function bootstrapLedger(opts: BootstrapOptions): Promise<{ created: string[] }> {
  const { keystore } = opts
  const log = opts.log ?? console.log
  const devnet = opts.devnet ?? createClient('devnet')
  const testnet = opts.testnet ?? createClient('testnet')
  const created: string[] = []
  const did = (what: string) => (created.push(what), log(`  created ${what}`))

  const submit = async (client: XrplClient, role: WalletRole, label: string, tx: Record<string, unknown>) => {
    const w = walletFrom(keystore.getWallet(role))
    const r = await client.submitAndWait(w.sign((await fillTx(client, { Account: w.classicAddress, ...tx } as never, {})) as never).tx_blob)
    if (r.engineResult !== 'tesSUCCESS') throw new Error(`${label}: ${r.engineResult} ${r.hash}`)
    return r
  }

  // ---- accounts ----
  const ensureAccounts = async (client: XrplClient, roles: readonly WalletRole[]) => {
    for (const role of roles) {
      if (!keystore.hasWallet(role)) {
        keystore.setWallet(role, generateWalletSecret())
        did(`wallet ${role}`)
      }
    }
    const missing: WalletRole[] = []
    for (const role of roles) if (!(await client.accountInfo(keystore.getWallet(role).address))) missing.push(role)
    for (const role of missing) await fund(keystore.getWallet(role).address, client.network)
    await Promise.all(missing.map((role) => waitForAccount(client, keystore.getWallet(role).address)))
    for (const role of missing) did(`account ${role} (${client.network})`)
  }

  try {
    await ensureAccounts(devnet, DEVNET_ROLES)
    await ensureAccounts(testnet, ['testnetTreasury'])

    // ---- RLUSD trust line on Testnet ----
    const treasury = keystore.getWallet('testnetTreasury').address
    const lines = (await testnet.request({ command: 'account_lines', account: treasury, peer: RLUSD_TESTNET_ISSUER, ledger_index: 'validated' })).result.lines as { currency: string }[]
    if (!lines.some((l) => l.currency === RLUSD_CURRENCY_HEX)) {
      await submit(testnet, 'testnetTreasury', 'RLUSD trust line', { TransactionType: 'TrustSet', LimitAmount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_TESTNET_ISSUER, value: '1000000000' } })
      did('trust line testnetTreasury RLUSD')
    }

    // ---- CMPT issuance ----
    const issuerAddress = keystore.getWallet('issuer').address
    let issuanceId = keystore.getMeta('cmptIssuanceId')
    // Only "not found" (e.g. Devnet was reset) means create; any other error stops the run.
    const notFound = (e: unknown) => ['entryNotFound', 'objectNotFound'].includes(String((e as { data?: { error?: string } })?.data?.error))
    let issuance = issuanceId
      ? await fetchIssuance(devnet, issuanceId).catch((e) => {
          if (notFound(e)) return null
          throw e
        })
      : null
    if (issuance && issuance.Issuer !== issuerAddress) throw new Error(`issuance ${issuanceId} is not issued by the key store issuer ${issuerAddress}`)
    if (!issuance) {
      const r = await submit(devnet, 'issuer', 'issuance create', { TransactionType: 'MPTokenIssuanceCreate', Flags: CMPT_FLAGS, MaximumAmount: CMPT_MAXIMUM })
      issuanceId = String((r.meta as Record<string, unknown>)?.mpt_issuance_id)
      keystore.setMeta('cmptIssuanceId', issuanceId)
      issuance = await fetchIssuance(devnet, issuanceId)
      did('issuance')
    }
    const id = issuanceId!

    // ---- ElGamal keys ----
    const keyOf = (owner: ElGamalOwner, label: string): ElGamalKeyPair => {
      if (!keystore.has(owner)) {
        keystore.setElGamal(owner, xrpl.deriveConfidentialKeypair() as ElGamalKeyPair)
        did(`encryption key ${label}`)
      }
      return keystore.getElGamal(owner)
    }
    const issuerKey = keyOf('issuer', 'issuer')
    if (!issuance.IssuerEncryptionKey) {
      await submit(devnet, 'issuer', 'issuer key', { TransactionType: 'MPTokenIssuanceSet', MPTokenIssuanceID: id, IssuerEncryptionKey: issuerKey.publicKey })
      did('issuer encryption key on ledger')
    } else if (issuance.IssuerEncryptionKey !== issuerKey.publicKey) {
      throw new Error(`issuance ${id} has another issuer encryption key than the key store`)
    }

    // ---- confidential holders ----
    const ctx = { client: devnet, keystore, issuanceId: id }
    const ensureHolder = async (role: WalletRole, owner: ElGamalOwner) => {
      const address = keystore.getWallet(role).address
      const key = keyOf(owner, role)
      let token = await fetchMPToken(devnet, address, id)
      if (!token) {
        await submit(devnet, role, `${role} authorize`, { TransactionType: 'MPTokenAuthorize', MPTokenIssuanceID: id })
        did(`${role} holds CMPT`)
        token = {}
      }
      if (!token.HolderEncryptionKey) {
        await submit(devnet, role, `${role} key`, await buildConvert(ctx, { account: address, amountMinor: 0, holderKey: key }))
        did(`${role} encryption key on ledger`)
      } else if (token.HolderEncryptionKey !== key.publicKey) {
        throw new Error(`${role} has another encryption key on the ledger than the key store`)
      }
    }
    await ensureHolder('pool', 'pool')
    await ensureHolder('demoShop', { user: keystore.getWallet('demoShop').address })
    await ensureHolder('cardSettlement', { user: keystore.getWallet('cardSettlement').address })

    // ---- issuer tickets (sign-up welcome credit) ----
    const tickets = (await listTickets(devnet, issuerAddress)).length
    if (tickets < ISSUER_TICKETS) {
      await submit(devnet, 'issuer', 'issuer tickets', { TransactionType: 'TicketCreate', TicketCount: ISSUER_TICKETS - tickets })
      did(`issuer tickets (${ISSUER_TICKETS - tickets})`)
    }

    for (const role of [...DEVNET_ROLES, 'testnetTreasury'] as const) log(`${role.padEnd(16)} ${keystore.getWallet(role).address}`)
    log(`${'cmptIssuanceId'.padEnd(16)} ${id}`)
    log(created.length ? `created ${created.length} item(s)` : 'nothing to create')
    return { created }
  } finally {
    if (!opts.devnet) await devnet.close()
    if (!opts.testnet) await testnet.close()
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  bootstrapLedger({ keystore: openKeyStoreFromEnv(process.env) }).catch((e) => {
    console.error((e as Error).message)
    process.exit(1)
  })
}
