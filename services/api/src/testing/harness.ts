// Test harness: an app on :memory: with fakes (or the real mock environment), and helpers that drive the API like the web does.
import type { KeyStore, Ledger, PoolWorker, PreparedTx, User } from '@zecca/contracts'
import { mockRawSigner, signMessage, type MockRawSigner } from '@zecca/xrpl-core/signer'
import { createApp, type AppDeps, type ZeccaApp } from '../app'
import type { Env } from '../config'
import { silentLogger } from '../core'
import type { PrivyVerifier } from '../auth/privy'
import { createFakeLedger, createFakePool, fakeKeyStore, type FakeLedger, type FakePool } from './fakes'

export const TEST_ENV: Env = { LEDGER_MODE: 'mock', SIGNER_MODE: 'mock', DEMO_MODE: '1', WEB_ORIGIN: 'http://localhost:3100' }

export type Harness<L extends Ledger = FakeLedger, P extends PoolWorker = FakePool> = {
  app: ZeccaApp
  ledger: L
  pool: P
  keystore: KeyStore
  clock: { now: number; advance(ms: number): void }
  call(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>
  json<T = any>(method: string, path: string, opts?: { token?: string; body?: unknown }): Promise<{ status: number; body: T }>
  signIn(signer?: MockRawSigner): Promise<{ token: string; signer: MockRawSigner; user?: User }>
  signUp(handle: string, o?: { role?: 'user' | 'merchant'; businessName?: string; displayName?: string; email?: string; phone?: string }): Promise<TestUser>
  sign(signer: MockRawSigner, prepared: PreparedTx): Promise<string>
  submit(u: { token: string; signer: MockRawSigner }, prepared: PreparedTx): Promise<{ status: number; body: any }>
  /** Lets fake pool ticks fire and every background task (payout, merge) finish. */
  settle(): Promise<void>
}

export type TestUser = { token: string; signer: MockRawSigner; user: User }

export function makeHarness<L extends Ledger = FakeLedger, P extends PoolWorker = FakePool>(
  o: { env?: Env; ledger?: L; pool?: P; keystore?: KeyStore; privy?: PrivyVerifier; extra?: Partial<AppDeps> } = {},
): Harness<L, P> {
  const keystore = o.keystore ?? fakeKeyStore()
  const ledger = (o.ledger ?? createFakeLedger(keystore)) as L
  const pool = (o.pool ?? createFakePool()) as P
  const clock = {
    now: Date.parse('2026-11-21T09:00:00.000Z'),
    advance(ms: number) {
      clock.now += ms
    },
  }
  const app = createApp({
    env: { ...TEST_ENV, ...o.env },
    db: ':memory:',
    ledger,
    keystore,
    poolWorker: pool,
    privy: o.privy,
    clock: () => clock.now,
    log: silentLogger,
    connectors: false,
    ...o.extra,
  })

  const call: Harness['call'] = (method, path, opts = {}) =>
    app.request(path, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    }) as Promise<Response>
  const json: Harness['json'] = async (method, path, opts) => {
    const res = await call(method, path, opts)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }

  const h: Harness<L, P> = {
    app,
    ledger,
    pool,
    keystore,
    clock,
    call,
    json,
    async signIn(signer = mockRawSigner()) {
      const n = await json('POST', '/v1/auth/nonce', { body: { address: signer.address, publicKey: signer.publicKey } })
      if (n.status !== 200) throw new Error(`nonce ${n.status} ${JSON.stringify(n.body)}`)
      const signature = await signMessage(signer.rawSign, n.body.message)
      const s = await json('POST', '/v1/auth/session', { body: { address: signer.address, publicKey: signer.publicKey, nonce: n.body.nonce, signature } })
      if (s.status !== 200) throw new Error(`session ${s.status} ${JSON.stringify(s.body)}`)
      return { token: s.body.token, signer, user: s.body.user }
    },
    async sign(signer, prepared) {
      return (await signer.sign(prepared.tx)).tx_blob
    },
    async submit(u, prepared) {
      return json('POST', '/v1/tx/submit', { token: u.token, body: { prepareId: prepared.prepareId, txBlob: await h.sign(u.signer, prepared) } })
    },
    async settle() {
      for (let k = 0; k < 3; k++) {
        await new Promise((r) => setTimeout(r, 5))
        await app.core.idle()
      }
    },
    async signUp(handle, so = {}) {
      const { token, signer } = await h.signIn()
      const role = so.role ?? 'user'
      const p = await json('POST', '/v1/onboarding/prepare', {
        token,
        body: {
          address: signer.address,
          publicKey: signer.publicKey,
          handle,
          displayName: so.displayName ?? handle[0].toUpperCase() + handle.slice(1),
          role,
          ...(role === 'merchant' ? { businessName: so.businessName ?? `${handle} shop` } : {}),
          ...(so.email ? { email: so.email } : {}),
        },
      })
      if (p.status !== 200) throw new Error(`onboarding prepare ${p.status} ${JSON.stringify(p.body)}`)
      const s = await h.submit({ token, signer }, p.body)
      if (s.status !== 200 || s.body.status !== 'validated') throw new Error(`onboarding submit ${s.status} ${JSON.stringify(s.body)}`)
      if (so.phone) app.core.db.prepare('UPDATE users SET phone = ? WHERE address = ?').run(so.phone, signer.address)
      return { token, signer, user: s.body.user }
    },
  }
  return h
}

/** Waits until `fn` stops throwing (pool events arrive on a tick). */
export async function eventually<T>(fn: () => T | Promise<T>, ms = 2000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      if (Date.now() > end) throw e
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}
