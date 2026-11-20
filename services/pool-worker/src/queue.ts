// One task at a time. Pool transactions must be strictly sequential: proofs are bound to the sequence and the balance version.
export type SerialQueue = { run<T>(fn: () => Promise<T>): Promise<T>; readonly length: number }

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve()
  let pending = 0
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      pending++
      const p = tail.then(() => fn())
      const done = () => void pending--
      tail = p.then(done, done)
      return p
    },
    get length() {
      return pending
    },
  }
}

/** One serial queue per key (e.g. per account); idle queues are dropped. */
export function createKeyedQueues(): { run<T>(key: string, fn: () => Promise<T>): Promise<T>; readonly length: number } {
  const queues = new Map<string, SerialQueue>()
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let q = queues.get(key)
      if (!q) queues.set(key, (q = createSerialQueue()))
      const queue = q
      const p = queue.run(fn)
      const drop = () => {
        if (queue.length === 0 && queues.get(key) === queue) queues.delete(key)
      }
      p.then(drop, drop)
      return p
    },
    get length() {
      let n = 0
      for (const q of queues.values()) n += q.length
      return n
    },
  }
}
