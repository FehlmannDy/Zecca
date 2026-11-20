// Live check against the real Lithic sandbox (not part of any test suite; run through cli.ts live-check).
// The API runs in process on the mock ledger with the card connector, on 127.0.0.1:<port> behind a quick tunnel
// (scripts/tunnel.ts --port <port>, started first). It enrolls our ASA URL, then: sign-up, tier 1, a real virtual card,
// load $20 through the pool, one demo-shop purchase under the card balance (approved by our webhook) and one above
// it (declined by our webhook), then the clearing. Prints decisions and timings, never a card number, code or secret.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { mockRawSigner, signMessage, type MockRawSigner } from '@zecca/xrpl-core/signer'
import { createApp } from '../../app'
import type { Logger } from '../../core'
import { users } from '../../users'
import { wiringFor } from '../../wiring'
import { cardCtx } from './context'
import { cardBalanceOf, cardSync, mountCard, registerCard } from './index'
import { enrollCardWebhook } from './setup'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function liveCheck(o: { port: number; zeccaRoot: string }): Promise<void> {
  const say = (m: string) => console.log(m)
  const quiet: Logger = { info: (m) => m.startsWith('[card]') && say(m), warn: (m) => say(m), error: (m) => say(m) }
  const base = readFileSync(path.join(o.zeccaRoot, '.data', `tunnel-${o.port}.url`), 'utf8').trim()
  if (!base.startsWith('https://')) throw new Error(`start the tunnel first: node node_modules/tsx/dist/cli.mjs scripts/tunnel.ts --port ${o.port}`)

  const env = { ...process.env, LEDGER_MODE: 'mock', SIGNER_MODE: 'mock', DEMO_MODE: '1', FEATURE_CARD: '1', FEATURE_DEMO_SHOP: '1', MOCK_VALIDATION_DELAY_MS: '50', WELCOME_CREDIT_MINOR: '5000' }
  const w = await wiringFor(env, () => {})
  const app = createApp({ env, db: ':memory:', ledger: w.ledger, keystore: w.keystore, poolWorker: w.poolWorker, log: quiet })
  mountCard(app, app.core, { pollMs: 0 })
  registerCard(app.core)
  await w.poolWorker.start()
  const server = serve({ fetch: app.fetch, port: o.port, hostname: '127.0.0.1' })
  try {
    const ctx = cardCtx(app.core)
    await enrollCardWebhook({ lithic: ctx.lithic!, publicBase: base, log: say })
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${base}/v1/health`).catch(() => null)
      if (r?.ok) break
      await sleep(1000)
    }

    const call = async (method: string, p: string, token?: string, body?: unknown) => {
      const res = await app.request(p, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : undefined }
    }
    const signer: MockRawSigner = mockRawSigner()
    const n = await call('POST', '/v1/auth/nonce', undefined, { address: signer.address, publicKey: signer.publicKey })
    const s = await call('POST', '/v1/auth/session', undefined, { address: signer.address, publicKey: signer.publicKey, nonce: n.body.nonce, signature: await signMessage(signer.rawSign, n.body.message) })
    const token = s.body.token as string
    const prep = await call('POST', '/v1/onboarding/prepare', token, { address: signer.address, publicKey: signer.publicKey, handle: `live${Date.now().toString(36).slice(-6)}`, displayName: 'Ana Ferri', role: 'user' })
    const sub = await call('POST', '/v1/tx/submit', token, { prepareId: prep.body.prepareId, txBlob: (await signer.sign(prep.body.tx)).tx_blob })
    if (sub.body.status !== 'validated') throw new Error(`sign-up failed: ${JSON.stringify(sub.body)}`)
    const userId = sub.body.user.id as string
    users.setTier(app.core, userId, 1)
    for (let i = 0; i < 50 && (await call('GET', '/v1/balance', token)).body.availableMinor < 5000; i++) await sleep(200)

    const card = await call('POST', '/v1/card', token)
    if (card.status !== 200) throw new Error(`card: ${JSON.stringify(card.body)}`)
    say(`card: sandbox virtual card ending ${card.body.last4}, ${card.body.state}`)
    const load = await call('POST', '/v1/card/load', token, { amountMinor: 2000 })
    const ls = await call('POST', '/v1/tx/submit', token, { prepareId: load.body.prepared.prepareId, txBlob: (await signer.sign(load.body.prepared.tx)).tx_blob })
    for (let i = 0; i < 100 && cardBalanceOf(app.core, userId) !== 2000; i++) await sleep(100)
    say(`load: $20.00 deposit ${ls.body.status}, card balance ${cardBalanceOf(app.core, userId)}`)

    const secret = (await call('GET', '/v1/card/secret', token)).body
    for (const [label, sku] of [
      ['under the card balance', 'guji-250'],
      ['above the card balance', 'grinder'],
    ] as const) {
      const order = (await call('POST', '/v1/demo/shop/orders', undefined, { items: [{ sku, qty: 1 }] })).body
      const t0 = Date.now()
      const r = await call('POST', '/v1/demo/shop/charge', undefined, { orderId: order.orderId, pan: secret.pan, expMonth: secret.expMonth, expYear: secret.expYear, cvc: secret.cvc })
      const hold = r.body.receipt ? ctx.store.hold(r.body.receipt.reference) : ctx.store.holdsOf(userId, 1)[0]
      say(
        `purchase ${label} (${order.amountMinor} cents): ${r.status} approved=${r.body.approved} ${r.body.message ?? ''} ` +
          `in ${Date.now() - t0} ms; our webhook recorded ${hold ? `${hold.status} ${hold.amountMinor}${hold.declineReason ? ` (${hold.declineReason})` : ''}` : 'nothing'}`,
      )
    }
    say('waiting for the clearing and the settlement...')
    await app.core.idle()
    await cardSync(app.core)
    const d = (await call('GET', '/v1/card', token)).body
    say(`card balance ${d.balanceMinor}; payments: ${d.authorizations.map((a: { status: string; amountMinor: number; merchant: string }) => `${a.merchant} ${a.amountMinor} ${a.status}`).join(', ')}`)
    for (const h of ctx.store.holdsOf(userId, 5)) say(`  ${h.authToken.slice(0, 8)}… ${h.status} settle=${h.settleTx ? h.settleTx.slice(0, 12) + '…' : (h.settleError ?? '-')}`)
  } finally {
    server.close()
    await w.poolWorker.stop().catch(() => {})
    await w.close().catch(() => {})
  }
}
