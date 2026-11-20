// Every environment variable Zecca reads, with a one-line comment. Source of .env.example (scripts/gen-env-example.ts).
// A variable with a default is written commented out (the code applies the same default); one without is `NAME=`.
// An optional one (unset means a fallback, while an empty value would not) is a commented `# NAME=`.
// Secrets never carry a default. scripts/lib/env-vars.test.ts checks this list against the env reads in the code.
import { DEFAULTS } from '@zecca/contracts'

export type EnvVar = { name: string; comment: string; default?: string; secret?: boolean; optional?: boolean }
export type EnvGroup = { title: string; vars: EnvVar[] }

const d = (n: number) => String(n)

export const ENV_GROUPS: EnvGroup[] = [
  {
    title: 'Modes',
    vars: [
      { name: 'LEDGER_MODE', comment: 'mock = in-memory ledger; devnet = real XRPL Devnet', default: 'mock' },
      { name: 'MOCK_VALIDATION_DELAY_MS', comment: 'Mock ledger only: delay in ms before a transaction is validated', default: '500' },
      { name: 'SIGNER_MODE', comment: 'mock = local key in the browser behind the raw_sign contract; privy = Privy embedded wallet', default: 'mock' },
      { name: 'IDENTITY_MODE', comment: 'mock = fixed test identity after 3 s; eudi = public EU reference verifier', default: 'mock' },
      { name: 'DEMO_MODE', comment: '1 enables the demo-only routes (dev credit, card test purchase, demo shop)', default: '0' },
      { name: 'NODE_ENV', comment: 'production turns off the check of every API response against its schema', optional: true },
    ],
  },
  {
    title: 'Origins and ports',
    vars: [
      { name: 'WEB_ORIGIN', comment: 'Public origin of the web app (CORS, links)', default: 'http://localhost:3100' },
      { name: 'API_ORIGIN', comment: 'Public origin of the API', default: 'http://localhost:8800' },
      { name: 'NEXT_PUBLIC_API_ORIGIN', comment: 'API origin as seen by the browser (built into the web app)', default: 'http://localhost:8800' },
      { name: 'PUBLIC_WEBHOOK_BASE', comment: 'Public https base for Lithic and MoonPay webhooks; locally the tunnel URL (scripts/tunnel.ts)' },
      { name: 'API_PORT', comment: 'Port the API listens on', default: '8800' },
      { name: 'PORT', comment: 'Port the API listens on when API_PORT is unset (hosting platforms set it)', optional: true },
      { name: 'API_HOST', comment: 'Interface the API binds to (0.0.0.0 in a container)', default: '127.0.0.1' },
      { name: 'WEB_PORT', comment: 'Port of the local web dev server', default: '3100' },
    ],
  },
  {
    title: 'Key store (file encrypted with AES-256-GCM, mode 0600, outside git)',
    vars: [
      { name: 'KEYSTORE_PATH', comment: 'Key store file; a relative path is taken from the repository root', default: './.data/keystore.enc' },
      { name: 'KEYSTORE_PASSPHRASE', comment: 'At least 16 characters; scripts/setup-env.ts generates one', secret: true },
    ],
  },
  {
    title: 'Ledger (Devnet ids, SPEC §2.2; change after a Devnet reset)',
    vars: [
      { name: 'CMPT_ISSUANCE_ID', comment: 'Confidential MPT issuance id (the dollar token)', default: '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9' },
      { name: 'SPONSOR_ADDRESS', comment: 'Sponsor account (pays every fee and reserve)', default: 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT' },
      { name: 'ISSUER_ADDRESS', comment: 'Issuer of the confidential token', default: 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3' },
      { name: 'POOL_ADDRESS', comment: 'Pool account every payment goes through', default: 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ' },
      { name: 'XRPL_DEVNET_URL', comment: 'Devnet websocket URL; unset = the default Devnet node of xrpl-core', optional: true },
    ],
  },
  {
    title: 'Storage and background jobs (relative paths are taken from the working directory)',
    vars: [
      { name: 'DATABASE_PATH', comment: 'API database file; unset = in memory with LEDGER_MODE=mock, ./.data/zecca.sqlite with devnet', optional: true },
      { name: 'POOL_DB_PATH', comment: 'Pool worker database file (devnet)', default: './.data/pool.sqlite' },
      { name: 'POOL_POLL_MS', comment: 'How often the pool worker polls the ledger, in ms', default: '15000' },
      { name: 'RECONCILE_MS', comment: 'How often the API reconciles pending payments, in ms (0 = off)', default: '60000' },
    ],
  },
  {
    title: 'Privy (login and user keys)',
    vars: [
      { name: 'PRIVY_APP_ID', comment: 'Privy app id (public)' },
      { name: 'PRIVY_APP_SECRET', comment: 'Privy app secret (server only)', secret: true },
    ],
  },
  {
    title: 'MoonPay (top-up, sandbox)',
    vars: [
      { name: 'MOONPAY_PUBLISHABLE_KEY', comment: 'MoonPay publishable key (pk_test_...)' },
      { name: 'MOONPAY_SECRET_KEY', comment: 'MoonPay secret key, signs widget URLs (server only)', secret: true },
      { name: 'MOONPAY_WEBHOOK_KEY', comment: 'MoonPay webhook signing key (wk_test_...), separate from the secret key', secret: true },
      { name: 'RAMP_SANDBOX_SCALE', comment: 'Multiplier on sandbox top-ups (1 = none); the screen says Sandbox when not 1', default: d(DEFAULTS.RAMP_SANDBOX_SCALE) },
    ],
  },
  {
    title: 'Lithic (card, sandbox)',
    vars: [
      { name: 'LITHIC_API_KEY', comment: 'Lithic sandbox API key', secret: true },
      { name: 'LITHIC_BASE_URL', comment: 'Lithic API base URL', default: 'https://sandbox.lithic.com' },
    ],
  },
  {
    title: 'Product settings (integers, minor units: 1 = one cent)',
    vars: [
      { name: 'WELCOME_CREDIT_MINOR', comment: 'Demo credit given at sign-up', default: d(DEFAULTS.WELCOME_CREDIT_MINOR) },
      { name: 'MERCHANT_FEE_BPS', comment: 'Zecca commission on merchant payments, basis points', default: d(DEFAULTS.MERCHANT_FEE_BPS) },
      { name: 'TX_CAP_MINOR', comment: 'Cap per transaction once verified', default: d(DEFAULTS.TX_CAP_MINOR) },
      { name: 'DAILY_CAP_MINOR', comment: 'Cap per day once verified', default: d(DEFAULTS.DAILY_CAP_MINOR) },
      { name: 'TIER0_BALANCE_CAP_MINOR', comment: 'Balance cap without identity', default: d(DEFAULTS.TIER0_BALANCE_CAP_MINOR) },
      { name: 'TIER0_TX_CAP_MINOR', comment: 'Cap per transaction without identity', default: d(DEFAULTS.TIER0_TX_CAP_MINOR) },
      { name: 'TIER0_MONTHLY_SEND_CAP_MINOR', comment: 'Monthly send cap without identity', default: d(DEFAULTS.TIER0_MONTHLY_SEND_CAP_MINOR) },
      { name: 'MARKET_SPREAD_BPS', comment: 'Zecca spread on metals, basis points', default: d(DEFAULTS.MARKET_SPREAD_BPS) },
      { name: 'EARN_FEE_BPS', comment: 'Zecca share of Earn yield, basis points', default: d(DEFAULTS.EARN_FEE_BPS) },
      { name: 'EARN_SWAP_BPS', comment: 'Zecca margin on the dollar-to-XRP conversion for Earn, basis points', default: d(DEFAULTS.EARN_SWAP_BPS) },
      { name: 'PAYMENT_REQUEST_TTL_SECONDS', comment: 'How long a payment request (QR, link) stays payable, in seconds', default: d(DEFAULTS.PAYMENT_REQUEST_TTL_SECONDS) },
      { name: 'SESSION_TTL_HOURS', comment: 'How long a login session lasts, in hours', default: '168' },
      { name: 'PREPARE_RATE_LIMIT_PER_MIN', comment: 'Prepared transactions (sign-up, send, pay) allowed per user per minute', default: '30' },
    ],
  },
  {
    title: 'Feature flags (1 = on); each stays off until its end-to-end test is green',
    vars: [
      { name: 'FEATURE_RAMP', comment: 'Top-up with MoonPay', default: '0' },
      { name: 'FEATURE_WITHDRAW', comment: 'Withdraw to a bank (MoonPay sell)', default: '0' },
      { name: 'FEATURE_CARD', comment: 'Card (Lithic)', default: '0' },
      { name: 'FEATURE_EARN', comment: 'Earn (Flare, Firelight)', default: '0' },
      { name: 'FEATURE_MARKET', comment: 'Metals market', default: '0' },
      { name: 'FEATURE_IDENTITY', comment: 'Identity check (EUDI)', default: '0' },
      { name: 'FEATURE_PROOFS', comment: 'Proofs of balance and payment', default: '0' },
      { name: 'FEATURE_DEMO_SHOP', comment: 'Demo shop; unset = follows DEMO_MODE', optional: true },
      { name: 'FEATURE_PASSKEY', comment: 'Passkey (Face ID) approval; keep off (DECISIONS #7)', default: '0' },
      { name: 'FEATURE_GOOGLE_LOGIN', comment: 'Google login through Privy (DECISIONS #6)', default: '0' },
    ],
  },
]

export const ENV_VARS: EnvVar[] = ENV_GROUPS.flatMap((g) => g.vars)

export function renderEnvExample(groups: EnvGroup[] = ENV_GROUPS): string {
  const out = [
    '# Zecca environment. Copy to .env (or run scripts/setup-env.ts, which fills it without printing values).',
    '# Generated by scripts/gen-env-example.ts from scripts/lib/env-vars.ts: edit that file, not this one.',
    '# Commented lines show the default the code applies (no value: see its comment); uncomment to change it.',
    '# Uncommented empty lines must be filled.',
  ]
  for (const g of groups) {
    out.push('', `# --- ${g.title} ---`)
    for (const v of g.vars) {
      if (v.secret && v.default !== undefined) throw new Error(`env vars: secret ${v.name} must not have a default`)
      if (v.optional && v.default !== undefined) throw new Error(`env vars: optional ${v.name} must not have a default`)
      out.push(`# ${v.comment}`, v.default !== undefined ? `# ${v.name}=${v.default}` : v.optional ? `# ${v.name}=` : `${v.name}=`)
    }
  }
  return out.join('\n') + '\n'
}
