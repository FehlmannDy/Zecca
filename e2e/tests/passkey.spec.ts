// "Approve with Face ID" against the real Privy (SPEC §4.11): throwaway mail.tm inbox, Chromium virtual
// authenticator as Face ID, link -> enrol -> cancelled sign fails in plain words -> sign prompts once and the
// signature verifies -> next sign within Privy's verification window does not prompt.
// Needs the network and a web origin listed in Privy's "Allowed origins", so it only runs with PASSKEY_E2E=1:
//   PASSKEY_E2E=1 PASSKEY_AS_ORIGIN=http://localhost:5173 E2E_BASE_URL=http://localhost:3100 npm run test:e2e -- passkey
// (PASSKEY_AS_ORIGIN only while the deployed origin is not allowed yet; see the script's header.)
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

test.skip(process.env.PASSKEY_E2E !== '1', 'real Privy and network: set PASSKEY_E2E=1')

test('passkey MFA answers a real Privy raw_sign and the signature verifies', () => {
  test.setTimeout(600_000)
  const out = mkdtempSync(join(tmpdir(), 'zecca-passkey-'))
  const r = spawnSync(
    process.execPath,
    ['-r', join(ROOT, 'scripts/dev/dnsfix.cjs'), join(ROOT, 'apps/web/scripts/passkey/run-privy-passkey.mjs'), process.env.E2E_BASE_URL ?? 'http://localhost:3100', out],
    { cwd: ROOT, encoding: 'utf8', timeout: 560_000, env: { ...process.env, AS_ORIGIN: process.env.PASSKEY_AS_ORIGIN ?? '' } },
  )
  const file = readdirSync(out).find((f) => f.startsWith('run-') && f.endsWith('.json'))
  expect(file, r.stdout + r.stderr).toBeTruthy()
  const evidence = JSON.parse(readFileSync(join(out, file!), 'utf8')) as { steps: { step: string; detail?: Record<string, unknown> }[] }
  const verdict = evidence.steps.find((s) => s.step === 'verdict')?.detail
  expect(verdict, JSON.stringify(evidence.steps.slice(-3))).toMatchObject({ endToEnd: true, firstPrompts: 1, secondOk: true })
  expect(verdict?.cancel).toMatchObject({ event: 'sign:error', friendly: 'Face ID was cancelled. Nothing was sent.' })
  expect(r.status).toBe(0)
})
