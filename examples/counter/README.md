# The counter example

A real Obelisk application whose portable web bundle is what ob-capacitor
wraps, kept as the sibling's acceptance reference.

- `deps/obelisk/thunk.nix` pins the immutable Obelisk revision this example
  builds against (independently of any app's own Obelisk pin).
- `config/common/route` is the public backend origin baked into the bundle
  (`https://localhost:8443` in CI, served by Caddy with a per-run CA).
- `static/src` carries real assets (an SVG logo and a stylesheet) so hashed
  URLs are exercised end to end.
- `app/` is the generated Capacitor application (from `ob-capacitor init` +
  `cap add android` + `cap add ios`); its `ios/` and `android/` projects are
  source-controlled. The Android debug overlay trusts the per-run test CA
  (`app/src/debug/res/raw/test_ca.pem`, overwritten by CI each run).
- `native-backend.nix` builds the test backend from a *downloaded* bundle, so
  native CI never cross-compiles a second frontend.

## Rebuild everything locally

```bash
nix-build default.nix -A nixpkgs.webBundle.js -o result-mobile
cd ../.. && node bin/ob-capacitor.mjs sync \
  --project examples/counter/app --bundle examples/counter/result-mobile --platform android
```
