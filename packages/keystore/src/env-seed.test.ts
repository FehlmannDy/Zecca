import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileKeyStore, openKeyStoreFromEnv } from './index'

const PASS = 'correct horse battery staple 1234'

describe('openKeyStoreFromEnv with KEYSTORE_B64 (deploy: restore the encrypted store onto an empty volume)', () => {
  it('writes the encrypted file from KEYSTORE_B64 when the path is empty, mode 0600, and opens it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ks-'))
    const src = path.join(dir, 'src.enc')
    const ks = createFileKeyStore({ path: src, passphrase: PASS, scryptN: 1024 })
    ks.setMeta('cmptIssuanceId', 'ABC')
    const b64 = readFileSync(src).toString('base64')
    const target = path.join(dir, 'volume', 'keystore.enc')
    const opened = openKeyStoreFromEnv({ KEYSTORE_PATH: target, KEYSTORE_PASSPHRASE: PASS, KEYSTORE_B64: b64 })
    expect(opened.getMeta('cmptIssuanceId')).toBe('ABC')
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })
  it('never overwrites an existing store with KEYSTORE_B64', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ks-'))
    const target = path.join(dir, 'keystore.enc')
    const live = createFileKeyStore({ path: target, passphrase: PASS, scryptN: 1024 })
    live.setMeta('who', 'live')
    const other = path.join(dir, 'other.enc')
    createFileKeyStore({ path: other, passphrase: PASS, scryptN: 1024 }).setMeta('who', 'other')
    const opened = openKeyStoreFromEnv({ KEYSTORE_PATH: target, KEYSTORE_PASSPHRASE: PASS, KEYSTORE_B64: readFileSync(other).toString('base64') })
    expect(opened.getMeta('who')).toBe('live')
  })
  it('refuses a KEYSTORE_B64 that is not a key store envelope, without writing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ks-'))
    const target = path.join(dir, 'keystore.enc')
    expect(() => openKeyStoreFromEnv({ KEYSTORE_PATH: target, KEYSTORE_PASSPHRASE: PASS, KEYSTORE_B64: Buffer.from('hello').toString('base64') })).toThrow(/KEYSTORE_B64/)
    expect(existsSync(target)).toBe(false)
    void writeFileSync
  })
})
