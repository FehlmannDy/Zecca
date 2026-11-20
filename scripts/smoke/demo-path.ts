// API-level smoke of the phase-1 demo path, against a running API (default http://localhost:8800).
// Uses the mock signer (the raw_sign contract with a local key), so it needs SIGNER_MODE=mock (or DEMO_MODE=1).
// Run: node node_modules/tsx/dist/cli.mjs scripts/smoke/demo-path.ts [--api http://localhost:8800] [--steps signup|full]
import { mockRawSigner, signMessage } from '@zecca/xrpl-core/signer'
import { formatUsd } from '@zecca/contracts'

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : d
}
const API = arg('--api', process.env.API_ORIGIN ?? 'http://localhost:8800')
const STEPS = arg('--steps', 'full')
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : undefined
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`)
  return json as T
}

type Prepared = { prepareId: string; tx: Record<string, unknown> }
async function person(handle: string, displayName: string, role: 'user' | 'merchant', businessName?: string) {
  const signer = mockRawSigner()
  const { nonce, message } = await call<{ nonce: string; message: string }>('POST', '/v1/auth/nonce', { address: signer.address, publicKey: signer.publicKey })
  const signature = await signMessage(signer.rawSign, message)
  const { token, user } = await call<{ token: string; user?: unknown }>('POST', '/v1/auth/session', { address: signer.address, publicKey: signer.publicKey, nonce, signature })
  if (user) throw new Error('fresh key already signed up?')
  const h = `${handle}${Math.floor(Math.random() * 1e4)}`
  const prep = await call<Prepared>('POST', '/v1/onboarding/prepare', { address: signer.address, publicKey: signer.publicKey, handle: h, displayName, role, businessName }, token)
  const signed = await signer.sign(prep.tx)
  const res = await call<{ status: string; hash: string; engineResult: string }>('POST', '/v1/tx/submit', { prepareId: prep.prepareId, txBlob: signed.tx_blob }, token)
  if (res.status !== 'validated') throw new Error(`onboarding ${res.engineResult}`)
  const me = await call<{ id: string; handle: string }>('GET', '/v1/me', undefined, token)
  log(`${displayName} signed up as @${me.handle} (${signer.address}) tx ${res.hash}`)
  return { signer, token, me }
}

async function approve(p: { signer: ReturnType<typeof mockRawSigner>; token: string }, prepared: Prepared) {
  const signed = await p.signer.sign(prepared.tx)
  return call<{ status: string; hash: string; engineResult: string }>('POST', '/v1/tx/submit', { prepareId: prepared.prepareId, txBlob: signed.tx_blob }, p.token)
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

const cfg = await call<{ ledgerMode: string; welcomeCreditMinor: number }>('GET', '/v1/config')
log(`API ${API} ledger=${cfg.ledgerMode}`)
const ana = await person('ana', 'Ana Ferri', 'user')
const bal = await waitFor('welcome credit', async () => {
  const b = await call<{ availableMinor: number }>('GET', '/v1/balance', undefined, ana.token)
  return b.availableMinor >= cfg.welcomeCreditMinor ? b : undefined
})
log(`Ana balance ${formatUsd(bal.availableMinor)}`)
if (STEPS === 'signup') process.exit(0)

const carla = await person('carla', 'Carla Rossi', 'user')
const bruno = await person('bruno', 'Bruno Esposito', 'merchant', 'Caffè Bruno')

const t = await call<{ intent: { id: string }; prepared: Prepared }>('POST', '/v1/transfers', { to: carla.me.id, amountMinor: 1200, note: 'Dinner' }, ana.token)
const s = await approve(ana, t.prepared)
log(`Ana -> Carla $12.00 deposit ${s.hash} ${s.engineResult}`)
await waitFor('Carla receives', async () => {
  const b = await call<{ availableMinor: number; pendingMinor: number }>('GET', '/v1/balance', undefined, carla.token)
  return b.availableMinor + b.pendingMinor >= cfg.welcomeCreditMinor + 1200 ? b : undefined
})
log('Carla sees $12.00')

const pr = await call<{ id: string; url: string }>('POST', '/v1/payment-requests', { amountMinor: 450, reference: 'Table 4' }, bruno.token)
log(`Bruno request ${pr.url}`)
const pay = await call<{ prepared: Prepared }>('POST', `/v1/payment-requests/${pr.id}/pay`, undefined, ana.token)
const ps = await approve(ana, pay.prepared)
log(`Ana pays Caffè Bruno $4.50 deposit ${ps.hash}`)
await waitFor('request paid', async () => {
  const r = await call<{ status: string }>('GET', `/v1/payment-requests/${pr.id}`, undefined, bruno.token)
  return r.status === 'paid' ? r : undefined
})
log('Bruno sees Paid')
const sales = await call<{ totals: { grossMinor: number; feeMinor: number; netMinor: number } }>('GET', '/v1/merchant/sales', undefined, bruno.token)
log(`Sales gross ${formatUsd(sales.totals.grossMinor)} fee ${formatUsd(sales.totals.feeMinor)} net ${formatUsd(sales.totals.netMinor)}`)
const act = await call<{ items: { kind: string; ledger: { depositTxHash?: string; payoutTxHash?: string } }[] }>('GET', '/v1/activity', undefined, ana.token)
log(`Ana activity: ${act.items.map((i) => i.kind).join(', ')}`)
log('DEMO PATH OK')
