// The landing and how-it-works copy: the product first (hero, the eight features), then privacy, the pool, the ledger
// and Zecca's earnings (SPEC §4.13, fees read from the shared defaults). SPEC §11 ("What Zecca must not claim") is
// checked over every string the two pages show, and no number on them is invented.
import { describe, expect, it } from 'vitest'
import { DEFAULTS, FeatureName } from '@zecca/contracts'
import { marketAssets, shopItems } from '@zecca/contracts/fixtures'
import { formatUsd } from '@zecca/contracts'
import { TOPUP_CHIPS } from '../topup/topup'
import * as copy from './content'

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []

describe('percentFromBps', () => {
  it('formats basis points with integer arithmetic and no trailing zeros', () => {
    expect(copy.percentFromBps(50)).toBe('0.5%')
    expect(copy.percentFromBps(100)).toBe('1%')
    expect(copy.percentFromBps(1000)).toBe('10%')
    expect(copy.percentFromBps(30)).toBe('0.3%')
    expect(copy.percentFromBps(5)).toBe('0.05%')
    expect(copy.percentFromBps(125)).toBe('1.25%')
  })
  it('refuses what is not a whole, non-negative number of basis points', () => {
    expect(() => copy.percentFromBps(0.5)).toThrow()
    expect(() => copy.percentFromBps(-1)).toThrow()
  })
})

describe('hero: the product first', () => {
  it('one money app on the XRP Ledger: pay, card, earn, metals', () => {
    expect(copy.HERO.title).toBe('Pay, spend, earn and own gold. One app, on the XRP Ledger.')
    expect(copy.HERO.sub).toMatch(/no seed phrase/i)
    expect(copy.HERO.sub).toMatch(/no network fees/i)
    expect(copy.HERO.sub).toMatch(/hidden on the public ledger/i)
    expect(copy.HERO.actions).toEqual([
      { label: 'Open the app', href: '/app' },
      { label: "I'm a merchant", href: '/merchant' },
    ])
  })
  it('the phone shows the welcome credit, one coffee and the balance they leave, nothing invented', () => {
    const [coffee, credit] = copy.PHONE.activity
    expect(credit.amountMinor).toBe(DEFAULTS.WELCOME_CREDIT_MINOR)
    expect(credit.direction).toBe('in')
    expect(coffee).toMatchObject({ name: copy.COFFEE.name, amountMinor: copy.COFFEE.amountMinor, direction: 'out' })
    expect(copy.PHONE.balanceMinor).toBe(DEFAULTS.WELCOME_CREDIT_MINOR - copy.COFFEE.amountMinor)
    expect(copy.PHONE.toast).toBe(`Paid. ${formatUsd(copy.COFFEE.amountMinor)} to ${copy.COFFEE.name}.`)
    // Earn on the phone names the vault and that the rate moves, never a rate.
    expect(strings(copy.PHONE.earn).join(' ')).not.toMatch(/\d/)
  })
})

describe('features: the product, in the owner’s order', () => {
  it('card, earn, metals, tap to pay, Face ID, identity, statements, add money', () => {
    expect(copy.FEATURES.items.map((f) => f.title)).toEqual([
      'Virtual card',
      'Earn',
      'Metals',
      'Tap to pay',
      'Face ID approvals',
      'Verified identity',
      'Statements with proofs',
      'Add money',
    ])
  })
  it('each flagged feature reads a real flag of GET /v1/config, so the page can mark what is switched off', () => {
    const flags = Object.fromEntries(copy.FEATURES.items.map((f) => [f.key, f.flag]))
    expect(flags).toEqual({ card: 'card', earn: 'earn', metals: 'market', tap: undefined, faceid: 'passkey', identity: 'identity', proofs: 'proofs', topup: 'ramp' })
    for (const f of copy.FEATURES.items) if (f.flag) expect(FeatureName.options).toContain(f.flag)
  })
  it('one line of benefit each, with no number in it (no rate, no invented figure)', () => {
    for (const f of copy.FEATURES.items) {
      expect(f.body.length).toBeLessThan(150)
      expect(f.body).not.toMatch(/\d/)
    }
  })
  it('says what each feature really is', () => {
    const body = (k: string) => copy.FEATURES.items.find((f) => f.key === k)!.body
    expect(body('card')).toMatch(/load it from your balance/i)
    expect(body('card')).toMatch(/demo shop/i)
    expect(body('card')).toMatch(/milliseconds/i)
    expect(body('earn')).toMatch(/Firelight/)
    expect(body('earn')).toMatch(/Flare/)
    expect(body('earn')).toMatch(/paid in XRP/)
    expect(body('earn')).toMatch(/varies/)
    expect(body('earn')).toMatch(/one approval/i)
    expect(body('metals')).toMatch(/gold, silver and palladium/i)
    expect(body('metals')).toMatch(/published on the ledger/i)
    expect(body('tap')).toMatch(/QR code/)
    expect(body('faceid')).toMatch(/passkey/i)
    expect(body('identity')).toMatch(/EU Digital Identity Wallet/)
    expect(body('identity')).toMatch(/credential/i)
    expect(body('proofs')).toMatch(/anyone can check each line on the public ledger/i)
    expect(body('topup')).toMatch(/MoonPay/)
  })
  it('the small pictures use the demo’s own data: the shop’s first item, the three metals’ history, the top-up chips', () => {
    expect(copy.FEATURE_ART.receipt).toEqual({ shop: 'Sette Archi', item: shopItems[0].name, amountMinor: shopItems[0].priceMinor, status: 'Approved' })
    expect(copy.FEATURE_ART.metals.map((m) => m.symbol)).toEqual(['XAU', 'XAG', 'XPD'])
    for (const m of copy.FEATURE_ART.metals) expect(m.history).toEqual(marketAssets.find((a) => a.symbol === m.symbol)!.history)
    expect(copy.FEATURE_ART.topupChips).toEqual([...TOPUP_CHIPS])
  })
})

describe('privacy, the pool, the ledger, the earnings', () => {
  it('one coffee seen from both sides: you see the shop and the amount, everyone else an address, the pool and a sealed amount', () => {
    expect(copy.PRIVACY.you).toMatchObject({ label: 'You see', name: 'Caffè Bruno', amountMinor: 450, status: 'Paid' })
    expect(copy.PRIVACY.others).toEqual({ label: 'Everyone else sees', from: 'An address', to: 'Zecca pool', amount: 'Sealed' })
  })
  it('the sealed amount is drawn as the same hex block on the server and in the browser', () => {
    const a = copy.sealedHex(450, 4, 8)
    expect(a).toEqual(copy.sealedHex(450, 4, 8))
    expect(a).toHaveLength(4)
    for (const line of a) expect(line).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/)
    expect(copy.sealedHex(451, 4, 8)).not.toEqual(a)
  })
  it('the payment goes you -> Zecca pool -> merchant, and every hop shows the address and seals the amount', () => {
    expect(copy.PAYMENT.nodes.map((n) => n.label)).toEqual(['You', 'Zecca pool', 'Merchant'])
    expect(copy.PAYMENT.hops).toHaveLength(2)
    for (const hop of copy.PAYMENT.hops) {
      expect(hop.observer.addresses).toMatch(/visible/i)
      expect(hop.observer.amount).toMatch(/sealed/i)
    }
  })
  it('says who seals the amount: Zecca builds the payment and its proof, you only approve and sign (SPEC §2.3, §11)', () => {
    expect(copy.PAYMENT.hops[0].body).toBe('Zecca seals the amount, and you approve and sign the payment with your own key.')
    expect(strings(copy).join('\n')).not.toMatch(/\b(your (app|phone|device)|on your (phone|device))\b[^.]*\b(seals?|encrypts?)\b/i)
  })
  it('four building blocks, each naming the network it runs on today', () => {
    expect(copy.BUILDING_BLOCKS.map((b) => b.title)).toEqual(['Sponsored accounts', 'Confidential tokens', 'Batched transactions', 'Credentials'])
    for (const b of copy.BUILDING_BLOCKS) expect(b.networks[0]).toMatch(/XRPL (Devnet|Testnet)/)
    expect(copy.BUILDING_BLOCKS.find((b) => b.title === 'Confidential tokens')!.networks.join(' ')).toMatch(/Top-up on XRPL Testnet/)
  })
  it('where Zecca earns: the first three lines of SPEC §4.13 live, the last three planned, fees from the defaults', () => {
    expect(copy.EARNINGS.live.map((e) => e.title)).toEqual(['Merchant fee', 'Metals spread', 'Share of Earn yield'])
    expect(copy.EARNINGS.planned.map((e) => e.title)).toEqual(['Card interchange', 'Currency conversion', 'Paid plan'])
    const live = strings(copy.EARNINGS.live).join(' ')
    expect(live).toContain(copy.percentFromBps(DEFAULTS.MERCHANT_FEE_BPS))
    expect(live).toContain(copy.percentFromBps(DEFAULTS.MARKET_SPREAD_BPS))
    expect(live).toContain(copy.percentFromBps(DEFAULTS.EARN_FEE_BPS))
    expect(copy.EARNINGS.note).toMatch(/free/i)
  })
  it('footer: the plain facts of where it runs', () => {
    expect(copy.FOOTER_LINE).toBe('Running on XRPL Devnet and Testnet. Built at the Italian XRPL Hackathon 2026.')
  })
})

describe('how it works (SPEC §2.1, §2.6)', () => {
  it('names the network of every step', () => {
    const steps = copy.NETWORK_ROWS.map((r) => r.step)
    for (const s of ['Sign up', 'Send and pay', 'Top up', 'Earn']) expect(steps).toContain(s)
    for (const r of copy.NETWORK_ROWS) expect(r.network.length).toBeGreaterThan(0)
    expect(copy.NETWORK_ROWS.find((r) => r.step === 'Top up')!.network).toMatch(/Testnet/)
    expect(copy.NETWORK_ROWS.find((r) => r.step === 'Send and pay')!.network).toMatch(/Devnet/)
    expect(copy.NETWORK_ROWS.find((r) => r.step === 'Earn')!.network).toMatch(/Flare/)
  })
  it('links each proof to the explorer of its network', () => {
    expect(copy.PROOFS.length).toBeGreaterThanOrEqual(3)
    for (const p of copy.PROOFS) {
      expect(p.hash).toMatch(/^[0-9A-F]{64}$/)
      expect(copy.explorerTx(p.network, p.hash)).toBe(`https://${p.network}.xrpl.org/transactions/${p.hash}`)
    }
  })
})

describe('SPEC §11: no claim beyond what is true today, and no list of negatives', () => {
  const shown = strings(copy).join('\n')
  it.each([
    ['non-custodial', /non-?custodial/i],
    ['anonymous', /anonym/i],
    ['Mainnet', /main ?net/i],
    ['available in Europe', /available in (the )?(EU|Europe)/i],
    ['a fixed yield', /\b(APY|APR)\b|\d+(\.\d+)?% (a|per) year|guaranteed/i],
  ])('never claims %s', (_, re) => {
    expect(shown).not.toMatch(re)
  })
  it('has no "what we do not claim" section: the pages say what Zecca does', () => {
    expect('LIMITS' in copy).toBe(false)
    expect(shown).not.toMatch(/(does not|don.t|do not) claim|honest limits/i)
  })
  it('uses no blockchain words outside the ledger explanations', () => {
    const { BUILDING_BLOCKS, NETWORK_ROWS, PROOFS, POOL_MODEL, FEATURES, HERO, ...plain } = copy
    // Two places say them on purpose: the hero's "no seed phrase" (the point is that there is none), and Earn, whose
    // yield is paid in XRP (SPEC §11 asks for exactly that to be said).
    const features = FEATURES.items.filter((f) => f.key !== 'earn')
    const text = [...strings(plain), ...strings(features), FEATURES.title, HERO.title, HERO.sub.replace(/no seed phrase/i, '')].join('\n')
    // "XRP Ledger" names the network (UI §5.1); XRP the coin is named only for Earn.
    expect(text).not.toMatch(/\b(seed|gas|trust ?line|wallet address)\b|\bXRP\b(?! Ledger)/i)
    expect(strings(BUILDING_BLOCKS).length + strings(NETWORK_ROWS).length + strings(PROOFS).length + strings(POOL_MODEL).length).toBeGreaterThan(0)
  })
  it('scopes "no smart contracts" to payments (Earn uses a Flare smart account) and keeps the building blocks plain', () => {
    expect(copy.LEDGER.intro).toMatch(/^Payments use no sidechain and no smart contracts/)
    const blocks = strings(copy.BUILDING_BLOCKS.map((b) => b.body)).join('\n')
    expect(blocks).not.toMatch(/\bXRP\b(?! Ledger)|\breserve\b/i)
    const signUp = copy.NETWORK_ROWS.find((r) => r.step === 'Sign up')?.what ?? ''
    expect(signUp).not.toMatch(/\bdrop\b|\bXRP\b|\bbatch\b/i)
  })
})
