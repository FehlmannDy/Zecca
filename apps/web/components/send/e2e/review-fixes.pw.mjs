// Checks for the review fixes (agent F), against a running web + API in mock mode. Not part of the unit suite.
//   WEB=http://localhost:3141 API=http://localhost:8841 node apps/web/components/send/e2e/review-fixes.pw.mjs
// 1. A submit whose answer is lost (it reached the API, the reply is replaced by the API's 502 "hasn't confirmed")
//    is followed on the send screen until it settles: no "Try again", and only one payment leaves Ana's balance.
// 2. A failed "To" lookup can be retried. 3. A failed /v1/config shows its message and Retry on Get paid.
// 4. The "Everyone else" caption no longer claims who paid whom.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = process.env.WEB ?? 'http://localhost:3141'
const API = process.env.API ?? 'http://localhost:8841'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '.screenshots')
mkdirSync(OUT, { recursive: true })
const RUN = Date.now().toString(36).slice(-4)
const T = 60_000
const UNCONFIRMED = "The payment network hasn't confirmed this yet. It will update here by itself within a few minutes."

const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`ok - ${what}`)
}

async function signUp(page, { email, handle, name }) {
  await page.goto(WEB + '/app/signup')
  await page.getByText('Welcome to Zecca').waitFor({ timeout: T })
  await page.getByLabel(/email/i).fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('Pick your handle').waitFor()
  await page.getByLabel(/handle/i).fill(handle)
  await page.getByText(`@${handle} is yours`).waitFor()
  await page.getByLabel(/your name|display name/i).fill(name)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.getByText(new RegExp(`You're set, ${name.split(' ')[0]}`)).waitFor({ timeout: T })
}

async function apiGet(page, path) {
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('zecca.session')).token)
  const r = await page.request.fetch(API + path, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok()) throw new Error(`GET ${path} -> ${r.status()} ${await r.text()}`)
  return r.json()
}

const browser = await chromium.launch()
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const ana = await (await browser.newContext(phone)).newPage()
const carla = await (await browser.newContext(phone)).newPage()
const errors = []
for (const p of [ana, carla]) p.on('pageerror', (e) => errors.push(e.message))

try {
  const carlaHandle = `carla${RUN}`
  await signUp(ana, { email: `ana-${RUN}@example.com`, handle: `ana${RUN}`, name: 'Ana Ferri' })
  await signUp(carla, { email: `carla-${RUN}@example.com`, handle: carlaHandle, name: 'Carla Rossi' })
  const before = { ana: (await apiGet(ana, '/v1/balance')).availableMinor, carla: (await apiGet(carla, '/v1/balance')).availableMinor }

  // ---- 2. lookup error, then Retry ----
  await ana.goto(WEB + '/app/send')
  await ana.getByLabel(/^to$/i).waitFor({ timeout: T })
  await ana.route('**/v1/directory/resolve**', (r) => r.abort())
  await ana.getByLabel(/^to$/i).fill(carlaHandle)
  await ana.getByText("Can't reach Zecca right now.", { exact: false }).waitFor({ timeout: T })
  await shot(ana, 'fix-lookup-error')
  await ana.unroute('**/v1/directory/resolve**')
  await ana.getByRole('button', { name: 'Retry' }).click()
  await ana.getByText('Carla Rossi').first().waitFor({ timeout: T })
  check(true, 'a failed lookup is retried with the same text')

  // ---- 1. a lost answer is followed, not paid again ----
  await ana.getByText('Carla Rossi').first().click()
  for (const k of ['1', '2']) await ana.getByRole('button', { name: k, exact: true }).click()
  await ana.getByRole('button', { name: 'Continue' }).click()
  await ana.getByText('Send $12.00 to Carla Rossi').first().waitFor({ timeout: T })
  let submits = 0
  await ana.route('**/v1/tx/submit', async (route) => {
    submits++
    await route.fetch() // it reaches the API and lands
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ledger_error', message: UNCONFIRMED } }) })
  })
  await ana.getByRole('button', { name: 'Approve' }).click()
  await ana.getByText(UNCONFIRMED).waitFor({ timeout: T }).catch(() => {})
  await ana.getByText(/Sending \$12\.00 to Carla|Sent\. \$12\.00 to Carla\./).first().waitFor({ timeout: T })
  await shot(ana, 'fix-lost-answer-following')
  check((await ana.getByRole('button', { name: 'Try again' }).count()) === 0, 'a lost answer offers no "Try again"')
  await ana.getByText(/Sent\. \$12\.00 to Carla\./).first().waitFor({ timeout: 90_000 })
  await ana.getByText(/Carla has it\.|On its way to Carla\./).first().waitFor({ timeout: T })
  await shot(ana, 'fix-lost-answer-settled')
  check(true, 'the followed payment turns into "Sent." by itself')
  await ana.unroute('**/v1/tx/submit')
  await carla.goto(WEB + '/app')
  await carla.waitForTimeout(3000)
  const after = { ana: (await apiGet(ana, '/v1/balance')).availableMinor, carla: (await apiGet(carla, '/v1/balance')).availableMinor }
  check(submits === 1, `one submit (${submits})`)
  check(before.ana - after.ana === 1200, `Ana paid $12 once (${before.ana} -> ${after.ana})`)
  check(after.carla - before.carla === 1200, `Carla got $12 once (${before.carla} -> ${after.carla})`)
  const outs = (await apiGet(ana, '/v1/activity?limit=20')).items.filter((a) => a.direction === 'out' && a.kind === 'p2p')
  check(outs.length === 1, `one payment in Ana's activity (${outs.length})`)

  // ---- 4. the caption ----
  await ana.getByRole('button', { name: 'View details' }).click()
  await ana.getByText('What the ledger shows').waitFor({ timeout: T })
  await ana.getByRole('tab', { name: 'Everyone else' }).click()
  const caption = await ana.locator('[role=tabpanel] p').first().innerText()
  check(!/who paid whom/i.test(caption) && /not how much\.$/.test(caption), `caption: "${caption}"`)
  await ana.locator('[role=tabpanel]').scrollIntoViewIfNeeded()
  await shot(ana, 'fix-detail-everyone')

  // ---- 3. config fails on Get paid ----
  const cold = await (await browser.newContext(phone)).newPage()
  cold.on('pageerror', (e) => errors.push(e.message))
  await cold.goto(WEB + '/app')
  await cold.evaluate((s) => localStorage.setItem('zecca.session', s), await ana.evaluate(() => localStorage.getItem('zecca.session')))
  await cold.route('**/v1/config', (r) => r.abort())
  await cold.goto(WEB + '/app/request')
  await cold.getByText("Can't reach Zecca right now.", { exact: false }).waitFor({ timeout: T })
  await shot(cold, 'fix-config-error-request')
  await cold.unroute('**/v1/config')
  await cold.getByRole('button', { name: 'Retry' }).click()
  await cold.getByText('Ask them to scan this, or send them the link.').waitFor({ timeout: T })
  check(true, 'Get paid shows the config error with Retry, and recovers')

  check(errors.length === 0, `no page errors (${errors.join(' | ')})`)
  console.log('PASS')
} catch (e) {
  console.error(e)
  await shot(ana, 'zz-fix-fail-ana').catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
