// E2E-2, identity (SPEC §9): IDENTITY_MODE=mock lifts the tier; the limit line disappears; a $60 send is no longer
// refused for the per-payment cap. Needs FEATURE_IDENTITY=1 (skipped otherwise) and the mock signer.
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
  await page.getByLabel(/display name/i).fill(opts.name)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText("One approval and you're in.")).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(new RegExp(`You're set, ${opts.name.split(' ')[0]}`))).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Go to home' }).or(page.getByRole('link', { name: 'Go to home' })).click()
}

async function token(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('zecca.session')
    const t = raw ? (JSON.parse(raw) as { token?: string }).token : undefined
    if (!t) throw new Error('no session token in storage')
    return t
  })
}

async function api(page: Page, method: string, path: string, body?: unknown) {
  const r = await page.request.fetch(API + path, { method, headers: { authorization: `Bearer ${await token(page)}`, 'content-type': 'application/json' }, data: body })
  expect(r.ok(), `${method} ${path} -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return r.json()
}

async function newPhone(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  return ctx.newPage()
}

async function startSend(page: Page, handle: string, name: string, keys: string[]) {
  await page.goto('/app/send')
  await page.getByLabel(/^to$/i).fill(handle)
  await page.getByText(name).first().click()
  for (const k of keys) await page.getByRole('button', { name: k, exact: true }).click()
  await page.getByRole('button', { name: /continue|next|review/i }).click()
}

test('E2E-2 identity: mock mode lifts the tier', async ({ browser, request }) => {
  const config = await (await request.get(`${API}/v1/config`)).json()
  test.skip(!config.features?.identity, 'FEATURE_IDENTITY is off')

  const carla = await newPhone(browser)
  await signUp(carla, { email: `carla-id-${RUN}@example.com`, handle: `carlaid${RUN}`, name: 'Carla Rossi' })
  const ana = await newPhone(browser)
  await signUp(ana, { email: `ana-id-${RUN}@example.com`, handle: `anaid${RUN}`, name: 'Ana Ferri' })

  // Tier 0: the quiet limit line under the balance, and $60 is refused with the limit sheet.
  await expect(ana.getByText(/Limit \$150\. Verify to lift it\./).first()).toBeVisible({ timeout: 30_000 })
  await api(ana, 'POST', '/v1/dev/credit', { amountMinor: 4000 })
  await expect(ana.getByText('$90').first()).toBeVisible({ timeout: 60_000 })
  await startSend(ana, `carlaid${RUN}`, 'Carla Rossi', ['6', '0'])
  await expect(ana.getByText("You've reached the limit for unverified accounts.")).toBeVisible({ timeout: 30_000 })

  // The identity screen: what is shared, the test identity after ~3 s, one approval.
  await ana.goto('/app/identity')
  await expect(ana.getByText('Verify with your EU Digital Identity Wallet')).toBeVisible()
  await expect(ana.getByText('Your name and date of birth. Nothing else.')).toBeVisible()
  await ana.getByRole('button', { name: 'Continue' }).click()
  await expect(ana.getByText('Test identity', { exact: true })).toBeVisible()
  await expect(ana.getByText('12 March 1994')).toBeVisible({ timeout: 20_000 })
  await ana.getByRole('button', { name: 'Approve' }).click()
  await expect(ana.getByText('Verified. Limits raised.').first()).toBeVisible({ timeout: 60_000 })
  expect((await api(ana, 'GET', '/v1/me')).tier).toBe(1)

  // Home: the limit line is gone.
  await ana.goto('/app')
  await expect(ana.getByText('$90').first()).toBeVisible({ timeout: 30_000 })
  await expect(ana.getByText(/Verify to lift it/)).toHaveCount(0)

  // $60 now goes to review and is sent.
  await startSend(ana, `carlaid${RUN}`, 'Carla Rossi', ['6', '0'])
  await expect(ana.getByText('Send $60.00 to Carla Rossi')).toBeVisible({ timeout: 30_000 })
  await ana.getByRole('button', { name: 'Approve' }).click()
  await expect(ana.getByText(/Sent\. \$60\.00 to Carla/)).toBeVisible({ timeout: 60_000 })
})
