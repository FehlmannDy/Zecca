// One queue per account (BUILD §8 rule 7) between the relayer's merges and the user's own transactions. The relayer's
// ConfidentialMPTMergeInbox runs as the user (Account = the user, Delegate = the relayer) and takes the user's next Sequence, while
// a PreparedTx has its Sequence (and its proof) fixed at prepare time: a merge landing in between makes the submit fail tefPAST_SEQ.
// - A merge does not start while the account has a prepare being built or an open PreparedTx. It is postponed (MergePostponed) and
//   the modules' hooks run it again as soon as the approval is used; the jobs tick's backoff covers one that expires or is left.
// - A prepare waits for the account's merge in flight, so the Sequence it reads is fresh.
import type { Core } from '../core'

export class MergePostponed extends Error {
  readonly code = 'merge_postponed'
}

type Gate = {
  building: Map<string, number>
  merging: Map<string, Set<Promise<unknown>>>
  postponed: Set<string>
  hooks: Set<(address: string) => void>
}
const gates = new WeakMap<Core, Gate>()
function gateOf(core: Core): Gate {
  let g = gates.get(core)
  if (!g) gates.set(core, (g = { building: new Map(), merging: new Map(), postponed: new Set(), hooks: new Set() }))
  return g
}

/** A prepare that waited this long for a merge goes ahead anyway (a hung relayer must not hang the person's approval). */
const MERGE_WAIT_MS = 30_000
/**
 * How long an approval nobody has used yet holds the merges back. An approve sheet closed without approving would otherwise keep
 * incoming money pending until the approval expires (150 ledgers, about 8 minutes). Approving later than this still works unless
 * money arrived meanwhile; then it fails with nothing taken and the person tries again.
 */
export const UNUSED_HOLD_MS = 2 * 60_000

/**
 * Open: not expired and either unused (for UNUSED_HOLD_MS), or used with no final outcome yet (being submitted, or its answer was
 * lost and it may still land). Past its LastLedgerSequence it can no longer apply, so it does not count.
 */
async function hasOpenPrepared(core: Core, address: string): Promise<boolean> {
  const rows = core.db
    .prepare(
      `SELECT last_ledger_sequence AS lls FROM prepared_txs
        WHERE address = ? AND expires_at > ?
          AND ((used_at IS NULL AND created_at > ?) OR (used_at IS NOT NULL AND (outcome IS NULL OR outcome = 'unknown')))`,
    )
    .all(address, core.iso(), core.iso(core.now() - UNUSED_HOLD_MS)) as { lls: number | null }[]
  if (!rows.length) return false
  if (rows.some((r) => r.lls === null)) return true
  const index = await core.ledger.ledgerIndex()
  return rows.some((r) => r.lls! >= index)
}

/** Runs the relayer's merge of `address`'s inbox, or throws MergePostponed while the account has an approval open. */
export function mergeInbox(core: Core, address: string): Promise<{ hash: string }> {
  const g = gateOf(core)
  const run = (async () => {
    const open = await hasOpenPrepared(core, address)
    // Checked after the await: a prepare that started meanwhile is waiting on this run, so it must not read the Sequence first.
    if (open || g.building.get(address)) {
      g.postponed.add(address)
      throw new MergePostponed(`merge of ${address} postponed: an approval is open`)
    }
    return core.pool.mergeInboxFor(address)
  })()
  let set = g.merging.get(address)
  if (!set) g.merging.set(address, (set = new Set()))
  set.add(run)
  const done = () => {
    set.delete(run)
    if (!set.size && g.merging.get(address) === set) g.merging.delete(address)
  }
  run.then(done, done)
  return run
}

/** Builds and stores a PreparedTx for `address`: after its merge in flight, and with no merge starting until it is stored. */
export async function preparing<T>(core: Core, address: string, fn: () => Promise<T>): Promise<T> {
  const g = gateOf(core)
  g.building.set(address, (g.building.get(address) ?? 0) + 1)
  try {
    if (g.merging.get(address)?.size) {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), MERGE_WAIT_MS)))
      try {
        for (let s = g.merging.get(address); s?.size; s = g.merging.get(address)) {
          if ((await Promise.race([Promise.allSettled([...s]), timeout])) === 'timeout') {
            core.log.warn(`[gate] prepare for ${address} goes ahead with a merge still in flight`)
            break
          }
        }
      } finally {
        clearTimeout(timer)
      }
    }
    return await fn()
  } finally {
    const n = (g.building.get(address) ?? 1) - 1
    if (n > 0) g.building.set(address, n)
    else g.building.delete(address)
    accountMaybeFree(core, address) // a prepare that failed stored nothing
  }
}

/** Called by the modules that merge: `hook(address)` runs their postponed merge again once that account is free. */
export function onAccountFree(core: Core, hook: (address: string) => void): void {
  gateOf(core).hooks.add(hook)
}

/** An approval of `address` was used, failed or settled: if a merge was postponed and nothing else is open, run it again. */
export function accountMaybeFree(core: Core, address: string): void {
  const g = gateOf(core)
  if (!g.postponed.has(address) || g.building.get(address)) return
  core.track(
    (async () => {
      if (await hasOpenPrepared(core, address)) return
      if (!g.postponed.delete(address)) return
      // On the next turn: the run that postponed it has finished and released its key.
      await new Promise((r) => setTimeout(r, 0))
      for (const hook of g.hooks) hook(address)
    })(),
    'merge after approval',
  )
}
