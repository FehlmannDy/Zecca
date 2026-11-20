// Send flow check against a running web + API in mock mode (agent F). Not part of the unit suite.
//   WEB=http://localhost:3141 API=http://localhost:8841 node apps/web/components/send/e2e/send-flow.pw.mjs
// Signs up Ana and Carla through the UI, sends $12.00, checks both sides and the ledger panel, the limit sheet,
// a short balance, the lookup messages and the get-paid screen. Screenshots go to ./.screenshots (gitignored).
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

async function token(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('zecca.session')).token)
}

async function api(page, method, path, body) {
  const r = await page.request.fetch(API + path, { method, headers: { authorization: `Bearer ${await token(page)}`, 'content-type': 'application/json' }, data: body })
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`)
  return r.json()
}

async function keypad(page, digits) {
  for (const k of digits) await page.getByRole('button', { name: k, exact: true }).click()
}

const browser = await chromium.launch()
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const anaCtx = await browser.newContext(phone)
const carlaCtx = await browser.newContext(phone)
const ana = await anaCtx.newPage()
const carla = await carlaCtx.newPage()
const errors = []
for (const p of [ana, carla]) p.on('pageerror', (e) => errors.push(e.message))

try {
  const carlaHandle = `carla${RUN}`
  await signUp(ana, { email: `ana-${RUN}@example.com`, handle: `ana${RUN}`, name: 'Ana Ferri' })
  await signUp(carla, { email: `carla-${RUN}@example.com`, handle: carlaHandle, name: 'Carla Rossi' })

  // Logged out, /app/send?to= goes through sign-up and comes back.
  const fresh = await (await browser.newContext(phone)).newPage()
  await fresh.goto(`${WEB}/app/send?to=${carlaHandle}`)
  await fresh.waitForURL(/\/app\/signup\?next=/, { timeout: T })
  check(decodeURIComponent(fresh.url()).includes(`/app/send?to=${carlaHandle}`), 'logged out: sign-up keeps ?next=/app/send?to=')
  await fresh.context().close()

  // ---- To ----
  await ana.goto(WEB + '/app/send')
  await ana.getByLabel(/^to$/i).waitFor({ timeout: T })
  await shot(ana, 'p390-send-1-to-empty')
  await ana.getByLabel(/^to$/i).fill('nobody_here_x')
  await ana.getByText('No one on Zecca matches that.', { exact: false }).waitFor()
  await shot(ana, 'p390-send-1b-unknown')
  await ana.getByLabel(/^to$/i).fill('rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH')
  await ana.getByText("Sending outside Zecca isn't supported yet.", { exact: false }).waitFor()
  await shot(ana, 'p390-send-1c-external')
  await ana.getByLabel(/^to$/i).fill(`ana${RUN}`)
  await ana.getByText("That's you.", { exact: false }).waitFor()
  check(true, 'lookup: unknown, external and self messages')
  await ana.getByLabel(/^to$/i).fill(carlaHandle)
  await ana.getByText('Carla Rossi').first().waitFor()
  await shot(ana, 'p390-send-1d-found')
  await ana.getByText('Carla Rossi').first().click()

  // ---- amount ----
  await keypad(ana, ['1', '2'])
  await ana.getByLabel(/note/i).fill('Dinner')
  await shot(ana, 'p390-send-2-amount')
  await ana.getByRole('button', { name: /continue|next|review/i }).click()
  await ana.getByText('Send $12.00 to Carla Rossi').first().waitFor({ timeout: T })
  check(await ana.getByText('Fee').isVisible(), 'approve sheet shows the fee line')
  await shot(ana, 'p390-send-3-approve')
  await ana.getByRole('button', { name: 'Approve' }).click()
  await ana.waitForTimeout(400)
  await shot(ana, 'p390-send-4-sealing')
  // The approve sheet repeats its title in a screen-reader heading, hence first().
  await ana.getByText(/Sent\. \$12\.00 to Carla\./).first().waitFor({ timeout: T })
  await ana.getByText(/Carla has it\.|On its way to Carla\./).waitFor({ timeout: T })
  await shot(ana, 'p390-send-5-sent')
  check(true, 'sent $12.00 to Carla')

  // ---- Carla sees it ----
  await carla.goto(WEB + '/app')
  await carla.getByText('$62').first().waitFor({ timeout: 90_000 })
  check(true, "Carla's balance shows $62")

  // ---- details from the success sheet ----
  await ana.getByRole('button', { name: 'View details' }).click()
  await ana.getByText('What the ledger shows').waitFor({ timeout: T })
  await ana.getByText('Dinner').first().waitFor()
  await shot(ana, 'p390-detail-1-you')
  await ana.getByRole('tab', { name: 'Everyone else' }).click()
  await ana.getByText('Zecca pool').first().waitFor()
  await ana.locator('a[href*="xrpl.org/transactions/"]').nth(1).waitFor({ timeout: 90_000 })
  const links = await ana.locator('a[href*="xrpl.org/transactions/"]').count()
  check(links === 2, `Everyone else shows two transaction links (${links})`)
  check((await ana.locator('dl').innerText()).includes('Not visible'), 'fee is not visible to everyone else')
  check(!(await ana.locator('[role=tabpanel]').innerText()).includes('Carla'), 'no counterparty name in Everyone else')
  await ana.locator('[role=tabpanel]').scrollIntoViewIfNeeded()
  await shot(ana, 'p390-detail-2-everyone')

  // ---- activity list on both sides ----
  await ana.goto(WEB + '/app/activity')
  await ana.getByText('Carla Rossi').first().waitFor({ timeout: T })
  await shot(ana, 'p390-activity-ana')
  await carla.goto(WEB + '/app/activity')
  await carla.getByText('Ana Ferri').first().waitFor({ timeout: T })
  check((await carla.getByText('+$12').count()) > 0, 'Carla sees +$12 from Ana')
  await shot(carla, 'p390-activity-carla')
  await carla.getByText('Ana Ferri').first().click()
  await carla.getByText('What the ledger shows').waitFor()
  await carla.getByRole('tab', { name: 'Everyone else' }).click()
  await carla.locator('a[href*="xrpl.org/transactions/"]').nth(1).waitFor({ timeout: 90_000 })
  await shot(carla, 'p390-detail-carla-everyone')

  // ---- /app/send?to= preselects ----
  await ana.goto(`${WEB}/app/send?to=${carlaHandle}`)
  await ana.getByRole('button', { name: 'Change' }).waitFor({ timeout: T })
  check(true, '/app/send?to= goes straight to the amount')

  // ---- short balance: $45 with $38 left ----
  await keypad(ana, ['4', '5'])
  await ana.getByText('You need $7.00 more.').waitFor()
  check(await ana.getByRole('link', { name: 'Top up' }).isVisible(), 'short balance shows Top up')
  await shot(ana, 'p390-send-short')
  for (let i = 0; i < 2; i++) await ana.getByRole('button', { name: 'Delete' }).click()

  // ---- limit: $60 at tier 0 ----
  await keypad(ana, ['6', '0'])
  await ana.getByRole('button', { name: /continue|next|review/i }).click()
  await ana.getByText("You've reached the limit for unverified accounts.").waitFor({ timeout: T })
  await shot(ana, 'p390-send-limit')
  check(true, 'tier 0 $60 opens the limit sheet')
  await ana.getByRole('button', { name: 'Not now' }).click()

  // ---- get paid ----
  await ana.goto(WEB + '/app/request')
  await ana.getByText('Ask them to scan this, or send them the link.').waitFor({ timeout: T })
  check((await ana.getByRole('img', { name: /QR code/ }).count()) === 1, 'request screen shows a QR code')
  await shot(ana, 'p390-request')

  // ---- 360 px and wide ----
  await ana.setViewportSize({ width: 360, height: 780 })
  await ana.goto(WEB + '/app/send')
  await ana.getByLabel(/^to$/i).fill(carlaHandle)
  await ana.getByText('Carla Rossi').first().waitFor({ timeout: T })
  await shot(ana, 'p360-send-to')
  const overflow = await ana.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  check(!overflow, 'no horizontal scroll at 360 px')

  const wide = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await wide.goto(WEB + '/app')
  await wide.evaluate((s) => localStorage.setItem('zecca.session', s), await ana.evaluate(() => localStorage.getItem('zecca.session')))
  for (const [path, name, wait] of [
    ['/app/send', 'w1280-send', 'Recent'],
    ['/app/activity', 'w1280-activity', 'Carla Rossi'],
    ['/app/request', 'w1280-request', 'Ask them to scan this'],
  ]) {
    await wide.goto(WEB + path)
    await wide.getByText(wait).first().waitFor({ timeout: T })
    await shot(wide, name)
  }
  await wide.goto(WEB + '/app/activity')
  await wide.getByText('Carla Rossi').first().click()
  await wide.getByRole('tab', { name: 'Everyone else' }).click()
  await wide.locator('a[href*="xrpl.org/transactions/"]').nth(1).waitFor({ timeout: T })
  await shot(wide, 'w1280-detail-everyone')
  await wide.emulateMedia({ colorScheme: 'dark' })
  await shot(wide, 'w1280-detail-everyone-dark')

  check(errors.length === 0, `no page errors (${errors.join(' | ')})`)
  console.log('PASS')
} catch (e) {
  console.error(e)
  await shot(ana, 'zz-fail-ana').catch(() => {})
  await shot(carla, 'zz-fail-carla').catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
