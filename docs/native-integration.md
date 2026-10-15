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

Full iOS acceptance remains unverified. Development requires macOS and Xcode.
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

Check the iOS acceptance step itself, not just the overall workflow status.
The `ios-evidence` artifact contains build/Appium logs, runtime versions and
touch screenshots; `acceptance-ios.json` is emitted only after all assertions
pass. The record job requires Android acceptance too and preserves iOS as
optional. No simulator result is claimed until that evidence is recorded.

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
