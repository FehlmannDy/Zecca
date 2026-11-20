# Zecca — specification

Status words used here: **proven** = ran on a real network on 2026-11-20 (see `../HANDOFF.md` for the transaction hashes); **to verify** = designed but never run, write the ledger test first and use the fallback if it fails; **new** = plain application code with no ledger risk.

---

## 1. Product

Zecca is a payment account. The public ledger sees that an account exists and that it transacts; it does not see how much the account holds or how much moves. Zecca's backend does see amounts (it holds the confidentiality keys), like any payment company sees its customers' payments.

| Feature | What the person does | Phase |
|---|---|---|
| Sign up | Enters an email, gets a code, picks a handle. One approval. | 1 |
| Balance | Sees a dollar balance and an activity list. | 1 |
| Top up | Buys with a card in the MoonPay widget inside the app. | 1 |
| Send | Types a handle (or phone, or email), an amount, approves. | 1 |
| Pay a merchant | Taps their phone on the merchant's, or scans a QR code; sees merchant and amount; approves. | 1 |
| Get paid (merchant) | Types an amount, shows the phone or the QR code, sees "Paid". | 1 |
| Sales (merchant) | Today's total, list of sales, fees, export. | 1 |
| Card | Gets a virtual card, loads it from the balance, pays anywhere cards work. | 2 |
| Earn | Moves money into a yield position and watches it. | 2 |
| Market | Buys and sells tokenised gold, silver and palladium. | 2 |
| Identity | Proves name and age from a European identity wallet to unlock higher limits and the market. | 2 |
| Proofs | Picks past payments and exports a statement a tax office or an auditor can check. | 2 |

Words: the app says **dollars** and shows `$`. The token is called cRLUSD in the one place where the ledger is explained; internally and on the ledger it is the MPT issuance called CMPT below. 1 token unit = 1 cent.

## 2. Ledger model

### 2.1 Networks

| Network | Used for | Why |
|---|---|---|
| XRPL Devnet (`rippled 3.4.1`) | Accounts, balances, every payment, card funding, market, credentials | Only network with Sponsor and ConfidentialTransfer live |
| XRPL Testnet | MoonPay delivery of RLUSD; XRP payment to the Flare Core Vault | MoonPay sandbox and Flare only exist there |
| Flare Coston2 | Smart account, FXRP, Firelight vault | Counterpart of Testnet |

Crossing from Testnet to Devnet is done in our books: when RLUSD lands on our Testnet treasury, we credit the same amount on Devnet. The app does not hide this; the "How it works" page says which network each step runs on.

### 2.2 Accounts (Devnet, already created — reuse them)

| Role | Address | Notes |
|---|---|---|
| Sponsor | `rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT` | Pays every fee and reserve of every user |
| Issuer | `rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3` | Issues CMPT; holds the issuer encryption key |
| Pool | `rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ` | Transit account for every payment; has its own ElGamal key |
| CMPT issuance | `006C6AA175853178147D8F0D592D9DE3658C836F69985AB9` | Confidential MPT, `Flags 32\|128`, `TransferFee` 0 |
| Card settlement | `rfPnRVpntUGgeaX64Z7DNy2XHkqL5qHZ8L` | Where card spend settles |
| Relayer | to create | Holds the delegated `ConfidentialMPTMergeInbox` permission of users (§2.5). Funded from the faucet; pays its own fees |
| Users, merchants | created at sign-up | 1 drop each, created by the sponsor; key held by Privy and owned by the user |

Seeds and encryption keys are in `../privy-xrpl-probe/web/state.json` and `../card-issuer/data/xrpl-state.json`. Import them with `scripts/import-keys.mjs` (§4.2); never print them.

Testnet and Coston2 addresses are in HANDOFF, "Accounts & addresses".

### 2.3 The one way a user transaction is made (proven)

```
API   builds the transaction (all fields set, Sponsor + SponsorFlags, LastLedgerSequence = current + 150)
API   stores it as a PreparedTx and returns it
App   asks Privy to sign: SHA-512Half(encodeForSigning(tx)) -> raw_sign -> 64-byte r||s
App   converts to DER, enforces low-S, verifies against the public key, sets TxnSignature, encodes
App   sends the blob back with the prepareId
API   checks the blob is exactly the PreparedTx (D11), co-signs as sponsor (SPN\0 prefix), submits, waits for validation
API   returns the ledger hash (it differs from the hash at signing, because of the sponsor signature)
```

In the browser the middle three lines are done by `xrpl-connect` with the Privy adapter (`manager.sign(tx)`), which also shows the review dialog. The page must contain `<xrpl-wallet-connector>`, or signing fails closed. Load it client-side only (no server rendering).

The user signs first and the sponsor after; the order cannot be swapped.

### 2.4 Sign-up (proven)

1. Sponsor sends a Payment of 1 drop with `tfSponsorCreatedAccount` to the user's new address.
2. API creates the user's ElGamal key and stores it in the key store.
3. One Batch, `tfAllOrNothing`, outer fee sponsored, signed once by the user, with `BatchSigners` from issuer and sponsor:
   1. `MPTokenAuthorize` CMPT (user, reserve sponsored)
   2. `Payment` of the welcome credit, issuer to user (omit when the credit is 0, as in probe case j)
   3. `ConfidentialMPTConvert` of that amount, registering the user's key (user)
   4. `ConfidentialMPTMergeInbox` (user)

Build details that cost hours the first time are in HANDOFF, "privy-xrpl-probe / Gotchas": inner flags and placeholders, explicit sequences, the Convert context hash, `autofill` returning a copy, `BatchSigners` order.

`WELCOME_CREDIT_MINOR` is configuration. The demo sets 5000; the UI labels it "Demo credit".

### 2.5 Money in an inbox (to verify)

A confidential transfer lands in the recipient's **inbox**. It counts in the balance we show, but it cannot be spent until a `ConfidentialMPTMergeInbox` moves it to the spendable part. That transaction is delegable and a delegated one was run (probe case i, on a funded account).

Plan: at sign-up the user also grants the relayer the `ConfidentialMPTMergeInbox` permission (`DelegateSet`, reserve sponsored). After each payout to a user, the relayer merges that user's inbox. The user never sees it.

- To verify first: `DelegateSet` as a fifth inner transaction of the sign-up Batch, on a 1-drop account with sponsored reserve.
- Fallback 1: a separate sponsored `DelegateSet` right after sign-up (a second approval on the sign-up screen).
- Fallback 2: no delegation. When the spendable part is short, the API returns a `ConfidentialMPTMergeInbox` to sign before the send ("Two quick approvals").

Only `MergeInbox` is delegated. Never delegate `ConfidentialMPTSend`: users sign their own payments (D10).

### 2.6 Every payment goes through the pool (proven for the deposit half and for pool sends)

```
payer   --ConfidentialMPTSend (signed by payer, fee sponsored)-->  pool          the deposit
pool    --ConfidentialMPTSend (signed by pool)------------------->  recipient     the payout
relayer --ConfidentialMPTMergeInbox on behalf of recipient                        §2.5
```

Addresses are public on the ledger, amounts are not. An observer sees "payer paid the pool" and "the pool paid recipient", never "payer paid recipient" and never how much. The pairing is an **intent** row in our database (§5, §8) and nothing else (D12).

- The API knows the deposit's hash the moment it submits it, so matching deposit to intent is exact, by hash.
- The pool worker still decrypts the deposit with the pool key and checks the amount equals the intent's amount before anything is credited.
- A deposit is credited once, keyed by its hash.
- The payout is `amount - fee`. The fee stays in the pool and is recorded (D13).
- "Received" (deposit validated and verified) is the moment the app tells both sides it is done (D4). The payout continues in the background and the recipient's balance already includes it as pending.
- Pool transactions are strictly sequential. Proof generation blocks for 0.7 to 3 s, which is why the pool lives in a worker thread.
- Decryption is a bounded search whose cost grows with the bound: try 10 000, then 200 000, then 10 000 000 units.

The same path serves: user to user, customer to merchant, card load, market purchase, earn deposit. Only the intent `kind` and what happens on "received" differ.

Known limit, to state plainly when asked and not to build around: a payout that follows its deposit by seconds can be guessed from timing.

### 2.7 Crediting from outside (top-up)

RLUSD arrives on our Testnet treasury. On Devnet the issuer pays the same amount of CMPT to the pool, the pool converts it to confidential, then pays it out to the user like any payout. Record each mint with the Testnet delivery hash so supply can be reconciled against deliveries.

## 3. Architecture

```
 User space      Merchant space      Android app (merchant phone)
     |                 |                    | emits the pay link over NFC
     +--------+--------+--------------------+
              |  HTTPS + SSE
        +-----v------------------------------------------+
Privy <-|  API: auth, directory, prepared transactions,  |
        |  sponsor policy, intents, payment requests,    |
        |  balances, events                              |
        +--+------+------+--------+--------+-------------+
           |      |      |        |        |
         Ramp   Card   Earn   Identity   Market     connectors, one module each, one vendor each
           |      |      |        |        |
        +--v------v------v--------v--------v--+
        | xrpl-core |  pool worker | key store |
        +-----+-----------+-------------------+
              |           |
        XRPL Devnet and Testnet
```

A connector that is down must not take the rest with it: each one is behind a feature flag and fails on its own screen only.

## 4. Components

For each: what it does, what to port, what is new. Function names in backticks exist today at the path given. Probe paths in this section's tables (`privy-xrpl-probe/…`, `card-issuer/…`) are given from `IXH26/`, as in HANDOFF.

### 4.1 `packages/xrpl-core`

Everything that builds, signs or submits a ledger transaction.

| Module | Port from | Target |
|---|---|---|
| `signer` | `privy-xrpl-probe/lib.mjs`: `compactToCanonicalDer`, `rawHashSigner`, `localSigner`, `mockRawSigner`, `privySigner` | Same functions, typed. `privySigner` takes an existing wallet id instead of creating a wallet per call |
| `sponsor` | `probe.mjs:37` `sponsorCosign`, `web/server.mjs:109` `cosignAndSubmit` | `cosignAsSponsor(sponsorWallet, blob) -> { tx_blob, hash }` |
| `batch` | `probe.mjs:86`, `web/server.mjs:64` `batchSigner`, `byAccountId` | `buildBatch({ outer, inners, sponsor, cosigners })` |
| `confidential` | `web/server.mjs:75/102/123` `prepareOnboarding`, `prepareSend`, balance decrypt; `card-issuer/src/xrpl-pool.js` | `buildOnboarding`, `buildSend`, `buildMergeInbox`, `buildConvert`, `decryptBounded`; keys come from a `KeyStore`, never from a file path |
| `client` | four copies, see HANDOFF "Shared pieces" | `createClient('devnet' \| 'testnet')` with reconnect, `submitAndWait`, serial queue per account |

`UserSigner` contract, the same for Privy, the mock and local keys:

```ts
interface UserSigner {
  address: string
  publicKey: string
  sign(tx: Transaction): Promise<{ tx_blob: string; hash: string }>   // hash in, 64-byte r||s out, DER + low-S + verify inside
}
```

Tests: unit tests for DER conversion (65-byte input, high-S input, wrong length), for Batch building against the JSON of the transactions that validated (`privy-xrpl-probe/results-privy.json`), and the ledger suite a to k.

### 4.2 `packages/keystore`

```ts
interface KeyStore {
  getWallet(role: 'sponsor' | 'issuer' | 'pool' | 'relayer' | 'cardSettlement' | 'kycIssuer' | 'testnetTreasury'): Wallet
  getElGamal(owner: 'issuer' | 'pool' | { user: string }): ElGamalKeyPair
  createUserElGamal(address: string): ElGamalPublicKey      // idempotent
  has(owner): boolean
}
```

Implementations: in-memory (tests) and a file encrypted with a key from the environment (`KEYSTORE_PASSPHRASE`), `chmod 600`, outside the repository. `scripts/import-keys.mjs` reads the existing `state.json` files and writes the new store; it prints role names and addresses only. `scripts/bootstrap-ledger.mjs` creates every account, the issuance and the keys from nothing (faucet, issuance with `Flags 32|128`, issuer key, pool key registered with a Convert of 0) and is safe to run twice.

### 4.3 `services/api`

Hono on Node, SQLite. Modules: `auth`, `directory`, `prepared` (prepare, verify, co-sign, submit), `policy`, `intents`, `paymentRequests`, `balances`, `events`, plus one folder per connector. Today's five routes on port 8787 (`web/server.mjs`) are the seed for `prepared`.

**Sponsor policy (D11).** At prepare time, store the transaction's signing hash, the user, the kind and an expiry (the `LastLedgerSequence`). At submit time, decode the blob, strip the signature, recompute the signing hash; refuse unless it equals a stored, unexpired, unused PreparedTx of the authenticated user, and unless the signature verifies against that user's public key. Mark it used before submitting. Also: one sign-up per Privy user, a cap per transaction and per day (configuration), a rate limit per user.

**Balances.** The source shown to the user is our own ledger of intents (instant). A background job decrypts the on-ledger balance (spendable and inbox) and flags any difference; it never blocks a screen.

### 4.4 `services/pool-worker`

Port `card-issuer/src/xrpl-pool.js` and `xrpl-pool-worker.js` (`createXrplPoolInWorker -> { addresses, depositsFrom, settle, payout, close }`), then generalise from "card deposits" to intents.

```ts
interface PoolWorker {
  start(): Promise<void>
  expectDeposit(i: { intentId: string; txHash: string; from: string; amountMinor: number }): void
  on(event: 'received' | 'paidOut' | 'failed', cb: (e: PoolEvent) => void): void
  payout(i: { intentId: string; to: string; amountMinor: number }): Promise<{ hash: string }>
  mintIn(amountMinor: number, reference: string): Promise<{ hash: string }>     // §2.7
  mergeInboxFor(address: string): Promise<{ hash: string }>                     // via the relayer, §2.5
  status(): { spendableMinor: number; inboxMinor: number; queue: number }
}
```

Must hold: one transaction at a time; a deposit credited once; a payout sent once per intent. For the last one, persist the sequence number reserved for a payout before submitting it, and on restart check the ledger for that sequence before sending again. The watcher subscribes to the pool account and also polls `account_tx` every 15 s. Log any event-loop stall over 100 ms.

### 4.5 Ramp connector (MoonPay)

Port `moonpay-ramp/lib/moonpay.mjs` (`signQuery`, `ipHash`, `signedWidgetUrl`, `verifyWebhookSignature`), `lib/xrpl.mjs`, `watcher.mjs` and the overlay page.

- The signed URL needs `allowedIpAddress`, a hash of the browser's public IP; the browser and the hash must match.
- Deliver to the Zecca **Testnet treasury** (it needs the RLUSD trust line to `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`) and identify the user with the widget's external transaction id. Today's code delivers to one hard-coded wallet; that changes.
- Credit only after checking on the ledger: validated, `tesSUCCESS`, right destination, right issuer, and use the **delivered** amount (D5). Then §2.7.
- The sandbox delivers one hundredth of the quote. `RAMP_SANDBOX_SCALE` (default 1, demo 100) multiplies the credit, and the screen says "Sandbox" when it is not 1.
- Withdrawal (MoonPay sell) has never been run. Build it behind its own flag and try it; if the sandbox refuses, leave the flag off.
- `POST /v1/dev/credit` exists only when `DEMO_MODE=1`, for a demo without the widget. It goes through §2.7 like a real top-up.

### 4.6 Card connector (Lithic) — phase 2

Port `card-issuer/src/lithic.js`, `store.js`, `server.js` and their tests (`card-issuer/test/*.test.js`, written for `node --test`). It works end to end today; the job is to remove its dependency on port 8787 and on `state.json` (`createXrplPoolInWorker` takes `webStatePath` and `cardStatePath` today) by using `KeyStore`, `xrpl-core` and the shared pool worker.

- Loading the card is an intent of kind `card_load`: a normal user-signed deposit to the pool, credited to the card's sub-balance on "received".
- The authorization webhook answers from the sub-balance in 1 to 10 ms and never touches the ledger. Lithic's deadline is 6 s. Settlement on the ledger happens after the answer.
- Sandbox traps (201 on a decline, 1 call per second, signed headers only a few minutes after setup) are in HANDOFF, "card-issuer / Gotchas".
- Clearing, voids and refunds are not handled today. Add at least void and refund back to the sub-balance.
- Why the card has its own balance: a card purchase must be answered in under 6 s, a confidential payment needs the user's approval and about 10 s on the ledger. So the user moves money to the card once, with one approval, and every purchase after that is instant. Paying straight from the main balance would mean letting Zecca send from the user's account without their approval (a delegated `ConfidentialMPTSend`); that is ruled out by D10. In the app this reads as a card balance you top up, like a prepaid card.
- The sandbox has no real shops. `POST /v1/dev/card/simulate` (only with `DEMO_MODE=1`) asks Lithic to simulate a purchase on the user's card (`POST /v1/simulate/authorize`), which calls our webhook like a real one. The card screen's "Test purchase" button uses it. This is how the card is demonstrated and how E2E-2 tests it.

### 4.7 Earn connector (Flare, Firelight) — phase 2

Port `flare-firelight/memo.mjs` (`memoFF`, `compactUserOp`, `serializedMemosSize`), `chain.mjs`, `step3.mjs`, `step5.mjs`.

- Deposit: one Testnet Payment to the Core Vault with the compact memo (D6), 1002 bytes; assert the serialized size is under 1024 before sending. The position is readable about 160 s later. Failed executions are silent: use a timeout.
- Withdrawal takes three more payments and a wait of 4 to 8 hours. Show it as "Requested, available in a few hours".
- The vault takes XRP, not dollars. The user's money is in dollars on Devnet, so a deposit is a conversion:
  1. "Add $50 to Earn": the user signs a normal confidential deposit to the pool on Devnet (intent `earn_deposit`).
  2. On "received", our Testnet treasury sends the same value in XRP, at the price feed's rate, to the user's Testnet address. Testnet XRP comes from the faucet; on Mainnet this step would be a swap of RLUSD for XRP on the ledger's exchange.
  3. The user approves the one payment to the Core Vault that opens the smart account and deposits.
  4. About 160 s later the position shows.
  Withdrawal runs the same path backwards and ends with a dollar credit through the pool.
- The position is shown in XRP with a dollar estimate, and the screen says the value moves with the price of XRP.
- Zecca earns twice here, and both are shown before the user approves: `EARN_FEE_BPS` of the yield, taken at withdrawal (default 1000, that is 10%), and `EARN_SWAP_BPS` on each conversion between dollars and XRP, in and out (default 30, that is 0.3%), since Zecca does the conversion.
- Who signs on Testnet (to verify): preferred, the user's own Privy key (same address on Testnet; our treasury funds that account with the XRP to deposit, since Testnet has no sponsorship); the API pre-fills every field so the adapter, which is configured for Devnet, has nothing to autofill. Fallback: a per-user Testnet wallet in the key store.
- Moving dollars into Earn is an intent of kind `earn_deposit` on Devnet; on "received" the treasury funds the Testnet side.

### 4.8 Identity connector (EUDI) — phase 2

Port `identity/lib.mjs` (`buildPresentationRequest`, `createTransaction`, `qrUrl`, `pollTransaction`, `readIdentity`). Verifier: `https://verifier-backend.eudiw.dev`, no account needed.

- Keep the minimum: given name, family name, birth date, and a computed "over 18". Do not log the raw presentation.
- On success, put a credential on the ledger: `CredentialCreate` by a Zecca KYC issuer, then a sponsored `CredentialAccept` signed by the user (probe case k).
- Tiers, as configuration.
  - Tier 0, email only: balance up to $150, $50 per payment, $150 sent per month, no card, no market, no Earn. The numbers mirror the EU exemption for low-value electronic money (Directive 2015/849, article 12: 150 stored, 50 per online payment). They are a product choice for the demo, not a legal position: from 10 July 2027 the EU's anti-money-laundering regulation requires crypto providers to identify every customer whatever the amount, so in the EU tier 0 would have to go.
  - Tier 1, identity verified: caps lifted to `TX_CAP_MINOR`, card, market and Earn unlocked.
  - Hitting a cap is a designed moment, not an error: "You've reached the limit for unverified accounts. Verify your identity to lift it." with the button to the identity screen.
- `IDENTITY_MODE=mock` returns a fixed test identity after 3 s so the rest can be built and demoed without a wallet. The screen says "Test identity".

### 4.9 Market (metals) — phase 2, mostly new

Three ordinary MPTs issued on Devnet by a Zecca market issuer: gold, silver, palladium, in milligrams. Holdings of metals are public on the ledger; only the dollar leg is hidden.

- Prices behind a `PriceFeed` interface. To verify: publish them on Devnet with `OracleSet` from a Zecca oracle account and read them back; fallback: the feed stays off-ledger. Source: a public metals price API if reachable, else a dated fixture, and the screen shows the price's timestamp.
- Buy: intent of kind `market_buy` (deposit to the pool); on "received" the market issuer pays the metal to the user. The user needs an `MPTokenAuthorize` for that metal first, reserve sponsored. To verify: one Batch with the authorize and the confidential send. Fallback: two approvals on the first purchase of each metal.
- Sell: the user pays the metal back (public MPT Payment, fee sponsored); on validation the pool pays out dollars.
- Zecca's margin is a spread around the feed price, `MARKET_SPREAD_BPS` (default 100, that is 1%): buy at price plus half, sell at price minus half. The asset page shows both prices.
- Requires tier 1.

### 4.10 Proofs — phase 2, new

The user selects activity items; the API produces a statement: for each, date, counterparty name, amount, direction, the deposit and payout hashes, and a signature by Zecca over the whole document. A reader can check each hash on a public explorer and Zecca's signature.

To investigate before promising more: whether `@xrplf/mpt-crypto` exposes a proof that a given ciphertext on the ledger encrypts a given amount. If it does, include it per line so the amount can be checked without trusting Zecca. If it does not, the statement says amounts are attested by Zecca.

### 4.11 `apps/web`

Next.js App Router. Routes: `/` landing, `/app/*` user space, `/merchant/*` merchant space, `/pay/[id]` pay page (works logged out up to the approve step), `/wallet/privy` the adapter's redirect. A merchant is a user with `role: 'merchant'`; one login, a switch between spaces when the account has both.

A merchant signs up exactly like a user: email, code, then business name instead of a handle prompt alone, and the same single approval (§2.4). No hardware, no contract, no separate tool. `/merchant` opened by someone not signed in starts that flow with the business switch already on. Checking that the business is real is out of scope and not simulated. Screens and copy: `UI.md`.

Approving with Face ID or a fingerprint (to verify). Today an approval is a click on "Approve" in the adapter's review dialog. Privy offers passkey verification for wallet signatures: once a user has enrolled a passkey, each signature asks for it, which on a phone is Face ID or a fingerprint. It is documented for Privy's EVM and Solana wallets; whether it applies to an XRPL wallet signing through `raw_sign` and the xrpl-connect adapter is unknown. Test it behind `FEATURE_PASSKEY`: offer "Approve with Face ID" after sign-up, enrol, and check that the next signature prompts. Privy may remember a passkey check for some minutes, so the prompt can appear once per session of activity instead of on every payment; show whatever it really does. It needs two switches in the Privy dashboard, which the owner was setting on the evening of 20 November (check, do not assume): passkeys enabled as a login method, with "Enable passkeys for sign up" left off so that an account always has an email and the passkey is added after sign-up; and, under User management > Authentication > MFA, "Enable MFA for transactions" with Passkey selected. In the same test, try the passkey as a way to sign in ("Sign in with Face ID" next to the email field), which needs the passkey login method enabled in the dashboard and the adapter's login to offer it. Each half is independent: ship whichever works. Fallback: email login and the Approve button, and the copy never mentions Face ID.

Pointers from Privy's docs (docs.privy.io, "MFA" under user authentication): a passkey must be linked to the user before it can be enrolled; enrolment and verification are `useMfaEnrollment` (`initEnrollmentWithPasskey`, `submitEnrollmentWithPasskey({ credentialIds })`) and `useMfa` (`init('passkey')`, `submit('passkey', options)`) in `@privy-io/react-auth`. The xrpl-connect adapter may not expose them: check its source, and if it does not, use Privy's SDK next to the adapter with the same app id. How long a verification stays valid is a dashboard setting ("MFA verification duration"); for the demo the shortest value makes Face ID show on each payment.

What the passkey is and is not, so the copy stays true: it is a key held by the phone and unlocked by Face ID or a fingerprint, used to prove to Privy that the owner is present. It is not the XRPL key and it does not sign the transaction; it unlocks Privy's signature. Card purchases never ask for it, because they do not touch the ledger at the moment of purchase (§4.6).

Sign in with Google (to verify). Google is switched on in the Privy dashboard with Privy's default OAuth credentials, so nothing else is needed on Google's side. Only email login has been run. Check whether the xrpl-connect adapter's login offers Google; if it does not, start Google login with Privy's SDK next to the adapter (same app id) and hand the session to it. Local redirects must be allowed for `http://localhost:3100`. If it works, the sign-up screen shows "Continue with Google" above the email field; if it does not, the button is not shown.

Privy app id `cmwp3ayt902ll0il2cu05wx46`; `PrivyAdapter({ appId, redirectUri: origin + '/wallet/privy' })`, network `devnet`. Email login is enabled in the Privy dashboard. Do not enable Privy's own fee sponsorship.

### 4.12 `apps/merchant-nfc`

Copy of `../nfc-paylink` (Android, package `ch.ixh.nfcpaylink`). It emulates an NFC tag carrying a URL; it receives the URL in the intent extra `url`. Only the merchant's phone needs Android; the customer's phone can be an iPhone or an Android.

- New: the merchant space opens the app with the request's link (an `intent:` link from Chrome on Android). The app must accept only `https` links on the configured Zecca host.
- The QR code is always shown next to the NFC prompt. It is the path that is known to work.
- Behaviour on phones is untested: on iPhone the customer taps a notification before the page opens. `TEST_PROTOCOL.md` is the checklist; put the result in `docs/HUMAN_STEPS.md`.

### 4.13 Where Zecca earns

| Line | Who pays | In the build |
|---|---|---|
| Merchant fee | Merchant, `MERCHANT_FEE_BPS` per sale (0.5%) | Phase 1, taken at payout |
| Metals spread | Buyer and seller, `MARKET_SPREAD_BPS` | Phase 2, in the quoted price |
| Share of Earn yield | The saver, `EARN_FEE_BPS` of earnings | Phase 2, at withdrawal |
| Conversion margin on Earn | The saver, `EARN_SWAP_BPS` each way between dollars and XRP | Phase 2, in the rate |
| Card interchange | The shop's bank, on every card purchase | Not built; paid by the card network to the issuer |
| Currency conversion | Sender, on transfers that change currency | Not built; Zecca is dollars only today |
| Paid plan | Subscriber: higher limits, physical card, priority | Not built |

Sending and paying stay free for the user. Every fee Zecca takes is recorded on its intent as `feeMinor` and shown to the person who pays it before they approve. The landing page lists the first three as live and the last three as planned.

### 4.14 Demo shop

A small fictional online shop inside the web app, at `/demo/shop`, so the demo shows Zecca from the outside: someone buys something on a website and pays with Zecca. It is labelled "Demo shop" on every page and uses an invented name (UI §5.11). It has one product page, a basket, a checkout with two ways to pay, and an order confirmation with a receipt.

- **Pay with Zecca** (phase 1, with the merchant work). The shop is a seeded merchant account whose key is in the key store. Checkout creates a payment request through the normal API and shows its QR code on a laptop, or opens `/pay/[id]` on a phone. The shop page listens to the request's public event stream and moves to "Order confirmed" when it is paid.
- **Pay by card** (phase 2, with the card). A card form. The user types their Zecca card's number, expiry and code. `POST /v1/demo/shop/charge` checks expiry and code against the card, then asks Lithic to simulate the purchase with that number, the shop's name as descriptor and a merchant category code (`POST /v1/simulate/authorize` takes `amount`, `descriptor`, `pan`, and optionally `mcc` and `merchant_acceptor_id`). Lithic calls our authorization webhook as it would for a real shop. Read the decision from the transaction (HANDOFF, "card-issuer / Gotchas"), show "Order confirmed" or "Card declined", then call `POST /v1/simulate/clearing` so the purchase settles.
- **Receipts**, both sides. The shop shows an order number, the item, the amount, the payment method, the time. In the Zecca app the same purchase appears in activity, and its detail is a receipt: shop name, amount, time, method ("Zecca balance" or "Card ending 4417"), status ("Authorised" then "Completed"), reference. For a card purchase the data comes from Lithic's transaction; for a Zecca payment it is the intent, with the "What the ledger shows" panel.

This replaces a bare "simulate" button: the card screen links to the shop ("Try your card in the demo shop").

## 5. Data objects

Canonical definitions go in `packages/contracts` as zod schemas; this is their content. All ids are opaque strings. All times are ISO 8601 UTC. All amounts are integers in minor units.

```ts
type Role = 'user' | 'merchant'

type User = {
  id: string; role: Role[]; handle: string            // ^[a-z0-9_]{3,20}$, unique, shown as @handle
  displayName: string; address: string                // XRPL classic address
  email?: string; phone?: string
  tier: 0 | 1; createdAt: string
  merchant?: { businessName: string; feeBps: number }
}
type PublicProfile = Pick<User, 'id' | 'handle' | 'displayName'> & { isMerchant: boolean }

type Balance = {
  availableMinor: number      // spendable now
  pendingMinor: number        // received, payout or merge still in flight
  cardMinor?: number; updatedAt: string
}

type PreparedTx = { prepareId: string; kind: TxKind; tx: object; expiresAt: string }
type TxKind = 'onboarding' | 'send' | 'merge_inbox' | 'delegate' | 'credential_accept' | 'market_authorize' | 'market_sell' | 'earn_deposit'

type IntentKind = 'p2p' | 'merchant' | 'card_load' | 'earn_deposit' | 'market_buy' | 'withdraw'
type IntentStatus = 'created' | 'submitted' | 'received' | 'paid_out' | 'failed' | 'expired'
type Intent = {
  id: string; kind: IntentKind; status: IntentStatus
  fromUserId: string; toUserId?: string
  amountMinor: number; feeMinor: number; note?: string
  paymentRequestId?: string
  depositTxHash?: string; payoutTxHash?: string
  failure?: { code: string; message: string }
  createdAt: string; updatedAt: string
}

type PaymentRequestStatus = 'created' | 'opened' | 'paid' | 'expired' | 'cancelled'
type PaymentRequest = {
  id: string; merchantId: string; merchantName: string
  amountMinor: number; reference?: string
  status: PaymentRequestStatus; url: string            // https://<web>/pay/<id>
  expiresAt: string; paidAt?: string; intentId?: string
}

type Activity = {                                      // what one user sees of an intent
  id: string; intentId: string; direction: 'in' | 'out'
  kind: IntentKind | 'topup' | 'welcome'
  counterparty?: PublicProfile; amountMinor: number; feeMinor: number
  status: 'pending' | 'done' | 'failed'; note?: string; at: string
  ledger: { depositTxHash?: string; payoutTxHash?: string; network: 'devnet' | 'testnet' }
}

type Sale = { id: string; paymentRequestId: string; amountMinor: number; feeMinor: number; netMinor: number
              payer?: PublicProfile; reference?: string; paidAt: string; payoutStatus: 'pending' | 'done' }

type ApiError = { error: { code: string; message: string } }   // message is English, fit to show to a user
```

## 6. HTTP API

Base path `/v1`. JSON. Errors are `ApiError` with a 4xx or 5xx status. Every route except the ones marked public needs `Authorization: Bearer <session>`.

### 6.1 Auth (decide in M0)

Preferred: the app obtains a Privy access token and the API verifies it with Privy's verification key, then issues its own short session token. Check first whether `@xrpl-commons/xrpl-connect-privy` exposes the Privy token (read its source in `node_modules`). Fallback: the API issues a nonce, the user signs it through the same `raw_sign` path, the API verifies it against the account's public key. Either way the session is bound to one XRPL address. Record the choice in `docs/DECISIONS.md`.

### 6.2 Phase 1

| Route | Request | Response |
|---|---|---|
| `GET /config` (public) | – | `{ network, addresses: { sponsor, issuer, pool }, issuanceId, features: Record<string, boolean>, limits }` |
| `POST /auth/session` (public) | `{ privyToken }` or `{ address, nonce, signature }` | `{ token, user?: User }` — `user` absent means not signed up yet |
| `GET /directory/handle-available?handle=` (public) | – | `{ available: boolean }` |
| `POST /onboarding/prepare` | `{ address, publicKey, handle, displayName, role, businessName? }` | `PreparedTx` (kind `onboarding`) |
| `POST /tx/submit` | `{ prepareId, txBlob }` | `{ status: 'validated' \| 'failed', hash, engineResult }` |
| `GET /me` | – | `User` |
| `GET /balance` | – | `Balance` |
| `GET /directory/resolve?q=` | handle, phone, email or XRPL address | `{ kind: 'zecca', profile: PublicProfile } \| { kind: 'external', address } \| { kind: 'unknown' }` |
| `GET /contacts` | – | `PublicProfile[]` — people this user has paid or been paid by |
| `POST /transfers` | `{ to: string /* userId */, amountMinor, note? }` | `{ intent: Intent, prepared: PreparedTx }` |
| `GET /transfers/:id` | – | `Intent` |
| `GET /activity?cursor=&limit=` | – | `{ items: Activity[], nextCursor? }` |
| `POST /payment-requests` (merchant) | `{ amountMinor, reference? }` | `PaymentRequest` |
| `GET /payment-requests/:id` (public) | – | `PaymentRequest`; the first read by someone other than the merchant sets `opened` |
| `POST /payment-requests/:id/pay` | – | `{ intent: Intent, prepared: PreparedTx }` |
| `POST /payment-requests/:id/cancel` (merchant) | – | `PaymentRequest` |
| `GET /merchant/sales?from=&to=` | – | `{ items: Sale[], totals: { grossMinor, feeMinor, netMinor, count } }` |
| `GET /merchant/sales.csv?from=&to=` | – | CSV |
| `GET /events` | SSE | §7 |
| `POST /ramp/session` | `{ direction: 'buy', fiatAmount?, fiatCurrency? }` | `{ widgetUrl, externalId }` |
| `POST /webhooks/moonpay` (public, signature checked) | MoonPay body | `200` |
| `POST /dev/credit` (only with `DEMO_MODE=1`) | `{ amountMinor }` | `Intent` |

`POST /transfers` and `POST /payment-requests/:id/pay` both create an intent and return the unsigned `ConfidentialMPTSend` to the pool. The app signs it and calls `POST /tx/submit`; on validation the API moves the intent to `submitted` and tells the pool worker to expect it.

### 6.3 Phase 2

| Route | Request | Response |
|---|---|---|
| `POST /card` | – | `{ id, last4, expMonth, expYear, state }` |
| `GET /card` | – | card + `balanceMinor` + recent authorizations |
| `GET /card/secret` | – | PAN, CVC for display, never stored by us beyond the request |
| `POST /card/load` | `{ amountMinor }` | `{ intent, prepared }` |
| `POST /webhooks/lithic/asa` (public, HMAC checked) | Lithic body | Lithic decision |
| `POST /dev/card/simulate` (only with `DEMO_MODE=1`) | `{ amountMinor, merchantName }` | `{ approved: boolean }` |
| `POST /demo/shop/orders` (public, only with `DEMO_MODE=1`) | `{ items }` | `{ orderId, amountMinor, paymentRequest }` |
| `POST /demo/shop/charge` (public, only with `DEMO_MODE=1`) | `{ orderId, pan, expMonth, expYear, cvc }` | `{ approved: boolean, receipt? }` |
| `GET /demo/shop/orders/:id` (public) | – | order with status and receipt |
| `POST /card/freeze`, `POST /card/unfreeze` | – | card |
| `GET /earn/position` | – | `{ depositedXrp, valueXrp, valueUsdMinor, apyPct?, pendingWithdrawal? }` |
| `POST /earn/deposits` | `{ amountMinor }` | `{ intent, prepared }` then a second `PreparedTx` (kind `earn_deposit`, Testnet) once funded |
| `POST /earn/withdrawals` | `{ amountXrp }` | `{ status: 'requested', claimableAt }` |
| `POST /identity/sessions` | – | `{ id, qrUrl, deepLink, expiresAt }` |
| `GET /identity/sessions/:id` | – | `{ status: 'pending' \| 'verified' \| 'rejected' \| 'error', identity?: { givenName, familyName, birthDate, over18 }, prepared?: PreparedTx }` |
| `GET /market/assets` | – | `[{ symbol, name, unit, priceMinor, priceAt, change24hPct?, history: number[] }]` |
| `GET /market/holdings` | – | `[{ symbol, quantityMg, valueMinor }]` |
| `POST /market/orders` | `{ symbol, side: 'buy' \| 'sell', amountMinor? , quantityMg? }` | `{ orderId, intent?, prepared }` |
| `POST /disclosures` | `{ activityIds: string[] }` | `{ id, url }` — a JSON and a printable page |
| `GET /disclosures/:id` (public with the id) | – | the statement |

## 7. Events (SSE on `GET /v1/events`)

One stream per session. Each message is `{ type, data, at }`.

| Type | Data | Sent to |
|---|---|---|
| `balance.updated` | `Balance` | the account owner |
| `intent.updated` | `Intent` | payer and recipient |
| `payment_request.updated` | `PaymentRequest` | the merchant; and anyone holding the pay page open (public stream `GET /v1/payment-requests/:id/events`) |
| `activity.created` | `Activity` | the account owner |
| `card.authorization` | `{ amountMinor, merchant, approved }` | the cardholder |

The merchant screen turns to "Paid" on `payment_request.updated` with `status: 'paid'`. If the stream drops, the screen polls the request every 2 s until it reconnects.

## 8. State machines

**Intent**

```
created --tx submitted and validated--> submitted --pool verifies deposit--> received --payout validated--> paid_out
   |                                        |                                   |
   +--LastLedgerSequence passed--> expired  +--amount mismatch--> failed        +--payout error--> failed (retry is manual, money stays in the pool, logged)
```

Effects on `received`, by kind: `p2p` and `merchant` queue a payout and mark the payment request `paid`; `card_load` credits the card sub-balance; `market_buy` delivers the metal; `earn_deposit` funds the Testnet side. Effects must be idempotent, keyed by intent id.

**Payment request**

```
created --page opened by a customer--> opened --intent received--> paid
created | opened --expiresAt (default 10 min)--> expired
created | opened --merchant cancels--> cancelled
```

Only one intent can pay a request. A second attempt gets `409` with a message the pay page can show.

## 9. End-to-end tests

**E2E-1, the demo path (phase 1).** Two browser contexts, mock signer.

1. Ana signs up as a user with handle `ana`; home shows the demo credit.
2. Bruno signs up as a merchant, business name "Caffè Bruno".
3. Ana tops up $40 through `POST /dev/credit`; balance rises (she stays under the tier 0 cap of $150).
4. Ana sends $12.00 to another user `carla` (created by API in setup); Ana's activity shows it, Carla's balance shows it.
5. Bruno creates a request for $4.50; the QR code and link appear.
6. Ana opens the link, sees "Caffè Bruno" and "$4.50", approves.
7. Bruno's screen shows "Paid" without a reload; the sale is in his list with the fee and the net.
8. Ana's activity item for the coffee opens the "What the ledger shows" panel with two transaction hashes.
9. Ana buys an item in the demo shop with "Pay with Zecca"; the shop shows "Order confirmed" and the receipt appears in her activity.
10. A user at tier 0 tries to send $60 and gets the limit screen.

Run it on the mock ledger at every merge and on Devnet at every integration point.

**E2E-2 (phase 2)**, one per feature: card load, then a purchase in the demo shop approved with its receipt in the app, and one declined; earn deposit shows a position; identity (mock mode) lifts the tier and unlocks the market; buy and sell gold; export a statement and open it.

## 10. Configuration

`.env.example` lists every variable with a comment. Minimum:

| Variable | Meaning |
|---|---|
| `LEDGER_MODE`, `SIGNER_MODE`, `IDENTITY_MODE`, `DEMO_MODE` | Switches described above |
| `WEB_ORIGIN`, `API_ORIGIN`, `PUBLIC_WEBHOOK_BASE` | Local: `http://localhost:3100`, `http://localhost:8800`, the tunnel URL |
| `KEYSTORE_PATH`, `KEYSTORE_PASSPHRASE` | Key store |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | From `../privy-xrpl-probe/.env` |
| `MOONPAY_PUBLISHABLE_KEY`, `MOONPAY_SECRET_KEY`, `MOONPAY_WEBHOOK_KEY` | Same names as in `../moonpay-ramp/.env` |
| `RAMP_SANDBOX_SCALE` | §4.5 |
| `LITHIC_API_KEY`, `LITHIC_BASE_URL` | Same names as in `../card-issuer/.env` |
| `WELCOME_CREDIT_MINOR`, `MERCHANT_FEE_BPS`, `TX_CAP_MINOR` | Product settings; defaults 5000, 50, 500000 |
| `TIER0_BALANCE_CAP_MINOR`, `TIER0_TX_CAP_MINOR`, `TIER0_MONTHLY_SEND_CAP_MINOR` | Limits without identity, §4.8; defaults 15000, 5000, 15000 |
| `MARKET_SPREAD_BPS`, `EARN_FEE_BPS`, `EARN_SWAP_BPS` | Zecca's margins, §4.13; defaults 100, 1000, 30 |
| `FEATURE_CARD`, `FEATURE_EARN`, `FEATURE_MARKET`, `FEATURE_IDENTITY`, `FEATURE_PROOFS`, `FEATURE_WITHDRAW` | Feature flags, all off until their E2E-2 test is green |

Copy values between `.env` files with a script or by hand without printing them.

## 11. What Zecca must not claim

Keep the product and the landing page inside what is true today.

- Not non-custodial: the signing key is the user's (Privy), the confidentiality key is held by Zecca.
- Not anonymous: addresses are public, amounts are hidden, and Zecca knows its customers.
- Devnet and Testnet only. Sponsor and ConfidentialTransfer are not on Mainnet yet.
- RLUSD is not authorised under MiCA in the EU today; MoonPay's widget says so itself. Do not write "available in Europe".
- The yield comes from Firelight on Flare, is paid in XRP and varies. Do not print a fixed rate unless it is read live.
- Timing can link a deposit to its payout.
