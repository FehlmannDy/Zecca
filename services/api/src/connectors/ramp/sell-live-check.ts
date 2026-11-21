// Live check of MoonPay SELL (sandbox) with the withdrawal's own pieces: the signed sell widget (moonpay.ts), the deposit
// checks (sell.ts) and the Testnet treasury payer (treasury.ts), on a throwaway faucet-funded treasury (never the key store).
// A page on 127.0.0.1 loads MoonPay's web SDK (flow sell, overlay); onInitiateDeposit posts MoonPay's props here, we re-read the
// sale from MoonPay, pay its deposit wallet from the treasury and answer { depositId }, then follow the sale's status.
// MoonPay's email sign-in sits behind hCaptcha and refused a disposable inbox from an automated browser (DECISIONS), so the
// full run is a human step: open the printed URL in a normal browser on this machine (same public IP as the signature).
// Run from zecca/ (unsandboxed): node --env-file=.env -r ./scripts/dev/dnsfix.cjs node_modules/tsx/dist/cli.mjs services/api/src/connectors/ramp/sell-live-check.ts [--smoke] [--usd=60] [--port=3111]
//   --smoke: opens the page in headless Chromium, checks MoonPay accepted the signature and shows the sale, and exits.
//   --usd: the sale in whole dollars (default 60); --port: the local page's port (default 3111).
// Keys come from the environment and are never printed (nor is a signed URL).
import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { createMemoryKeyStore } from '@zecca/keystore'
import { fund, generateWalletSecret } from '@zecca/xrpl-core'
import { createMoonPayApi, ipHash, signQuery } from './moonpay'
import { checkSellTx, debitMinor, paymentAmount, resolveDestination } from './sell'
import { createLiveTreasuryPayer } from './treasury'

const smoke = process.argv.includes('--smoke')
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))
const keys = { publishableKey: process.env.MOONPAY_PUBLISHABLE_KEY ?? '', secretKey: process.env.MOONPAY_SECRET_KEY ?? '' }
if (!keys.publishableKey || !keys.secretKey) throw new Error('MOONPAY_PUBLISHABLE_KEY / MOONPAY_SECRET_KEY are not set')
const api = createMoonPayApi({ publishableKey: keys.publishableKey })

const secret = generateWalletSecret('ed25519')
const keystore = createMemoryKeyStore()
keystore.setWallet('testnetTreasury', secret)
const payer = createLiveTreasuryPayer({ keystore, log: (m) => log(m) })
log(`throwaway Testnet treasury ${secret.address}: asking the faucet`)
await fund(secret.address, 'testnet')
for (let i = 0; i < 20 && !(await payer.client.accountInfo(secret.address)); i++) await new Promise((r) => setTimeout(r, 2000))

const where = await api.ipCountry(undefined) // MoonPay sees this machine's public IP, which a browser on it shares
if (where.status !== 200) throw new Error(`MoonPay ip_address: ${where.status}`)
log('MoonPay sees', { country: where.body.alpha2, isSellAllowed: where.body.isSellAllowed })
// The treasury only holds faucet XRP: sell XRP (MoonPay's XRP minimum is 21.77 XRP).
const currencyCode = 'xrp'
const externalId = `ramp_check_${Date.now()}`
const params: Record<string, string> = {
  apiKey: keys.publishableKey,
  baseCurrencyCode: currencyCode,
  quoteCurrencyCode: 'usd',
  quoteCurrencyAmount: flag('usd') ?? '60',
  refundWalletAddress: secret.address,
  paymentMethod: 'credit_debit_card',
  externalCustomerId: 'usr_live_check',
  externalTransactionId: externalId,
  allowedIpAddress: ipHash(keys.secretKey, where.body.ipAddress),
}

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Zecca sell check</title>
<body style="font:15px system-ui;padding:24px"><button id="open" style="font-size:16px;padding:10px 16px">Open MoonPay (sell, sandbox)</button><pre id="out"></pre>
<script src="https://static.moonpay.com/web-sdk/v1/moonpay-web-sdk.min.js"></script><script>
const out = (m) => (document.getElementById('out').textContent += m + '\\n')
const post = async (p, b) => (await fetch(p, { method: 'POST', body: JSON.stringify(b) })).json()
document.getElementById('open').onclick = async () => {
  const w = window.MoonPayWebSdk.init({ flow: 'sell', environment: 'sandbox', variant: 'overlay', params: await (await fetch('/params')).json(), handlers: {
    onInitiateDeposit: async (props) => { out('onInitiateDeposit ' + JSON.stringify(props)); const r = await post('/deposit', props); out('deposit ' + JSON.stringify(r)); if (!r.depositId) throw new Error(r.error); return { depositId: r.depositId } },
    onUnsupportedRegion: async () => out('unsupported region'),
    onClose: async () => out('closed'),
  }})
  w.updateSignature((await post('/sign', { url: w.generateUrlForSigning() })).signature)
  w.show()
}
</script>`

const readBody = (r: IncomingMessage) => new Promise<string>((res) => {
  let s = ''
  r.on('data', (c) => (s += c))
  r.on('end', () => res(s))
})

async function deposit(props: Record<string, any>): Promise<{ depositId?: string; error?: string }> {
  log('onInitiateDeposit props', props)
  const sale = await api.getSellTransaction(String(props.transactionId))
  log('MoonPay sale', { status: sale.status, fields: sale.body && typeof sale.body === 'object' ? Object.keys(sale.body) : sale.body, depositWallet: sale.body?.depositWallet ?? null })
  const chk = checkSellTx(sale.body, { transactionId: String(props.transactionId), externalId, currencyCode })
  if (!chk.ok) return { error: chk.reason }
  const dest = resolveDestination({ moonpay: { address: chk.depositAddress, tag: chk.depositTag }, widget: { address: props.depositWalletAddress, tag: props.depositWalletAddressTag } }, secret.address)
  log('sale', { status: chk.status, amount: `${chk.cryptoAmount} ${chk.currency}`, usdRate: chk.usdRate, debitMinor: debitMinor(chk.currency, chk.cryptoAmount, chk.usdRate), destination: dest })
  if (!dest.ok) return { error: dest.reason }
  const r = await payer.pay({ destination: dest.address, tag: dest.tag, amount: paymentAmount(chk.currency, chk.cryptoAmount) }, (s) => log('treasury payment signed', s))
  log('treasury payment', { validated: r.validated, engineResult: r.engineResult, hash: r.hash })
  if (!r.validated) return { error: r.engineResult }
  void follow(String(props.transactionId))
  return { depositId: r.hash }
}

/** Prints the sale's status changes until MoonPay completes or fails it (or 30 minutes pass). */
async function follow(id: string): Promise<void> {
  let last = ''
  for (let i = 0; i < 120; i++) {
    const s = await api.getSellTransaction(id).catch(() => null)
    const now = `${s?.body?.status} ${s?.body?.failureReason ?? ''} depositHash=${s?.body?.depositHash ?? ''}`
    if (now !== last) log('MoonPay sale status', (last = now))
    if (s?.body?.status === 'completed' || s?.body?.status === 'failed') return
    await new Promise((r) => setTimeout(r, 15_000))
  }
}

let signatureOk: boolean | undefined
const server = createServer(async (rq, rs) => {
  try {
    if (rq.url === '/') return void rs.writeHead(200, { 'content-type': 'text/html' }).end(page)
    if (rq.url === '/params') return void rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(params))
    if (rq.url === '/sign') {
      const url = new URL(JSON.parse(await readBody(rq)).url)
      if (url.hostname !== 'sell-sandbox.moonpay.com' || url.searchParams.get('externalTransactionId') !== externalId) return void rs.writeHead(400).end('{}')
      url.searchParams.delete('signature')
      return void rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ signature: signQuery(keys.secretKey, url.search) }))
    }
    if (rq.url === '/deposit') return void rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await deposit(JSON.parse(await readBody(rq)))))
    rs.writeHead(404).end()
  } catch (e) {
    log('error', (e as Error).message)
    rs.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }))
  }
})
const port = Number(flag('port') ?? 3111)
await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
log(`open http://127.0.0.1:${port}/ in a browser on this machine, press the button and sell with a real inbox (sandbox KYC: UK address; payout card 4000 0209 5159 5032)`)

if (smoke) {
  const { chromium } = createRequire(import.meta.url)('playwright-core')
  const browser = await chromium.launch({ headless: true })
  const p = await browser.newPage()
  p.on('response', (r: any) => {
    if (r.url().includes('/v3/verify_widget_signature')) signatureOk = r.status() < 400
  })
  await p.goto(`http://127.0.0.1:${port}/`)
  await p.click('#open')
  const frame = p.frameLocator('iframe[src*="moonpay"]').first()
  await frame.getByText(/Sell crypto/i).first().waitFor({ timeout: 30_000 })
  const text = (await frame.locator('body').innerText()).replace(/\s+/g, ' ')
  log('smoke', { signatureAccepted: signatureOk, quote: /\$ ?\d+.*?(\d+\.\d+ XRP)/.exec(text)?.[1] ?? null, testMode: /Test Mode/.test(text) })
  await browser.close()
  server.close()
  await payer.client.close()
  if (signatureOk !== true) process.exit(1)
}
