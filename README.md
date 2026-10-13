<div align="center">

# obelisk-capacitor

### Your Haskell frontend, in a native app.

`Obelisk` · `Reflex-DOM` · `Capacitor` — one web bundle, application-owned native projects.

[![Android CI](https://github.com/obsidiansystems/obelisk-capacitor/actions/workflows/mobile.yml/badge.svg?branch=master)](https://github.com/obsidiansystems/obelisk-capacitor/actions/workflows/mobile.yml) [![Built with Nix](https://img.shields.io/static/v1?logo=nixos&logoColor=white&label=&message=Built%20with%20Nix&color=41439a)](https://nixos.org) [![Capacitor](https://img.shields.io/badge/Capacitor-8.5.3-119EFF?logo=capacitor&logoColor=white)](https://capacitorjs.com) [![Obsidian](https://img.shields.io/badge/Obsidian-Systems-white)](https://obsidian.systems)

[Quick start](#quick-start) · [Counter example](./examples/counter) · [Native plugins](#native-plugins-from-haskell) · [Compatibility](./compatibility.json)

</div>

After the one-time setup below, the edit loop is a bundle build and a sync:

```sh
# In your Obelisk application:
nix-build default.nix -A nixpkgs.webBundle.js -o result-mobile
node deps/obelisk-capacitor/bin/ob-capacitor.mjs sync \
  --project mobile --bundle result-mobile --platform android
```

Wrap an [Obelisk](https://github.com/obsidiansystems/obelisk) frontend in
[Capacitor](https://capacitorjs.com), keep its Reflex-DOM event graph running
inside the native WebView, and call device APIs through ordinary JSaddle.
Obelisk builds the portable web artifact; this repository handles the
Capacitor integration. Your app owns the Android and iOS projects.

> **Android first.** Android is the required native CI gate. iOS testing is
> temporarily opt-in and non-blocking; full iOS acceptance remains unverified.
> [`compatibility.json`](./compatibility.json) records passing, exercised
> configurations—not a promise that every OS or WebView works.

## Why obelisk-capacitor?

- **Keep your Haskell frontend.** Reflex events, `Dynamic`s, typed routes and
  JSaddle interop run from the compiled JavaScript bundle. No second Haskell
  runtime or native Haskell cross-compilation.
- **Build once, package natively.** The bundle carries bootstrap HTML, public
  config, compiler output and hashed assets. Native packaging needs neither
  the producer's Nix store nor another frontend build.
- **Own the native projects.** Commit `android/` and `ios/`. Use the normal
  Capacitor CLI, Android Studio and Xcode; retain native source, plugins and
  signing settings across syncs.
- **Reach real device APIs.** Export official or custom Capacitor plugins
  from an application-owned `native.mjs`, then call them from Haskell.
- **Pin the two sides independently.** Obelisk core and this integration have
  separate Git pins. Core web/compiler/security releases do not wait for
  mobile SDKs, and mobile releases do not gate Obelisk.

## Quick start

### Prerequisites

| Tool | Needed for |
|---|---|
| Node 22.19+ and npm 10+ | The CLI and locked application dependencies; CI uses Node 22.23.2 |
| Nix and an Obelisk revision with `webBundle` | Building the portable JavaScript frontend |
| Android Studio / Android SDK and JDK 21 | Android builds; the template uses compileSdk 36 and minSdk 24 |
| macOS and Xcode | Optional iOS work; the currently unverified CI configuration selects Xcode 26.2 |

### 1. Pin the integration

From your Obelisk application root:

```sh
git clone https://github.com/obsidiansystems/obelisk-capacitor.git deps/obelisk-capacitor
(cd deps/obelisk-capacitor && npm ci)
```

Check out the sibling Git revision you intend to keep and record that pin
with your application's dependencies. Pin Obelisk separately to a compatible
revision; the [counter example](./examples/counter/deps/obelisk/thunk.nix)
shows its immutable core pin. There is no npm-registry publication or global
CLI installation.

### 2. Build the bundle and create the app

```sh
nix-build default.nix -A nixpkgs.webBundle.js -o result-mobile

node deps/obelisk-capacitor/bin/ob-capacitor.mjs init mobile \
  --app-id com.example.myapp --app-name "My App" --bundle result-mobile

(cd mobile && npx --no-install cap add android)
```

`init` needs only Node/npm, not a native SDK. Commit the generated application,
including `mobile/android/`, its lockfile and `native.mjs`. `www/`,
`node_modules/`, build products and signing secrets are ignored.

On macOS, `npx --no-install cap add ios` adds an application-owned iOS project.
Capacitor 8 uses Swift Package Manager: `ios/App/App.xcodeproj`, scheme `App`;
no CocoaPods workspace is required.

### 3. Rebuild, sync, run

Use the build-and-sync commands above after each frontend change, then:

```sh
(cd mobile && npx --no-install cap run android)
# Or work in Android Studio:
(cd mobile && npx --no-install cap open android)
```

For iOS development, select `--platform ios` when syncing and use the local
Capacitor CLI or Xcode. This workflow exists, but its full native acceptance
is still unverified.

## Two commands, clear ownership

```text
ob-capacitor init DIR --app-id ID --app-name NAME --bundle BUNDLE
ob-capacitor sync --project DIR --bundle BUNDLE --platform ios|android
```

Invoke them with `node deps/obelisk-capacitor/bin/ob-capacitor.mjs`.

**`init`** validates the bundle, refuses an existing destination, and prepares
an app in an invocation-owned temporary directory. It installs the locked
template with `npm ci`, sets the app ID/name and ownership marker, and stages
the web payload. The destination appears only after initialization succeeds.

**`sync`** requires the ownership marker, `webDir=www` and an existing native
project. It validates and stages a complete replacement before swapping the
owned web payload, then invokes the application's installed Capacitor CLI.
Invalid input leaves the old payload intact; native-sync failures propagate
their exit status. It never mutates the source bundle or silently downloads
a different CLI. Native source, signing configuration and plugin definitions
remain application-owned.

## The bundle boundary

The core exporter produces:

```text
obelisk-web-bundle.json
www/
  index.html
  ghcjs/                 # Optimized compiler output
  static/                # Hashed assets and original-name aliases
```

The manifest must specify `format=obelisk-web-bundle`, `version=1`,
`target=js`, and `webDir=www`. The payload must include `www/ghcjs/all.js`.
Only public `config/common` and `config/frontend` values belong in the
bootstrap HTML—never `config/backend`, signing material or other secrets.

During staging, the CLI:

1. Parses the version-1 bootstrap HTML and switches `client` mode to
   **`client-hash`**. Routes such as `/?q=a.b#item/a.b` keep dotted identifiers
   out of Capacitor's asset-path handling; the query stays before the hash.
2. Bundles the app's `native.mjs` as an ES2020 browser IIFE exposed as
   `ObeliskCapacitor`, loading it synchronously before the deferred Haskell
   entry point. The compiler's `all.js` is not rewritten.
3. Copies regular files, without symlinks, Nix store dependencies or `.assets`
   metadata. Every sync starts from the pristine artifact, so script tags do
   not accumulate.

**JavaScript only for native packaging.** WASM bundles are rejected with a
rebuild instruction; the CLI never switches compilers or ships two runtimes.
The GHC WASM backend's asynchronous JSFFI needs JSPI, which is unavailable in
older WKWebView and Android WebView releases. Core's WASM web target is
unchanged.

## Native plugins from Haskell

The template's application-owned `native.mjs` exports:

```js
export { Capacitor } from '@capacitor/core';
export { App } from '@capacitor/app';
export { Device } from '@capacitor/device';
```

The public boundary is `globalThis.ObeliskCapacitor.{Capacitor,App,Device,...}`.
Add a plugin dependency to the app, export it here, and sync. The
[counter frontend](./examples/counter/frontend/src/Frontend.hs) calls the real
`Device.getInfo()` through JSaddle and displays its platform/OS result.
Promise rejections are rendered as errors, not swallowed.

Lifecycle and URL-open events come from the official `App` plugin. Your app
owns URL allowlists, route decoding and associated-domain/custom-scheme
configuration; incoming URLs are not silently converted into navigation.

### Coming from obelisk-ios-xcode?

The old integration booted the GHC RTS from `libfrontend.a` and forwarded
UIKit/push/universal-link callbacks through StablePtr/C FFI. Capacitor is not
ABI-compatible with it:

- Lifecycle and URL callbacks become `App` plugin calls; notifications use
  the appropriate push plugin.
- Custom native code becomes a Capacitor plugin exported through `native.mjs`.
  Native WKWebView handles and C FFI surfaces do not carry across.
- The frontend artifact is a JavaScript web bundle, not a native static library.

## Talking to your backend

Packaged assets run at `https://localhost` on Android and
`capacitor://localhost` on iOS. Resolve backend requests against an explicit
absolute origin—not the WebView's local origin.

The example reads public `common/route`, trims and validates it, and shows a
visible error if it is missing or invalid. Its backend allows precisely those
two Capacitor origins, including CORS preflight. HTTPS terminates at an
explicit reverse proxy; CI uses Caddy and an ephemeral test CA, trusted only
by the Android debug build or the iOS simulator.

Production must not set `server.url`, permit broad cleartext traffic, disable
TLS verification or patch every fetch/XHR request. Cross-origin web cookies
and OAuth flows do not automatically work in a WebView—choose token or
plugin-based authentication deliberately. Offline-only apps need no backend.

## A small app with a real event loop

[`examples/counter`](./examples/counter) is the native acceptance reference:

- A local counter driven by DOM events, `foldDyn` and `dynText`.
- Public-config rendering and a decoded, content-hashed image.
- Typed route navigation, back/forward history and reload at a dotted hash route.
- A real asynchronous backend POST that changes server state.
- Native `Device.getInfo()` through JSaddle and Capacitor.
- Visible backend failure while the local counter remains interactive.

It exercises live FRP and native integration, not just a static page. It is
not a stress test, a large dynamic UI, or lifecycle/background-resume coverage.

## CI and compatibility

The [mobile workflow](./.github/workflows/mobile.yml) runs on pull requests,
`master` pushes and manual dispatch. It builds the JavaScript bundle once on
Linux, then packages those bytes inside an Android Emulator WebView using
UiAutomator2 and a matching Chromedriver. The backend is the real Obelisk
server, built from the downloaded bundle without another frontend
cross-compilation. The suite also exercises Android hardware back.

**Android is the required native gate.** iOS is disabled on ordinary pushes
and PRs; manual dispatch with `run_ios=true` enables its non-blocking
Simulator/XCUITest job. A skipped or failing iOS job cannot be recorded as
verified or prevent a passing Android run from being recorded.

Successful acceptance runs add the observed core/compiler/Capacitor/device/
WebView tuple to [`compatibility.json`](./compatibility.json). Actions
artifacts contain screenshots, logs and acceptance results. Framework build
floors (iOS 15+ / Android API 24+) are not tested-platform claims. Emulator or
simulator evidence says nothing about physical devices or signed store builds.

## Signing and distribution

Use the native projects' normal release tools: Xcode **Signing & Capabilities**
and archive/distribution options, or Android `signingConfigs` with external
keystore properties. Keep signing keys and credentials out of Nix inputs,
bundles and source control. Sync does not take ownership of them.

## Development

```sh
npm ci
npm test
```

The Node tests cover bundle validation and CLI/application flows. They do not
replace the native acceptance jobs.

## About Obsidian Systems

obelisk-capacitor is built by **[Obsidian Systems](https://obsidian.systems)**,
maintainers of [Obelisk](https://github.com/obsidiansystems/obelisk),
[Reflex](https://reflex-frp.org/) and
[nix-thunk](https://github.com/obsidiansystems/nix-thunk).

- Website — <https://obsidian.systems>
- Blog — <https://blog.obsidian.systems>
- GitHub — <https://github.com/obsidiansystems>
