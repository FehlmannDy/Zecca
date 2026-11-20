// Coston2 reads for Earn (port of ../flare-firelight/chain.mjs, ff.mjs simulation, poll.mjs, step5.mjs readers), with viem.
// Nothing here writes to Flare: the executor relays every XRPL payment; the user never needs FLR.
import { createPublicClient, decodeErrorResult, encodeFunctionData, http, keccak256, toHex, type Hex, type PublicClient } from 'viem'
import { flareTestnet } from 'viem/chains'
import { abis, COSTON2_RPC, EXECUTOR, FIRELIGHT_VAULT, FIRELIGHT_VAULT_ID, REGISTRY } from './abi'
import type { FlareSide, MintParams, VaultPosition } from './sides'

type Raw = Record<string, unknown>

export function createLiveFlare(o: { rpc?: string; client?: PublicClient } = {}): FlareSide & { client: PublicClient } {
  const pc = (o.client ?? createPublicClient({ chain: flareTestnet, transport: http(o.rpc ?? COSTON2_RPC, { retryCount: 3, timeout: 20_000 }) })) as PublicClient
  const read = <T>(address: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    pc.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>

  let addrs: Promise<{ mac: Hex; am: Hex; fxrp: Hex }> | null = null
  const contracts = () =>
    (addrs ??= (async () => {
      const [mac, am] = await Promise.all([
        read<Hex>(REGISTRY, abis.registry, 'getContractAddressByName', ['MasterAccountController']),
        read<Hex>(REGISTRY, abis.registry, 'getContractAddressByName', ['AssetManagerFXRP']),
      ])
      const fxrp = await read<Hex>(am, abis.am, 'fAsset')
      return { mac, am, fxrp }
    })().catch((e) => {
      addrs = null
      throw e
    }))

  let params: { at: number; p: MintParams } | null = null

  const side: FlareSide & { client: PublicClient } = {
    mode: 'live',
    client: pc,
    async personalAccount(xrplAddress) {
      const A = await contracts()
      return read<Hex>(A.mac, abis.mac, 'getPersonalAccount', [xrplAddress])
    },
    async nonce(pa) {
      const A = await contracts()
      return read<bigint>(A.mac, abis.memo, 'getNonce', [pa])
    },
    async mintParams() {
      if (params && Date.now() - params.at < 10 * 60_000) return params.p
      const A = await contracts()
      const [coreVault, feeBips, minFeeUBA, execFeeUBA] = await Promise.all([
        read<string>(A.am, abis.dm, 'directMintingPaymentAddress'),
        read<bigint>(A.am, abis.dms, 'getDirectMintingFeeBIPS'),
        read<bigint>(A.am, abis.dms, 'getDirectMintingMinimumFeeUBA'),
        read<bigint>(A.am, abis.dms, 'getDirectMintingExecutorFeeUBA'),
      ])
      const p: MintParams = { coreVault, feeBips, minFeeUBA, execFeeUBA, fxrp: A.fxrp, assetManager: A.am, vault: FIRELIGHT_VAULT }
      params = { at: Date.now(), p }
      return p
    },
    async simulate(memoHex, xrplAddress) {
      const A = await contracts()
      try {
        await pc.call({
          account: A.am,
          to: A.mac,
          data: encodeFunctionData({
            abi: abis.memo,
            functionName: 'handleMintedFAssets',
            args: [keccak256(toHex(`zecca-sim-${Date.now()}`)), xrplAddress, 0n, 0n, memoHex, EXECUTOR, '0x'],
          }),
        })
        return 'ok'
      } catch (e) {
        const raw = (e as { walk?: (f: (x: unknown) => boolean) => unknown })?.walk?.((x) => typeof (x as Raw)?.data === 'string') as Raw | undefined
        try {
          return decodeErrorResult({ abi: abis.memo, data: raw?.data as Hex }).errorName
        } catch {
          return `revert ${String(raw?.data ?? (e as Error).message).slice(0, 80)}`
        }
      }
    },
    async isExecuted(xrplHash) {
      const A = await contracts()
      return read<boolean>(A.mac, abis.memo, 'isTransactionIdUsed', [`0x${xrplHash.toLowerCase()}`])
    },
    async position(xrplAddress): Promise<VaultPosition> {
      const A = await contracts()
      const b = await read<{ fXrp: { balance: bigint }; vaults: readonly { vaultId: bigint; shares: bigint; assets: bigint }[] }>(A.mac, abis.mac, 'getBalances', [xrplAddress])
      const v = b.vaults.find((x) => x.vaultId === FIRELIGHT_VAULT_ID)
      return { shares: v?.shares ?? 0n, assets: v?.assets ?? 0n, fxrp: b.fXrp.balance }
    },
    currentPeriod: () => read<bigint>(FIRELIGHT_VAULT, abis.firelight, 'currentPeriod'),
    nextPeriodEnd: () => read<bigint>(FIRELIGHT_VAULT, abis.firelight, 'nextPeriodEnd'),
    async withdrawal(period, pa) {
      const [assets, claimed] = await Promise.all([
        read<bigint>(FIRELIGHT_VAULT, abis.firelight, 'withdrawalsOf', [period, pa]),
        read<boolean>(FIRELIGHT_VAULT, abis.firelight, 'isWithdrawClaimed', [period, pa]),
      ])
      return { assets, claimed }
    },
  }
  return side
}

