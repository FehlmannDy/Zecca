// End-to-end check of "Approve with Face ID" against the real Privy, with a throwaway inbox and Chromium's
// virtual authenticator standing in for Face ID. Drives /dev/passkey: email login -> link passkey -> enrol as MFA
// -> sign a never-valid AccountSet (raw_sign) -> expect mfaRequired answered by our handler -> signature verifies.
//
//   node -r ./scripts/dev/dnsfix.cjs apps/web/scripts/passkey/run-privy-passkey.mjs <baseUrl> <evidenceDir> [query]
//
// AS_ORIGIN=http://localhost:5173 serves the page to the browser under that origin (every request to it is proxied
// by Playwright to <baseUrl>), for when Privy's "Allowed origins" does not list <baseUrl> ("Origin not allowed").
// The real server on that port is never contacted.
//
// Run from the repo root, unsandboxed. Writes <evidenceDir>/run-<time>.json (the page's step log, no secrets) and
// screenshots. Exit code 0 only when the signature came back after a passkey prompt and verified.
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { createInbox, waitForCode } from './mailtm.mjs'

const [base = 'http://localhost:3100', outDir = '.', query = ''] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const evidence = { startedAt: new Date().toISOString(), base, query, steps: [], console: [], http: [] }
const note = (step, detail) => {
  evidence.steps.push({ at: new Date().toISOString(), step, ...(detail ? { detail } : {}) })
  console.log(`[run] ${step}`, detail ? JSON.stringify(detail) : '')
}

// channel 'chromium' = the full browser in new headless mode (the headless shell never answers Privy's iframe ping).
const browser = await chromium.launch({ headless: process.env.HEADED !== '1', channel: 'chromium' })
const context = await browser.newContext()
const asOrigin = process.env.AS_ORIGIN?.replace(/\/$/, '')
if (asOrigin) {
  evidence.asOrigin = asOrigin
  const prefix = new RegExp(`^${asOrigin.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`)
  await context.route(prefix, async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(asOrigin, base) })
    await route.fulfill({ response })
  })
  // Never reach the real server on that port: Next's dev websocket (HMR) is relayed to <baseUrl> too.
  const wsFrom = asOrigin.replace(/^http/, 'ws')
  const wsTo = base.replace(/^http/, 'ws')
  await context.routeWebSocket(new RegExp(`^${wsFrom.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`), (ws) => {
    const upstream = new WebSocket(ws.url().replace(wsFrom, wsTo))
    upstream.binaryType = 'arraybuffer'
    const queue = []
    upstream.onopen = () => queue.splice(0).forEach((m) => upstream.send(m))
    upstream.onmessage = (e) => ws.send(typeof e.data === 'string' ? e.data : Buffer.from(e.data))
    upstream.onclose = () => ws.close().catch(() => {})
    ws.onMessage((m) => (upstream.readyState === 1 ? upstream.send(m) : queue.push(m)))
    ws.onClose(() => upstream.close())
  })
}
const pageOrigin = asOrigin ?? base
// Keep the CSP reports Privy's iframe sends (they say which directive blocked it); never forward them.
await context.route(/csp-report\.browser-intake-datadoghq\.com/, async (route) => {
  evidence.cspReports = [...(evidence.cspReports ?? []), (route.request().postData() ?? '').slice(0, 1500)]
  await route.fulfill({ status: 204, body: '' })
})
// Message names only (never payloads: they carry access tokens), in the page and in Privy's iframe.
await context.addInitScript(() => {
  window.addEventListener('message', (e) => {
    let d = e.data
    if (typeof d === 'string') try { d = JSON.parse(d) } catch { return }
    if (d && typeof d.event === 'string') console.log(`[msg] at ${location.host} from ${e.origin}: ${d.event}${d.error ? ' error=' + JSON.stringify(d.error).slice(0, 200) : ''}`)
  })
})
const page = await context.newPage()
page.on('console', (m) => {
  const t = m.text()
  const where = m.location()?.url ?? ''
  if (/auth\.privy\.io/.test(where) || /^\[msg\]/.test(t) || (/privy|mfa|passkey|error|wallet/i.test(t) && !/DevTools|Fast Refresh|HMR/.test(t))) evidence.console.push(`${m.type()}: ${/auth\.privy\.io/.test(where) ? '[iframe] ' : ''}${t.slice(0, 400)}`)
})
page.on('pageerror', (e) => evidence.console.push(`pageerror: ${e.message.slice(0, 400)}`))
page.on('framenavigated', (f) => f === page.mainFrame() && evidence.console.push(`navigated: ${f.url()}`))
page.on('requestfailed', (r) => evidence.http.push(`FAILED ${r.failure()?.errorText} ${r.method()} ${r.url().split('?')[0]}`))
page.on('frameattached', (f) => evidence.console.push(`frame: ${f.url() || '(blank)'}`))
page.on('response', (r) => {
  if (process.env.DEBUG_IFRAME === '1' && /auth\.privy\.io/.test(r.url())) evidence.http.push(`${r.status()} ${r.request().method()} ${r.url().split('?')[0]} (frame ${r.frame()?.url().split('?')[0].slice(0, 60)})`)
  if (r.status() >= 400 && !/analytics_events/.test(r.url())) evidence.http.push(`${r.status()} ${r.request().method()} ${r.url().split('?')[0]}`)
})

const shot = (name) => page.screenshot({ path: `${outDir}/${stamp}-${name}.png` }).catch(() => {})
const pageLog = () => page.evaluate(() => window.__passkeyDev?.log ?? [])
async function waitForLog(re, timeout = 60_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const hit = (await pageLog()).find((e) => re.test(e.event))
    if (hit) return hit
    await page.waitForTimeout(250)
  }
  throw new Error(`timed out waiting for ${re}`)
}

let exitCode = 1
try {
  // Chromium's virtual authenticator: a platform authenticator with user verification (Face ID's role).
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  note('virtual-authenticator', { authenticatorId })

  const inbox = await createInbox()
  note('inbox', { address: inbox.address })

  await page.goto(`${pageOrigin}/dev/passkey${query ? `?${query}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  const avail = await waitForLog(/^available$/, 120_000)
  note('page-ready', avail.detail)

  // Privy's embedded-wallet iframe attaches its message listener a few seconds after its load event, and the
  // adapter pings it once, right at load: on a cold cache the ping is lost ("embedded wallet readiness timed out").
  // The page applies lib/passkey/iframe-ready.ts (repeats the ping), so a cold cache works. PREWARM=1 loads the
  // iframe once first anyway, as for a returning visitor.
  if (process.env.PREWARM === '1') {
    const warm = await page.evaluate(async (appId) => {
      const f = document.createElement('iframe')
      f.hidden = true
      f.src = `https://auth.privy.io/apps/${appId}/embedded-wallets`
      document.body.appendChild(f)
      await new Promise((r) => f.addEventListener('load', r))
      await new Promise((r) => setTimeout(r, 6000))
      f.remove()
      return 'ok'
    }, process.env.PRIVY_APP_ID ?? 'cmwp3ayt902ll0il2cu05wx46')
    note('iframe-prewarmed', { warm })
  }

  // Privy email login through the xrpl-connect connector (open shadow DOM; Playwright pierces it).
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByText('Sign in with socials').click()
  await page.getByRole('button', { name: 'Email', exact: true }).click()
  await page.locator('input[name=email]').fill(inbox.address)
  const sentAt = Date.now()
  await page.getByRole('button', { name: 'Send code' }).click()
  note('code-requested')
  await shot('1-code-requested')
  const { code, from } = await waitForCode(inbox, { since: sentAt })
  note('code-received', { from })
  // xrpl-connect draws six cells over one real input (input.auth-prompt-code-input, autocomplete=one-time-code).
  const codeInput = page.locator('input[autocomplete=one-time-code]')
  await codeInput.waitFor({ state: 'attached', timeout: 30_000 })
  await codeInput.fill(code, { force: true })
  const submit = page.getByRole('button', { name: 'Verify code' })
  if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {})
  await shot('2-code-entered')
  if (process.env.DEBUG_IFRAME === '1') {
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(2000)
      for (const f of page.frames()) {
        if (!/auth\.privy\.io/.test(f.url())) continue
        const st = await f.evaluate(() => ({ ready: document.readyState, scripts: document.scripts.length, next: typeof window.next, html: document.body?.innerHTML?.length ?? -1, ls: (() => { try { return localStorage.length } catch (e) { return String(e) } })() })).catch((x) => String(x).slice(0, 200))
        evidence.console.push(`[iframe-state ${i}] ${JSON.stringify(st)}`)
      }
    }
  }
  const connected = await waitForLog(/^connected$/, 120_000)
  note('signed-in', connected.detail)
  await waitForLog(/^status$/, 30_000)

  // Baseline: a signature before any passkey exists must not ask for one.
  for (const [label, re] of [
    ['Link passkey', /^link:(ok|error)$/],
    ['Enroll as MFA', /^enroll:(ok|error)$/],
    ['Status', /^status:(ok|error)$/],
  ]) {
    const before = (await pageLog()).length
    await page.getByRole('button', { name: label, exact: true }).click()
    const until = Date.now() + 90_000
    let hit
    while (!hit && Date.now() < until) {
      hit = (await pageLog()).slice(before).find((e) => re.test(e.event))
      if (!hit) await page.waitForTimeout(250)
    }
    note(label, hit ?? { timeout: true })
    await shot(label.replace(/\W+/g, '-'))
    if (!hit || /error/.test(hit.event)) throw new Error(`${label} failed`)
  }

  // The signature: approve in the adapter's review, then the handler must answer Privy's MFA with the passkey.
  async function signOnce(tag) {
    const before = (await pageLog()).length
    await page.getByRole('button', { name: 'Sign test transaction', exact: true }).click()
    const approve = page.getByRole('button', { name: 'Approve', exact: true })
    await approve.waitFor({ timeout: 30_000 })
    await shot(`${tag}-review`)
    await approve.click()
    const until = Date.now() + 120_000
    let hit
    while (!hit && Date.now() < until) {
      hit = (await pageLog()).slice(before).find((e) => /^sign:(ok|error)$/.test(e.event))
      if (!hit) await page.waitForTimeout(250)
    }
    const slice = (await pageLog()).slice(before).map((e) => `${e.event}${e.detail ? ' ' + JSON.stringify(e.detail) : ''}`)
    note(tag, { result: hit ?? 'timeout', events: slice })
    await shot(`${tag}-done`)
    return hit
  }
  // Cancel path first: the authenticator refuses user verification (what dismissing Face ID does). The signature
  // must fail at once with our words, and the next one must still work.
  let cancel = null
  if (process.env.CANCEL_CHECK !== '0') {
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
    cancel = await signOnce('sign-0-cancelled')
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true })
  }
  const first = await signOnce('sign-1')
  const second = await signOnce('sign-2')
  const ok = first?.event === 'sign:ok' && first.detail?.verified === true && first.detail?.prompts >= 1
  note('verdict', {
    endToEnd: ok,
    cancel: cancel ? { event: cancel.event, ms: cancel.detail?.ms, friendly: cancel.detail?.friendly } : 'skipped',
    firstPrompts: first?.detail?.prompts,
    firstMs: first?.detail?.ms,
    secondPrompts: second?.detail?.prompts,
    secondOk: second?.event === 'sign:ok',
  })
  exitCode = ok ? 0 : 2
} catch (e) {
  note('failed', { message: e.message })
  evidence.frames = await Promise.all(
    page.frames().map(async (f) => ({
      url: f.url().split('?')[0],
      state: await f.evaluate(() => ({ ready: document.readyState, title: document.title, text: document.body?.innerText?.slice(0, 200) })).catch((x) => String(x).slice(0, 200)),
    })),
  )
  await shot('failed')
} finally {
  evidence.pageLog = await pageLog().catch(() => [])
  await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
  writeFileSync(`${outDir}/run-${stamp}.json`, JSON.stringify(evidence, null, 2))
  console.log(`[run] evidence: ${outDir}/run-${stamp}.json`)
  await browser.close()
  process.exit(exitCode)
}
