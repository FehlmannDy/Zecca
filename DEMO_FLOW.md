# Zecca — 5-minute demo flow

The order of actions for the demo video: who does what, on which screen, what it shows. Times are a guide (total 5:00). Cut every wait longer than a couple of seconds.

**Cast**
- **Ana**, the customer, on an **iPhone**: Paradym installed, holding the test identity credential.
- **Caffè Bruno**, the merchant:
  - an **Android phone** with Zecca Till, already paired at `/merchant/pair`;
  - a **laptop** signed in at https://zecca-beta.vercel.app/merchant/sales.
- A **friend** account (any existing Zecca user) to send money to.

## Before recording

1. Have a fresh email ready for Ana's sign-up, so the sign-up is shown live.
2. Laptop tabs: the landing page https://zecca-beta.vercel.app, the merchant sales page, the demo shop `/demo/shop`, and `devnet.xrpl.org`.
3. On the Android till: NFC on; NFC PayLink closed; Zecca Till open on the keypad.
4. Phones: Do Not Disturb on, battery charged.
5. Card, Earn and Metals open only after identity is verified, so keep that order.

## The flow

| Time | Who / screen | Action | What it shows |
|---|---|---|---|
| 0:00–0:20 | Laptop, landing | Scroll the hero and the feature tiles. | One app: pay, card, earn, metals, on the XRP Ledger, layer 1. |
| 0:20–1:00 | Ana, iPhone | **Open the app** → email → code → pick a handle → **Approve**. The three lines tick: *Creating your account*, *Opening your private balance*, *Adding your demo credit*. Then **$50.00**, counting up. Accept **Add Face ID**. | Email sign-in, no seed phrase, no XRP. The sponsor creates the account, and **one** signature covers the whole sign-up Batch: authorize, credit, convert to confidential, merge, delegation. Face ID is a passkey. |
| 1:00–1:35 | Ana, iPhone | **Send** → the friend's handle → **$12** → **Approve with Face ID**. The arches fill: *Sealing the amount* → *Sending* → *Confirmed*. | A confidential payment (ConfidentialMPTSend); the fee is paid by Zecca's sponsor; Face ID approval. |
| 1:35–2:00 | Ana, iPhone, then laptop | Open the payment in **Activity** → **What the ledger shows** → switch to **Everyone else**. Open the transaction link on the explorer. | The amount is a sealed block and the counterparty is "Zecca pool". On the public explorer, no readable amount. |
| 2:00–2:45 | Merchant, Android till + Ana, iPhone | Till: type **4.50** → **Charge**. Full screen: amount, QR, "Hold the customer's phone to the back of this one". Ana taps the iPhone on the back of the till → "Pay $4.50 to Caffè Bruno" → **Approve with Face ID**. The till turns green: **Paid**, with the arches. | Tap to pay: the till serves the pay link over NFC itself, with the QR as a fallback. Paid at deposit validation, in about 10 s. |
| 2:45–2:55 | Laptop, merchant sales | Show the new sale: $4.50, fee $0.02, net $4.48. | The merchant dashboard and Zecca's business model (0.5% merchant fee). |
| 2:55–3:15 | Ana, iPhone (or laptop) | Demo shop `/demo/shop` → add a coffee → **Go to basket** → **Checkout** → **Pay … with Zecca** → **Approve** → **Order confirmed**. | Zecca as a checkout on a third-party site. |
| 3:15–3:25 | Ana, iPhone | **Send** $60 → the limit sheet: "You've reached the limit for unverified accounts." → **Verify your identity**. | Tier-0 limits, a designed moment. |
| 3:25–3:55 | Ana, iPhone + Paradym | **Continue** → **Other wallets** → open Paradym → share name and date of birth → back in Zecca: **Verified. Limits raised.** → one approval. | EU Digital Identity Wallet (OpenID4VP) → an on-ledger **XRPL Credential** (CredentialCreate by Zecca, CredentialAccept signed by Ana, sponsored). |
| 3:55–4:10 | Ana, iPhone | **More → Earn** → add **$10** → **Approve**. *(Cut: the position shows about 2.5 min later; come back to it at 4:45.)* | Yield in XRP from Firelight on Flare: one XRPL Testnet payment opens a Flare smart account, mints FXRP and deposits. |
| 4:10–4:25 | Ana, iPhone | **More → Card** → **Get my card** → **Load card** $10 → **Approve**. In the demo shop, pay by card → approved. | A virtual card (Lithic sandbox) funded from the confidential balance, purchases answered in milliseconds. |
| 4:25–4:35 | Ana, iPhone | **More → Metals** → **Gold** → **Buy** 1 g → **Approve**. | Gold, silver and palladium as MPTs, with the price published on the ledger (OracleSet). |
| 4:35–4:45 | Ana, iPhone | **More → Statements** → tick payments → **Create statement**. | A signed statement with a per-line proof that anyone can check against the public ledger. |
| 4:45–4:52 | Ana, iPhone | **More → Earn**: the position is live. | Earn round trip; the withdrawal is proven too (README). |
| 4:52–5:00 | Laptop, landing | https://zecca-beta.vercel.app and the GitHub repo. | Live on XRPL Devnet and Testnet. |

## If something is slow

- **Devnet slow or "not synced":** wait 30 s; the API retries by itself. Record that scene again.
- **No email code:** use **Continue with Google**.
- **NFC does not trigger:** scan the QR on the till instead; the flow is the same.
- **Running long:** skip the demo shop (2:55) and the metals scene (4:25); everything else carries the story.
- **Add money (MoonPay sandbox):** shown only if there is time, under **More → Add money**.
