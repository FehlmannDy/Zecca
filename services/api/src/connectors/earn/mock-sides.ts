// In-memory XRPL Testnet + Coston2 for EARN_MODE=mock and the unit tests. It behaves like the real pair where Earn
// depends on it: a payment to the Core Vault is executed by "Flare" a while later by decoding the same 0xFF memo the
// facet decodes (memo[10:]), checking sender and nonce, minting net = amount - max(0.25%, 0.1) - executor fee to the
// smart account, then running the calls all-or-nothing. A failure is silent (nothing executed), as on Coston2.
// No yield is simulated: a mock position keeps the value deposited (the screen labels it "Test position").
import { decodeFunctionData, erc20Abi, getAddress, keccak256, toHex, type Abi, type Hex } from 'viem'
import type { KeyStore } from '@zecca/contracts'
import { sha512Half } from '@zecca/xrpl-core/signer'
import { abis, CORE_VAULT, FIRELIGHT_VAULT } from './abi'
import { decodeMemo } from './memo'
import type { FlareSide, MintParams, Signed, TestnetSide, TxOutcome, VaultPosition } from './sides'
import { testnetWalletSecret } from './wallets'

export const MOCK_FXRP: Hex = '0x0b6A3645c240605887a5532109323A3E12273dc7'
export const MOCK_ASSET_MANAGER: Hex = '0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA'
const FEE_DROPS = 12n
const RESERVE = 1_000_000n
const MIN_REDEEM = 5_000_000n
const PERIOD_MS = 4 * 3_600_000

type Payment = { Account: string; Destination: string; Amount: string; Sequence: number; Fee: string; Memos?: { Memo: { MemoData: string } }[] }

export type MockEarnSides = {
  testnet: TestnetSide & { credit(address: string, drops: bigint): void }
  flare: FlareSide
  control: { advancePeriods(n: number): void; executedCount(): number }
}

export function createMockEarnSides(o: { keystore: KeyStore; executeAfterMs?: number; payoutAfterMs?: number; periodMs?: number; now?: () => number }): MockEarnSides {
  const now = o.now ?? Date.now
  const executeAfterMs = o.executeAfterMs ?? 8_000
  const payoutAfterMs = o.payoutAfterMs ?? Math.min(executeAfterMs, 2_000)
  const periodMs = o.periodMs ?? PERIOD_MS
  let periodOffset = 0n

  // ---------- Testnet ----------
  const balances = new Map<string, bigint>()
  const seqs = new Map<string, number>()
  const results = new Map<string, TxOutcome>()
  const treasury = () => (o.keystore.hasWallet('testnetTreasury') ? o.keystore.getWallet('testnetTreasury').address : 'rMockTestnetTreasuryXXXXXXXXXXXXX')
  balances.set(treasury(), 1_000_000_000n)

  const testnet: MockEarnSides['testnet'] = {
    mode: 'mock',
    treasuryAddress: treasury,
    walletFor: (userAddress) => testnetWalletSecret(o.keystore, userAddress).address,
    balanceDrops: async (a) => balances.get(a) ?? 0n,
    reserveDrops: async () => RESERVE,
    async sign(from, p) {
      const account = from === 'treasury' ? treasury() : testnet.walletFor(from.user)
      const seq = seqs.get(account) ?? 1
      seqs.set(account, seq + 1)
      const tx: Payment = { Account: account, Destination: p.Destination, Amount: p.Amount, Sequence: seq, Fee: String(FEE_DROPS), ...(p.Memos ? { Memos: p.Memos } : {}) }
      const blob = Buffer.from(JSON.stringify(tx)).toString('hex').toUpperCase()
      return { blob, hash: sha512Half(blob) } satisfies Signed
    },
    async submit(blob) {
      const hash = sha512Half(blob)
      const seen = results.get(hash)
      if (seen) return seen
      const tx = JSON.parse(Buffer.from(blob, 'hex').toString('utf8')) as Payment
      const amount = BigInt(tx.Amount)
      const bal = balances.get(tx.Account) ?? 0n
      let engineResult = 'tesSUCCESS'
      if (bal < amount + FEE_DROPS + (tx.Account === treasury() ? 0n : RESERVE)) engineResult = 'tecUNFUNDED_PAYMENT'
      else if (!balances.has(tx.Destination) && tx.Destination !== CORE_VAULT && amount < RESERVE) engineResult = 'tecNO_DST_INSUF_XRP'
      const out: TxOutcome = { validated: engineResult === 'tesSUCCESS', engineResult, hash }
      results.set(hash, out)
      if (!out.validated) {
        balances.set(tx.Account, bal - FEE_DROPS)
        return out
      }
      balances.set(tx.Account, bal - amount - FEE_DROPS)
      balances.set(tx.Destination, (balances.get(tx.Destination) ?? 0n) + amount)
      if (tx.Destination === CORE_VAULT) later(executeAfterMs, () => execute(hash, tx))
      return out
    },
    txResult: async (hash) => results.get(hash) ?? null,
    async topUpTreasury(minDrops) {
      const t = treasury()
      if ((balances.get(t) ?? 0n) < minDrops) balances.set(t, (balances.get(t) ?? 0n) + 100_000_000n)
    },
    credit(address, drops) {
      balances.set(address, (balances.get(address) ?? 0n) + drops)
    },
  }

  // ---------- Coston2 ----------
  type Account = { xrpl: string; nonce: bigint; fxrp: bigint; shares: bigint; allowance: bigint }
  const accounts = new Map<string, Account>()
  const executed = new Set<string>()
  const owed = new Map<string, { assets: bigint; claimed: boolean }>()
  const vault = { assets: 0n, shares: 0n }
  const paOf = (xrpl: string): Hex => getAddress(`0x${keccak256(toHex(`zecca-mock-pa:${xrpl}`)).slice(26)}`)
  const accountOf = (xrpl: string): Account => {
    const pa = paOf(xrpl)
    let a = accounts.get(pa)
    if (!a) accounts.set(pa, (a = { xrpl, nonce: 0n, fxrp: 0n, shares: 0n, allowance: 0n }))
    return a
  }
  const currentPeriod = () => BigInt(Math.floor(now() / periodMs)) + periodOffset
  const params: MintParams = { coreVault: CORE_VAULT, feeBips: 25n, minFeeUBA: 100_000n, execFeeUBA: 100_000n, fxrp: MOCK_FXRP, assetManager: MOCK_ASSET_MANAGER, vault: FIRELIGHT_VAULT }
  const calledAbi: Record<string, Abi> = { [MOCK_FXRP.toLowerCase()]: erc20Abi, [FIRELIGHT_VAULT.toLowerCase()]: abis.firelight, [MOCK_ASSET_MANAGER.toLowerCase()]: abis.am as Abi }

  class Revert extends Error {}

  /** Runs the user op on a copy of the state; returns the new state, or throws Revert with the error name. */
  function runCalls(pa: Hex, a: Account, callData: Hex, minted: bigint): { a: Account; vault: typeof vault; owed: Map<string, { assets: bigint; claimed: boolean }>; payouts: { to: string; drops: bigint }[] } {
    const s = { a: { ...a, fxrp: a.fxrp + minted }, vault: { ...vault }, owed: new Map(owed), payouts: [] as { to: string; drops: bigint }[] }
    const op = decodeFunctionData({ abi: abis.pa, data: callData })
    if (op.functionName !== 'executeUserOp') throw new Revert('InvalidMemoData')
    const calls = (op.args?.[0] ?? []) as readonly { target: Hex; value: bigint; data: Hex }[]
    calls.forEach((c, index) => {
      const abi = calledAbi[c.target.toLowerCase()]
      if (!abi) throw new Revert(`CallFailed(${index})`)
      const f = decodeFunctionData({ abi, data: c.data })
      const args = (f.args ?? []) as readonly unknown[]
      const fail = () => {
        throw new Revert(`CallFailed(${index})`)
      }
      switch (`${c.target.toLowerCase()}:${f.functionName}`) {
        case `${MOCK_FXRP.toLowerCase()}:approve`:
          s.a.allowance = args[1] as bigint
          break
        case `${FIRELIGHT_VAULT.toLowerCase()}:deposit`: {
          const assets = args[0] as bigint
          if (s.a.fxrp < assets || s.a.allowance < assets || assets <= 0n) fail()
          const shares = s.vault.shares === 0n ? assets : (assets * s.vault.shares) / s.vault.assets
          s.a.fxrp -= assets
          s.a.allowance -= assets
          s.a.shares += shares
          s.vault.assets += assets
          s.vault.shares += shares
          break
        }
        case `${FIRELIGHT_VAULT.toLowerCase()}:redeem`: {
          const shares = args[0] as bigint
          if (shares <= 0n || shares > s.a.shares) fail()
          const assets = (shares * s.vault.assets) / s.vault.shares
          const key = `${currentPeriod() + 1n}:${pa}`
          s.owed.set(key, { assets: (s.owed.get(key)?.assets ?? 0n) + assets, claimed: false })
          s.a.shares -= shares
          s.vault.shares -= shares
          s.vault.assets -= assets
          break
        }
        case `${FIRELIGHT_VAULT.toLowerCase()}:claimWithdraw`: {
          const period = args[0] as bigint
          const w = s.owed.get(`${period}:${pa}`)
          if (period >= currentPeriod() || !w || w.claimed) fail()
          s.owed.set(`${period}:${pa}`, { ...w!, claimed: true })
          s.a.fxrp += w!.assets
          break
        }
        case `${MOCK_ASSET_MANAGER.toLowerCase()}:redeemAmount`: {
          const amount = args[0] as bigint
          if (amount < MIN_REDEEM || amount > s.a.fxrp) fail()
          s.a.fxrp -= amount
          // 0.5% redemption fee plus the system fee (about 0.02%), taken from the agent's XRP payout.
          s.payouts.push({ to: String(args[1]), drops: amount - (amount * 50n) / 10_000n - (amount * 2n) / 10_000n })
          break
        }
        default:
          fail()
      }
    })
    return s
  }

  function execute(hash: string, tx: Payment) {
    const memo = tx.Memos?.[0]?.Memo.MemoData
    if (!memo) return
    let m: ReturnType<typeof decodeMemo>
    try {
      m = decodeMemo(`0x${memo}`)
    } catch {
      return
    }
    const amount = BigInt(tx.Amount)
    const pct = (amount * params.feeBips) / 10_000n
    const mintFee = pct > params.minFeeUBA ? pct : params.minFeeUBA
    const minted = amount - mintFee - m.executorFeeUBA
    const pa = paOf(tx.Account)
    const a = accountOf(tx.Account)
    if (minted <= 0n || getAddress(m.sender) !== pa || m.nonce !== a.nonce) return
    try {
      const s = runCalls(pa, a, m.callData, minted)
      accounts.set(pa, { ...s.a, nonce: a.nonce + 1n })
      Object.assign(vault, s.vault)
      owed.clear()
      for (const [k, v] of s.owed) owed.set(k, v)
      executed.add(hash.toUpperCase())
      for (const p of s.payouts) later(payoutAfterMs, () => testnet.credit(p.to, p.drops))
    } catch (e) {
      if (!(e instanceof Revert)) throw e
    }
  }

  const flare: FlareSide = {
    mode: 'mock',
    personalAccount: async (xrpl) => paOf(xrpl),
    nonce: async (pa) => [...accounts.entries()].find(([k]) => k === pa)?.[1].nonce ?? 0n,
    mintParams: async () => params,
    async simulate(memoHex, xrpl) {
      let m: ReturnType<typeof decodeMemo>
      try {
        m = decodeMemo(memoHex)
      } catch {
        return 'InvalidMemoData'
      }
      const pa = paOf(xrpl)
      const a = accountOf(xrpl)
      if (getAddress(m.sender) !== pa) return 'InvalidSender'
      if (m.nonce !== a.nonce) return 'InvalidNonce'
      try {
        runCalls(pa, a, m.callData, 0n)
        return 'ok'
      } catch (e) {
        if (e instanceof Revert) return e.message.startsWith('CallFailed') ? 'CallFailed' : e.message
        return 'InvalidMemoData'
      }
    },
    isExecuted: async (h) => executed.has(h.toUpperCase()),
    async position(xrpl): Promise<VaultPosition> {
      const a = accounts.get(paOf(xrpl))
      if (!a) return { shares: 0n, assets: 0n, fxrp: 0n }
      return { shares: a.shares, assets: vault.shares === 0n ? 0n : (a.shares * vault.assets) / vault.shares, fxrp: a.fxrp }
    },
    currentPeriod: async () => currentPeriod(),
    nextPeriodEnd: async () => ((currentPeriod() - periodOffset + 2n) * BigInt(periodMs)) / 1000n,
    withdrawal: async (period, pa) => owed.get(`${period}:${pa}`) ?? { assets: 0n, claimed: false },
  }

  return {
    testnet,
    flare,
    control: {
      advancePeriods(n) {
        periodOffset += BigInt(n)
      },
      executedCount: () => executed.size,
    },
  }
}

function later(ms: number, f: () => void) {
  const t = setTimeout(f, Math.max(0, ms))
  t.unref?.()
}
