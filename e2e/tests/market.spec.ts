// E2E-2, market (SPEC §9): a verified user buys gold, then sells it back. Mock signer, DEMO_MODE=1, FEATURE_MARKET=1.
// The tier is lifted through the market's DEMO_MODE-only hook (POST /v1/dev/market/tier) so this test does not
// depend on the identity screen; the identity E2E covers that path. Skipped when the API has the market off.
// Needs a ledger that can pay metals: E2E_LEDGER=devnet, or @zecca/ledger-mock once it issues MPTs (market contract
// request). Until then the mock-ledger API refuses purchases ("Metals aren't available right now.") and this spec fails
// at the first purchase: E2E-2 market is not green on the mock ledger.
import { expect, test, type Browser, type Page } from '@playwright/test'

const API = process.env.E2E_API_ORIGIN ?? 'http://localhost:8800'
const RUN = Date.now().toString(36).slice(-4)

async function signUp(page: Page, opts: { email: string; handle: string; name: string }) {
  await page.goto('/app/signup')
  await expect(page.getByText('Welcome to Zecca')).toBeVisible()
  await page.getByLabel(/email/i).fill(opts.email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Pick your handle')).toBeVisible()
  await page.getByLabel(/handle/i).fill(opts.handle)
  await expect(page.getByText(`@${opts.handle} is yours`)).toBeVisible()
  await page.getByLabel(/display name|your name/i).fill(opts.name)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText("One approval and you're in.")).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(new RegExp(`You're set, ${opts.name.split(' ')[0]}`))).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Go to home' }).or(page.getByRole('link', { name: 'Go to home' })).click()
}

async function token(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)!
        if (/session|token/i.test(k)) {
          const v = store.getItem(k)!
          try {
            const j = JSON.parse(v)
            if (j?.token) return j.token as string
          } catch {
            if (v.length > 16) return v
          }
        }
      }
    }
    throw new Error('no session token in storage')
  })
}

async function api(page: Page, method: string, path: string, body?: unknown) {
  const t = await token(page)
  const r = await page.request.fetch(API + path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, data: body ?? {} })
  expect(r.ok(), `${method} ${path} -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return r.json()
}

async function newPhone(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  return ctx.newPage()
}

test('E2E-2 market: buy gold, then sell it back', async ({ browser, request }) => {
  const config = await (await request.get(`${API}/v1/config`)).json()
  test.skip(!config.features?.market, 'FEATURE_MARKET is off on this API')
  test.skip(!config.demoMode, 'needs DEMO_MODE=1 (tier hook and demo credit)')

  const lia = await newPhone(browser)
  await signUp(lia, { email: `lia-${RUN}@example.com`, handle: `lia${RUN}`, name: 'Lia Neri' })

  // Unverified: the market shows the locked state.
  await lia.goto('/app/market')
  await expect(lia.getByText('Verify your identity to trade metals.')).toBeVisible()
  await expect(lia.getByText('Palladium', { exact: true })).toBeVisible()

  // Verified (test hook), with money to spend.
  expect((await api(lia, 'POST', '/v1/dev/market/tier')).tier).toBe(1)
  await api(lia, 'POST', '/v1/dev/credit', { amountMinor: 4000 })
  await lia.goto('/app/market')
  await expect(lia.getByText('Verify your identity to trade metals.')).toBeHidden()
  await lia.getByRole('link', { name: /Gold/ }).click()
  await expect(lia.getByText('You buy at')).toBeVisible()
  await expect(lia.getByText('You sell at')).toBeVisible()
  await expect(lia.getByText(/Price at .+ · /).first()).toBeVisible()

  // Buy $10 of gold: the first purchase opens the holding and pays, two approvals behind one "Approve".
  await lia.getByRole('button', { name: 'Buy', exact: true }).click()
  await lia.getByRole('textbox', { name: 'Amount' }).fill('10')
  await expect(lia.getByText(/^About [\d.]+ g for \$/)).toBeVisible()
  await lia.getByRole('button', { name: 'Continue' }).click()
  await expect(lia.getByRole('dialog', { name: /^Buy [\d.]+ g of gold for \$\d+\.\d\d$/ })).toBeVisible()
  await expect(lia.getByText(/Your first gold purchase takes two approvals/)).toBeVisible()
  await lia.getByRole('button', { name: 'Approve' }).click()
  await expect(lia.getByText(/^Bought\. [\d.]+ g of gold\.$/).first()).toBeVisible({ timeout: 60_000 })
  await expect(lia.getByText('The gold is in your holdings.')).toBeVisible({ timeout: 60_000 })
  await lia.getByRole('button', { name: 'Done' }).click()
  await expect(lia.getByText(/^0\.\d+ g$/)).toBeVisible({ timeout: 30_000 })

  // Sell it all back: the metal goes to Zecca in public, the dollars come back privately.
  await lia.getByRole('button', { name: 'Sell', exact: true }).click()
  await lia.getByRole('button', { name: 'Sell all' }).click()
  await lia.getByRole('button', { name: 'Continue' }).click()
  await expect(lia.getByRole('dialog', { name: /^Sell [\d.]+ g of gold for \$\d+\.\d\d$/ })).toBeVisible()
  await lia.getByRole('button', { name: 'Approve' }).click()
  await expect(lia.getByText(/^Sold\. \$\d+\.\d\d on its way\.$/).first()).toBeVisible({ timeout: 60_000 })
  await lia.getByRole('button', { name: 'Done' }).click()
  await expect(lia.getByText('0 g', { exact: true })).toBeVisible({ timeout: 30_000 })

  // Activity shows both, under "Metals".
  await lia.goto('/app')
  await expect(lia.getByText(/Sold [\d.]+ g of gold/).first()).toBeVisible({ timeout: 30_000 })
  await expect(lia.getByText(/[\d.]+ g of gold/).first()).toBeVisible()
})
