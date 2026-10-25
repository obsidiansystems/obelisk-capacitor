# Native integration

Start with the [quick start](../README.md#quick-start). These instructions
assume the generated app is in `mobile/`, with commands run from your Obelisk
application's root.

## Plugins

The [template's `native.mjs`](../templates/app/native.mjs) exports Capacitor,
App and Device. To add another plugin:

1. Install its npm package in `mobile/`.
2. Export it from `mobile/native.mjs`.
3. Run `ob-capacitor sync` as shown in the quick start.

JSaddle can access these exports through `globalThis.ObeliskCapacitor`.
The [counter frontend](../examples/counter/frontend/src/Frontend.hs) shows
`Device.getInfo()` and displays the native result or error.

Use the App plugin for lifecycle and URL-open events. Your application must
configure URL allowlists, associated domains or custom schemes, and decide
how incoming URLs affect navigation.

## Backend access

Packaged assets have these local origins:

| Platform | Origin |
|---|---|
| Android | `https://localhost` |
| iOS | `capacitor://localhost` |

Use a separate absolute HTTPS URL for your backend. Configure it to allow
CORS requests, including preflight, from the app's origin. The counter uses
public `common/route` config for its backend URL; see its
[frontend](../examples/counter/frontend/src/Frontend.hs) and
[backend](../examples/counter/backend/src/Backend.hs).

Only public values belong in `config/common` and `config/frontend`. They are
included in the app. Keep backend secrets and signing credentials out of
bundles, Nix inputs and source control.

Do not use `server.url`, broad cleartext permissions or disabled TLS
verification to connect a production backend. Configure authentication for
the WebView; cross-origin cookies and OAuth flows may need a native plugin.
Offline-only apps do not need a backend.

For local HTTPS testing, use the [counter runner](../examples/counter#run-android-with-nix).

## iOS

iOS Simulator acceptance passed on iPhone 16 / iOS 26.2 with Xcode 26.2 in
[run 40234239685](https://github.com/obsidiansystems/obelisk-capacitor/actions/runs/40234239685).
Android passed in the same run. The Linux-built frontend's SHA-256 was
recomputed and matches both platforms' artifacts and the CI-recorded entries
in [`compatibility.json`](../compatibility.json).

Native counter taps, goal drags to 4 and 24, and card swipes passed with count 5
and goal 24 preserved through the round trip. The existing config/assets,
hash-route/reload/history, HTTPS backend, native `Device.getInfo()` and
backend-outage checks also passed.

Native screenshots show the goal ring changing and cards snapped into view.
The run's `final-ios.png` exposed header/status-bar overlap after scrolling.
The counter now keeps an opaque, viewport-fixed background behind that safe
area. The iOS test adds vertical-scroll and post-navigation checks plus
`status-bar-scrolled-ios.png`. The regression fails on the old CSS and passes
on the new CSS in a browser smoke with emulated iOS insets; zero-inset
rendering is unchanged. Hosted WKWebView confirmation of this fix is pending.

Development requires macOS and Xcode.
After building `result-mobile` with `webBundle.js`, add and sync the platform:

```sh
(cd mobile && npx --no-install cap add ios)
node deps/obelisk-capacitor/bin/ob-capacitor.mjs sync \
  --project mobile --bundle result-mobile --platform ios
(cd mobile && npx --no-install cap open ios)
```

Run `cap add ios` only once. Later frontend changes need a rebuild and sync.
Capacitor 8 uses Swift Package Manager. Open `mobile/ios/App/App.xcodeproj`
and select the `App` scheme; no CocoaPods workspace is required.

Hosted simulator acceptance is opt-in and non-blocking. Open the
[mobile workflow](https://github.com/obsidiansystems/obelisk-capacitor/actions/workflows/mobile.yml),
choose **Run workflow**, select `master`, and enable
**Run the non-blocking iOS Simulator acceptance job**. With Actions write
permission, the equivalent CLI command is:

```sh
gh workflow run mobile.yml --repo obsidiansystems/obelisk-capacitor \
  --ref master -f run_ios=true
```

The job targets Xcode 26.2 and a fresh iPhone 16 simulator on iOS 26.2,
using the same Linux-built web bundle as Android. The test driver is pinned
to XCUITest 12.13.2 (bundled WebDriverAgent 16.12.10) to avoid the copy phase
introduced by [WebDriverAgent PR 1271](https://github.com/appium/WebDriverAgent/pull/1271),
which expects a dylib missing from Xcode 26.2.
CI keeps the prebooted simulator headless and uses that standalone WDA build.
Session creation has a ten-minute client deadline and no client retries, so
a slow startup does not create competing sessions on the same device.
The iOS WebView allowlist includes `process-App`, the identifier WebKit reports
for this simulator app, in addition to its normal bundle ID; no wildcard is used.

Check the iOS acceptance step itself, not just the overall workflow status.
The `ios-evidence` artifact contains build/Appium logs, runtime versions and
any captured screenshots. The Appium file log includes debug-level WebKit
discovery details while console output stays at info level. The built app's
`Info.plist` and `capacitor.config.json` are also collected to check the
inspection settings actually packaged, not just the source configuration.
Failures also capture `failure-native-ios.xml` to distinguish nested
accessibility nodes from independent WebViews and inspect the visible hierarchy.
`acceptance-ios.json` is emitted only after all assertions pass. The record
job requires Android acceptance too and preserves iOS as optional; a successful
build or a green overall workflow alone is not simulator acceptance.

## Signing

Configure signing in the application-owned native project. Use Android
`signingConfigs` with external keystore properties, or Xcode's Signing &
Capabilities settings. Sync preserves these settings.

Physical devices and signed store builds have not been tested. See
[`compatibility.json`](../compatibility.json) for tested configurations.

## Migrating from obelisk-ios-xcode

Capacitor packages a JavaScript frontend rather than a native Haskell library.
Create a new Capacitor project with the quick start, then port your native
integration:

- Replace lifecycle and URL callbacks with App plugin events.
- Use an appropriate Capacitor plugin for notifications.
- Move custom native code into Capacitor plugins exported from `native.mjs`.

The old UIKit and Haskell FFI bridge is not compatible with Capacitor. Native
WKWebView handles and FFI callbacks cannot be carried across unchanged.
