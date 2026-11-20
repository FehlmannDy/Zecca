// KeyStore persisted to one file, encrypted with AES-256-GCM under a key derived by scrypt from the passphrase.
// File: JSON envelope { v:1, kdf:'scrypt', n, r, p, salt, iv, tag, data } (base64), mode 0600, written atomically.
// Several processes may open the same file (API and pool worker): a store reloads when the file changed on disk
// before every read and write, so nobody overwrites keys written by another. Errors never contain a secret.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, closeSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElGamalKeyPair, KeyStore } from '@zecca/contracts'
import { createMemoryKeyStore, type KeyStoreState } from './memory'

export const MIN_PASSPHRASE_LENGTH = 16
const SCRYPT = { n: 1 << 15, r: 8, p: 1 }

type Envelope = { v: 1; kdf: 'scrypt'; n: number; r: number; p: number; salt: string; iv: string; tag: string; data: string }

export type FileKeyStoreOptions = {
  path: string
  passphrase: string
  /** Defaults to xrpl.deriveConfidentialKeypair(). */
  generateElGamal?: () => ElGamalKeyPair
  /** scrypt N for a new file (default 2^15). Tests lower it to stay fast; an existing file keeps the cost it was written with. */
  scryptN?: number
}

/** Writes through a 0600 temp file in the same folder, fsync, then rename: readers see the old file or the new one, never a part. */
export function writeFileAtomic(target: string, contents: string, hooks: { beforeRename?: (tmp: string) => void } = {}): void {
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, contents)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    hooks.beforeRename?.(tmp)
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  try {
    const dfd = openSync(dir, 'r')
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } catch {
    // Directory fsync is best effort (not supported everywhere).
  }
}

const isEnvelope = (x: unknown): x is Envelope => {
  const e = x as Envelope
  return (
    !!e && e.v === 1 && e.kdf === 'scrypt' &&
    [e.n, e.r, e.p].every((v) => Number.isInteger(v) && v > 0) && e.n <= 1 << 20 && e.r <= 32 && e.p <= 16 &&
    [e.salt, e.iv, e.tag, e.data].every((v) => typeof v === 'string')
  )
}

export function createFileKeyStore(opts: FileKeyStoreOptions): KeyStore & { snapshot(): KeyStoreState } {
  if (typeof opts.passphrase !== 'string' || opts.passphrase.length < MIN_PASSPHRASE_LENGTH)
    throw new Error(`key store: the passphrase (KEYSTORE_PASSPHRASE) must be at least ${MIN_PASSPHRASE_LENGTH} characters`)
  const file = path.resolve(opts.path)
  let kdf: { salt: Buffer; n: number; r: number; p: number; key: Buffer } | null = null
  let stamp: string | null = null

  const deriveKey = (salt: Buffer, n: number, r: number, p: number) => {
    if (kdf && kdf.salt.equals(salt) && kdf.n === n && kdf.r === r && kdf.p === p) return kdf.key
    const key = scryptSync(opts.passphrase, salt, 32, { N: n, r, p, maxmem: 256 * n * r })
    kdf = { salt, n, r, p, key }
    return key
  }
  const stampOf = (s: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  const currentStamp = () => {
    try {
      return stampOf(statSync(file))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  const persist = (state: KeyStoreState) => {
    const key = kdf ? kdf.key : deriveKey(randomBytes(16), opts.scryptN ?? SCRYPT.n, SCRYPT.r, SCRYPT.p)
    const { salt, n, r, p } = kdf!
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([c.update(JSON.stringify(state), 'utf8'), c.final()])
    const env: Envelope = { v: 1, kdf: 'scrypt', n, r, p, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
    writeFileAtomic(file, JSON.stringify(env))
    stamp = currentStamp()
  }

  const read = (): { state: KeyStoreState; stamp: string } => {
    const fd = openSync(file, 'r')
    let text: string
    let st: string
    try {
      st = stampOf(fstatSync(fd))
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
    let env: unknown
    try {
      env = JSON.parse(text)
    } catch {
      env = null
    }
    if (!isEnvelope(env)) throw new Error(`key store: ${file} is not a key store file`)
    const key = deriveKey(Buffer.from(env.salt, 'base64'), env.n, env.r, env.p)
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
      d.setAuthTag(Buffer.from(env.tag, 'base64'))
      const plain = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()])
      return { state: JSON.parse(plain.toString('utf8')) as KeyStoreState, stamp: st }
    } catch {
      throw new Error(`key store: cannot open ${file}: wrong passphrase or damaged file`)
    }
  }

  const make = (initial?: KeyStoreState) => createMemoryKeyStore({ initial, generateElGamal: opts.generateElGamal, onChange: persist })

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  let inner: ReturnType<typeof make>
  if (currentStamp() === null) {
    inner = make()
    persist(inner.snapshot())
  } else {
    const r = read()
    inner = make(r.state)
    stamp = r.stamp
    if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600)
  }

  /** Reload when another process rewrote the file since we last read or wrote it. */
  const fresh = () => {
    const s = currentStamp()
    if (s !== null && s !== stamp) {
      const r = read()
      inner = make(r.state)
      stamp = r.stamp
    }
    return inner
  }

  return {
    getWallet: (role) => fresh().getWallet(role),
    hasWallet: (role) => fresh().hasWallet(role),
    setWallet: (role, secret) => fresh().setWallet(role, secret),
    getElGamal: (owner) => fresh().getElGamal(owner),
    setElGamal: (owner, keyPair) => fresh().setElGamal(owner, keyPair),
    createUserElGamal: (address) => fresh().createUserElGamal(address),
    has: (owner) => fresh().has(owner),
    getMeta: (key) => fresh().getMeta(key),
    setMeta: (key, value) => fresh().setMeta(key, value),
    snapshot: () => fresh().snapshot(),
  }
}

/** The repository root (this file is packages/keystore/src/file.ts). */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** KEYSTORE_PATH, default `.data/keystore.enc`; a relative path is taken from the repository root, not the working directory. */
export function keyStorePath(env: Record<string, string | undefined>): string {
  const p = env.KEYSTORE_PATH?.trim() || '.data/keystore.enc'
  return path.resolve(REPO_ROOT, p)
}

/** Opens (or creates) the file key store named by KEYSTORE_PATH, with KEYSTORE_PASSPHRASE. */
export function openKeyStoreFromEnv(env: Record<string, string | undefined> = process.env): KeyStore & { snapshot(): KeyStoreState } {
  const passphrase = env.KEYSTORE_PASSPHRASE
  if (!passphrase) throw new Error('key store: KEYSTORE_PASSPHRASE is not set (run scripts/setup-env.ts)')
  return createFileKeyStore({ path: keyStorePath(env), passphrase })
}
