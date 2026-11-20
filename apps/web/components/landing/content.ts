// Copy for the landing page (/) and /how-it-works. UI.md §5.1 is final copy; the earnings come from SPEC §4.13 with the
// fees read from the shared defaults; the limits are SPEC §11, word for word where it gives the words.
// content.test.ts checks every string here against SPEC §11 ("What Zecca must not claim").
import { DEFAULTS } from '@zecca/contracts'

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
  title: 'Money that moves like a message. Private by default.',
  sub: 'Sign in with an email. Pay with a tap. Your balance stays between you and the people you pay.',
  actions: [
    { label: 'Open the app', href: '/app' },
    { label: "I'm a merchant", href: '/merchant' },
  ],
  /** The two views of one payment, beside the hero. */
  views: {
    you: { label: 'You see', name: 'Caffè Bruno', note: 'Flat white and a cornetto', amountMinor: 450, status: 'Paid' },
    others: { label: 'Everyone else sees', from: 'An address', to: 'Zecca pool', amount: 'Sealed' },
  },
} as const

export type FactIcon = 'key' | 'sponsor' | 'sealed'
export const FACTS: readonly { icon: FactIcon; title: string; body: string }[] = [
  { icon: 'key', title: 'No seed phrase.', body: 'Your key is created when you sign in, and only you can use it.' },
  { icon: 'sponsor', title: 'No network fees.', body: 'Zecca sponsors every transaction.' },
  { icon: 'sealed', title: 'Hidden amounts.', body: 'The public ledger sees that a payment happened, not how much.' },
]

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
      body: 'Your app seals the amount and you sign the payment with your own key.',
      observer: { addresses: 'Your address and the pool: visible', amount: 'Amount: sealed' },
    },
    {
      step: '2',
      title: 'The pool pays the merchant',
      body: `Zecca opens the amount, checks it, and the merchant sees "Paid" about 10 seconds after you approve. The payout, minus the ${percentFromBps(DEFAULTS.MERCHANT_FEE_BPS)} merchant fee, follows in the background.`,
      observer: { addresses: 'The pool and the merchant: visible', amount: 'Amount: sealed' },
    },
  ],
  outcome: 'Someone watching sees two separate payments, one into the pool and one out of it. Never one from you to the merchant, and never an amount.',
  caveat: 'Close timing can still link the two.',
} as const

export type BlockIcon = 'sponsor' | 'sealed' | 'batch' | 'credential'
export const LEDGER = {
  title: 'Built on the XRP Ledger, layer 1',
  intro: 'No sidechain and no smart contracts. Four features of the ledger itself do the work.',
} as const
export const BUILDING_BLOCKS: readonly { icon: BlockIcon; title: string; body: string; network: string }[] = [
  {
    icon: 'sponsor',
    title: 'Sponsored accounts',
    body: 'Zecca opens your account and pays its fees and reserve, so you never need to hold XRP.',
    network: 'Live on XRPL Devnet',
  },
  {
    icon: 'sealed',
    title: 'Confidential tokens',
    body: 'Your dollars are a token whose balances and transfers are encrypted on the ledger, with proofs that every amount adds up.',
    network: 'Live on XRPL Devnet. Top-ups arrive as RLUSD on XRPL Testnet.',
  },
  {
    icon: 'batch',
    title: 'Batched transactions',
    body: 'Signing up is one approval: opening the account, the private balance and the demo credit go through together, or not at all.',
    network: 'Live on XRPL Devnet',
  },
  {
    icon: 'credential',
    title: 'Credentials',
    body: 'A verified identity becomes a credential on your account that raises your limits. Your personal data stays off the ledger.',
    network: 'Tested on XRPL Devnet',
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

export type Feature = 'card' | 'earn' | 'market' | 'identity'
/** SPEC §2.1: which network each step runs on. `feature` rows show whether that feature is switched on right now. */
export const NETWORK_ROWS: readonly { step: string; network: string; what: string; feature?: Feature }[] = [
  {
    step: 'Sign up',
    network: 'XRPL Devnet',
    what: 'Zecca’s sponsor opens your account with one drop of XRP. One approval then opens your private balance and adds the demo credit, in one batch.',
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

/** SPEC §11. */
export const LIMITS = {
  title: 'What Zecca does not claim',
  items: [
    { title: 'Not non-custodial.', body: 'The key that signs your payments is yours, through Privy. The key that reads your amounts is held by Zecca.' },
    { title: 'Not anonymous.', body: 'Addresses are public, amounts are hidden, and Zecca knows its customers.' },
    { title: 'Devnet and Testnet only.', body: 'Sponsored accounts and confidential transfers are not on the XRP Ledger Mainnet yet.' },
    { title: 'RLUSD is not authorised under MiCA in the EU today.', body: 'MoonPay’s widget says so itself.' },
    { title: 'Earn has no fixed rate.', body: 'The yield comes from Firelight on Flare, is paid in XRP and varies.' },
    { title: 'Timing can link a deposit to its payout.', body: 'A payout that follows its deposit by seconds can be guessed from timing.' },
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
