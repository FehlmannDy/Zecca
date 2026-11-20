import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileKeyStore, keyStorePath, openKeyStoreFromEnv, writeFileAtomic } from './file'

const PASS = 'correct horse battery staple'
const OTHER = 'not the right passphrase at all'
const seed = 'sFAKEFAKEFAKEFAKEFAKEFAKEFAKE'
const secret = { address: 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT', seed, algorithm: 'ecdsa-secp256k1' as const }
const FAST = 1 << 10
const kp = { publicKey: '02' + 'AB'.repeat(32), privateKey: 'CD'.repeat(32) }

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zecca-ks-'))
  file = path.join(dir, 'sub', 'keystore.enc')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const mode = (p: string) => statSync(p).mode & 0o777

describe('file KeyStore', () => {
  it('round-trips wallets, ElGamal keys and meta through an encrypted file', () => {
    const a = createFileKeyStore({ path: file, passphrase: PASS })
    a.setWallet('sponsor', secret)
    a.setElGamal('pool', kp)
    a.setElGamal({ user: 'rUser1' }, kp)
    a.setMeta('cmptIssuanceId', '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9')

    const b = createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })
    expect(b.getWallet('sponsor')).toEqual(secret)
    expect(b.getElGamal('pool')).toEqual(kp)
    expect(b.getElGamal({ user: 'rUser1' })).toEqual(kp)
    expect(b.getMeta('cmptIssuanceId')).toBe('006C6AA175853178147D8F0D592D9DE3658C836F69985AB9')
    expect(b.snapshot()).toEqual(a.snapshot())

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(seed)
    expect(raw).not.toContain(kp.privateKey)
    expect(raw).not.toContain('rUser1')
    const env = JSON.parse(raw)
    expect(env).toMatchObject({ v: 1, kdf: 'scrypt', n: 1 << 15, r: 8, p: 1 })
    for (const k of ['salt', 'iv', 'tag', 'data']) expect(typeof env[k]).toBe('string')
  })

  it('creates the file (and its folder) on first open, mode 0600, and keeps it 0600 after writes', () => {
    const ks = createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })
    expect(mode(file)).toBe(0o600)
    ks.setWallet('pool', secret)
    expect(mode(file)).toBe(0o600)
    chmodSync(file, 0o644)
    createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })
    expect(mode(file)).toBe(0o600)
  })

  it('uses a fresh IV on every write', () => {
    const ks = createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })
    const iv1 = JSON.parse(readFileSync(file, 'utf8')).iv
    ks.setMeta('a', '1')
    const iv2 = JSON.parse(readFileSync(file, 'utf8')).iv
    expect(iv2).not.toBe(iv1)
  })

  it('refuses the wrong passphrase with a clear error that leaks nothing', () => {
    createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).setWallet('sponsor', secret)
    let err: unknown
    try {
      createFileKeyStore({ path: file, passphrase: OTHER, scryptN: FAST })
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/wrong passphrase/)
    for (const s of [PASS, OTHER, seed]) expect(String(err)).not.toContain(s)
  })

  it('refuses a damaged file', () => {
    createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).setWallet('sponsor', secret)
    const env = JSON.parse(readFileSync(file, 'utf8'))
    const data = Buffer.from(env.data, 'base64')
    data[0] ^= 1
    writeFileSync(file, JSON.stringify({ ...env, data: data.toString('base64') }))
    expect(() => createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })).toThrow(/wrong passphrase or damaged/)
    writeFileSync(file, 'not json')
    expect(() => createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })).toThrow(/not a key store file/)
  })

  it('refuses a passphrase shorter than 16 characters', () => {
    expect(() => createFileKeyStore({ path: file, passphrase: 'short-pass-15ch' })).toThrow(/at least 16 characters/)
    expect(() => createFileKeyStore({ path: file, passphrase: '' })).toThrow(/at least 16 characters/)
    expect(() => readdirSync(dir)).not.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('persists createUserElGamal once (idempotent across reopen)', () => {
    let n = 0
    const gen = () => ({ publicKey: `PUB${++n}`, privateKey: `PRIV${n}` })
    const a = createFileKeyStore({ path: file, passphrase: PASS, generateElGamal: gen, scryptN: FAST })
    expect(a.createUserElGamal('rUser1')).toBe('PUB1')
    const b = createFileKeyStore({ path: file, passphrase: PASS, generateElGamal: gen, scryptN: FAST })
    expect(b.createUserElGamal('rUser1')).toBe('PUB1')
    expect(b.getElGamal({ user: 'rUser1' })).toEqual({ publicKey: 'PUB1', privateKey: 'PRIV1' })
    expect(n).toBe(1)
  })

  it('two stores on one file (API process and pool worker) see and keep each other\'s writes', () => {
    let n = 0
    const gen = () => ({ publicKey: `PUB${++n}`, privateKey: `PRIV${n}` })
    const api = createFileKeyStore({ path: file, passphrase: PASS, generateElGamal: gen, scryptN: FAST })
    const worker = createFileKeyStore({ path: file, passphrase: PASS, generateElGamal: gen, scryptN: FAST })
    api.createUserElGamal('rUser1')
    expect(worker.has({ user: 'rUser1' })).toBe(true)
    worker.setMeta('poolSequence', '42')
    api.createUserElGamal('rUser2')
    const fresh = createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })
    expect(fresh.has({ user: 'rUser1' })).toBe(true)
    expect(fresh.has({ user: 'rUser2' })).toBe(true)
    expect(fresh.getMeta('poolSequence')).toBe('42')
  })

  const isRoot = process.getuid?.() === 0

  it.skipIf(isRoot)('a write that fails on disk is not kept in memory: has() stays false and a retry writes for real', () => {
    let n = 0
    let breakDisk = false
    // Runs inside the write, just before the file is saved: makes the save fail like EACCES/ENOSPC would.
    const gen = () => {
      if (breakDisk) chmodSync(path.dirname(file), 0o500)
      return { publicKey: `PUB${++n}`, privateKey: `PRIV${n}` }
    }
    const ks = createFileKeyStore({ path: file, passphrase: PASS, generateElGamal: gen, scryptN: FAST })
    breakDisk = true
    try {
      expect(() => ks.createUserElGamal('rUserA')).toThrow()
    } finally {
      chmodSync(path.dirname(file), 0o700)
      breakDisk = false
    }
    expect(ks.has({ user: 'rUserA' })).toBe(false)
    expect(() => ks.getElGamal({ user: 'rUserA' })).toThrow(/no ElGamal key/)
    expect(createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).has({ user: 'rUserA' })).toBe(false)
    expect(ks.createUserElGamal('rUserA')).toBe('PUB2')
    expect(createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).getElGamal({ user: 'rUserA' })).toEqual({ publicKey: 'PUB2', privateKey: 'PRIV2' })
  })

  it.skipIf(isRoot)('keeps failing (never pretends) while the folder cannot be written, then works once it can', () => {
    let n = 0
    const gen = () => ({ publicKey: `PUB${++n}`, privateKey: `PRIV${n}` })
    const ks = createFileKeyStore({ path: file, passphrase: PASS, generateElGamal: gen, scryptN: FAST })
    chmodSync(path.dirname(file), 0o500)
    try {
      expect(() => ks.createUserElGamal('rUserA')).toThrow()
      expect(() => ks.createUserElGamal('rUserA')).toThrow()
      expect(() => ks.setMeta('k', 'v')).toThrow()
      expect(ks.has({ user: 'rUserA' })).toBe(false)
      expect(ks.getMeta('k')).toBeUndefined()
    } finally {
      chmodSync(path.dirname(file), 0o700)
    }
    const pub = ks.createUserElGamal('rUserA')
    expect(createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).getElGamal({ user: 'rUserA' }).publicKey).toBe(pub)
  })

  it('two processes writing the same file at the same time lose no key', async () => {
    createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const tsx = path.join(repo, 'node_modules/tsx/dist/cli.mjs')
    const writer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/concurrent-writer.ts')
    const COUNT = 120
    const run = (tag: string) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const p = spawn(process.execPath, [tsx, writer, file, PASS, tag, String(COUNT)], { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        p.stderr.on('data', (d) => (err += d))
        p.on('close', (code) => resolve({ code, err }))
      })
    const done = Promise.all([run('A'), run('B')])
    const deadline = Date.now() + 20_000
    while (!(existsSync(`${file}.ready.A`) && existsSync(`${file}.ready.B`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    writeFileSync(`${file}.go`, '')
    const results = await done
    for (const r of results) expect(r, r.err).toMatchObject({ code: 0 })
    const users = createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).snapshot().elgamal.users
    expect(Object.keys(users).length).toBe(2 * COUNT)
    expect(users.rA0).toEqual({ publicKey: 'PA1', privateKey: 'KA1' })
    expect(users[`rB${COUNT - 1}`]).toEqual({ publicKey: `PB${COUNT}`, privateKey: `KB${COUNT}` })
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp'))).toEqual([])
  }, 60_000)

  it('ignores a stale temp file left by a crashed write', () => {
    createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).setWallet('sponsor', secret)
    writeFileSync(path.join(path.dirname(file), '.keystore.enc.999.dead.tmp'), '{"v":1,"partial')
    expect(createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST }).getWallet('sponsor')).toEqual(secret)
  })
})

describe('writeFileAtomic', () => {
  it('writes a 0600 file through a temp file in the same folder', () => {
    const target = path.join(dir, 'f.json')
    let tmpSeen = ''
    writeFileAtomic(target, 'hello', {
      beforeRename: (tmp) => {
        tmpSeen = tmp
        expect(path.dirname(tmp)).toBe(dir)
        expect(readFileSync(tmp, 'utf8')).toBe('hello')
      },
    })
    expect(tmpSeen).not.toBe('')
    expect(readFileSync(target, 'utf8')).toBe('hello')
    expect(mode(target)).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['f.json'])
  })

  it('leaves the previous file whole and no temp file when the write crashes before the rename', () => {
    const target = path.join(dir, 'f.json')
    writeFileAtomic(target, 'version 1')
    expect(() =>
      writeFileAtomic(target, 'version 2, much longer than version 1', {
        beforeRename: () => {
          throw new Error('simulated crash')
        },
      }),
    ).toThrow(/simulated crash/)
    expect(readFileSync(target, 'utf8')).toBe('version 1')
    expect(readdirSync(dir)).toEqual(['f.json'])
  })
})

describe('openKeyStoreFromEnv', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

  it('defaults KEYSTORE_PATH to <repo>/.data/keystore.enc and resolves relative paths from the repo root', () => {
    expect(keyStorePath({})).toBe(path.join(repoRoot, '.data', 'keystore.enc'))
    expect(keyStorePath({ KEYSTORE_PATH: './.data/keystore.enc' })).toBe(path.join(repoRoot, '.data', 'keystore.enc'))
    expect(keyStorePath({ KEYSTORE_PATH: '/var/data/ks.enc' })).toBe('/var/data/ks.enc')
  })

  it('opens the store named by the environment', () => {
    createFileKeyStore({ path: file, passphrase: PASS, scryptN: FAST })
    const a = openKeyStoreFromEnv({ KEYSTORE_PATH: file, KEYSTORE_PASSPHRASE: PASS })
    a.setMeta('x', 'y')
    expect(openKeyStoreFromEnv({ KEYSTORE_PATH: file, KEYSTORE_PASSPHRASE: PASS }).getMeta('x')).toBe('y')
  })

  it('says clearly when KEYSTORE_PASSPHRASE is missing', () => {
    expect(() => openKeyStoreFromEnv({ KEYSTORE_PATH: file })).toThrow(/KEYSTORE_PASSPHRASE is not set/)
  })
})
