// Whether the signed-in person has Face ID enrolled with Privy, remembered for the tab per account (the session's
// address). For any other account the answer is unknown (null), so after a sign-out the next person signed in in the
// same tab never inherits the previous person's answer, in either direction (UI.md §5.4).

type Account = string | null | undefined

export type EnrolledCache = {
  /** true/false as Privy last said for this account; null when not known for it. */
  get(account: Account): boolean | null
  set(account: string, enrolled: boolean): void
  /**
   * Asks Privy (read; null = cannot tell yet) and keeps the answer only if `account` is still the one signed in
   * (current()) when it comes back. One read at a time per account.
   */
  refresh(account: string, read: () => Promise<boolean | null>, current: () => Account): Promise<boolean | null>
  subscribe(fn: () => void): () => void
}

export function createEnrolledCache(): EnrolledCache {
  let entry: { account: string; enrolled: boolean } | null = null
  let pending: { account: string; promise: Promise<boolean | null> } | null = null
  const listeners = new Set<() => void>()

  const set = (account: string, enrolled: boolean) => {
    entry = { account, enrolled }
    listeners.forEach((fn) => fn())
  }

  return {
    get: (account) => (account && entry?.account === account ? entry.enrolled : null),
    set,
    refresh(account, read, current) {
      if (pending?.account === account) return pending.promise
      // The executor runs read() now; a throw becomes the rejection, and finally only runs once `promise` is set.
      const promise: Promise<boolean | null> = new Promise<boolean | null>((resolve) => resolve(read()))
        .then((enrolled) => {
          if (enrolled === null || current() !== account) return null
          set(account, enrolled)
          return enrolled
        })
        .finally(() => {
          if (pending?.promise === promise) pending = null
        })
      pending = { account, promise }
      return promise
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
  }
}
