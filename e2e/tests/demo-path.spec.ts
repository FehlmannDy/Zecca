// E2E-1, the phase-1 demo path (SPEC §9). Two browser contexts, mock signer (SIGNER_MODE=mock).
// Selectors use the final English copy from docs/UI.md, so the test doubles as a copy check.
import { expect, test, type Browser, type Page } from '@playwright/test'

const API = process.env.E2E_API_ORIGIN ?? 'http://localhost:8801'
const RUN = Date.now().toString(36).slice(-4)

async function signUp(page: Page, opts: { email: string; handle: string; name: string; business?: string }) {
  await page.goto(opts.business ? '/merchant' : '/app/signup')
  await expect(page.getByText(opts.business ? 'Open your business account' : 'Welcome to Zecca').first()).toBeVisible()
  await page.getByLabel(/email/i).fill(opts.email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Pick your handle').first()).toBeVisible()
  await page.getByLabel(/handle/i).fill(opts.handle)
  await expect(page.getByText(`@${opts.handle} is yours`).first()).toBeVisible()
  await page.getByLabel(/your name/i).fill(opts.name)
  if (opts.business) {
    const toggle = page.getByLabel("I'm setting up a business")
    if (!(await toggle.isChecked())) await toggle.check()
    await page.getByLabel(/business name/i).fill(opts.business)
  }
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText("One approval and you're in.").first()).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(new RegExp(`You're set, ${opts.name.split(' ')[0]}`))).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Go to home' }).or(page.getByRole('link', { name: 'Go to home' })).click()
}

/** Amounts are split into spans (dollars large, cents small): compare the page text without whitespace. */
async function expectAmount(page: Page, text: string, timeout = 30_000) {
  await expect.poll(async () => (await page.locator('body').innerText()).replace(/\s+/g, ''), { timeout }).toContain(text.replace(/\s+/g, ''))
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
  const r = await page.request.fetch(API + path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, data: body })
  expect(r.ok(), `${method} ${path} -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return r.json()
}

async function newPhone(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  return ctx.newPage()
}

test('E2E-1: the demo path', async ({ browser }) => {
  const ana = await newPhone(browser)
  const bruno = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const carla = await newPhone(browser)

  // 1. Ana signs up; home shows the demo credit.
  await signUp(ana, { email: `ana-${RUN}@example.com`, handle: `ana${RUN}`, name: 'Ana Ferri' })
  await expectAmount(ana, '$50.00', 30_000)

  // 2. Bruno signs up as a merchant, "Caffè Bruno".
  await signUp(bruno, { email: `bruno-${RUN}@example.com`, handle: `bruno${RUN}`, name: 'Bruno Esposito', business: 'Caffè Bruno' })

  // Carla exists (created through the UI here; SPEC says by API in setup — same effect).
  await signUp(carla, { email: `carla-${RUN}@example.com`, handle: `carla${RUN}`, name: 'Carla Rossi' })

  // 3. Ana tops up $40 through POST /dev/credit; balance rises.
  await api(ana, 'POST', '/v1/dev/credit', { amountMinor: 4000 })
  await expectAmount(ana, '$90.00', 60_000)

  // 4. Ana sends $12.00 to Carla.
  await ana.goto('/app/send')
  await ana.getByLabel(/^to$/i).fill(`carla${RUN}`)
  await ana.getByText('Carla Rossi').first().click()
  for (const k of ['1', '2']) await ana.getByRole('button', { name: k, exact: true }).click()
  await ana.getByRole('button', { name: /continue|next|review/i }).click()
  await expect(ana.getByText('Send $12.00 to Carla Rossi').first()).toBeVisible()
  await ana.getByRole('button', { name: 'Approve' }).click()
  await expect(ana.getByText(/Sent\. \$12\.00 to Carla/).first()).toBeVisible({ timeout: 60_000 })
  await carla.goto('/app')
  await expectAmount(carla, '$62.00', 90_000)

  // 5. Bruno creates a request for $4.50; the QR code and link appear.
  await bruno.goto('/merchant/charge')
  for (const k of ['4', 'Decimal point', '5', '0']) await bruno.getByRole('button', { name: k, exact: true }).click()
  const created = bruno.waitForResponse((r) => r.url().endsWith('/v1/payment-requests') && r.request().method() === 'POST')
  await bruno.getByRole('button', { name: 'Charge' }).click()
  await expect(bruno.getByText('Waiting for the customer').first()).toBeVisible()
  await expect.soft(bruno.getByRole('img', { name: /Payment code for \$4\.50/ }).or(bruno.getByLabel(/Payment code for \$4\.50/)).first()).toBeVisible()
  const link = ((await (await created).json()) as { url: string }).url

  // 6. Ana opens the link, sees "Caffè Bruno" and "$4.50", approves.
  await ana.goto(link)
  await expect(ana.getByText('Caffè Bruno').first()).toBeVisible()
  await expectAmount(ana, '$4.50')
  await ana.getByRole('button', { name: 'Approve' }).click()

  // 7. Bruno's screen shows "Paid" without a reload; the sale is in his list with the fee and the net.
  await expect(bruno.getByText('Paid', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect(ana.getByText('Paid', { exact: true }).first()).toBeVisible({ timeout: 60_000 })

  // 8. Ana's activity item for the coffee opens "What the ledger shows" with two hashes.
  await ana.goto('/app/activity')
  await ana.getByText('Caffè Bruno').first().click()
  await expect(ana.getByText('What the ledger shows').first()).toBeVisible()
  await ana.getByRole('button', { name: 'Everyone else' }).or(ana.getByRole('tab', { name: 'Everyone else' })).click()
  await expect(ana.getByText('Zecca pool').first()).toBeVisible()
  await expect(ana.locator('a[href*="xrpl.org/transactions/"]')).toHaveCount(2, { timeout: 90_000 })

  // 9. Ana buys in the demo shop with "Pay with Zecca"; the shop shows "Order confirmed".
  await ana.goto('/demo/shop')
  await expect(ana.getByText('Demo shop. Nothing is shipped, nothing is charged.').first()).toBeVisible()
  await ana.getByRole('button', { name: 'Add to basket' }).first().click()
  await ana.getByRole('link', { name: 'Go to basket' }).first().click()
  await ana.getByRole('button', { name: 'Checkout' }).click()
  await ana.getByRole('link', { name: /^Pay \$[\d.,]+ with Zecca$|Or pay in this browser/ }).first().click()
  await ana.getByRole('button', { name: 'Approve' }).click()
  await expect(ana.getByText('Paid', { exact: true }).first()).toBeVisible({ timeout: 90_000 })
  await ana.getByRole('link', { name: /^Back to/ }).or(ana.getByRole('button', { name: /^Back to/ })).first().click()
  await expect(ana.getByText('Order confirmed').first()).toBeVisible({ timeout: 90_000 })

  // 10. A tier-0 user tries to send $60 and gets the limit screen.
  await ana.goto('/app/send')
  await ana.getByLabel(/^to$/i).fill(`carla${RUN}`)
  await ana.getByText('Carla Rossi').first().click()
  for (const k of ['6', '0']) await ana.getByRole('button', { name: k, exact: true }).click()
  await ana.getByRole('button', { name: /continue|next|review/i }).click()
  await expect(ana.getByText("You've reached the limit for unverified accounts.").first()).toBeVisible({ timeout: 30_000 })

  // The dock's More screen lists what is on, and signs out.
  await ana.goto('/app/more')
  await expect(ana.getByRole('link', { name: /Activity/ }).first()).toBeVisible()
  await expect(ana.getByRole('link', { name: /How Zecca works/ }).first()).toBeVisible()
  await expect(ana.getByRole('button', { name: 'Sign out' }).filter({ hasText: 'Sign out' })).toBeVisible()
})
