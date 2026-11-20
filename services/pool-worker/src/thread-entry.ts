// Runs inside the worker thread (loaded by thread-bootstrap.mjs, which registers tsx first).
// Builds the dependencies with the factory module, runs createPoolWorker, answers RPC calls and forwards events, logs and status.
// The proof generation and decryption (synchronous WASM, 0.7–3 s) block this thread only, never the API's event loop.
import { parentPort, workerData } from 'node:worker_threads'
import type { KeyStore, Ledger, PoolWorker } from '@zecca/contracts'
import { pollMsFromEnv } from './env'
import type { PoolStore } from './store'
import { createPoolWorker } from './worker'

export type PoolDeps = { ledger: Ledger; keystore: KeyStore; store: PoolStore; close?: () => void | Promise<void> }
export type PoolDepsFactory = (env: Record<string, string | undefined>, ctx: { log: (m: string) => void }) => Promise<PoolDeps>

export type ToThread = { id: number; method: RpcMethod; args: unknown[] }
export type FromThread =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'log'; m: string }
  | { type: 'event'; event: import('@zecca/contracts').PoolEvent }
  | { type: 'status'; status: ReturnType<PoolWorker['status']> }
  | { type: 'result'; id: number; ok: unknown }
  | { type: 'error'; id: number; message: string; code?: string }

export const RPC_METHODS = ['start', 'expectDeposit', 'payout', 'mintIn', 'mergeInboxFor', 'stop'] as const
export type RpcMethod = (typeof RPC_METHODS)[number]

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function main() {
  const port = parentPort
  if (!port) return
  const { env, factory } = workerData as { env: Record<string, string | undefined>; factory: string }
  const post = (m: FromThread) => port.postMessage(m)
  const log = (m: string) => post({ type: 'log', m })
  let deps: PoolDeps
  let worker: PoolWorker
  try {
    const mod = (await import(factory)) as { createPoolDeps?: PoolDepsFactory }
    if (typeof mod.createPoolDeps !== 'function') throw new Error(`pool worker factory ${factory} does not export createPoolDeps`)
    deps = await mod.createPoolDeps(env, { log })
    const pollMs = pollMsFromEnv(env.POOL_POLL_MS, log)
    // lagMonitor off here: this thread blocks on proofs by design; createPoolWorkerInThread watches the API's thread instead.
    worker = createPoolWorker({ ledger: deps.ledger, keystore: deps.keystore, store: deps.store, log, pollMs, lagMonitor: false })
  } catch (e) {
    post({ type: 'fatal', message: msg(e) })
    return
  }
  const status = () => post({ type: 'status', status: worker.status() })
  // Status first: the parent's status() is already current when its event handlers run.
  for (const t of ['received', 'paidOut', 'failed'] as const)
    worker.on(t, (event) => {
      status()
      post({ type: 'event', event })
    })

  async function run(method: RpcMethod, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'start':
        return worker.start()
      case 'expectDeposit':
        return worker.expectDeposit(args[0] as Parameters<PoolWorker['expectDeposit']>[0])
      case 'payout':
        return worker.payout(args[0] as Parameters<PoolWorker['payout']>[0])
      case 'mintIn':
        return worker.mintIn(args[0] as number, args[1] as string)
      case 'mergeInboxFor':
        return worker.mergeInboxFor(args[0] as string)
      case 'stop':
        await worker.stop()
        await deps.close?.()
        return undefined
    }
  }

  port.on('message', async ({ id, method, args }: ToThread) => {
    if (!RPC_METHODS.includes(method)) return post({ type: 'error', id, message: `unknown method ${String(method)}` })
    // Status before the result: the parent's status() is already current when its call resolves.
    try {
      const p = run(method, args)
      status() // the queue just grew
      const ok = await p
      status()
      post({ type: 'result', id, ok })
    } catch (e) {
      status()
      post({ type: 'error', id, message: msg(e), code: (e as { code?: string }).code })
    }
  })
  post({ type: 'ready' })
  status()
}

await main()
