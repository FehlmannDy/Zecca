// Test fixture (file.test.ts): one process that adds `count` user ElGamal keys to a shared key store file.
// Waits for <file>.go after writing <file>.ready.<tag>, so two writers start at the same moment.
// Args: <file> <passphrase> <tag> <count>. Keys are fake; nothing is printed.
import { existsSync, writeFileSync } from 'node:fs'
import { createFileKeyStore } from '../file'

const [file, passphrase, tag, count] = process.argv.slice(2) as [string, string, string, string]
let n = 0
const ks = createFileKeyStore({ path: file, passphrase, scryptN: 1 << 10, generateElGamal: () => ({ publicKey: `P${tag}${++n}`, privateKey: `K${tag}${n}` }) })
writeFileSync(`${file}.ready.${tag}`, '')
const nap = new Int32Array(new SharedArrayBuffer(4))
const deadline = Date.now() + 20_000
while (!existsSync(`${file}.go`)) {
  if (Date.now() > deadline) throw new Error('writer: no go signal')
  Atomics.wait(nap, 0, 0, 2)
}
for (let i = 0; i < Number(count); i++) ks.createUserElGamal(`r${tag}${i}`)
