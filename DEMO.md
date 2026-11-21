# Zecca — demo script

**Live:** https://zecca-beta.vercel.app (web, Vercel) · API https://zecca-api-production.up.railway.app (Railway) · XRPL **Devnet** for every payment, **Testnet** + Flare **Coston2** for top-up and Earn.
Everything a judge needs is in the browser. Use two devices (or two browser profiles): one is the customer, one is the merchant.

## The 3-minute path (phase 1)

| # | Do | See | What it proves |
|---|---|---|---|
| 1 | Customer phone: open the site → **Open the app** → email → code → pick a handle → **Approve** | Three lines tick ("Creating your account", "Opening your private balance", "Adding your demo credit"), then "You're set" and **$50.00** | Email login, a key the user owns (Privy), an XRPL account created by Zecca's sponsor with 1 drop, and **one** signature for the whole sign-up Batch (MPT authorize + credit + confidential convert + merge + delegation). The user never holds XRP. |
| 2 | Laptop: open `/merchant` → sign up with **I'm setting up a business** → "Caffè Bruno" | The till | A merchant is just a user with a business name. No hardware, no contract. |
| 3 | Customer: **Send** → type a handle → $12 → **Approve** | The arches fill: "Sealing the amount" → "Sending" → "Confirmed", then "Sent. $12.00 to …" | A confidential payment (amount encrypted on the ledger), fee paid by the sponsor, signed only by the user. |
| 4 | Customer: open the payment in **Activity** → **What the ledger shows** → switch to **Everyone else** | The amount becomes a sealed block of real ciphertext, the counterparty becomes "Zecca pool", two transaction links | Click a link: the public Devnet explorer shows a `ConfidentialMPTSend` with no readable amount. This panel is the product's argument. |
| 5 | Merchant: **Charge** $4.50 | Full-screen QR code (and "Use NFC" on Android) | A payment request; the link is the QR. |
| 6 | Customer: scan the QR (or tap phones with the NFC app) → "Pay $4.50 to Caffè Bruno" → **Approve** | | Pay a merchant from a link, often in a fresh browser. |
| 7 | Merchant screen | Turns to **Paid** by itself in about 10 s; the sale shows fee $0.02 and net $4.48 | Paid at deposit validation (D4); the payout follows from the pool in the background. Zecca's 0.5% fee is in its own books, not on the ledger. |
| 8 | Customer: **More → Add money** | MoonPay sandbox widget (or **Add demo credit**) | Fiat top-up: RLUSD delivered on Testnet, credited after checking the delivery on the ledger. Labelled "Sandbox". |
| 9 | Customer: open `/demo/shop` (Sette Archi) → add a coffee → **Pay with Zecca** | "Order confirmed" with a receipt, and the receipt in the app's activity | Zecca from the outside: checkout on a third-party site. |
| 10 | Customer: try to send $60 | "You've reached the limit for unverified accounts." | Tier-0 limits (EU low-value e-money style), a designed moment, not an error. |

## Phase 2 (each behind a flag, all on in the demo)

| Feature | Path | What it proves |
|---|---|---|
| **Identity** | More → Verify your identity → (Test identity) → one approval | An on-ledger XRPL **Credential** (`CredentialCreate` by Zecca's KYC issuer, `CredentialAccept` signed by the user, sponsored). Limits lift. The screen says "Test identity" in this mode; a real EU Digital Identity Wallet scan works against the public EU verifier. |
| **Earn** | More → Earn → Add $10 | One approval; Zecca converts dollars to XRP, one XRPL Testnet payment opens a Flare smart account, mints FXRP and deposits into Firelight. Position shows after about 160 s (real run: 151 s). |
| **Metals** | More → Metals → Gold → Buy | Gold, silver, palladium as MPTs on Devnet; prices published on-ledger with `OracleSet` and read back; dollar leg confidential through the pool. |
| **Statements** | More → Statements → pick payments → Create statement | A statement signed by Zecca **and a per-line proof** that the sealed amount on the ledger equals the amount shown, checkable by anyone against a public node, without trusting Zecca. |
| **Card** | More → Card → Load card → then pay by card in the demo shop | A real Lithic sandbox card; purchases answered from the card balance in a few ms (approved 6.3 ms / declined 2.1 ms measured), settled on Devnet afterwards. *(On once checked on the deployed site.)* |
| **Face ID** | More → Face ID → Add Face ID | Privy passkey MFA on an XRPL `raw_sign`: the next approval asks for Face ID. *(On once checked on an iPhone.)* |
| **Tap to pay** | Android merchant phone with the Zecca NFC app (`apps/merchant-nfc/release/zecca-nfc.apk`) | The merchant phone emulates an NFC tag carrying the pay link; an iPhone or Android customer taps and opens the pay page. |

## What the public ledger sees

Addresses: yes. Amounts: no. Who paid whom: no — every payment goes *payer → Zecca pool* and *pool → recipient*; the link lives only in Zecca's database. Timing can still link a deposit to its payout (stated plainly on `/how-it-works`).

## If something goes wrong during the demo

- Devnet slow or "not synced": wait 30 s and retry; the API retries itself.
- No email code: use "Continue with Google".
- Card declined everywhere: the Lithic webhook must point at the API (`services/api/src/connectors/card/cli.ts enroll --base https://zecca-api-production.up.railway.app`).
- Local fallback, no network: `npm run dev` with `LEDGER_MODE=mock SIGNER_MODE=mock` runs the whole demo on the mock ledger (labelled).
