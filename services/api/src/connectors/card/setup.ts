// Lithic sandbox setup (port of card-issuer/scripts/lithic-setup.js and set-webhook-url.js): point Lithic's ASA at
// <PUBLIC_WEBHOOK_BASE>/v1/webhooks/lithic/asa and read the ASA secret, which switches signed headers on.
// Lithic: "Within minutes, the headers will begin appearing" (about 3 min observed), so run it a few minutes before a demo.
// The API fetches the same secret itself (GET /v1/auth_stream/secret) and keeps it; nothing here prints it.
// A quick tunnel's URL changes on every restart: run this again after each new tunnel (no API restart needed).
import path from 'node:path'
import type { LithicApi } from './lithic-api'

export const ASA_PATH = '/v1/webhooks/lithic/asa'

export async function enrollCardWebhook(o: { lithic: LithicApi; publicBase: string; log?: (m: string) => void }): Promise<{ url: string; enrollment: unknown }> {
  const log = o.log ?? (() => {})
  const base = o.publicBase.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+$/.test(base)) throw new Error('The public webhook base must be an https origin, e.g. https://<id>.trycloudflare.com')
  const url = base + ASA_PATH
  await o.lithic.enrollAsa(url)
  log(`ASA endpoint enrolled: ${url}`)
  const secret = await o.lithic.authStreamSecret()
  log(`ASA secret ${secret.startsWith('whsec_') ? 'received (not printed); the API reads it itself' : 'NOT received'}`)
  const enrollment = await o.lithic.asaEnrollment()
  log('Signed ASA headers start a few minutes after the first secret read; until then the webhook answers 401.')
  return { url, enrollment }
}

/** --base <url>, else PUBLIC_WEBHOOK_BASE, else the tunnel helper's URL file for the API port (scripts/tunnel.ts). */
export function publicBaseFrom(
  argv: string[],
  env: Record<string, string | undefined>,
  read: (file: string) => string | undefined,
  zeccaRoot: string,
): string | undefined {
  const i = argv.indexOf('--base')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  if (env.PUBLIC_WEBHOOK_BASE) return env.PUBLIC_WEBHOOK_BASE
  const p = argv.indexOf('--port')
  const port = p >= 0 ? argv[p + 1] : env.API_PORT || '8800'
  return read(path.join(zeccaRoot, '.data', `tunnel-${port}.url`))?.trim() || undefined
}
