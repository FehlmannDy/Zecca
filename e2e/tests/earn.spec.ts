// E2E-2, Earn (SPEC §9): an earn deposit shows a position. Mock signer. Needs FEATURE_EARN=1 on the API.
// Earn is for verified accounts (tier 1): the tier is lifted through the identity screen when FEATURE_IDENTITY=1 with
// IDENTITY_MODE=mock, else (local runs only) by E2E_DATABASE_PATH, the API's SQLite file.
// With EARN_MODE=mock the position is in memory and labelled "Test position"; live, Flare takes about 3 minutes.
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
  await expect(page.getByText(new RegExp(`You're set, ${opts.name.split(' ')[0]}`))).toBeVisible({ timeout: 60_000 })
}

async function liftTier(page: Page, features: Record<string, boolean>, handle: string): Promise<boolean> {
  if (features.identity) {
    await page.goto('/app/identity')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Approve' }).click({ timeout: 60_000 })
    await expect(page.getByText('Verified. Limits raised.').first()).toBeVisible({ timeout: 60_000 })
    return true
  }
  const db = process.env.E2E_DATABASE_PATH
  if (!db) return false
  const { default: Database } = await import('better-sqlite3')
  const conn = new Database(db)
  conn.prepare('UPDATE users SET tier = 1 WHERE handle = ?').run(handle)
  conn.close()
  return true
}

test('E2E-2 earn: a deposit shows a position', async ({ browser, request }) => {
  const config = await (await request.get(`${API}/v1/config`)).json()
  test.skip(!config.features?.earn, 'FEATURE_EARN is off on the API')
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const handle = `erin${RUN}`
  await signUp(page, { email: `erin-${RUN}@example.com`, handle, name: 'Erin Galli' })

  // Tier 0: the locked state, with the way to the identity screen.
  await page.goto('/app/earn')
  await expect(page.getByText('Verify your identity to use Earn.')).toBeVisible()
  test.skip(!(await liftTier(page, config.features, handle)), 'no way to lift the tier: set FEATURE_IDENTITY=1 + IDENTITY_MODE=mock, or E2E_DATABASE_PATH')

  await page.goto('/app/earn')
  await page.reload() // the shell refreshes the stored user (tier) from GET /v1/me
  await expect(page.getByText('Nothing in Earn yet.', { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Earnings are paid in XRP and their dollar value moves with its price.')).toBeVisible()
  await expect(page.getByText('Withdrawals take a few hours.')).toBeVisible()

  await page.getByRole('button', { name: 'Add to Earn' }).first().click()
  await page.getByRole('button', { name: '$10', exact: true }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Add $10.00 to Earn').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/You get about \d+\.\d\d XRP/).first()).toBeVisible()
  await expect(page.getByText('0.3% conversion. Zecca keeps 10% of what you earn.').first()).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Added. $10.00 to Earn.').first()).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Done' }).click()

  // While Flare executes: the opening state with the arches, then the position.
  const live = (await (await request.get(`${API}/v1/health`)).json()).ledger === 'devnet'
  // (In mock mode Flare "executes" in a few seconds, so the position may already be there.)
  const withdraw = page.getByRole('button', { name: 'Withdraw' })
  await expect(page.getByText(/Converting your dollars to XRP|Opening your Earn account on Flare/).first().or(withdraw.and(page.locator(':enabled')))).toBeVisible({ timeout: 30_000 })
  await expect(withdraw).toBeEnabled({ timeout: live ? 8 * 60_000 : 90_000 })
  await expect(page.getByText(/\d+\.\d\d XRP|^XRP$/).first()).toBeVisible()
  if (!live) await expect(page.getByText('Test position').first()).toBeVisible()
  await expect(page.getByText('What the ledger shows')).toBeVisible()
})
