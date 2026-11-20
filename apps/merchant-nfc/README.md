# merchant-nfc

Android app (package `ch.ixh.nfcpaylink`, label "NFC PayLink") that makes the merchant's phone act as an NFC tag holding one Zecca payment link. The customer taps their phone (iPhone or Android) on the back of it and the pay page opens. Phone test checklist: `TEST_PROTOCOL.md`.

## Opening the app with a link

From the merchant web space in Chrome on Android (the link must be opened by a tap, i.e. a user gesture):

```
intent:#Intent;action=android.intent.action.VIEW;package=ch.ixh.nfcpaylink;S.url=<encodeURIComponent(payUrl)>;end
```

Fallback deep link (other browsers): `zecca-nfc://emit?url=<encodeURIComponent(payUrl)>`

From a computer: `adb shell am start -n ch.ixh.nfcpaylink/.MainActivity --es url https://<host>/pay/<id>`

The app then shows "Hold the customer's phone to the back of this one" with the link, and serves it until another link replaces it.

## Which links are accepted

Any app can open the activity with a link, so every link (intent extra, deep link, typed in) goes through `PayLinkPolicy.check`:

- `https://` only (lowercase, as Zecca generates it); no `user@` part; printable ASCII only; at most 1000 characters;
- host on the allowlist; `*.example.com` means any subdomain of example.com;
- path exactly `/pay/<id>` with `<id>` = 1 to 80 of `A-Z a-z 0-9 _ -`; a query string is allowed.

Anything else is shown in red as refused and is never sent; the link that was being served stops too.

The allowlist is the Gradle property `zeccaNfcHosts`, compiled into `BuildConfig.PAYLINK_HOSTS`. Default (in `android/gradle.properties`): `*.trycloudflare.com,localhost,app.zecca.example`. To change it, edit that line or override it per build:

```bash
./gradlew test assembleDebug -PzeccaNfcHosts=pay.zecca.ch
```

`*.trycloudflare.com` lets any quick tunnel through, including one an attacker opens; keep it for the demo only and build with the fixed production host otherwise.

## Build

```bash
cd android
./gradlew test assembleDebug     # JDK 17+, sdk.dir in local.properties (gitignored)
cp app/build/outputs/apk/debug/app-debug.apk ../release/zecca-nfc.apk
```
