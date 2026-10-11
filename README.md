# obelisk-capacitor

Capacitor sibling for [Obelisk](https://github.com/obsidiansystems/obelisk):
wrap the portable **obelisk web bundle** (JavaScript target) in application-
owned iOS and Android projects, and call native device APIs from your Haskell
frontend through jsaddle.

Obelisk core ships the generic `webBundle` output; this repository owns the
Capacitor-specific contract. Apps pin Obelisk and this sibling independently:
Obelisk's web, GHC, nixpkgs and security releases never wait for mobile SDKs,
and mobile releases never wait for Obelisk.

- **Status:** initial release. The exercised platform matrix lives in
  [`compatibility.json`](./compatibility.json); a platform not listed there is
  not claimed to work.
- **Target:** `js` (GHCJS). A WASM bundle is rejected with instructions to
  rebuild for JavaScript; the sibling never rebuilds your frontend, switches
  compilers, or ships two runtimes. (Rationale: the GHC WASM backend's
  asynchronous JSFFI needs JSPI, which older WKWebView/Android WebView
  releases lack; the JavaScript output has no such dependency.)

## Setup

Requirements: Node 22.19+ / npm 10+ (CI runs Node 22.23.2), Nix for the
Obelisk build, and for native work Xcode (iOS) or Android Studio (Android).

```bash
git clone git@github.com:obsidiansystems/obelisk-capacitor.git <app>/deps/obelisk-capacitor
cd <app>/deps/obelisk-capacitor && npm ci   # prepares the CLI (esbuild + parse5)
```

No npm publication: applications consume the CLI from a pinned Git revision.

## The two commands

```text
ob-capacitor init DIR --app-id ID --app-name NAME --bundle BUNDLE
ob-capacitor sync --project DIR --bundle BUNDLE --platform ios|android
```

Run them as `node deps/obelisk-capacitor/bin/ob-capacitor.mjs ...`.

### init

Validates the bundle first, refuses an existing destination, then in a
temporary directory: copies the locked application template, runs
project-local `npm ci`, writes your appId/appName into `capacitor.config.json`
(`webDir` stays `www`), stamps the `obeliskCapacitor` ownership marker, and
stages the web tree. The destination appears only when everything succeeded;
on failure only the invocation-owned temporary directory is removed. `init`
needs Node/npm, not Xcode or the Android SDK.

### sync

Requires the ownership marker, `webDir=www` and the platform's native
project. It validates and stages the complete replacement web tree before
touching the previous payload, rejects symlinked destinations, never modifies
the source bundle, and then invokes the application's **own** installed
Capacitor CLI (`cap sync <platform>`) with an argument array - no command
that could silently download another CLI. A failing native sync propagates
its exit status; nothing is reported as a partial success.

### The standard native workflow

1. `nix-build default.nix -A nixpkgs.webBundle.js -o result-mobile` (in your
   Obelisk application).
2. `ob-capacitor init DIR --app-id ... --app-name ... --bundle result-mobile`.
3. In the generated application: `npx cap add android`, and on macOS
   `npx cap add ios`. These native projects are **application-owned and
   source-controlled**; sync regenerates only Capacitor's own sync output.
4. After each frontend rebuild: rebuild the bundle, `ob-capacitor sync ...`,
   then use the local `cap run`, `cap open`, or native build tools as usual.

`www/`, `node_modules/`, build products and signing secrets are ignored by
the generated `.gitignore`.

## What the bundle must look like

The bundle directory (from `nix-build -A nixpkgs.webBundle.js`) is validated
against `obelisk-web-bundle.json` (`"version": 1`, `"target": "js"`,
`"webDir": "www"`) and must contain `www/index.html`, `www/ghcjs/all.js` and
`www/static/`. During staging the sibling:

- parses the bootstrap HTML and requires the version-1 structure
  (`obelisk-frontend-mode` metadata with `content="client"` plus the deferred
  `/ghcjs/all.js` entry), switching the mode to **`client-hash`** - Obelisk's
  hash routing (`/?q=x#item/a.b`) suits Capacitor's local origins, whose
  extensionless-path handling is not a general SPA fallback;
- bundles the application-owned `native.mjs` with esbuild (browser IIFE,
  `target=es2020`, global `ObeliskCapacitor`) to `www/obelisk-capacitor.js`,
  loaded synchronously in the head before the deferred Haskell entry. The
  compiler's `all.js` is never rewritten;
- copies the payload as regular files (no symlinks, no Nix store references,
  no `.assets` metadata).

Every sync starts from the pristine bundle artifact, so script tags cannot
accumulate.

## Plugin interop (no second Haskell runtime)

`native.mjs` is the application's plugin entry. The template exports
`Capacitor` (core), `App` (`@capacitor/app`) and `Device`
(`@capacitor/device`); add more official or custom plugins by exporting them
there and adding their npm packages to the app's `package.json`.

The public JS boundary is
`globalThis.ObeliskCapacitor.{Capacitor,App,Device,...}`. From Haskell, use
ordinary jsaddle (see `examples/counter/frontend/src/Frontend.hs`): the
example's Device button calls the real `Device.getInfo()` and renders its
native `platform`/`os` - through the documented plugin object, not the
bridge's internals. Native Promise **rejections surface in the UI**; they are
never swallowed.

App lifecycle and URL-open events come from the official `App` plugin.
Applications remain responsible for URL allowlists, route decoding and
associated-domain/custom-scheme setup; inbound URLs are never turned into
navigation silently.

### Migrating from obelisk-ios-xcode

`obelisk-ios-xcode` wrapped a native `libfrontend.a`, booted the GHC RTS and
forwarded UIKit/push/universal-link callbacks through StablePtr/C FFI. None
of that is ABI-compatible with Capacitor:

- native callbacks become plugin calls (`App` for lifecycle/URL opens, push
  plugins for notifications, ...);
- the WKWebView handle and C FFI surfaces are **not carried across** - custom
  native code becomes a Capacitor plugin invoked through `native.mjs`;
- the frontend artifact is now the JavaScript web bundle rather than a
  cross-compiled static library.

## Backend access

Capacitor's local origins are `capacitor://localhost` (iOS) and
`https://localhost` (Android). Production uses packaged assets: do not set
`server.url`, do not permit broad cleartext traffic, do not disable TLS
checks, and do not patch all fetch/XHR requests.

The example resolves its backend origin from the public config
`common/route` (trimmed and validated; a missing or invalid value renders a
visible error instead of silently fetching the WebView's own origin) and
allows precisely the two Capacitor origins on the backend, including
preflight. HTTPS terminates at an explicit reverse proxy (Caddy in CI);
cookies/OAuth flows do **not** automatically work cross-origin in a
WebView - use token or plugin-based auth deliberately. Offline-only
applications need no backend config.

## CI and release evidence

`.github/workflows/mobile.yml` (PRs and `workflow_dispatch`) builds the
counter example's web bundle once on Linux, transfers the **same bytes** to
the platform jobs, and runs them inside a real iOS Simulator (XCUITest) and
Android Emulator (UiAutomator2 + matching Chromedriver) against a real TLS
backend built from the downloaded bundle (`examples/counter/native-backend.nix`
- no second frontend cross-compilation). Assertions cover config-driven
render, counter events, hashed assets, hash-route navigation/back/forward,
reload at a dotted hash route with an encoded query, Android hardware back,
a real backend state transition, native `Device.getInfo()` results, and
visible failure when the backend is unreachable. Screenshots, Appium/browser
logs and observed versions are uploaded as artifacts on every run.

Both platform jobs are required for a sibling release; make them required
status checks. Framework build floors (iOS 15+ / Android API 24+) say
nothing about the OS/WebView versions actually exercised - those are recorded
per run in `compatibility.json`. Simulator/emulator proof is what we claim:
physical-device and signed-store distribution are not asserted.

## Signing and release

The native projects are yours: configure signing as you would in any
Capacitor app - Xcode "Signing & Capabilities" / `xcodebuild` distribution
options, Android `signingConfigs` with keystore properties kept **outside**
Nix inputs and bundles. Private keys never belong in the bundle, the Nix
store, or this repository.

## Example

[`examples/counter`](./examples/counter) is a real Obelisk application with
its own immutable Obelisk pin, public config, hashed static assets, the
plugin entry, and generated (source-controlled) `ios/` and `android/`
projects. Its frontend exercises every assertion above.

## Development

```bash
npm ci
npm test          # bundle/cli/app unit + flow tests (node:test)
```
