// The landing and how-it-works copy: final strings from UI.md §5.1, Zecca's earnings from SPEC §4.13 (fees read from the
// shared defaults), and SPEC §11 ("What Zecca must not claim") checked over every string the two pages show.
import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '@zecca/contracts'
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

describe('landing copy (UI §5.1, final)', () => {
  it('hero', () => {
    expect(copy.HERO.title).toBe('Money that moves like a message. Private by default.')
    expect(copy.HERO.sub).toBe('Sign in with an email. Pay with a tap. Your balance stays between you and the people you pay.')
    expect(copy.HERO.actions).toEqual([
      { label: 'Open the app', href: '/app' },
      { label: "I'm a merchant", href: '/merchant' },
    ])
  })
  it('three facts', () => {
    expect(copy.FACTS.map((f) => `${f.title} ${f.body}`)).toEqual([
      'No seed phrase. Your key is created when you sign in, and only you can use it.',
      'No network fees. Zecca sponsors every transaction.',
      'Hidden amounts. The public ledger sees that a payment happened, not how much.',
    ])
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
  it('footer', () => {
    expect(copy.FOOTER_LINE).toBe('Running on XRPL Devnet and Testnet. Built at the Italian XRPL Hackathon 2026.')
  })
})

describe('how it works (SPEC §2.1, §2.6, §11)', () => {
  it('names the network of every step', () => {
    const steps = copy.NETWORK_ROWS.map((r) => r.step)
    for (const s of ['Sign up', 'Send and pay', 'Top up', 'Earn']) expect(steps).toContain(s)
    for (const r of copy.NETWORK_ROWS) expect(r.network.length).toBeGreaterThan(0)
    expect(copy.NETWORK_ROWS.find((r) => r.step === 'Top up')!.network).toMatch(/Testnet/)
    expect(copy.NETWORK_ROWS.find((r) => r.step === 'Send and pay')!.network).toMatch(/Devnet/)
    expect(copy.NETWORK_ROWS.find((r) => r.step === 'Earn')!.network).toMatch(/Flare/)
  })
  it('states every honest limit of SPEC §11, including the timing one word for word', () => {
    const limits = strings(copy.LIMITS).join(' ')
    expect(limits).toContain('Timing can link a deposit to its payout.')
    expect(limits).toMatch(/not non-custodial/i)
    expect(limits).toMatch(/not anonymous/i)
    expect(limits).toMatch(/Devnet and Testnet only/i)
    expect(limits).toMatch(/not authorised under MiCA/i)
    expect(limits).toMatch(/paid in XRP and (it )?varies/i)
  })
  it('links each proof to the explorer of its network', () => {
    expect(copy.PROOFS.length).toBeGreaterThanOrEqual(3)
    for (const p of copy.PROOFS) {
      expect(p.hash).toMatch(/^[0-9A-F]{64}$/)
      expect(copy.explorerTx(p.network, p.hash)).toBe(`https://${p.network}.xrpl.org/transactions/${p.hash}`)
    }
  })
})

describe('SPEC §11: no claim beyond what is true today', () => {
  // The limits section states these on purpose, as negations; everything else must not make the claim at all.
  const { LIMITS, ...rest } = copy
  const shown = strings(rest).join('\n')
  it.each([
    ['non-custodial', /non-?custodial/i],
    ['anonymous', /anonym/i],
    ['Mainnet', /main ?net/i],
    ['available in Europe', /available in (the )?(EU|Europe)/i],
    ['a fixed yield', /\b(APY|APR)\b|\d+(\.\d+)?% (a|per) year|guaranteed/i],
  ])('never claims %s', (_, re) => {
    expect(shown).not.toMatch(re)
  })
  it('uses no blockchain words outside the ledger explanations', () => {
    const { BUILDING_BLOCKS, NETWORK_ROWS, PROOFS, POOL_MODEL, FACTS, ...plain } = rest
    const text = strings(plain).join('\n') + '\n' + strings(FACTS.map((f) => f.body)).join('\n')
    // "XRP Ledger" names the network (UI §5.1); XRP the coin is not mentioned.
    expect(text).not.toMatch(/\b(seed|gas|trust ?line|wallet address)\b|\bXRP\b(?! Ledger)/i)
    expect(LIMITS).toBeDefined()
  })
  it('scopes "no smart contracts" to payments (Earn uses a Flare smart account) and keeps the building blocks plain', () => {
    expect(copy.LEDGER.intro).toMatch(/^Payments use no sidechain and no smart contracts/)
    const blocks = strings(copy.BUILDING_BLOCKS.map((b) => b.body)).join('\n')
    expect(blocks).not.toMatch(/\bXRP\b(?! Ledger)|\breserve\b/i)
    const signUp = copy.NETWORK_ROWS.find((r) => r.step === 'Sign up')?.what ?? ''
    expect(signUp).not.toMatch(/\bdrop\b|\bXRP\b|\bbatch\b/i)
  })
})
