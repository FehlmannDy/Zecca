// Coston2 ABIs and addresses (HANDOFF "flare-firelight"). Flare's periphery package for the protocol contracts,
// the Firelight vault ABI from its verified source (copied from ../flare-firelight/firelight-abi.json).
import type { Abi, Hex } from 'viem'
import { iPersonalAccountAbi } from '@flarenetwork/flare-wagmi-periphery-package/contracts/coston2/IPersonalAccount'
import { iMasterAccountControllerAbi } from '@flarenetwork/flare-wagmi-periphery-package/contracts/coston2/IMasterAccountController'
import { iMemoInstructionsFacetAbi } from '@flarenetwork/flare-wagmi-periphery-package/contracts/coston2/IMemoInstructionsFacet'
import { iDirectMintingAbi } from '@flarenetwork/flare-wagmi-periphery-package/contracts/coston2/IDirectMinting'
import { iDirectMintingSettingsAbi } from '@flarenetwork/flare-wagmi-periphery-package/contracts/coston2/IDirectMintingSettings'
import { iAssetManagerAbi } from '@flarenetwork/flare-wagmi-periphery-package/contracts/coston2/IAssetManager'
import { iFlareContractRegistryAbi } from '@flarenetwork/flare-wagmi-periphery-package/contracts/coston2/IFlareContractRegistry'
import firelight from './firelight-abi.json'

export const abis = {
  pa: iPersonalAccountAbi,
  mac: iMasterAccountControllerAbi,
  memo: iMemoInstructionsFacetAbi,
  dm: iDirectMintingAbi,
  dms: iDirectMintingSettingsAbi,
  am: iAssetManagerAbi,
  registry: iFlareContractRegistryAbi,
  firelight: firelight as Abi,
}

export const COSTON2_RPC = 'https://coston2-api.flare.network/ext/C/rpc'
export const REGISTRY: Hex = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019'
/** Firelight vault (stXRP), MasterAccountController vault id 1. */
export const FIRELIGHT_VAULT: Hex = '0xC90D6847747b85d1fa2E07859869fb9fB72c0361'
export const FIRELIGHT_VAULT_ID = 1n
/** The executor that relayed every probe payment; the simulation names it as the executor. */
export const EXECUTOR: Hex = '0x103b384064ae85577127097A7cCadfd6fb13f437'
/** XRPL Testnet address of the FXRP Core Vault (AssetManager.directMintingPaymentAddress()). */
export const CORE_VAULT = 'rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p'
export const COSTON2_EXPLORER = 'https://coston2-explorer.flare.network/tx/'
