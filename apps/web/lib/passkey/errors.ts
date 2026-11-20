// The words to show when a Privy signature fails because of Face ID. xrpl-connect wraps errors
// ("Failed to sign transaction. ...", originalError); this finds ours underneath.

type Chain = { name?: string; message?: string; code?: string; originalError?: unknown; cause?: unknown }

export function passkeyErrorMessage(error: unknown): string | null {
  let e = error as Chain | undefined
  for (let depth = 0; e && typeof e === 'object' && depth < 6; depth += 1) {
    if (e.name === 'PasskeyMfaError' && e.message) return e.message
    if (e.code === 'OPERATION_TIMEOUT' && /hash signing/i.test(e.message ?? '')) return 'The approval took too long. Nothing was sent. Try again.'
    e = (e.originalError ?? e.cause) as Chain | undefined
  }
  return null
}
