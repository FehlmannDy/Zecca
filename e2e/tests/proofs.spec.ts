// E2E-2, proofs (SPEC §9): export a statement and open it. Mock signer. Skipped while FEATURE_PROOFS is off on the API.
import { expect, test, type Page } from '@playwright/test'

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
  await page.getByLabel(/your name|display name/i).fill(opts.name)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText("One approval and you're in.")).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  // Sign-up ends on a "You're set" screen or goes straight home, depending on where it started.
  const goHome = page.getByRole('button', { name: 'Go to home' }).or(page.getByRole('link', { name: 'Go to home' }))
  await expect(goHome.or(page.getByText('Demo credit'))).toBeVisible({ timeout: 60_000 })
  if (await goHome.isVisible()) await goHome.click()
}

test('E2E-2 proofs: export a statement and open it', async ({ browser, request }) => {
  const config = await (await request.get(`${API}/v1/config`)).json()
  test.skip(!config?.features?.proofs, 'FEATURE_PROOFS is off')

  const ana = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await signUp(ana, { email: `ana-proofs-${RUN}@example.com`, handle: `anap${RUN}`, name: 'Ana Ferri' })
  await expect(ana.getByText('$50')).toBeVisible({ timeout: 30_000 })

  await ana.goto('/app/proofs')
  await expect(ana.getByRole('heading', { name: 'Statements' })).toBeVisible()
  await ana.getByRole('checkbox', { name: /^Demo credit/ }).check()
  await ana.getByRole('button', { name: /Create statement/ }).click()

  await expect(ana).toHaveURL(/\/statement\/stm_/, { timeout: 30_000 })
  const url = ana.url()
  await expect(ana.getByRole('heading', { name: 'Ana Ferri' })).toBeVisible()
  await expect(ana.getByText('Anyone can check each line on the public ledger.')).toBeVisible()
  await expect(ana.getByText('Zecca demo credit')).toBeVisible()
  await ana.getByRole('button', { name: 'Check signature' }).click()
  await expect(ana.getByText(/Signature valid/)).toBeVisible()

  // The link is public: a stranger with no session opens the same statement.
  const stranger = await (await browser.newContext()).newPage()
  await stranger.goto(url)
  await expect(stranger.getByRole('heading', { name: 'Ana Ferri' })).toBeVisible()
  await stranger.getByRole('button', { name: 'Check signature' }).click()
  await expect(stranger.getByText(/Signature valid/)).toBeVisible()
})
