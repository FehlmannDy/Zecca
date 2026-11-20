// Thread env parsing. POOL_POLL_MS feeds setInterval: NaN or 0 would poll account_tx back to back against the ledger.
export const MIN_POLL_MS = 1000

/** POOL_POLL_MS as whole milliseconds >= 1 s; unset gives undefined (the worker default, 15 s); anything else is logged and gives the default. */
export function pollMsFromEnv(raw: string | undefined, log: (m: string) => void): number | undefined {
  const v = raw?.trim()
  if (!v) return undefined
  const n = /^\d+$/.test(v) ? Number(v) : NaN
  if (Number.isSafeInteger(n) && n >= MIN_POLL_MS) return n
  log(`[pool] POOL_POLL_MS=${JSON.stringify(raw)} is not a whole number of milliseconds >= ${MIN_POLL_MS}; using the default`)
  return undefined
}
