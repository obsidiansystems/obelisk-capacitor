// Application-owned native plugin entry. ob-capacitor bundles this file (and
// everything it imports) with esbuild into www/obelisk-capacitor.js, exposed
// as globalThis.ObeliskCapacitor for the Haskell frontend's jsaddle interop.
//
// Add further official or custom plugins by exporting them here and adding
// their npm packages to this project's package.json.
export { Capacitor } from '@capacitor/core';
export { App } from '@capacitor/app';
export { Device } from '@capacitor/device';
