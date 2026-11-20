# NFC PayLink research: Android HCE tag → iPhone / Android, no app, no stickers

Research date: 2026-11-20. Status tags used below:
- **[DOC]** an official Apple or Android doc says it.
- **[SRC]** read in AOSP source.
- **[DEV]** a developer report.
- **[UNCERTAIN]** unverified or conflicting.
- **(re-checked)** I fetched the page myself and confirmed the quote. Other items come from one research pass and were not fetched a second time.

## Verdict

**Probably yes on iPhone XS and newer, but unproven until we test on our own devices.**

- No Apple or Google document confirms or excludes it. Apple's rule is about the protocol: the iPhone reads in the background any NDEF tag whose message has a URI record. Core NFC handles NFC Forum tag types 1–5. A correct Android HCE Type 4 tag meets that description.
- Independent open-source projects say an iPhone shows the native "open link" notification for an HCE-emulated Type 4 URI tag, with no app installed:
  - LuigiVampa92/ndef-emulator
  - Azati1/nfc_url_tag
  - ppiankov/pockettag, which reports an iPhone 16 on iOS 26.6.1. The repo is now 404; we saw only search snippets.
- None of these projects publishes logs or videos. There are also counter-reports:
  - an iOS "unknown tag";
  - an iPhone opening Wallet when the other device keeps polling;
  - an Apple-forum user whose Android emulator apps did not work natively.
- Evidence strength: **moderate**. The two things that matter most are lenient APDU handling (iOS sends unusual read patterns) and stopping the merchant phone from polling.
- **Android customer phones:** this is expected to work. The tag dispatch path is documented, and it changed in Android 16 and 17 (section 4). Android-to-Android is reported as less reliable than a real tag.

## 1. iOS background tag reading

All of the following is from Apple's background tag reading doc (https://developer.apple.com/documentation/corenfc/adding-support-for-background-tag-reading, Markdown at the `.md` URL), **[DOC] (re-checked)**, unless marked otherwise.

| Topic | What Apple says |
|---|---|
| Supported models | "iPhone XS and later support background tag reading." Apple's iOS guide says iPhone 7, 8 and X need **NFC Tag Reader in Control Center** instead [DOC] (https://support.apple.com/en-euro/guide/iphone/aside/asd-nfc-reader/15.0/ios). Whether that reader handles an HCE tag is [UNCERTAIN]. |
| Record format | The system looks for `typeNameFormat` = NFC Well Known with `type` = "U". "If the NDEF message contains more than one URI record, the system uses the first one. The URI record must contain either a universal link or a supported URL scheme." We serve a single record: TNF 0x01, type "U", prefix 0x04 (`https://`). |
| Schemes | HTTP/HTTPS, mailto, sms, tel, facetime, facetime-audio, Maps, X-HM. "Background tag reading doesn't support custom URL schemes." |
| No app, no entitlement | "If there are no installed apps associated with the universal link, the system opens the link in Safari." A plain https link needs no Associated Domains entitlement. That entitlement only matters if you want to route the link into your own app. |
| User interaction | "The system displays a pop-up notification each time it reads a new tag. After the user taps the notification…". The page does **not** open on its own; the customer taps the notification. |
| Lock state | "If the iPhone is locked, the system prompts the user to unlock the phone before providing the tag data". Apple Tech Talk 702 adds: "After first unlock, the device will scan for NFC tags in the background whenever the display is on regardless of the lock state" [DOC] (https://developer.apple.com/videos/play/tech-talks/702). |
| Screen | "the system reads tags in the background only when the user's iPhone is in use", so the display must be on. |
| Suspended when | "The device has never been unlocked. A Core NFC reader session is in progress. Apple Pay Wallet is in use. The camera is in use. Airplane mode is enabled." |
| Tag types | Core NFC reads "tags of types 1 through 5 that contain data in the NFC Data Exchange Format (NDEF)" [DOC] (https://developer.apple.com/documentation/corenfc). Tech Talk 702: "Background tag reading will work with any NDEF formatted tag whose NDEF message includes a URL record." |
| Re-tap | Tech Talk 702: "tapping on the NFC tag again will trigger a new notification." One forum report (iPhone 12 Pro, iOS 16.3) describes misses and "a one-minute interval" [DEV] (https://developer.apple.com/forums/thread/756426). |

Stricter developer claim [DEV, UNCERTAIN]: the URI must be record 0 and alone, and `TNF_ABSOLUTE_URI` does nothing on iOS (https://github.com/Staberman/ntag213-ndef). Our single well-known URI record meets this stricter rule too.

## 2. Android HCE as an NFC Forum Type 4 Tag

Android HCE guide: https://developer.android.com/develop/connectivity/nfc/hce. API reference: https://developer.android.com/reference/android/nfc/NfcAdapter.

- **Registration [DOC].** A `HostApduService` with `BIND_NFC_SERVICE`, and an AID group in category `other`, which "can be always active". We register the NDEF Tag Application AID `D2760000850101`.
  - If another app registers the same AID, conflict resolution applies. A foreground activity can win with `CardEmulation.setPreferredService`, which this app calls in `onResume`.
- **Screen and lock [DOC].**
  - HCE doesn't work with the screen off.
  - On Android 10+, if **Secure NFC** is on, HCE can't work from the lock screen whatever `requireDeviceUnlock` says.
  - `requireDeviceScreenOn=false` is documented only for payment services.
- **Random UID [DOC].** "HCE devices should be assumed to have a random UID… on every tap". About 1 KB is a "reasonable upper bound" for data exchanged within 300 ms.
- **Stop the merchant phone polling [DOC].** On API 35+, `NfcAdapter.setDiscoveryTechnology(activity, FLAG_READER_DISABLE, FLAG_LISTEN_KEEP)` disables polling while the activity is in the foreground. This app calls it on Android 15+ and confirmed it exists in the android-36 `android.jar`.
  - Before API 35, `enableReaderMode` with no technology flags keeps HCE routing on Android 12+ in AOSP [SRC], but turns HCE off on Android 10. We didn't use it because it varies by OEM and version.
  - Source: https://android.googlesource.com/platform/packages/modules/Nfc/+/refs/heads/main/NfcNci/src/com/android/nfc/NfcService.java
- **Command sequence.** The NFC Forum T4T spec text is paywalled, so this sequence comes from open implementations (TechBooster `NdefHostApduService`, LuigiVampa92, TI SLOA208B snippet):

  | Step | APDU | Response |
  |---|---|---|
  | Select NDEF app | `00 A4 04 00 07 D2760000850101 [00]` | 9000 |
  | Select CC file | `00 A4 00 0C 02 E103` | 9000 |
  | Read CC | `00 B0 00 00 0F` | 15-byte CC + 9000 |
  | Select NDEF file | `00 A4 00 0C 02 E104` | 9000 |
  | Read NLEN | `00 B0 00 00 02` | NLEN + 9000 |
  | Read data | `00 B0 <offset> <len>` | message bytes + 9000 |

  - Our CC is `000F 20 00FF 00FF 0406 E104 <NLEN+2> 00 FF`: mapping version 2.0, MLe 255, read access open, no write access.
  - Other projects use a max NDEF size field of 0x00FF, 0x7FFF, or len+2. Which one is "right" is [UNCERTAIN/CONFLICTING]. We use len+2, as LuigiVampa92 does, since that project reports iOS working.
- **iOS APDU quirks [DEV]**, from code comments in https://github.com/LuigiVampa92/ndef-emulator (`NfcType4TagNdefEmulator.kt`):
  - "ios tend to duplicate select fid commands multiple times"
  - iOS reads the NDEF file "first… (first 2 bytes), then the data but with incorrect offset (0 instead of 2) and then the last two bytes"
  - "android can sometimes send 3-bytes Le in extended apdu format"
  - Our state machine handles all three, and unit tests cover each one. It treats the NDEF file as a plain byte file with arbitrary offset and length, accepts repeated SELECTs, and accepts extended Le.
- **T4T v1.0 AID** `D2760000850100` is not served. No source shows iOS using it [UNCERTAIN].

## 3. The key question: evidence that iOS background reading fires for Android HCE

| Source | Claim | Strength |
|---|---|---|
| https://github.com/LuigiVampa92/ndef-emulator (README, re-checked) | Normal URI: "Perfectly and natively works on both Android and iOS". ✅ means "You do not need any specific third-party applications on the device that will read the emulated tag". | Medium. No device or iOS version given, but the code has iOS-specific workarounds, which suggests real iPhone testing. |
| https://github.com/ppiankov/pockettag (404 now; search snippets only) | Huawei P40 → iPhone 16 on iOS 26.6.1 worked for web links. An iPhone 11 is said to open "only places". Sony Xperia's built-in T4T answers before the app. Some Android pairs fail with "Empty tag". | Low–medium: specific versions, but we couldn't check it. |
| https://github.com/Azati1/nfc_url_tag | Demo: an iPhone "shows a Website NFC Tag notification and opens the link in Safari". Android "does not answer NFC readers while the display is off". | Low–medium. |
| https://zapped.to/blog/use-android-phone-as-nfc-business-card (2026-08) | Web link is "Read and acted on natively" on iPhone. | Low (secondary, based on LuigiVampa92). |
| https://developer.apple.com/forums/thread/128931 | 2020: emulated tag read **in an app**, not in the background. 2022: "android NFC apps that did not emulate on an iPhone natively". | Counter-evidence (weak). |
| https://community.nxp.com/t5/NFC/Card-emulation-on-PN7160/m-p/1466719 (403; snippet) | Emulated T4T showed as "tag unknown" on iOS 15.5 / iPhone X. Leftover reader polling "by default in iphone this will open wallet application". | Counter-evidence. It also motivates disabling merchant polling. |
| https://developer.apple.com/forums/thread/692720 | Real NDEF URL tags opened Apple Wallet/Pay about half the time. Unresolved. | Risk signal. |

## 4. Stock Android customer phone

From https://developer.android.com/develop/connectivity/nfc/nfc, **[DOC] (re-checked)**:
- "Android-powered devices are usually looking for NFC tags when the screen is unlocked". So the customer phone must be unlocked.
- "Starting in Android 16, scanning NFC tags that store web links… triggers the `ACTION_VIEW` intent instead of the `ACTION_NDEF_DISCOVERED` intent. Beginning with Android 17, scanning such a tag surfaces an "open link" notification, requiring explicit user interaction". So on Android 17+ the customer taps a notification, as on iOS.
- Android 16+ has a per-app allowlist at "Settings > Apps > Special app access > Launch via NFC". It "was added to address concerns… when they place the phone next to a NFC tag (credit card, another phone/watch, etc)." If the browser was disallowed there, the link won't open.

AOSP `NfcDispatcher` [SRC, research pass]:
- web links go to a VIEW intent;
- the "open link?" dialog is off by default (`enable_nfc_url_open_dialog=false`);
- after 5 NDEF read errors polling pauses for 2 s, and after 5 such pauses for 30 s.

Source: https://android.googlesource.com/platform/packages/modules/Nfc/+/refs/heads/main/NfcNci/src/com/android/nfc/NfcDispatcher.java

Android-to-Android: reported to work (LuigiVampa92 ✅), with some device pairs failing (pockettag). Both phones alternate between polling and listening. That is why the merchant app disables polling on Android 15+.

## 5. Pitfalls from people who shipped this

1. **Merchant screen must be on.** Keep the app in the foreground. The app sets `FLAG_KEEP_SCREEN_ON` and calls `setPreferredService`.
2. **Secure NFC** (Android 10+) blocks HCE on the lock screen.
3. **Merchant polling** can make the iPhone open Wallet, which also suspends background reading. It can also make the merchant read the customer's Android (Huawei: "your phone will detect it as a POS device", https://consumer.huawei.com/en/support/content/en-us00409929). The fix is `setDiscoveryTechnology` on Android 15+. Below 15 there is no clean fix.
4. **OEM routing.** Sony Xperia's built-in T4T answers before the app (pockettag). Samsung custom-AID routing issues have been reported [UNCERTAIN, snippet only]. The app's status line "NDEF AID routed to this app" checks this.
5. **AID conflicts** with other tag-emulator apps (https://github.com/MichaelsPlayground/NfcHceNdefEmulator).
6. **Strict APDU matching** (exact bytes, fixed Le) breaks iOS reads. Be lenient (section 2).
7. **The customer always taps a notification** on iOS, and on Android 17+. Don't promise "tap and the page opens" for those phones.
8. **Keep URLs short.** About 1 KB within 300 ms is Android's guidance. A short `https://host/pay/<id>` is ideal.
9. **Fresh tunnel hostnames.** These are a test-setup issue, not NFC: a new trycloudflare hostname failed with the laptop's default DNS but resolved via 8.8.8.8 right away (seen during this build).

## Not verified / open

- No real-device test yet. TEST_PROTOCOL.md is the plan for that.
- The NFC Forum T4T spec text is paywalled, so the command sequence comes from open implementations.
- Behaviour of the Control Center reader (iPhone 7/8/X) with an HCE tag is unverified.
- Some sources were seen only through search snippets: pockettag, the NXP thread, the Samsung forum.
