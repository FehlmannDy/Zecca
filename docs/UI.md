# Zecca — interface

The interface is judged as hard as the ledger work. It has to look like a finished consumer product, in English, and it has to make one idea obvious: this is a normal payment app, and the ledger underneath cannot see your money.

## 1. Brand

"Zecca" is the Italian word for a mint, the building where coins are struck. The logo (`../zecca-logo.png`, copy it to `apps/web/public/brand/`) is black line art of a mint: a dome, a pediment, the wordmark, and a row of seven arches. Line weight is even, corners are round, nothing is filled.

Take three things from it and use them everywhere:

1. **Line, not fill.** Icons and illustrations are single-weight outlines with round caps. No gradients inside shapes, no 3D coins, no stock crypto imagery.
2. **The arches.** The row of seven arches is the signature. It is the progress indicator while a payment confirms (arches fill left to right over the wait, see §5.4), the divider on the landing page, and the empty-state illustration. Use it for those three things and nowhere else.
3. **Ink on paper.** Mostly black and warm white. One metal accent. Colour is spent on meaning (money in, money out, sealed), never on decoration.

Voice: plain, short, confident. Say what happened and what to do. "Paid. $4.50 to Caffè Bruno." No exclamation marks, no "Oops", no crypto vocabulary (BUILD §8, rule 8).

## 2. Tokens

Define as CSS variables and map them into Tailwind. Light is the default; dark is supported because the dashboard component has both.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#F5F2EB` | `#0C0D0F` | Page background |
| `--surface` | `#FFFFFF` | `#16181B` | Solid cards, sheets |
| `--ink` | `#0C0C0D` | `#F2EFE8` | Text, lines, primary buttons |
| `--muted` | `#6B6A66` | `#9A988F` | Secondary text |
| `--line` | `#DDD8CC` | `#2A2C30` | Hairlines, borders |
| `--brass` | `#A8842F` | `#D2AE5A` | The one accent: active state, focus ring, chart glow |
| `--in` | `#1E6B57` | `#58B79C` | Money received, success |
| `--out` | `#0C0C0D` | `#F2EFE8` | Money sent (same as ink: spending is not an error) |
| `--alert` | `#B23A24` | `#E5745C` | Errors, declines |
| `--sealed` | `#23324F` | `#8FA6D6` | Anything that represents hidden data |

Check contrast for every text pair (4.5:1 minimum) in both themes before using them.

Type:

- **Wordmark and uppercase labels**: a geometric sans with a round C that matches the logo's letters. Compare Outfit and Montserrat against the PNG and keep the closer one. Uppercase, letter-spacing 0.12em, small sizes only (section labels, the nav wordmark).
- **Everything else**: Manrope Variable. It ships with the dashboard component, so there is one text family, not three.
- **Amounts**: Manrope with `font-variant-numeric: tabular-nums`. The balance is the largest thing on the screen. Cents are set smaller and lighter than dollars.
- Hashes and addresses: a monospace, truncated in the middle (`C8594C53…AB55`), with a copy button.

Shape: radius 20 px on cards, 14 px on inputs and buttons, full round on chips. Hairline borders of 1 px in `--line`. Shadows are soft and only on floating things (sheets, the dock).

## 3. The two 21st.dev components

Both prompts are in `docs/ui/`, with full source. Follow the shadcn convention: copy the source files unchanged into `apps/web/components/ui/`, then build Zecca's own components on top of them in `apps/web/components/zecca/`. Do not edit the originals beyond what theming requires; note any edit in a comment at the top of the file.

### 3.1 Glassy Dashboard (`docs/ui/21st-glassy-dashboard-prompt.txt`)

One file, `glassy-dashboard.tsx`. Dependencies: `gsap`, `@gsap/react`, `lucide-react`, `@fontsource-variable/manrope`. Props: `backgroundImage`, `backgroundCredit`, `workspaceName`, `panelFrost`, `initialTheme`.

It is a complete demo workspace with its own sample data and four views. Zecca needs its **look and its building blocks**, not its sample content:

- Keep the original file as the reference and for the `/merchant` desktop shell's behaviour (dock, frosted panels, theme switch, GSAP entrance).
- Extract into `components/zecca/glass/`: `Panel`, `Metric`, `Badge`, `Counter`, `Dock`, `Dialog`, and the `gd-*` style layer (background, frost, panel borders). Give them real props and remove the hard-coded records.
- **Background**: the default is a stock photo from a CDN with an Unsplash credit. Replace it with our own backdrop: an SVG or CSS composition built from the logo's arches and dome in `--line` on `--paper`, with a soft light falloff so the frosted panels have something to blur. No external image, no credit line.
- Where it is used: the **merchant space on a tablet or laptop** (the till view: today's total, live sales feed, chart, payout status) and the **user space on wide screens**. On a phone, use the extracted `Panel` and `Metric` in a single column with a bottom dock; do not try to squeeze the four-view workspace into 390 px.
- Respect `prefers-reduced-motion`: the component already has a hook for it; keep it working after extraction.

### 3.2 Peak Chart (`docs/ui/21st-peak-chart-prompt.txt`)

One file, canvas-based, no dependency beyond React. Props: `data`, `labels`, `value`, `valueSuffix`, `decimals`, `title`, `caption`, `updatedText`, `trend`, `periods`, `period`, `onPeriodChange`, `accent`, `width`, `loop`, `backdrop`, `formatValue`, `font`. The card keeps a 540:696 ratio and scales with `width`.

The card is dark by design (near-black with a coloured glow) in both themes. Treat it as the one "ink" card on a light page: one per screen, never two side by side. `accent` hue-shifts the glow, grid, line and dot: set it to the brass token. Set `font` to Manrope.

The headline number is `value` with `decimals` and `valueSuffix`; `formatValue` only formats the hover readout. There is no prefix prop, so add a `valuePrefix` prop for the `$` (a small edit, noted at the top of the file) and use `decimals={2}`.

Use it for exactly these:

| Where | `title` | `value` | `data` |
|---|---|---|---|
| User home | Balance | balance in dollars, prefix `$`, two decimals | daily balance from activity |
| Merchant home | Sales today / this week | gross sales | sales per hour or per day; `periods` = Today, 7 days, 30 days |
| Earn | Your position | value in XRP, `valueSuffix` " XRP" | position value over time |
| Market, asset page | Gold, per gram | price | price history from `GET /market/assets` |

Always pass real `data`. Leaving it out shows the component's built-in demo series, which must never reach a screen a judge sees. With fewer than two points, show the number without the chart.

## 4. Layout

- **User space and pay page: phone first.** Design at 390 × 844, verify 360 to 430. One column, bottom dock with four items: Home, Pay, Card, More. Sheets slide up for Send, Top up and Approve.
- **Merchant space: two layouts.** Phone: a till (keypad, big amount, "Charge"). Tablet and laptop: the glass dashboard.
- **Landing: desktop first**, readable on a phone.
- Max content width 1120 px. Spacing scale 4, 8, 12, 16, 24, 32, 48, 72.

## 5. Screens and copy

Copy below is final unless a screen needs less room. Sentence case everywhere.

### 5.1 Landing (`/`)

Purpose: a judge understands the product in ten seconds and opens the app.

- Hero: wordmark, then "Money that moves like a message. Private by default." Sub-line: "Sign in with an email. Pay with a tap. Your balance stays between you and the people you pay." Buttons: "Open the app", "I'm a merchant".
- Three facts, each with a line icon: "No seed phrase. Your key is created when you sign in, and only you can use it." / "No network fees. Zecca sponsors every transaction." / "Hidden amounts. The public ledger sees that a payment happened, not how much."
- "How a payment works": the three-step pool diagram (you → Zecca pool → merchant) with what an outside observer sees under each arrow.
- "Built on the XRP Ledger, layer 1": the four building blocks in plain words (sponsored accounts, confidential tokens, batched transactions, credentials), each naming the network it runs on today.
- Footer: "Running on XRPL Devnet and Testnet. Built at the Italian XRPL Hackathon 2026."

### 5.2 Sign-up

1. "Welcome to Zecca" / "Continue with Google" if that login works (SPEC §4.11) / email field / "Continue". Then the code step, which Privy renders.
2. "Pick your handle" / `@` field with live availability ("@ana is yours" / "Taken, try another") / display name / toggle "I'm setting up a business" (adds "Business name").
3. Approve step: "One approval and you're in." Under it, three lines that tick as they complete: "Creating your account", "Opening your private balance", "Adding your demo credit". The arches fill while it runs (about 7 seconds).
4. "You're set, Ana." / balance / "Go to home".

### 5.3 Home (user)

Balance (Peak Chart on wide screens, plain large number on a phone), with "Available" and, when not zero, "Arriving: $x.xx". Four actions: "Send", "Pay", "Top up", "Request". Then "Activity": avatar, name or merchant, note, amount (`+` in `--in` for received, plain ink for sent), a small clock while pending. Empty state: the arches, "Nothing yet. Top up to get started."

### 5.4 Send

"To" field accepting a handle, phone or email, resolving as the user types to a row with avatar and name; recent contacts below. Then the amount keypad and an optional note. Then the approve sheet: "Send $12.00 to Carla Rossi" / "@carla" / "Fee $0.00" / "Approve". 

If passkey approval is on (SPEC §4.11), the button reads "Approve with Face ID" on a phone that has it; otherwise "Approve". Never promise Face ID in copy when the feature flag is off.

While waiting: the seven arches fill, with one line under them that changes: "Sealing the amount" → "Sending" → "Confirmed". The wait is about 10 seconds and must feel deliberate, not stuck. On success: "Sent. $12.00 to Carla." with "Done" and "View details". On failure: what happened in one sentence and "Try again".

### 5.5 Pay a merchant (`/pay/[id]`)

Opens from an NFC tap or a QR code, often in a fresh browser. Shows immediately, even logged out: merchant name, amount, reference. Logged out: "Sign in to pay" (returns here after login). Logged in: "Pay $4.50 to Caffè Bruno" / "Approve". Then the arches, then "Paid" with a large tick and the time. States to design: request expired ("This request has expired. Ask the merchant for a new one."), already paid, not enough balance ("You need $1.20 more." with "Top up").

### 5.6 Activity detail and "What the ledger shows"

Top: who, how much, when, status, note. Then a panel titled "What the ledger shows" with a two-way switch, "You" and "Everyone else":

- **You**: amount, counterparty name, fee.
- **Everyone else**: the same rows with the amount replaced by a sealed block in `--sealed` showing the first bytes of the real ciphertext, the counterparty replaced by "Zecca pool", and the two transaction hashes linking to the Devnet explorer (`https://devnet.xrpl.org/transactions/<hash>`).

This panel is the product's argument in one screen. Build it with real data from the ledger, never a mock-up.

### 5.7 Top up

"Add money" / amount chips / "Continue" opens the MoonPay widget as an overlay. After the purchase: "Payment received. Your balance updates when the transfer lands, usually under a minute." Small print when the sandbox scale is on: "Sandbox purchase. No real money moved."

### 5.8 Merchant: charge

Keypad, large amount, optional reference, "Charge". Then a full screen: the amount, the QR code, and on Android "Hold the customer's phone to the back of this one" with a button "Use NFC" that opens the companion app. Status line: "Waiting for the customer" → "Customer is paying" (request `opened`) → full-screen "Paid" in `--in` with the amount and a sound-free haptic-style animation of the arches completing. "New charge" returns to the keypad.

### 5.9 Merchant: sales

Glass dashboard on wide screens. Metrics: "Today", "Sales", "Average", "Fees". Peak Chart with period switch. Live feed of sales (time, payer's first name or "Customer", amount, "Paid out" or "Paying out"). "Export CSV". Fee line in plain words: "0.5% per sale. No monthly fee."

### 5.10 Phase 2 screens

- **Card**: this screen is a showpiece, give it the care of the home screen.
  - The card itself, large, at the real 85.6 : 54 ratio: ink black, the mint's dome and arches drawn in hairline `--brass` across it, the Zecca wordmark, the holder's name, the last four digits. It tilts a few degrees with the pointer or the phone's motion and a soft light moves across it. Tap to flip: the back shows the full number, expiry and code for 30 seconds with copy buttons, then flips back.
  - Under it: "Card balance", "Load card" (amount sheet, one approval, the arches), "Freeze card" toggle (the card greys out). One line explains the model: "Move money to your card once, then every purchase is instant."
  - In demo mode, a link "Try your card in the demo shop" (§5.11). It is how a judge sees an approval, a decline and a receipt.
  - A card payment opens as a receipt: shop name, amount, time, "Card ending 4417", "Authorised" then "Completed", reference.
  - "Card payments": a live list fed by `card.authorization` events. An approved purchase slides in with the shop's name and amount; a declined one says "Declined, not enough on the card".
  - Small print: "Sandbox card. It works with test purchases only." The card is a real Lithic sandbox card; it cannot be added to Apple Pay or used in a shop.
- **Earn**: Peak Chart of the position, "Add to Earn", "Withdraw", the fees before approving ("0.3% conversion. Zecca keeps 10% of what you earn."), and two honest lines: "Earnings are paid in XRP and their dollar value moves with its price." / "Withdrawals take a few hours."
- **Market**: three rows (Gold, Silver, Palladium) with price per gram, a small sparkline, and the price's time. Asset page with Peak Chart, "Buy", "Sell", holdings in grams. Locked state for tier 0: "Verify your identity to trade metals."
- **Identity**: "Verify with your EU Digital Identity Wallet" / QR code on desktop, "Open wallet" button on a phone / what will be shared: "Your name and date of birth. Nothing else." / result: "Verified. Limits raised."
- **Proofs**: activity list with checkboxes, "Create statement", then a printable page with Zecca's signature and "Anyone can check each line on the public ledger."

### 5.11 Demo shop (`/demo/shop`)

A believable small online shop, deliberately not styled like Zecca, so that paying there reads as leaving the app: its own name ("Sette Archi", an invented coffee roaster), its own warm palette and serif headings, a ribbon "Demo shop. Nothing is shipped, nothing is charged." on every page.

- Product page: one bag of coffee with a line drawing, price, "Add to basket". Two or three more items so the basket total can vary (one priced above the card balance, to produce a decline).
- Checkout: order summary, then two options side by side. "Pay with Zecca" shows a QR code on a laptop and a button on a phone, with "Waiting for your approval" until the page flips by itself. "Pay by card" is an ordinary card form.
- Result: "Order confirmed" with a receipt (order number, items, amount, method, time, "Print"), or "Card declined. Try another payment method."

### 5.12 Limits

When a tier 0 account hits a cap, a sheet, not an error toast: "You've reached the limit for unverified accounts." / the three limits with the one that was hit highlighted / "Verify your identity" / "Not now". The home screen shows a quiet line under the balance for tier 0: "Limit $150. Verify to lift it."

## 6. States, motion, accessibility

- Every screen has four states designed: loading (skeletons in `--line`, never a spinner on a blank page), empty, error, and success.
- Motion is functional: sheets slide, numbers count, the arches fill. Durations 150 to 300 ms, ease-out. Everything respects `prefers-reduced-motion`; with it on, the arches fill in steps without easing.
- Keyboard: every action reachable and visibly focused (2 px `--brass` ring). Sheets trap focus and close on Escape.
- Touch targets at least 44 px. Amount inputs use the numeric keypad (`inputmode="decimal"`).
- Announce payment results to screen readers with a live region ("Paid, four dollars fifty to Caffè Bruno").
- Never rely on colour alone: received amounts carry `+`, pending carries an icon, declined carries the word.
- Errors say what to do next. The API's `error.message` is written to be shown as is.
