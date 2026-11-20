// Used by every approve flow: sign the prepared tx with the user's key, hand the blob back with its prepareId.
import type { PreparedTx } from '@zecca/contracts'
import { ZeccaApiError, type ApiClient } from '../api'
import type { WalletSigner } from './types'

export async function signAndSubmit(api: Pick<ApiClient, 'call'>, signer: WalletSigner, prepared: PreparedTx) {
  const { tx_blob } = await signer.sign(prepared.tx)
  const result = await api.call('txSubmit', { body: { prepareId: prepared.prepareId, txBlob: tx_blob } })
  if (result.status !== 'validated')
    throw new ZeccaApiError(422, { code: 'ledger_error', message: "That didn't go through and nothing was taken. Try again." })
  return result
}
