# The counter example

A real Obelisk application whose portable web bundle is what ob-capacitor
wraps, kept as the sibling's acceptance reference.

- `deps/obelisk/thunk.nix` pins the immutable Obelisk revision this example
  builds against (independently of any app's own Obelisk pin).
- `config/common/route` is the public backend origin baked into the bundle
  (`https://localhost:8443`, served by Caddy with a per-run CA).
- `static/src` carries real assets (an SVG logo and a stylesheet) so hashed
  URLs are exercised end to end.
- `app/` is the generated Capacitor application (from `ob-capacitor init` +
  `cap add android` + `cap add ios`); its `ios/` and `android/` projects are
  source-controlled. The Android debug overlay trusts the per-run test CA
  (`app/src/debug/res/raw/test_ca.pem`, overwritten by CI each run).
- `native-backend.nix` builds the test backend from a *downloaded* bundle, so
  native CI never cross-compiles a second frontend.

Android is the required native CI gate. iOS is temporarily opt-in and
non-blocking (`workflow_dispatch` with `run_ios=true`); its full acceptance
remains unverified. Passing tuples and run links live in
[`compatibility.json`](../../compatibility.json).

The frontend exercises live Reflex-DOM behavior: a `foldDyn` counter,
route-driven widget replacement, asynchronous XHR responses, and JSaddle
effects displaying native device information. It is a small integration
smoke app, not a large-UI or lifecycle stress test. The native suite checks
both successful backend state changes and visible failures while local
events remain responsive.

## Run Android with Nix

From the repository root:

```sh
NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1 \
  nix-shell examples/counter/android.nix --run counter-android
```

Setting `NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1` accepts the Android SDK licenses
for this invocation. The runner requires x86_64 Linux, Nix, and read/write
access to `/dev/kvm`. Ports 8000 and 8443 must be free.

Nix supplies the SDK, API 35 Google APIs x86_64 system image, emulator,
Node 22, JDK 21, OpenSSL and Caddy from the example's existing nixpkgs pin.
You do not need Android Studio or a separate SDK installation.
On Wayland without an X11 display, the runner starts its own
`xwayland-satellite` process for the emulator window.

The command builds the JavaScript bundle and native backend. It then creates
a development CA, syncs a temporary copy of the native app, and builds the
debug APK. It starts the backend and HTTPS proxy, boots a fresh emulator,
maps port 8443 with `adb reverse`, and installs and launches the app.

The terminal prints the emulator serial, APK path and log directory.
Keep it open while testing. Press Ctrl+C to stop the processes and remove
the temporary workspace, including the AVD, certificates, APK and logs.
Copy any files you want to keep before stopping.

Native source and the checked-in test CA are unchanged. The runner installs
the CLI's locked dependencies into the repository's ignored `node_modules/`.
Nix, npm and Gradle retain their normal caches. npm and Gradle need network
access for dependencies that are not cached; this is not a sandboxed APK build.

For a run without an emulator window:

```sh
NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1 \
  nix-shell examples/counter/android.nix --run 'counter-android --headless'
```

Headless mode also stays running until interrupted. It does not run the
Appium acceptance suite.

### Manual checks

1. Tap Increment. The local count changes from 0 to 1.
2. Tap POST /api/increment. The first response is `HTTP 200 {"count":1}`.
3. Check that the device result contains `platform=android`.
4. Open item a.b. Use Android Back to return to the home route.

To inspect the WebView, open `chrome://inspect/#devices` in desktop Chrome.
Select the counter's `https://localhost/` page. DevTools provides the console,
network requests and an offline network setting for checking request failures.

