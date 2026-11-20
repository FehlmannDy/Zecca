# Zecca

Zecca is a payment app in the style of Revolut or Wise that runs on the XRP Ledger, layer 1: sign in with an email, pay with a tap or a QR code, and your balance and the amounts you send stay hidden on the public ledger.
You never see a seed phrase and never hold XRP: Zecca opens your account and pays every network fee, and you sign each payment with your own key.

Built at the Italian XRPL Hackathon 2026 (Bari), Track 2. Running on XRPL Devnet and Testnet.

## Run it locally

Node 22.12 or later and npm. No network is needed: the default mode is an in-memory ledger with a local test signer.

```sh
git clone https://github.com/FehlmannDy/Zecca.git && cd Zecca
npm install
npm run env:setup   # creates .env (mode 600) with a fresh key store passphrase; prints key names only
npm run dev         # API on :8800 (with the pool worker) and the web app on :3100
# open http://localhost:3100
```

To run against the real XRPL Devnet, set `LEDGER_MODE=devnet` in `.env`, run `npm run bootstrap` once (it creates the sponsor, issuer, pool and the other accounts from the faucets, plus the confidential token; a second run creates nothing), then `npm run dev`. Signing in with a real email needs `SIGNER_MODE=privy` and a Privy app (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`). Every variable is listed with its default in [`.env.example`](.env.example).

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Unit and contract tests on the in-memory ledger (Vitest, a few seconds, no network) |
| `npm run test:ledger` | Real transactions on XRPL Devnet and Testnet (needs the network and a bootstrapped key store) |
| `npm run test:e2e` | The demo path in a real browser (Playwright): sign up, balance, send, pay a merchant, "Paid" |
| `npm run typecheck` | TypeScript, strict, over every package |

## How it works

Every payment goes through the Zecca pool: you send a confidential transfer to the pool, the pool checks the amount and sends a second confidential transfer to the person or shop you paid. The ledger shows two payments, to and from the pool, with the addresses visible and the amounts encrypted. Which deposit pays which recipient lives only in Zecca's database; no memo, tag or field on the ledger links them. The app's `/how-it-works` page gives the full picture, network by network; [docs/SPEC.md](docs/SPEC.md) has the ledger model.

XRP Ledger features used, all on layer 1 (no sidechain, no smart contract):

- **Sponsored accounts** (Sponsor): the user's account is created with one drop; Zecca's sponsor pays every fee and reserve.
- **Confidential tokens** (ConfidentialTransfer on an MPT): balances and amounts are ElGamal-encrypted with zero-knowledge proofs.
- **Batched transactions** (Batch): sign-up is one approval, all or nothing.
- **Delegated permissions** (Permission Delegation): a relayer merges incoming payments into the spendable balance for the user.
- **Credentials** (tested on Devnet, wired with the identity feature): a verified identity becomes an on-ledger credential that raises limits.

## Proven on the ledger

Transactions from our test runs on 20 November 2026. Devnet is reset from time to time, so these links can expire.

| What | Network | Transaction |
|---|---|---|
| Account created by the sponsor with 1 drop | Devnet | [`C4225559…40EC`](https://devnet.xrpl.org/transactions/C42255597710602E16C35FF416082D506C96598377F4210D5E42E847119740EC) |
| One-signature sign-up Batch (authorize, credit, convert to confidential, merge) | Devnet | [`C8594C53…AB55`](https://devnet.xrpl.org/transactions/C8594C5337AC38A74A7E3EBCF8333706372667453307E25DFAFA1C8E6ADCAB55) |
| Confidential send to the pool, fee sponsored | Devnet | [`D1DAE5A9…3777`](https://devnet.xrpl.org/transactions/D1DAE5A97DDCA1590AE6E3E489378AA7EAEDD44500DD7B0E76670CA135A83777) |
| MoonPay sandbox purchase delivered as RLUSD | Testnet | [`548D695E…8939`](https://testnet.xrpl.org/transactions/548D695E91F1F48720D64F0380C084DE3E0A6A4F97CA1599B79324FB5A1F8939) |
| One XRPL payment into the Firelight vault on Flare | Testnet | [`B53177C7…5307`](https://testnet.xrpl.org/transactions/B53177C7D31A4CC4F786824150F72A4EFE206DC7818989E98CC80A74E71B5307) |

Long-lived Devnet accounts: pool [`rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ`](https://devnet.xrpl.org/accounts/rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ), sponsor [`rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT`](https://devnet.xrpl.org/accounts/rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT), issuer [`rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3`](https://devnet.xrpl.org/accounts/rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3); confidential token (MPT issuance) `006C6AA175853178147D8F0D592D9DE3658C836F69985AB9`.

## Repository layout

```
apps/
  web/              Next.js: landing, user space, merchant space, pay page, demo shop
  merchant-nfc/     Android app that hands the pay link to the customer's phone over NFC (release/zecca-nfc.apk)
services/
  api/              HTTP API (Hono): auth, directory, prepared transactions, sponsor policy, intents, events, connectors
  pool-worker/      Worker thread: watches the pool, decrypts and checks deposits, pays out
packages/
  contracts/        Shared schemas (zod), types, fixtures: the API and the web are built against them
  xrpl-core/        Signer, sponsor co-signature, Batch builder, confidential helpers, live ledger client
  keystore/         Key store interface and its encrypted-file implementation
  ledger-mock/      In-memory ledger with the same state machine (LEDGER_MODE=mock)
scripts/            setup-env, import-keys, bootstrap-ledger, tunnel, smoke test
e2e/                Playwright: the demo path
docs/               SPEC.md (product and ledger model), UI.md (interface), DECISIONS.md
```

Deployment (API as one Docker image, web on Vercel) is described in [DEPLOY.md](DEPLOY.md).

## What Zecca does not claim

- **Not non-custodial.** The key that signs your payments is yours (held through Privy); the key that reads your amounts is held by Zecca, like any payment company sees its customers' payments.
- **Not anonymous.** Addresses are public, amounts are hidden, and Zecca knows its customers.
- **Devnet and Testnet only.** Sponsored accounts and confidential transfers are not on Mainnet yet.
- **RLUSD is not authorised under MiCA in the EU today**; MoonPay's widget says so itself.
- **Earn has no fixed rate.** The yield comes from Firelight on Flare, is paid in XRP and varies.
- **Timing can link a deposit to its payout.** A payout that follows its deposit by seconds can be guessed from timing.

## Licence

[MIT](LICENSE)
