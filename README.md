# Zecca

Zecca is a payment app in the style of Revolut or Wise that runs on the XRP Ledger, layer 1: sign in with an email, pay with a tap or a QR code, and your balance and the amounts you send stay hidden on the public ledger.
You never see a seed phrase and never hold XRP: Zecca opens your account and pays every network fee, and you sign each payment with your own key.

Built at the Italian XRPL Hackathon 2026 (Bari), Track 2. Running on XRPL Devnet and Testnet.

## Try it

https://zecca-beta.vercel.app — sign up with an email (you get $50 of demo credit), send money to someone, open a payment and switch "What the ledger shows" to *Everyone else*. The click path a judge needs, and what each screen proves on the ledger, is in [DEMO.md](DEMO.md).

## Features

| Feature | XRP Ledger primitive | Where in the code |
|---|---|---|
| An account without holding XRP | Sponsored account creation: a 1-drop `Payment` with `tfSponsorCreatedAccount` from Zecca's sponsor | `packages/xrpl-core/src/ledger.ts` (`ensureAccount`) |
| Sign-up in one approval | `Batch`, all or nothing, signed once by the user | `services/api/src/onboarding.ts`, `packages/xrpl-core/src/confidential.ts` (`buildOnboarding`), `packages/xrpl-core/src/batch.ts` |
| Every fee paid by Zecca | Sponsor co-signature (`Sponsor`, `SponsorSignature`) on each user transaction | `packages/xrpl-core/src/sponsor.ts`, `services/api/src/prepared/` (sponsor policy) |
| Hidden balances and amounts | Confidential MPT: `ConfidentialMPTConvert`, `ConfidentialMPTSend`, `ConfidentialMPTMergeInbox` (ElGamal ciphertexts and zero-knowledge proofs) | `packages/xrpl-core/src/confidential.ts`, `services/api/src/intents/flow.ts`, `services/pool-worker/src/worker.ts` |
| Incoming money becomes spendable without an approval | Permission delegation: `DelegateSet` lets Zecca's relayer send `ConfidentialMPTMergeInbox` for the user | `packages/xrpl-core/src/confidential.ts`, `services/api/src/prepared/account-gate.ts` |
| Pay a shop by QR code or NFC tap | The same confidential deposit to the pool, from a payment request link | `services/api/src/paymentRequests/`, `apps/web/app/pay/`, `apps/merchant-nfc/` |
| Face ID on approvals | Privy passkey check on the `raw_sign` that signs the transaction | `apps/web/lib/passkey/`, `apps/web/lib/wallet/privy.ts` |
| Verified identity raises limits | Credentials: `CredentialCreate` by Zecca's KYC issuer, `CredentialAccept` signed by the user | `services/api/src/connectors/identity/` |
| Top up with a card | MoonPay sandbox delivers RLUSD by `Payment` on Testnet; once that is checked, Zecca's issuer mints the credit into the pool on Devnet (`Payment`, then `ConfidentialMPTConvert`) and the pool pays it out | `services/api/src/connectors/ramp/` |
| Payment card | Lithic sandbox card; purchases settled by a `ConfidentialMPTSend` from the pool to the card settlement account | `services/api/src/connectors/card/` |
| Earn | A Testnet `Payment` with a memo instruction opens a Flare smart account, which deposits into the Firelight vault on Flare Coston2 | `services/api/src/connectors/earn/` |
| Gold, silver, palladium | One MPT per metal; prices published on the ledger with `OracleSet` | `services/api/src/connectors/market/` |
| Statements with proofs | A proof per line that a `ConfidentialMPTSend` ciphertext encrypts the amount shown, checked against a public node | `services/api/src/connectors/proofs/` |

## How it works

Every payment goes through the Zecca pool: you send a confidential transfer to the pool, the pool checks the amount and sends a second confidential transfer to the person or shop you paid. The ledger shows two payments, to and from the pool, with the addresses visible and the amounts encrypted. Which deposit pays which recipient lives only in Zecca's database; no memo, tag or field on the ledger links them. The app's `/how-it-works` page gives the full picture, network by network; [docs/SPEC.md](docs/SPEC.md) has the ledger model.

### System architecture

The web app talks to one HTTP API; the API prepares each transaction the user approves, the user signs it in the browser with their Privy key, and the pool worker on its own thread is the only part that moves money out of the pool.

```mermaid
flowchart TB
  nfc["Android NFC app<br/>apps/merchant-nfc"]
  web["Web app, Next.js<br/>apps/web"]
  privy["Privy<br/>email or Google sign-in, embedded wallet:<br/>the user's key, raw_sign, Face ID"]

  subgraph api["Zecca API, Hono · services/api"]
    direction LR
    auth["auth"]
    dir["directory"]
    prep["prepared transactions<br/>+ sponsor policy"]
    intents["intents"]
    events["events, SSE"]
    conn["connectors<br/>ramp · card · earn<br/>market · identity · proofs"]
  end

  pool["Pool worker<br/>worker thread<br/>services/pool-worker"]
  db[("SQLite<br/>users, intents, books,<br/>deposit to payout routing")]
  ks[("Key store<br/>encrypted file:<br/>wallets, ElGamal keys")]

  devnet[["XRPL Devnet"]]
  testnet[["XRPL Testnet"]]
  flare[["Flare Coston2"]]
  moonpay["MoonPay sandbox"]
  lithic["Lithic sandbox"]
  eudi["EUDI verifier<br/>OpenID4VP"]

  nfc -- "tap: pay link" --> web
  web -- "sign in, raw_sign" --> privy
  web -- "HTTPS + SSE" --> api
  auth -- "verify token" --> privy
  api --- db
  api --- ks
  intents -- "RPC: expect deposit,<br/>pay out, mint, merge" --> pool
  pool --- db
  pool --- ks
  prep -- "sponsor co-signs, submits" --> devnet
  pool -- "watch the pool, decrypt,<br/>pay out, merge" --> devnet
  conn -- "credentials, metals, oracle" --> devnet
  conn --> eudi
  conn <--> moonpay
  conn <--> lithic
  moonpay -- "RLUSD" --> testnet
  conn -- "check deliveries,<br/>Earn payments" --> testnet
  testnet -. "executor relays" .-> flare
  conn -- "reads" --> flare
```

### One payment

The user signs a deposit to the pool; the sponsor co-signs only the exact transaction the API prepared; the pool worker decrypts the deposit and pays the recipient with a second confidential transfer.

```mermaid
sequenceDiagram
  autonumber
  actor A as Alice
  participant W as Web app + Privy
  participant API as Zecca API
  participant L as XRPL Devnet
  participant PW as Pool worker
  actor B as Bob's screen

  A->>W: Send $12 to @bob
  W->>API: POST /v1/transfers
  Note over API: intent and PreparedTx stored:<br/>ConfidentialMPTSend Alice to pool, Sponsor = Zecca
  API-->>W: transaction to approve
  A->>W: Approve
  Note over W: Privy raw_sign, Face ID if enrolled
  W->>API: POST /v1/tx/submit, signed blob
  Note over API: sponsor policy: same bytes as the PreparedTx,<br/>signed by this user, unused, not expired
  API->>L: sponsor co-signs, submit
  L-->>API: validated
  API-->>W: Sent, SSE intent.updated
  API->>PW: expect this deposit
  L-->>PW: deposit on the pool's account stream
  Note over PW: decrypt with the pool's key,<br/>amount must equal the intent's
  PW-->>API: received
  API-->>B: SSE: +$12.00 pending
  API->>PW: pay out $12 to Bob
  PW->>L: ConfidentialMPTSend pool to Bob
  PW-->>API: paid out
  API->>PW: merge Bob's inbox
  PW->>L: ConfidentialMPTMergeInbox by the relayer, delegated
  API-->>B: SSE: balance available
  Note over API,PW: Which deposit paid which payout is stored only in Zecca's database
```

### Sign-up in one signature

The sponsor creates the account with 1 drop, then the user signs one Batch; the inner transactions below are listed in the order `buildOnboarding` puts them.

```mermaid
sequenceDiagram
  autonumber
  actor U as New user
  participant W as Web app + Privy
  participant API as Zecca API
  participant L as XRPL Devnet

  U->>W: email code, pick a handle
  W->>API: POST /v1/onboarding/prepare
  API->>L: sponsor Payment of 1 drop, tfSponsorCreatedAccount
  Note over L: account exists, no XRP held
  Note over API: new ElGamal key for the user,<br/>kept in the key store.<br/>Batch built, issuer and sponsor<br/>add their BatchSigners
  API-->>W: Batch to approve
  U->>W: Approve, one signature
  W->>API: POST /v1/tx/submit
  API->>L: sponsor co-signs the fee, submit
  Note over API,L: Batch, all or nothing<br/>1. MPTokenAuthorize, reserve sponsored<br/>2. Payment issuer to user, $50 demo credit<br/>3. ConfidentialMPTConvert, the user's key registered<br/>4. ConfidentialMPTMergeInbox, credit spendable<br/>5. DelegateSet: the relayer may merge, reserve sponsored
  L-->>API: validated
  API-->>W: You're set, $50.00
```

### Paying a merchant by QR code or NFC

A charge on the till is a payment request whose link is the QR code, or the NFC tag the Android app emulates; the till shows "Paid" when the pool has checked the deposit, and the payout follows in the background.

```mermaid
sequenceDiagram
  autonumber
  actor M as Merchant till
  participant API as Zecca API
  participant N as Android NFC app
  actor C as Customer phone
  participant L as XRPL Devnet
  participant PW as Pool worker

  M->>API: POST /v1/payment-requests, $4.50
  API-->>M: request with its link /pay/:id
  alt QR code
    M->>C: the customer scans the QR code
  else NFC tap
    M->>N: zecca-nfc://emit?url=link
    N->>C: tap: an NFC Type 4 tag holding the link
  end
  C->>API: open /pay/:id, "Pay $4.50 to Caffè Bruno"
  C->>API: POST /v1/payment-requests/:id/pay
  API-->>C: transaction to approve
  C->>API: Approve, raw_sign, POST /v1/tx/submit
  API->>L: sponsor co-signs, deposit to the pool
  L-->>PW: deposit validated
  PW-->>API: received, amount checked
  API-->>M: SSE: Paid, fee $0.02, net $4.48
  API->>PW: pay out the net amount, then merge
  PW->>L: ConfidentialMPTSend pool to merchant
```

### What the public ledger sees and what Zecca knows

Anyone reading Devnet sees two transfers with encrypted amounts; the link between them, and the amounts in clear, are only in Zecca's database and key store.

```mermaid
flowchart TB
  subgraph ledger["Public ledger, Devnet"]
    direction LR
    t1["tx 1 · ConfidentialMPTSend<br/>Alice's address to the Zecca pool<br/>amount: ciphertext"]
    t2["tx 2 · ConfidentialMPTSend<br/>the Zecca pool to Bob's address<br/>amount: ciphertext"]
  end
  subgraph zecca["Zecca, private"]
    direction LR
    i["intent<br/>@alice to @bob, $12.00<br/>deposit tx 1, payout tx 2"]
    k["ElGamal keys of<br/>the pool and the users"]
  end
  i -. "deposit" .-> t1
  i -. "payout" .-> t2
```

| | Public ledger | Zecca |
|---|---|---|
| Addresses | Visible | Visible |
| Balances and amounts | ElGamal ciphertexts, with zero-knowledge proofs | Decrypted with the keys in its key store |
| Who paid whom | Payer to pool, pool to recipient | The intent links the deposit to its payout |
| Names and emails | Not on the ledger | In its database |
| Time of each transaction | Visible | Visible |

### Phase-2 connectors at a glance

Each connector is behind its own `FEATURE_*` flag and ends in an XRP Ledger transaction or a check against one.

```mermaid
flowchart LR
  id["Identity"] --> id2["EU wallet presents a PID<br/>OpenID4VP, EUDI verifier"] --> id3["CredentialCreate<br/>CredentialAccept<br/>Devnet"]
  earn["Earn"] --> e2["deposit to the pool<br/>Devnet"] --> e3["Testnet Payment + memo<br/>Flare smart account<br/>FXRP into Firelight<br/>Coston2"]
  metals["Metals"] --> m2["deposit to the pool<br/>Devnet"] --> m3["metal MPT from the issuer<br/>price from OracleSet<br/>Devnet"]
  st["Statements"] --> s2["statement<br/>signed by Zecca"] --> s3["proof per line:<br/>ciphertext = amount shown<br/>checked on a public node"]
  card["Card"] --> c2["Lithic ASA answered<br/>from the card balance"] --> c3["at clearing: pool pays<br/>the card settlement account<br/>Devnet"]
  topup["Top-up"] --> t2["MoonPay delivers RLUSD<br/>to Zecca's treasury<br/>Testnet"] --> t3["delivery checked, minted<br/>into the pool, paid out<br/>Devnet"]
```

## Proven on the ledger

Transactions from our test runs and from production on 20 and 21 November 2026. Devnet is reset from time to time, so these links can expire.

| What | Network | Transaction |
|---|---|---|
| Account created by the sponsor with 1 drop | Devnet | [`C4225559…40EC`](https://devnet.xrpl.org/transactions/C42255597710602E16C35FF416082D506C96598377F4210D5E42E847119740EC) |
| One-signature sign-up Batch (authorize, credit, convert to confidential, merge) | Devnet | [`C8594C53…AB55`](https://devnet.xrpl.org/transactions/C8594C5337AC38A74A7E3EBCF8333706372667453307E25DFAFA1C8E6ADCAB55) |
| Sign-up Batch on production, with the relayer's `DelegateSet` | Devnet | [`64DB5BCA…8B10`](https://devnet.xrpl.org/transactions/64DB5BCA3C9CB50F1966221BE53DDAB6C273813B7DA46D4B0661C2C2FD9F8B10) |
| Confidential send to the pool, fee sponsored | Devnet | [`D1DAE5A9…3777`](https://devnet.xrpl.org/transactions/D1DAE5A97DDCA1590AE6E3E489378AA7EAEDD44500DD7B0E76670CA135A83777) |
| Payout: confidential send from the pool to the recipient | Devnet | [`9D7B2D19…7A60`](https://devnet.xrpl.org/transactions/9D7B2D19449EC3934F899DEDB7C181E3FF01027FCA56A82B136A636C4C537A60) |
| The relayer merges the recipient's inbox (delegated `ConfidentialMPTMergeInbox`) | Devnet | [`F1B54C10…8F94`](https://devnet.xrpl.org/transactions/F1B54C10C43A917A6B8D0124E7C7FC7BABBD1F43054E0FD59EB6FB15ADB68F94) |
| MoonPay sandbox purchase delivered as RLUSD | Testnet | [`548D695E…8939`](https://testnet.xrpl.org/transactions/548D695E91F1F48720D64F0380C084DE3E0A6A4F97CA1599B79324FB5A1F8939) |
| One XRPL payment into the Firelight vault on Flare | Testnet | [`B53177C7…5307`](https://testnet.xrpl.org/transactions/B53177C7D31A4CC4F786824150F72A4EFE206DC7818989E98CC80A74E71B5307) |

Long-lived Devnet accounts: pool [`rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ`](https://devnet.xrpl.org/accounts/rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ), sponsor [`rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT`](https://devnet.xrpl.org/accounts/rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT), issuer [`rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3`](https://devnet.xrpl.org/accounts/rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3); confidential token (MPT issuance) `006C6AA175853178147D8F0D592D9DE3658C836F69985AB9`.

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

## Licence

[MIT](LICENSE)
