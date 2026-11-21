# Zecca Till

A native Android till for Zecca merchants (package `ch.ixh.zeccatill`, label "Zecca Till"). The merchant pairs the phone once with a code from the Zecca merchant space; after that the phone takes charges: keypad, large amount, optional reference, "Charge", then a full screen with the amount, the QR code of the pay link and the same link served over NFC by the app itself, the live status, and a full-screen "Paid". It looks and reads like the web till (`apps/web/components/merchant/till.tsx`, `docs/UI.md` §5.8), in light and dark.

No WebView, no AndroidX: plain Android views in Kotlin, zxing core for the QR codes, Manrope and Montserrat bundled.

The web till plus the NFC PayLink app (`apps/merchant-nfc`) still work as before and stay the fallback.

## Install

`release/zecca-till.apk` (version 1.0). Android 7.0 or later. On the phone, open the APK and allow installs from that source when Android asks. Taps need NFC with host card emulation (most Android phones); the QR code works without it. The camera is only used to scan the pairing code.

The APK is a release build (no http, not debuggable), signed with the Android debug key like the NFC PayLink APK.

## Pair

1. In the Zecca merchant space, open **Tills** (on a computer: "Pair a till"). It shows a QR code and an 8-character code, valid 10 minutes and once.
2. In Zecca Till, tap **Scan the code** and point the camera at it. No camera, or it does not read: type the code under "or type it" and tap **Pair**. The server is `https://zecca-api-production.up.railway.app` unless you change it.
3. The till shows the business name. It is now on the merchant's list of tills.

If the phone's own camera app offers to open the pairing link (`zecca-till://pair?api=…&code=…`), Zecca Till opens with the form filled in; the merchant still taps **Pair**. A link can never pair the till by itself.

**Unpair** in the till's header forgets the pairing on the phone. **Unpair** in the merchant space stops the till's token at once; the till then says "This till is not paired. Pair it again from your Zecca merchant space." and goes back to the pairing screen.

## Charge

Type the amount, add a reference if you like, tap **Charge $x.xx**. The full screen shows:

- the amount and reference, the QR code of the pay link;
- "Hold the customer's phone to the back of this one" when NFC is on (or "Turn on NFC to take taps" with a button to the NFC settings);
- the status, checked every 2 seconds: "Waiting for the customer", then "Customer is paying" once the customer opens the pay page, then the green "Paid" screen with the seven arches filling, the amount and the time;
- "Expires in 9:41", and **Cancel charge** while nobody has paid.

"This request has expired." and "Charge cancelled." end a charge too. **New charge** goes back to the keypad. The screen stays on while a charge is open. Back never drops an open charge; only **Cancel charge** does.

## NFC: one app at a time

Zecca Till and NFC PayLink both answer as an NFC Forum Type 4 tag on the same AID (`D2760000850101`). On a phone with both installed, only one should be the preferred service: Zecca Till makes itself the preferred service while it is on screen (`CardEmulation.setPreferredService` in `onResume`) and lets go in `onPause`, like NFC PayLink does. If a tap opens Android's app picker or the other app's link, keep Zecca Till on screen during the charge, or uninstall NFC PayLink from the till phone.

The link is served from this process only while a charge is open on screen with the app in the foreground (`ServedLink`): `onPause` clears it, since in the background the till stops polling and cannot see the charge end, and `onResume` serves it again. With no open charge, or with the app in the background, a reader finds no tag. APDUs are logged without the link: `adb logcat -s ZeccaTillHCE`.

## What the till can and cannot do

- The till token is random, stored hashed by the API and in this app's private SharedPreferences, which never leave the phone: `android:allowBackup="false"` up to Android 11, and on Android 12+ `res/xml/data_extraction_rules.xml` excludes everything from cloud backup and device-to-device transfer (some manufacturers' transfer tools ignore `allowBackup`).
- A till token can create, read and cancel its own charges (`/v1/till/charges`), nothing else: no balance, no transfers, no activity, no sales.
- The pairing link must point at Zecca's API over https. Only a debug build accepts http, and only to `localhost` and the emulator's host `10.0.2.2`.

## Build

```bash
cd android
./gradlew test assembleDebug assembleRelease    # JDK 21, sdk.dir in local.properties (gitignored)
cp app/build/outputs/apk/release/app-release.apk ../release/zecca-till.apk
```

JVM tests (76): keypad and money, the pairing link parser and host allowlist, JSON and the API's answers, charge status and merging, when the pay link is served over NFC, QR codes read back, and the Type 4 tag and NDEF tests copied from NFC PayLink.

## Try it on an emulator against a local mock API

```bash
# from the repository root
LEDGER_MODE=mock SIGNER_MODE=mock DEMO_MODE=1 API_PORT=8990 API_ORIGIN=http://10.0.2.2:8990 \
  node node_modules/tsx/dist/cli.mjs services/api/src/server.ts
adb install -r apps/merchant-till/android/app/build/outputs/apk/debug/app-debug.apk
# a merchant's pairing link (POST /v1/merchant/tills with a merchant session), then:
adb shell "am start -a android.intent.action.VIEW -d 'zecca-till://pair?api=http%3A%2F%2F10.0.2.2%3A8990&code=<code>' ch.ixh.zeccatill"
```

Charge on the emulator, then pay the request as another mock user (`scripts/smoke/demo-path.ts` shows the calls) and watch the till turn to "Paid".

## Files

`android/app/src/main/java/ch/ixh/zeccatill/`:

| File | What |
|---|---|
| `MainActivity.kt` | The four screens (pair, till, charging, paid) and their states |
| `TillApi.kt`, `TillJson.kt`, `Json.kt` | The till routes of `services/api/src/connectors/till` |
| `PairingPayload.kt` | `zecca-till://pair` links and typed codes, https and host checks |
| `Money.kt`, `Charge.kt` | Keypad, cents, status lines, expiry countdown, ISO times |
| `Ui.kt`, `Views.kt` | Tokens, type, buttons, the backdrop, the mint mark, the arches, the QR code |
| `QrScanner.kt`, `Qr.kt` | Camera scan and zxing encode/decode |
| `TillApduService.kt`, `Type4TagEmulator.kt`, `NdefUri.kt` | The NFC tag (the last two copied from NFC PayLink) |
| `TillStore.kt` | The pairing on the phone, and the link being served |

Licences: Manrope and Montserrat under the SIL Open Font License (`licenses/`), zxing under Apache 2.0, the icons from lucide (ISC).
