import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import xrpl from 'xrpl'
import { createClient, NETWORK_URLS, type RawClient } from './client'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rippledError = (error: string) => Object.assign(new Error(error), { data: { error } })

function fakeRaw(handlers: Record<string, (req: any) => any>) {
  const ee = new EventEmitter()
  let connected = false
  let connects = 0
  const requests: any[] = []
  const raw: RawClient & { connects(): number; drop(): void; requests: any[] } = {
    requests,
    connects: () => connects,
    drop() {
      connected = false
    },
    async request(req: any) {
      if (!connected) throw new Error('NotConnectedError')
      requests.push(req)
      const h = handlers[req.command]
      if (!h) throw new Error('no handler for ' + req.command)
      const r = await h(req)
      if (r instanceof Error) throw r
      return { result: r }
    },
    async connect() {
      connects++
      await sleep(5)
      connected = true
      ee.emit('connected')
    },
    async disconnect() {
      connected = false
    },
    isConnected: () => connected,
    on: (e: string, cb: (...a: any[]) => void) => ee.on(e, cb),
    removeListener: (e: string, cb: (...a: any[]) => void) => ee.removeListener(e, cb),
    emit: (e: string, ...a: any[]) => ee.emit(e, ...a),
    async autofill(tx: any) {
      return { ...tx }
    },
  } as never
  return raw
}

const blob = (lls = 100) =>
  xrpl.encode({ TransactionType: 'AccountSet', Account: 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT', Fee: '10', Sequence: 1, LastLedgerSequence: lls, SigningPubKey: '02' + '11'.repeat(32), TxnSignature: '3044' + '22'.repeat(68) } as never)

describe('createClient', () => {
  it('knows the Devnet and Testnet endpoints', () => {
    expect(NETWORK_URLS.devnet).toBe('wss://s.devnet.rippletest.net:51233')
    expect(NETWORK_URLS.testnet).toBe('wss://s.altnet.rippletest.net:51233')
    expect(createClient('testnet', { raw: fakeRaw({}) }).url).toBe(NETWORK_URLS.testnet)
    expect(createClient('devnet', { url: 'wss://example.test', raw: fakeRaw({}) }).url).toBe('wss://example.test')
  })

  it('connects once for concurrent callers and reconnects when the socket dropped', async () => {
    const raw = fakeRaw({ ledger: () => ({ ledger_index: 42 }) })
    const c = createClient('devnet', { raw })
    expect(await Promise.all([c.ledgerIndex(), c.ledgerIndex(), c.ledgerIndex()])).toEqual([42, 42, 42])
    expect(raw.connects()).toBe(1)
    raw.drop()
    expect(await c.ledgerIndex()).toBe(42)
    expect(raw.connects()).toBe(2)
  })

  it('accountInfo returns null for an unknown account and the account_data otherwise', async () => {
    const raw = fakeRaw({ account_info: (r) => (r.account === 'rKnown' ? { account_data: { Sequence: 7 } } : rippledError('actNotFound')) })
    const c = createClient('devnet', { raw })
    expect(await c.accountInfo('rKnown')).toEqual({ Sequence: 7 })
    expect(await c.accountInfo('rNope')).toBeNull()
  })

  it('nextSequence reads the current (open) ledger so pending txs count', async () => {
    const raw = fakeRaw({ account_info: (r) => ({ account_data: { Sequence: r.ledger_index === 'current' ? 12 : 11 } }) })
    expect(await createClient('devnet', { raw }).nextSequence('rA')).toBe(12)
  })

  it('baseFeeDrops reads server_info (base fee x load factor, rounded up)', async () => {
    let info = { validated_ledger: { base_fee_xrp: 0.000001 }, load_factor: 1 }
    const c = createClient('devnet', { raw: fakeRaw({ server_info: () => ({ info }) }) })
    expect(await c.baseFeeDrops()).toBe(1)
    info = { validated_ledger: { base_fee_xrp: 0.00001 }, load_factor: 1.55 }
    expect(await c.baseFeeDrops()).toBe(16)
  })
})

describe('submitAndWait', () => {
  it('returns the validated result with the ledger hash', async () => {
    let polls = 0
    const b = blob()
    const raw = fakeRaw({
      submit: () => ({ engine_result: 'tesSUCCESS' }),
      tx: () => (++polls < 3 ? { validated: false } : { validated: true, ledger_index: 55, meta: { TransactionResult: 'tesSUCCESS' } }),
      ledger: () => ({ ledger_index: 50 }),
    })
    const r = await createClient('devnet', { raw, pollMs: 0 }).submitAndWait(b)
    expect(r).toMatchObject({ validated: true, engineResult: 'tesSUCCESS', hash: xrpl.hashes.hashSignedTx(b), ledgerIndex: 55 })
    expect(r.meta).toEqual({ TransactionResult: 'tesSUCCESS' })
  })

  it('returns at once on a tem/tef/tel preliminary result, without waiting', async () => {
    for (const engine of ['temMALFORMED', 'tefPAST_SEQ', 'telINSUF_FEE_P']) {
      const raw = fakeRaw({ submit: () => ({ engine_result: engine }) })
      const r = await createClient('devnet', { raw, pollMs: 0 }).submitAndWait(blob())
      expect(r).toMatchObject({ validated: false, engineResult: engine })
      expect(raw.requests.map((q) => q.command)).toEqual(['submit'])
    }
  })

  it('a tec result is in a ledger but not a success (same as the mock ledger)', async () => {
    const raw = fakeRaw({
      submit: () => ({ engine_result: 'tecNO_PERMISSION' }),
      tx: () => ({ validated: true, ledger_index: 9, meta: { TransactionResult: 'tecNO_PERMISSION' } }),
      ledger: () => ({ ledger_index: 8 }),
    })
    const r = await createClient('devnet', { raw, pollMs: 0 }).submitAndWait(blob())
    expect(r).toMatchObject({ validated: false, engineResult: 'tecNO_PERMISSION', ledgerIndex: 9 })
  })

  it('gives up with tefMAX_LEDGER once the LastLedgerSequence is validated without the tx', async () => {
    let ledger = 98
    const raw = fakeRaw({
      submit: () => ({ engine_result: 'terQUEUED' }),
      tx: () => rippledError('txnNotFound'),
      ledger: () => ({ ledger_index: ledger++ }),
    })
    const r = await createClient('devnet', { raw, pollMs: 0 }).submitAndWait(blob(100))
    expect(r).toMatchObject({ validated: false, engineResult: 'tefMAX_LEDGER' })
  })

  it('reports a submit that the server rejects outright', async () => {
    const raw = fakeRaw({ submit: () => rippledError('invalidTransaction') })
    const r = await createClient('devnet', { raw, pollMs: 0 }).submitAndWait(blob())
    expect(r).toMatchObject({ validated: false, engineResult: 'invalidTransaction' })
  })
})

describe('serial', () => {
  it('runs one task at a time per account, in order; other accounts run in parallel; a failure does not block', async () => {
    const c = createClient('devnet', { raw: fakeRaw({}) })
    const log: string[] = []
    const task = (name: string, ms: number, fail = false) => async () => {
      log.push(`start ${name}`)
      await sleep(ms)
      log.push(`end ${name}`)
      if (fail) throw new Error(name)
      return name
    }
    const a1 = c.serial('rA', task('a1', 20, true))
    const a2 = c.serial('rA', task('a2', 5))
    const b1 = c.serial('rB', task('b1', 1))
    expect(c.queueLength('rA')).toBe(2)
    await expect(a1).rejects.toThrow('a1')
    expect(await a2).toBe('a2')
    expect(await b1).toBe('b1')
    expect(log.indexOf('end a1')).toBeLessThan(log.indexOf('start a2'))
    expect(log.indexOf('end b1')).toBeLessThan(log.indexOf('end a1'))
    expect(c.queueLength('rA')).toBe(0)
  })
})
