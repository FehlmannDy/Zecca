# NFC PayLink: device test protocol

Goal: the merchant's Android phone (app "NFC PayLink") emulates an NFC tag that holds one https payment link. A customer taps with an iPhone or an Android phone, and the payment page opens. No stickers, no customer app.

The code has only been tested on a laptop (JVM unit tests, debug build, page served over localhost and a tunnel). **This protocol is the first test on real phones.** Write down everything you see, including nothing happening. A clear "nothing happened" is a useful result.

## What you need

| Item | Notes |
|---|---|
| Merchant phone: Android with NFC | Android 15+ is best: the app can then stop the phone polling as a reader, so it only acts as a tag. Android 10 to 14 should work, but the phone keeps polling. |
| iPhone XS / XR or newer | Needed for background tag reading. On iPhone 7, 8 or X, use Control Center > NFC Tag Reader (step 12). |
| Optional: a second Android phone as customer | For section C. |
| Laptop | Has this repo, Node 22, `cloudflared`, and the Android SDK at `~/Android/Sdk`. |
| USB cable for the merchant phone | Optional, but `adb logcat` is the best failure evidence. |

Record these before you start:
- merchant phone model, Android version, and whether **Secure NFC** is on (Settings > Connected devices > NFC);
- iPhone model and iOS version;
- customer Android model and Android version (16 and 17 behave differently, see step 14);
- whether Google Wallet / Samsung Wallet is set up on each Android.

Background for each expectation is in RESEARCH.md.

## Setup (laptop)

S1. Build and test the app:

```bash
cd nfc-paylink/android
./gradlew test assembleDebug          # needs JDK 17+; sdk.dir is in local.properties
# APK: app/build/outputs/apk/debug/app-debug.apk
```

S2. Install the app on the merchant phone (USB debugging on):

```bash
~/Android/Sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

S3. Start the page server, then expose it over https:

```bash
cd nfc-paylink/server
npm ci
PORT=3000 node server.mjs
# second terminal:
cloudflared tunnel --no-autoupdate --url http://localhost:3000
# note the https://<random>.trycloudflare.com URL it prints
```

Expected: `https://<random>.trycloudflare.com/pay/demo` opens in a laptop browser and shows **Café du Lac, CHF 4.50**, a Pay button and a QR code. The text under the QR code starts with `https://`.
If it fails: a new trycloudflare hostname can take up to a minute to resolve. Retry, or try it from a phone on mobile data. Don't start the NFC tests until this works.

S4. Give the URL to the merchant app. Use **either** method:
- Type it into the text field and tap **Serve this link over NFC**, or
- `adb shell am start -n ch.ixh.nfcpaylink/.MainActivity --es url https://<random>.trycloudflare.com/pay/demo`

S5. Check the status block in the app:
- `NFC: on, HCE supported`
- `NDEF AID routed to this app: yes`
- `Reader polling: disabled while this screen is open` (only on Android 15+)
- `Serving: https://…/pay/demo`

If it fails: note the exact text. `NFC: OFF` means turn NFC on in Settings. `routed … NO` means another app (for example a tag-emulator app) has claimed the same AID: uninstall it or note its name.

S6. Optional, recommended: in a laptop terminal, run `~/Android/Sdk/platform-tools/adb logcat -s PayLinkHCE` and leave it running. Every APDU the customer phone sends shows up as `C-APDU … -> R-APDU …`.

## How to tap

- Merchant phone: app open in the foreground, screen on. Keep the screen awake (the app does this itself).
- Hold the two phones **back to back**. The iPhone NFC antenna is at the **top edge**, near the camera. Most Android antennas are in the middle or upper middle of the back. Line up the top of the iPhone with the middle of the Android.
- Hold still for **2–3 seconds**. If nothing happens, pull apart to 10 cm, then try again, sliding slowly.
- Remove thick or metal cases and magnetic wallets.

After each tap, the merchant app shows a **Last tap** line, for example `14:02:11: NDEF 41/41 bytes read (complete), link lost`. This shows whether the customer phone actually read the tag.

## A. Baseline (no NFC)

1. **QR fallback.** Scan the QR code on the laptop page with each customer phone's camera.
   - iPhone: a Safari banner appears, and tapping it opens the page.
   - Android: Google Lens or the camera shows the URL, and tapping it opens the page.
   - If it fails: it's a network or tunnel problem, not NFC. Fix it before going on.

2. **Pay button.** On the page, tap **Pay CHF 4.50**.
   - Both phones: the page shows **Paid (mock)**. No real payment happens.
   - The laptop server log shows `POST /pay/demo` with the phone's user agent.

## B. iPhone customer (background tag reading, no app)

3. **Main case.** iPhone unlocked, screen on, on the home screen. Camera, Wallet and NFC apps all closed, and Airplane mode off. Tap it to the merchant phone.
   - iPhone: a pop-up notification appears for the link. The page does **not** open on its own. Tapping the notification opens Safari on the payment page.
   - If Apple Wallet pops up instead, note it. The likeliest cause is the merchant phone polling, which is most common below Android 15.
   - Merchant: `Last tap: … (complete)`.
   - If it fails, note all of these:
     a) whether the merchant **Last tap** line changed at all;
     b) if it changed, `complete` or `INCOMPLETE`, and the byte counts;
     c) the logcat lines (copy them);
     d) whether anything appeared on the iPhone, even a brief one;
     e) how long you held the phones and in what position.
     A **Last tap that didn't change** means the iPhone never selected the NDEF application, so it isn't polling or doesn't see the phone. **INCOMPLETE** means the iPhone started reading but stopped.

4. **Repeat step 3 five times**, pulling the phones fully apart between taps. Write down the success count (for example 4/5).
   - iPhone: one notification per tap. Apple says a re-tap triggers a new notification. One developer reported misses and about a one-minute interval, so wait at least 5 s between taps, and also try 60 s.
   - If it fails: say whether failures alternate with successes or come in a run, and how long you waited between taps.

5. **iPhone locked, screen on** (wake it with the side button, but don't unlock). Tap it.
   - iPhone: a notification appears on the lock screen. Apple says the iPhone scans "whenever the display is on regardless of the lock state" after the first unlock. Tapping it asks for Face ID / passcode, then Safari opens.
   - Merchant: `Last tap: … (complete)`.

5b. **iPhone just restarted, never unlocked since boot.** Tap it.
   - iPhone: nothing. Apple documents that reading is unavailable until the first unlock.

6. **iPhone screen off.** Tap it.
   - iPhone: nothing should happen, because background reading needs the screen on.
   - Merchant: **Last tap** should not change.

7. **iPhone with the Camera app open.** Tap it.
   - iPhone: nothing should happen. Apple documents that background reading is suspended while the camera is in use.

8. **iPhone with Wallet open**, or while double-clicking the side button for Apple Pay. Tap it.
   - iPhone: nothing should happen, or Apple Pay UI only.
   - Merchant: note anything that appears, such as a sound or a "no supported app" message.

9. **Merchant app in the background.** Press Home on the merchant phone, keeping its screen on and unlocked. Repeat step 3.
   - Both phones: should still work, because the HCE service answers without the activity. On Android 15+, reader polling is back on now, so note if anything differs.

10. **Merchant phone locked, screen on.** Repeat step 3.
    - Both phones: should still work, because the service sets `requireDeviceUnlock="false"`. **Exception:** if Secure NFC is on (Android 10+), HCE doesn't work from the lock screen, so a failure is expected then. Note the Secure NFC setting and the result.

11. **Merchant screen off.** Repeat step 3.
    - Both phones: nothing should happen. Android HCE needs the screen on.

12. **Fallback for iPhone 7, 8 or X, or if step 3 fails.** Add **NFC Tag Reader** to Control Center (Settings > Control Center), open it, then tap.
    - iPhone: the tag is read and a notification for the link appears.
    - If this works but step 3 doesn't, the tag is fine and only background reading isn't firing. That's an important finding.

13. **Diagnostic, only if 3 and 12 both fail.** Install a free NFC reader app on the iPhone (for example "NFC Tools"), start a read, and tap.
    - iPhone: the app shows one URI record with the URL.
    - If this also fails, the iPhone can't read the emulated tag at all. Attach the logcat output.

## C. Android customer (no app)

14. **Main case.** Customer Android with NFC on, unlocked, screen on, on the home screen. Tap it.
    - Customer Android, by version:
      - Android ≤ 16: the browser opens the payment page directly. It may ask which browser to use the first time.
      - Android 17+: an "open link" notification appears, and tapping it opens the browser.
    - Merchant: `Last tap: … (complete)`.
    - If the merchant shows a complete read but nothing opens on Android 16+: check Settings > Apps > Special app access > **Launch via NFC** on the customer phone, and that the browser is allowed there.
    - If it fails, note:
      a) the merchant **Last tap** line;
      b) any toast on the customer phone, such as "No supported application for this NFC tag" or "Empty tag";
      c) whether a Wallet / payment UI popped up on either phone;
      d) whether the **merchant** phone reacted (a sound or a toast). That would mean the merchant was polling and read the customer phone. This happens most on Android below 15.

15. **Repeat step 14 five times** and write down the success count.
    - Android-to-Android is known to be less reliable than reading a real tag, because both phones switch between reading and listening. Try holding the phones still for longer, and offset them slightly.
    - After 5 failed reads in a row, Android pauses NFC polling (2 s, then 30 s), so wait 30 s before the next tap after a run of failures.

16. **Customer Android locked, screen on.** Tap it.
    - Customer Android: nothing should happen. By default, Android only reads tags when it's unlocked.

17. **Swap roles**, if both phones are Android. Install the app on the second phone, and repeat 14 in the other direction.
    - Either direction: same result as step 14. If it works in only one direction, write down which.

## D. Content changes

18. **Change the URL** in the merchant app to `…/pay/tshirt`, tap Serve, then tap with each customer phone.
    - Both phones: the page shows **IXH Merch Stand, CHF 25.00**.
    - If it fails: if the old page opens, the customer phone may be showing a cached or recent notification, so note it.

19. **Long URL.** Serve `https://<tunnel>/pay/demo?ref=` followed by about 300 characters. Tap with each phone.
    - Both phones: the demo page opens, because the server ignores the query string. This checks chunked reads larger than one APDU.
    - Merchant: `Last tap` shows a complete read of 300+ bytes.

## Result sheet (copy for each run)

| Step | Customer phone | Result (OK / FAIL / partial) | Merchant "Last tap" text | What appeared on the customer phone | Notes |
|---|---|---|---|---|---|
| 3 | iPhone … iOS … | | | | |
| 4 | | x/5 | | | |
| … | | | | | |

Also attach the `adb logcat -s PayLinkHCE` output for every failing step. It shows which APDUs the customer phone sent: whether it sent `00A4040007D2760000850101…` (select NDEF application) and how far it got.
