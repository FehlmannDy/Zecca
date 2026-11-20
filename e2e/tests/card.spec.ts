// E2E-2, card (SPEC §9): load the card, buy in the demo shop by card (approved, receipt in the app), and one declined
// (an item above the card balance). Needs FEATURE_CARD=1, DEMO_MODE=1, the Lithic sandbox key, and Lithic's ASA pointed
// at this API (services/api/src/connectors/card/cli.ts enroll). The card needs tier 1: with the identity feature on the
// test verifies the identity first; otherwise it expects an account the API already marks verified.
import { expect, test, type Page } from '@playwright/test'

const API = process.env.E2E_API_ORIGIN ?? 'http://localhost:8800'
const RUN = Date.now().toString(36).slice(-5)

async function signUp(page: Page, o: { email: string; handle: string; name: string }) {
  await page.goto('/app/signup')
  await expect(page.getByText('Welcome to Zecca')).toBeVisible({ timeout: 60_000 })
  await page.getByLabel(/email/i).fill(o.email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Pick your handle')).toBeVisible()
  await page.getByLabel(/handle/i).fill(o.handle)
  await expect(page.getByText(`@${o.handle} is yours`)).toBeVisible()
  await page.getByLabel(/your name|display name/i).fill(o.name)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText(new RegExp(`You're set, ${o.name.split(' ')[0]}`))).toBeVisible({ timeout: 60_000 })
}

const token = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('zecca.session') ?? '{}').token as string)

async function api<T = any>(page: Page, method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth) headers.authorization = `Bearer ${await token(page)}`
  const r = await page.request.fetch(API + path, { method, headers, data: body })
  expect(r.ok(), `${method} ${path} -> ${r.status()} ${await r.text()}`).toBeTruthy()
  return r.json()
}

async function payByCard(page: Page, sku: string, card: { pan: string; expMonth: number; expYear: number; cvc: string }) {
  const order = await api<{ orderId: string; amountMinor: number }>(page, 'POST', '/v1/demo/shop/orders', { items: [{ sku, qty: 1 }] }, false)
  await page.goto(`/demo/shop/checkout/${order.orderId}`)
  await expect(page.getByText('Demo shop. Nothing is shipped, nothing is charged.')).toBeVisible()
  await page.getByLabel('Card number').fill(card.pan)
  await page.getByLabel('Expiry').fill(`${String(card.expMonth).padStart(2, '0')}/${String(card.expYear % 100).padStart(2, '0')}`)
  await page.getByLabel('Security code').fill(card.cvc)
  await page.getByRole('button', { name: /^Pay \$/ }).click()
}

test('E2E-2 card: load, a purchase approved with its receipt in the app, one declined', async ({ page, request }) => {
  const config = await (await request.get(`${API}/v1/config`)).json()
  test.skip(!config.features?.card || !config.demoMode, 'needs FEATURE_CARD=1 and DEMO_MODE=1')

  await signUp(page, { email: `card-${RUN}@example.com`, handle: `card${RUN}`, name: 'Ana Ferri' })

  // The card is for verified accounts (tier 1).
  await page.goto('/app/card')
  const getCard = page.getByRole('button', { name: /Get my card/ })
  const locked = page.getByText('Verify your identity to get a card.')
  await expect(getCard.or(locked)).toBeVisible({ timeout: 30_000 })
  if (!(await getCard.isVisible())) {
    await page.waitForTimeout(1500) // the shell refreshes the user (tier) once on load
    if (!(await getCard.isVisible())) {
      test.skip(!config.features.identity, 'the account is tier 0 and identity is off')
      await page.getByRole('link', { name: 'Verify your identity' }).click()
      const approve = page.getByRole('button', { name: 'Approve' })
      await expect(page.getByText(/Verified\. Limits raised\./).or(approve)).toBeVisible({ timeout: 60_000 })
      if (await approve.isVisible()) await approve.click()
      await expect(page.getByText(/Verified\. Limits raised\./)).toBeVisible({ timeout: 60_000 })
      await page.goto('/app/card')
    }
  }

  // A virtual sandbox card.
  await getCard.click()
  await expect(page.getByText('Card balance')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Sandbox card. It works with test purchases only.')).toBeVisible()
  const last4 = ((await api(page, 'GET', '/v1/card')) as { last4: string }).last4

  // Load $20: one approval, the arches, then the card balance.
  await page.getByRole('button', { name: /Load card/ }).click()
  await page.getByRole('button', { name: '$20' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Move $20.00 to your card').first()).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Moved. $20.00 to your card.').first()).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(async () => ((await api(page, 'GET', '/v1/card')) as { balanceMinor: number }).balanceMinor, { timeout: 90_000 }).toBe(2000)

  // The card's details, as the cardholder reads them off the back of the card.
  const card = await api<{ pan: string; expMonth: number; expYear: number; cvc: string }>(page, 'GET', '/v1/card/secret')

  // Approved: $14.50 of coffee, under the card balance.
  await payByCard(page, 'guji-250', card)
  await expect(page.getByText('Order confirmed').first()).toBeVisible({ timeout: 30_000 })

  // The receipt in the app: Sette Archi, $14.50, card ending ####, Authorised then Completed.
  await page.goto('/app/card')
  const row = page.getByRole('button', { name: /Sette Archi.*(Authorised|Completed)/ }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByText(`Card ending ${last4}`)).toBeVisible()
  await expect(page.getByText('$14').first()).toBeVisible()
  await page.keyboard.press('Escape')

  // Declined: the $99 grinder is above what is left on the card.
  await payByCard(page, 'grinder', card)
  await expect(page.getByText('Card declined. Try another payment method.').first()).toBeVisible({ timeout: 30_000 })
  await page.goto('/app/card')
  await expect(page.getByText('Declined, not enough on the card').first()).toBeVisible({ timeout: 30_000 })
  expect(((await api(page, 'GET', '/v1/card')) as { balanceMinor: number }).balanceMinor).toBe(550)
})
