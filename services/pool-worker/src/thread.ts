// createPoolWorkerInThread: the pool worker on a worker_threads Worker (port of card-issuer/src/xrpl-pool-worker.js).
// Same PoolWorker interface; every method is a message-passing RPC, events and logs are forwarded, status() is mirrored.
import { Worker } from 'node:worker_threads'
import type { PoolEvent, PoolWorker } from '@zecca/contracts'
import type { FromThread, RpcMethod } from './thread-entry'

export type ThreadOptions = {
  /** Passed explicitly: it becomes the thread's process.env and the factory's input. */
  env: Record<string, string | undefined>
  log?: (m: string) => void
  /** Module (URL or absolute path) exporting createPoolDeps(env, { log }). Defaults to the devnet factory (live-deps.ts). Tests inject a fake. */
  factory?: string | URL
}

/** Keep the -r/--require preloads (the DNS fix on this laptop); drop process-only flags such as --env-file and loader flags. */
export function preloadArgs(execArgv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i]
    if ((a === '-r' || a === '--require') && i + 1 < execArgv.length) out.push(a, execArgv[++i])
    else if (a.startsWith('--require=')) out.push(a)
  }
  return out
}

const cleanEnv = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>

export function createPoolWorkerInThread(o: ThreadOptions): Promise<PoolWorker> {
  const log = o.log ?? ((m: string) => console.log(m))
  const factory = o.factory ? (o.factory instanceof URL ? o.factory.href : o.factory) : new URL('./live-deps.ts', import.meta.url).href
  const env = cleanEnv(o.env)
  const thread = new Worker(new URL('./thread-bootstrap.mjs', import.meta.url), { execArgv: preloadArgs(process.execArgv), env, workerData: { env, factory } })

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const listeners = { received: new Set<(e: PoolEvent) => void>(), paidOut: new Set<(e: PoolEvent) => void>(), failed: new Set<(e: PoolEvent) => void>() }
  let status: ReturnType<PoolWorker['status']> = { spendableMinor: 0, inboxMinor: 0, queue: 0 }
  let seq = 0
  let dead: Error | null = null

  const failAll = (e: Error) => {
    dead ??= e
    for (const p of pending.values()) p.reject(e)
    pending.clear()
  }
  const call = <T>(method: RpcMethod, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (dead) return reject(dead)
      const id = ++seq
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      thread.postMessage({ id, method, args })
    })

  const proxy: PoolWorker = {
    start: () => call<void>('start'),
    expectDeposit: (i) => void call('expectDeposit', i).catch((e: Error) => log(`[pool] expectDeposit ${i.txHash} not delivered to the thread: ${e.message}`)),
    on(event, cb) {
      listeners[event].add(cb)
    },
    payout: (i) => call('payout', i),
    mintIn: (amountMinor, reference) => call('mintIn', amountMinor, reference),
    mergeInboxFor: (address) => call('mergeInboxFor', address),
    status: () => ({ ...status }),
    async stop() {
      if (dead) return
      try {
        await call('stop')
      } finally {
        failAll(new Error('pool worker thread stopped'))
        await thread.terminate()
      }
    },
  }

  return new Promise<PoolWorker>((resolve, reject) => {
    let ready = false
    thread.on('error', (e) => {
      log(`[pool] worker thread error: ${e.message}`)
      failAll(e)
      if (!ready) reject(e)
    })
    thread.on('exit', (code) => {
      if (!dead) log(`[pool] worker thread exited (${code})`)
      failAll(new Error(`pool worker thread exited (${code})`))
      if (!ready) reject(new Error(`pool worker thread exited (${code}) before it was ready`))
    })
    thread.on('message', (m: FromThread) => {
      switch (m.type) {
        case 'ready':
          ready = true
          return resolve(proxy)
        case 'fatal':
          failAll(new Error(m.message))
          void thread.terminate()
          return reject(new Error(`pool worker thread failed to start: ${m.message}`))
        case 'log':
          return log(m.m)
        case 'status':
          status = m.status
          return
        case 'event':
          for (const cb of listeners[m.event.type]) {
            try {
              cb(m.event)
            } catch (e) {
              log(`[pool] ${m.event.type} listener failed: ${(e as Error).message}`)
            }
          }
          return
        case 'result':
        case 'error': {
          const p = pending.get(m.id)
          pending.delete(m.id)
          if (!p) return
          if (m.type === 'result') p.resolve(m.ok)
          else p.reject(Object.assign(new Error(m.message), m.code ? { code: m.code } : {}))
        }
      }
    })
  })
}
