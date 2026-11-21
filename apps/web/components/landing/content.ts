// Copy for the landing page (/) and /how-it-works. The landing leads with the product (hero, then the eight features),
// then privacy, the pool, the ledger and the earnings (SPEC §4.13, fees read from the shared defaults).
// Every number shown comes from the defaults or the demo's own data. content.test.ts checks every string here against
// SPEC §11 ("What Zecca must not claim").
import { DEFAULTS, formatUsd, type FeatureName } from '@zecca/contracts'
import { marketAssets, shopItems } from '@zecca/contracts/fixtures'
import { TOPUP_CHIPS } from '../topup/topup'

/** 50 -> "0.5%". Integer arithmetic only. */
export function percentFromBps(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new TypeError(`bps must be a whole, non-negative number, got ${bps}`)
  const whole = Math.floor(bps / 100)
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''}%`
}

export type Network = 'devnet' | 'testnet'
export const explorerTx = (network: Network, hash: string) => `https://${network}.xrpl.org/transactions/${hash}`
export const explorerAccount = (network: Network, address: string) => `https://${network}.xrpl.org/accounts/${address}`

export const REPO_URL = 'https://github.com/FehlmannDy/Zecca'
/** The pool every payment goes through (SPEC §2.2). Public on the ledger by design. */
export const POOL_ADDRESS = 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ'

export const HERO = {
  title: 'Pay, spend, earn and own gold. One app, on the XRP Ledger.',
  sub: 'Sign in with an email and you are ready. No seed phrase, no network fees, and the amounts you move stay hidden on the public ledger.',
  actions: [
    { label: 'Open the app', href: '/app' },
    { label: "I'm a merchant", href: '/merchant' },
  ],
} as const

/** The coffee of UI.md's voice line ("Paid. $4.50 to Caffè Bruno."), used by the phone and the privacy section. */
export const COFFEE = { name: 'Caffè Bruno', initials: 'CB', note: 'Flat white and a cornetto', amountMinor: 450 } as const

/** The Zecca home drawn in the hero: the welcome credit, one coffee, and the balance they leave. */
export const PHONE = {
  holder: 'Ana Ferri',
  initials: 'AF',
  balanceMinor: DEFAULTS.WELCOME_CREDIT_MINOR - COFFEE.amountMinor,
  actions: ['Send', 'Pay', 'Top up', 'Request'],
  /** UI.md §5.10's card ending. */
  card: { title: 'Card', last4: '4417', action: 'Load' },
  earn: { title: 'Earn', note: 'Firelight vault on Flare', rate: 'Variable rate' },
  activity: [
    { name: COFFEE.name, note: COFFEE.note, amountMinor: COFFEE.amountMinor, direction: 'out' },
    { name: 'Demo credit', note: 'Welcome to Zecca', amountMinor: DEFAULTS.WELCOME_CREDIT_MINOR, direction: 'in' },
  ],
  dock: ['Home', 'Pay', 'Card', 'More'],
  toast: `Paid. ${formatUsd(COFFEE.amountMinor)} to ${COFFEE.name}.`,
} as const

/** A flag of GET /v1/config. The pages mark a feature whose flag is off. */
export type Feature = FeatureName
export type FeatureKey = 'card' | 'earn' | 'metals' | 'tap' | 'faceid' | 'identity' | 'proofs' | 'topup'
export type FeatureItem = { key: FeatureKey; flag?: Feature; title: string; body: string }
const FEATURE_ITEMS: readonly FeatureItem[] = [
  {
    key: 'card',
    flag: 'card',
    title: 'Virtual card',
    body: 'Load it from your balance, then check out by card in the demo shop. Every purchase is answered in milliseconds.',
  },
  {
    key: 'earn',
    flag: 'earn',
    title: 'Earn',
    body: 'Put dollars to work in the Firelight vault on Flare with one approval. The yield is paid in XRP and the rate varies.',
  },
  { key: 'metals', flag: 'market', title: 'Metals', body: 'Gold, silver and palladium by the gram, at a price published on the ledger.' },
  { key: 'tap', title: 'Tap to pay', body: 'Hold your phone to the shop’s phone, or scan its QR code. Approve, and the shop sees "Paid".' },
  { key: 'faceid', flag: 'passkey', title: 'Face ID approvals', body: 'Approve payments with Face ID or your fingerprint, through a passkey.' },
  {
    key: 'identity',
    flag: 'identity',
    title: 'Verified identity',
    body: 'Share your name and date of birth from an EU Digital Identity Wallet. A credential on your account raises your limits.',
  },
  { key: 'proofs', flag: 'proofs', title: 'Statements with proofs', body: 'Pick payments for a signed statement. Anyone can check each line on the public ledger.' },
  { key: 'topup', flag: 'ramp', title: 'Add money', body: 'Top up with MoonPay, by card or bank transfer. The money lands in your balance.' },
]
export const FEATURES = {
  title: 'One balance for everything you do with money.',
  intro: 'Everything runs from the same balance, and nothing moves until you approve it.',
  items: FEATURE_ITEMS,
} as const

const metal = (symbol: 'XAU' | 'XAG' | 'XPD', short: string) => {
  const a = marketAssets.find((m) => m.symbol === symbol)!
  return { symbol, short, name: a.name, history: a.history ?? [] }
}
/** What the small pictures show, from the demo's own data. */
export const FEATURE_ART = {
  receipt: { shop: 'Sette Archi', item: shopItems[0].name, amountMinor: shopItems[0].priceMinor, status: 'Approved' },
  earn: { source: 'Firelight on Flare', rate: 'Variable rate' },
  metals: [metal('XAU', 'Au'), metal('XAG', 'Ag'), metal('XPD', 'Pd')],
  metalsNote: { unit: 'Per gram', source: 'Price on the ledger' },
  tap: { done: 'Paid', or: 'Or scan the QR code' },
  faceid: { action: 'Approve with Face ID' },
  identity: { source: 'EU Digital Identity Wallet', status: 'Verified', fields: ['Name', 'Date of birth'], result: 'Limits raised' },
  statement: { title: 'Statement', check: 'Checked on the ledger' },
  topupChips: [...TOPUP_CHIPS] as number[],
  topup: { action: 'Continue with MoonPay', methods: ['Card', 'Bank transfer'] },
} as const

export const PRIVACY = {
  title: 'Private by default.',
  intro: 'The ledger is public. Your amounts are not. Here is one coffee, seen from both sides.',
  you: { label: 'You see', from: 'You', ...COFFEE, status: 'Paid' },
  others: { label: 'Everyone else sees', from: 'An address', to: 'Zecca pool', amount: 'Sealed' },
} as const

/** A sealed amount drawn as a block of hex: `lines` lines of `groups` groups of four. Deterministic (same on the
 *  server and in the browser), and only a picture: it is not the real ciphertext of anything. */
export function sealedHex(seed: number, lines: number, groups: number): string[] {
  let x = (seed * 2654435761) >>> 0 || 1
  const next = () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x
  }
  return Array.from({ length: lines }, () =>
    Array.from({ length: groups }, () => (next() & 0xffff).toString(16).toUpperCase().padStart(4, '0')).join(' '),
  )
}

export const PAYMENT = {
  title: 'How a payment works',
  intro: 'Every payment goes through the Zecca pool. Nobody outside Zecca can read the amount at any step.',
  nodes: [
    { id: 'you', label: 'You', caption: 'Approve with one tap' },
    { id: 'pool', label: 'Zecca pool', caption: 'Checks the amount' },
    { id: 'merchant', label: 'Merchant', caption: 'Sees "Paid"' },
  ],
  hops: [
    {
      step: '1',
      title: 'You pay the pool',
      body: 'Zecca seals the amount, and you approve and sign the payment with your own key.',
      observer: { addresses: 'Your address and the pool: visible', amount: 'Sealed' },
    },
    {
      step: '2',
      title: 'The pool pays the merchant',
      body: `Zecca opens the amount, checks it, and the merchant sees "Paid" about 10 seconds after you approve. The payout, minus the ${percentFromBps(DEFAULTS.MERCHANT_FEE_BPS)} merchant fee, follows in the background.`,
      observer: { addresses: 'The pool and the merchant: visible', amount: 'Sealed' },
    },
  ],
  outcome: 'Someone watching sees two separate payments, one into the pool and one out of it. Never one from you to the merchant, and never an amount.',
} as const

export type BlockIcon = 'sponsor' | 'sealed' | 'batch' | 'credential'
export const LEDGER = {
  title: 'Built on the XRP Ledger, layer 1',
  intro: 'Payments use no sidechain and no smart contracts: four features of the ledger itself do the work.',
} as const
export const BUILDING_BLOCKS: readonly { icon: BlockIcon; title: string; body: string; networks: readonly string[] }[] = [
  {
    icon: 'sponsor',
    title: 'Sponsored accounts',
    body: 'Zecca opens your account and pays every ledger cost, so you never need to buy anything to start.',
    networks: ['Live on XRPL Devnet'],
  },
  {
    icon: 'sealed',
    title: 'Confidential tokens',
    body: 'Your dollars are a token whose balances and transfers are encrypted on the ledger, with proofs that every amount adds up.',
    networks: ['Live on XRPL Devnet', 'Top-up on XRPL Testnet'],
  },
  {
    icon: 'batch',
    title: 'Batched transactions',
    body: 'Signing up is one approval: opening the account, the private balance and the demo credit go through together, or not at all.',
    networks: ['Live on XRPL Devnet'],
  },
  {
    icon: 'credential',
    title: 'Credentials',
    body: 'A verified identity becomes a credential on your account that raises your limits. Your personal data stays off the ledger.',
    networks: ['Tested on XRPL Devnet'],
  },
]

export const EARNINGS = {
  title: 'Where Zecca earns',
  note: 'Sending and paying stay free. Every fee is shown to the person who pays it, before they approve.',
  live: [
    { title: 'Merchant fee', body: `${percentFromBps(DEFAULTS.MERCHANT_FEE_BPS)} per sale, taken when the merchant is paid out. No monthly fee.` },
    { title: 'Metals spread', body: `${percentFromBps(DEFAULTS.MARKET_SPREAD_BPS)}, built into the quoted price of gold, silver and palladium.` },
    {
      title: 'Share of Earn yield',
      body: `Zecca keeps ${percentFromBps(DEFAULTS.EARN_FEE_BPS)} of what you earn, plus ${percentFromBps(DEFAULTS.EARN_SWAP_BPS)} on each conversion in and out.`,
    },
  ],
  planned: [
    { title: 'Card interchange', body: 'Paid by the card network on every card purchase, not by you.' },
    { title: 'Currency conversion', body: 'A margin on transfers that change currency. Zecca is dollars only today.' },
    { title: 'Paid plan', body: 'Higher limits, a physical card and priority support.' },
  ],
} as const

export const FOOTER_LINE = 'Running on XRPL Devnet and Testnet. Built at the Italian XRPL Hackathon 2026.'

// ---- /how-it-works ----

export const HOW = {
  title: 'How Zecca works',
  intro:
    'Zecca is a payment account on the XRP Ledger. The public ledger sees that an account exists and that it pays; it does not see how much it holds or how much moves. Zecca does see amounts, like any payment company sees its customers’ payments.',
} as const

/** SPEC §2.1: which network each step runs on. `feature` rows show whether that feature is switched on right now. */
export const NETWORK_ROWS: readonly { step: string; network: string; what: string; feature?: Feature }[] = [
  {
    step: 'Sign up',
    network: 'XRPL Devnet',
    what: 'Zecca’s sponsor opens your account and pays for it. One approval then opens your private balance and adds the demo credit, both at once.',
  },
  {
    step: 'Send and pay',
    network: 'XRPL Devnet',
    what: 'Two confidential transfers through the Zecca pool: you to the pool, then the pool to the person or shop you paid. Fees are sponsored.',
  },
  {
    step: 'Top up',
    network: 'MoonPay sandbox, XRPL Testnet, then XRPL Devnet',
    what: 'MoonPay delivers RLUSD to Zecca’s account on Testnet. Zecca credits the same amount, as delivered, to your balance on Devnet. That crossing is done in Zecca’s books.',
  },
  {
    step: 'Card',
    network: 'Lithic sandbox, funded on XRPL Devnet',
    what: 'You move money to your card balance through the pool once; every purchase is then approved instantly from that balance.',
    feature: 'card',
  },
  {
    step: 'Earn',
    network: 'XRPL Testnet and Flare Coston2',
    what: 'One payment on Testnet opens a Flare smart account, mints FXRP and deposits it in the Firelight vault.',
    feature: 'earn',
  },
  {
    step: 'Metals',
    network: 'XRPL Devnet',
    what: 'Gold, silver and palladium as tokens, bought and sold through the pool at a quoted price.',
    feature: 'market',
  },
  {
    step: 'Identity',
    network: 'EU reference verifier, credential on XRPL Devnet',
    what: 'You share your name and date of birth from an EU Digital Identity Wallet; Zecca records a credential that raises your limits.',
    feature: 'identity',
  },
]

export const POOL_MODEL = {
  title: 'The pool',
  points: [
    'Every payment is two confidential transfers: the payer to the Zecca pool, then the pool to the recipient. Addresses are public on the ledger; amounts are not.',
    'Which deposit pays which recipient lives only in Zecca’s database. No memo, tag or field on the ledger links the two.',
    'The pool opens each deposit with its own key and checks the amount before anything is credited. A deposit is credited once.',
    `"Paid" shows as soon as the deposit is validated, about 10 seconds. The payout follows in the background, minus any fee, which Zecca keeps in its own books (${percentFromBps(DEFAULTS.MERCHANT_FEE_BPS)} for merchants, nothing between people).`,
    'You sign every payment with your own key. Zecca’s sponsor co-signs only transactions Zecca prepared itself, once each.',
  ],
} as const

/** Public transactions from the test runs of 20 November 2026 (HANDOFF §0). */
export const PROOFS: readonly { label: string; network: Network; hash: string }[] = [
  { label: 'Account opened by the sponsor with one drop', network: 'devnet', hash: 'C42255597710602E16C35FF416082D506C96598377F4210D5E42E847119740EC' },
  { label: 'One-approval sign-up batch', network: 'devnet', hash: 'C8594C5337AC38A74A7E3EBCF8333706372667453307E25DFAFA1C8E6ADCAB55' },
  { label: 'Confidential payment to the pool, fee sponsored', network: 'devnet', hash: 'D1DAE5A97DDCA1590AE6E3E489378AA7EAEDD44500DD7B0E76670CA135A83777' },
  { label: 'MoonPay sandbox top-up delivered as RLUSD', network: 'testnet', hash: '548D695E91F1F48720D64F0380C084DE3E0A6A4F97CA1599B79324FB5A1F8939' },
  { label: 'One payment into the Firelight vault on Flare', network: 'testnet', hash: 'B53177C7D31A4CC4F786824150F72A4EFE206DC7818989E98CC80A74E71B5307' },
]
