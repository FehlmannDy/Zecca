// Screenshots of the sign-up steps and home on the mock API, phone and laptop, light and dark.
// Run the web first: NEXT_PUBLIC_API_MOCK=1 npm run dev -w @zecca/web   then: node apps/web/scripts/screenshots.mjs
// Output: apps/web/.screenshots/ (git-ignored).
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = process.env.WEB_URL ?? 'http://localhost:3100'
const OUT = fileURLToPath(new URL('../.screenshots/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const viewports = { phone: { width: 390, height: 844 }, laptop: { width: 1280, height: 800 } }
const only = process.argv.slice(2)

const browser = await chromium.launch()
for (const scheme of ['light', 'dark']) {
  for (const [vpName, viewport] of Object.entries(viewports)) {
    const tag = `${vpName}-${scheme}`
    if (only.length && !only.some((o) => tag.includes(o))) continue
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: vpName === 'phone' ? 2 : 1 })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    const shot = (name) => page.screenshot({ path: `${OUT}${tag}-${name}.png`, fullPage: true })

    await page.goto(`${BASE}/app/signup`)
    await page.getByRole('heading', { name: 'Welcome to Zecca' }).waitFor()
    await page.getByLabel('Email').fill('ana@example.com')
    await shot('1-welcome')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('heading', { name: 'Pick your handle' }).waitFor()
    await page.getByLabel('Your name').fill('Ana Ferri')
    await page.getByText('@ana is yours').waitFor()
    await shot('2-handle')
    await page.getByText("I'm setting up a business").click()
    await page.getByLabel('Business name').fill('Ana Studio')
    await shot('2b-handle-business')
    await page.getByText("I'm setting up a business").click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('heading', { name: "One approval and you're in." }).waitFor()
    await shot('3-approve')
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.waitForTimeout(2200)
    await shot('3b-approving')
    await page.getByRole('heading', { name: "You're set, Ana." }).waitFor({ timeout: 20_000 })
    await page.waitForTimeout(400)
    await shot('4-done')
    await page.getByRole('button', { name: 'Go to home' }).click()
    await page.waitForURL(`${BASE}/app`)
    await page.getByText('Demo credit').first().waitFor()
    await page.waitForTimeout(1200)
    await shot('5-home')

    // Some life: a top-up and money arriving from Carla, pushed live through the event stream.
    await page.evaluate(() => {
      const m = window.__zeccaMock
      const ana = Object.values(m.data().users).find((u) => u.handle === 'ana')
      m.credit(ana, 4000, 'topup', undefined, 'testnet')
      m.demoIncoming('carla', 'ana', 1250, 'Dinner at Mimì')
    })
    await page.waitForTimeout(4000)
    await shot('6-home-arriving')
    await page.waitForTimeout(4500)
    await shot('7-home-activity')
    if (errors.length) console.log(tag, 'page errors:', errors.slice(0, 5))
    console.log('done', tag)
    await ctx.close()
  }
}
await browser.close()
