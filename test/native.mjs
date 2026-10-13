// Native acceptance: one script, WebdriverIO standalone remote(), Node
// assertions. Runs the counter example inside a real iOS Simulator or
// Android Emulator WebView against the real TLS backend.
//
// Environment:
//   APPIUM_OS      ios | android
//   APP            absolute path to .app / .apk under test
//   BACKEND_ORIGIN https://localhost:8443 (what common/route baked in)
//   PLATFORM_DIR   test/ios or test/android (its node_modules supplies appium + driver)
//   APPIUM_HOME    job-local extensions home
//   CHROMEDRIVER_EXECUTABLE_DIR (android only)
//   DEVICE_UDID    simulator udid / emulator serial
//   PLATFORM_VERSION / DEVICE_NAME (ios)
//   CADDY_PID      optional: TLS proxy pid, killed to test visible backend failure
//   ARTIFACTS_DIR  where screenshots/logs are written
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const OS = process.env.APPIUM_OS;
assert.ok(OS === 'ios' || OS === 'android', 'APPIUM_OS must be ios or android');
const PLATFORM_DIR = resolve(process.env.PLATFORM_DIR);
const ARTIFACTS = resolve(process.env.ARTIFACTS_DIR || 'test-artifacts');
const req = createRequire(resolve(PLATFORM_DIR, 'package.json'));
const appiumMain = req.resolve('appium');
const { remote } = await import(req.resolve('webdriverio')).then((m) => m.default ? m : m);

await mkdir(ARTIFACTS, { recursive: true });

// ---- Appium as a managed subprocess ----------------------------------------

const appiumArgs = [
  appiumMain,
  '--address', '127.0.0.1',
  '--port', '4723',
  '--log', `${ARTIFACTS}/appium-${OS}.log`,
  '--log-level', 'info',
];
if (OS === 'android') appiumArgs.push('--allow-insecure', 'uiautomator2:chromedriver_autodownload');

const appium = spawn(process.execPath, appiumArgs, {
  env: { ...process.env, APPIUM_HOME: process.env.APPIUM_HOME },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const waitForAppium = async () => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:4723/status');
      if (r.ok) {
        const j = await r.json();
        if (j.value?.ready) return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('appium did not become ready');
};

const caps = OS === 'ios'
  ? {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:app': process.env.APP,
      'appium:deviceName': process.env.DEVICE_NAME || 'iPhone 16',
      'appium:platformVersion': process.env.PLATFORM_VERSION || '26.2',
      'appium:udid': process.env.DEVICE_UDID,
      'appium:noReset': true,
      'appium:autoAcceptAlerts': true,
      'appium:webviewConnectTimeout': 30000,
      'appium:useNewWDA': true,
      'appium:showXcodeLog': true,
      'appium:wdaLaunchTimeout': 240000,
      'appium:wdaConnectionTimeout': 240000,
    }
  : {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:app': process.env.APP,
      'appium:udid': process.env.DEVICE_UDID,
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      'appium:chromedriverExecutableDir': process.env.CHROMEDRIVER_EXECUTABLE_DIR,
      'appium:showChromedriverLog': true,
      'appium:webviewConnectTimeout': 30000,
    };

const shot = (driver, name) => driver.saveScreenshot(`${ARTIFACTS}/${name}-${OS}.png`);

const webviewUrl = async (driver) => driver.execute(() => window.location.href);
const waitText = async (driver, sel, want, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await driver.execute((s) => document.querySelector(s)?.textContent ?? null, sel);
    if (last === want) return;
    await driver.pause(300);
  }
  throw new Error(`timeout: ${sel} wanted ${JSON.stringify(want)}, last ${JSON.stringify(last)}`);
};

let driver;
let failed = false;
try {
  await waitForAppium();
  driver = await remote({ hostname: '127.0.0.1', port: 4723, path: '/', capabilities: caps, logLevel: 'error' });

  // Discover the WEBVIEW context and switch into it.
  const contexts = await driver.getContexts();
  const webview = contexts.find((c) => /WEBVIEW/i.test(typeof c === 'string' ? c : c.id));
  if (!webview) throw new Error(`no WEBVIEW context; contexts: ${JSON.stringify(contexts)}`);
  await driver.switchContext(webview);
  await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#count'))), { timeout: 60000 });
  await shot(driver, 'initial');

  // 1. Initial config-driven render.
  const origin = await driver.execute(() => document.querySelector('#backend-origin')?.textContent);
  // The baked config value may carry the file's trailing newline; the
  // semantic assertion is on the trimmed text.
  assert.match(origin.trim(), new RegExp(`^common/route: ${process.env.BACKEND_ORIGIN?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

  // 1b. iOS-only native-touch scenario: real taps, a slider drag to both
  // endpoints, and card swipes through the scroll-snap track. Gestures are
  // W3C touch actions in NATIVE_APP; state assertions run back in the saved
  // WEBVIEW context. Webview CSS rectangles are mapped into the native
  // webview rectangle via the viewport scale — no JS-driven positioning.
  if (OS === 'ios') {
    const cssRect = (sel) => driver.execute((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return {
        left: r.left, top: r.top, width: r.width, height: r.height,
        vw: document.documentElement.clientWidth, vh: window.innerHeight,
      };
    }, sel);
    const isVisible = (sel) => driver.execute((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1
        && r.top >= -1 && r.bottom <= window.innerHeight + 1;
    }, sel);
    // One native gesture: tap for a single point, drag otherwise.
    const gesture = async (pts) => {
      const nat = await driver.switchContext('NATIVE_APP')
        .then(() => driver.$$('**/XCUIElementTypeWebView'))
        .then(async (els) => {
          if (!els.length) throw new Error('no XCUIElementTypeWebView in NATIVE_APP');
          const el = els[els.length - 1];
          const loc = await el.getLocation();
          const size = await el.getSize();
          return { x: loc.x, y: loc.y, w: size.width };
        });
      const scale = await driver.switchContext(webview)
        .then(() => driver.execute(() => document.documentElement.clientWidth))
        .then((cw) => nat.w / cw);
      const mapped = pts.map(({ x, y }) => ({
        nx: Math.round(nat.x + x * scale),
        ny: Math.round(nat.y + y * scale),
      }));
      await driver.switchContext('NATIVE_APP');
      await driver.performActions([{
        type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
        actions: mapped.length === 1
          ? [
              { type: 'pointerMove', duration: 0, x: mapped[0].nx, y: mapped[0].ny },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 60 },
              { type: 'pointerUp', button: 0 },
            ]
          : [
              { type: 'pointerMove', duration: 0, x: mapped[0].nx, y: mapped[0].ny },
              { type: 'pointerDown', button: 0 },
              ...mapped.slice(1).map((p) => ({ type: 'pointerMove', duration: 140, x: p.nx, y: p.ny })),
              { type: 'pause', duration: 100 },
              { type: 'pointerUp', button: 0 },
            ],
      }]);
      await driver.releaseActions();
      await driver.switchContext(webview);
    };
    const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

    // Tap + Increment five times with native touches; state read in WEBVIEW.
    for (let i = 0; i < 5; i++) {
      await gesture([center(await cssRect('#counter-inc'))]);
      await waitText(driver, '#count', String(i + 1));
    }
    assert.equal(await driver.execute(() => document.querySelector('#count')?.textContent), '5');

    // Drag the goal slider to both endpoints (min 4, max 24). A drag from
    // mid-track to an endpoint ends exactly at that endpoint.
    const goal = await cssRect('#counter-goal');
    const gy = goal.top + goal.height / 2;
    const midX = goal.left + goal.width / 2;
    await gesture([{ x: midX, y: gy }, { x: goal.left - 4, y: gy }]);
    await waitText(driver, '#goal-value', '4');
    await driver.switchContext('NATIVE_APP');
    await shot(driver, 'goal-min');
    await driver.switchContext(webview);
    await gesture([{ x: midX, y: gy }, { x: goal.right + 4, y: gy }]);
    await waitText(driver, '#goal-value', '24');
    await driver.switchContext('NATIVE_APP');
    await shot(driver, 'goal-max');
    await driver.switchContext(webview);
    // The drag must not have touched the counter.
    assert.equal(await driver.execute(() => document.querySelector('#count')?.textContent), '5');

    // Native horizontal swipes across the scroll-snap track and back.
    const cards = await cssRect('#link-main'); // any element gives viewport metrics
    const swipeY = Math.min(cards.vh * 0.55, 500);
    const swipe = async (dir) => gesture([
      { x: dir > 0 ? cards.vw * 0.85 : cards.vw * 0.15, y: swipeY },
      { x: dir > 0 ? cards.vw * 0.15 : cards.vw * 0.85, y: swipeY },
    ]);
    await swipe(1);
    await driver.waitUntil(async () => isVisible('#backend-inc'), { timeout: 15000 });
    await swipe(1);
    await driver.waitUntil(async () => isVisible('#device-btn'), { timeout: 15000 });
    await swipe(-1);
    await driver.waitUntil(async () => isVisible('#backend-inc'), { timeout: 15000 });
    await swipe(-1);
    await driver.waitUntil(async () => isVisible('#counter-inc'), { timeout: 15000 });
    await driver.switchContext('NATIVE_APP');
    await shot(driver, 'swipe-roundtrip');
    await driver.switchContext(webview);
    // State survived the swipe round trip because all cards stay mounted.
    assert.equal(await driver.execute(() => document.querySelector('#count')?.textContent), '5');
    assert.equal(await driver.execute(() => document.querySelector('#goal-value')?.textContent), '24');

    // Reset so the existing acceptance sequence resumes from count 0.
    await (await driver.$('#counter-reset')).click();
    await waitText(driver, '#count', '0');
  }

  // 2. Local counter 0 -> 1 on tap.
  assert.equal(await driver.execute(() => document.querySelector('#count')?.textContent), '0');
  await (await driver.$('#counter-inc')).click();
  await waitText(driver, '#count', '1');

  // 3. Hashed static asset decoded correctly (hashed URL, really loaded).
  const logo = await driver.execute(() => {
    const i = document.getElementById('logo');
    return { src: i.getAttribute('src'), w: i.naturalWidth };
  });
  assert.match(logo.src, /[0-9a-z]+-logo\.svg$/, `logo must load under its hashed name, got src=${JSON.stringify(logo.src)} w=${logo.w}`);
  assert.ok(logo.w > 0, `hashed logo must actually decode, got ${JSON.stringify(logo)}`);

  // 4. Typed route navigation: dotted path segment + encoded query in the hash.
  await (await driver.$('#link-item')).click();
  await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#item-marker'))), { timeout: 30000 });
  const urlItem = await webviewUrl(driver);
  assert.match(urlItem, /\/\?q=a\.b#item\/a\.b$/);

  // 5. Browser-history back/forward inside the WebView.
  await driver.execute(() => window.history.back());
  await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#home-marker'))), { timeout: 30000 });
  await driver.execute(() => window.history.forward());
  await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#item-marker'))), { timeout: 30000 });

  // 6. Reload at a dotted hash route with an encoded query.
  await driver.execute(() => window.location.reload());
  await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#item-marker'))), { timeout: 60000 });
  const urlReload = await webviewUrl(driver);
  assert.match(urlReload, /\/\?q=a\.b#item\/a\.b$/);

  // 6b. Return to the main route; the backend/device widgets live there.
  await driver.execute(() => window.history.back());
  await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#home-marker'))), { timeout: 30000 });

  // 7. Real backend state transition initiated by the UI (via TLS proxy).
  await (await driver.$('#backend-inc')).click();
  await driver.waitUntil(async () => /HTTP 200/.test(await driver.execute(() => document.querySelector('#backend-result')?.textContent ?? '')), { timeout: 30000 });
  const backend1 = await driver.execute(() => document.querySelector('#backend-result')?.textContent);
  assert.match(backend1, /"count":1/);

  // 8. Device.getInfo(): the native platform, not the web fallback.
  await (await driver.$('#device-btn')).click();
  await driver.waitUntil(async () => {
    const t = await driver.execute(() => document.querySelector('#device-result')?.textContent ?? '');
    return t && t !== 'pending' && t !== 'waiting for the ObeliskCapacitor bridge';
  }, { timeout: 30000 });
  const device = await driver.execute(() => document.querySelector('#device-result')?.textContent);
  assert.match(device, new RegExp(`platform=${OS}`), `Device.getInfo must report the native platform: ${device}`);
  assert.ok(!/platform=web/.test(device), `web fallback means the bridge is not native: ${device}`);

  // 9. Android hardware back in NATIVE_APP context: item -> main route.
  if (OS === 'android') {
    // A real user gesture creates a traversable native back-stack entry.
    // Synthetic element.click() can trigger Chromium's history intervention.
    await (await driver.$('#link-item')).click();
    await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#item-marker'))), { timeout: 30000 });
    await driver.switchContext('NATIVE_APP');
    await driver.pressKeyCode(4);
    await driver.switchContext(webview);
    await driver.waitUntil(async () => (await driver.execute(() => !!document.querySelector('#home-marker'))), { timeout: 30000 });
  }

  // 10. Backend unavailable: the UI stays usable and the failure is visible.
  if (process.env.CADDY_PID) {
    const countBefore = Number(await driver.execute(() => document.querySelector('#count').textContent));
    try { process.kill(Number(process.env.CADDY_PID), 'SIGKILL'); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    await (await driver.$('#backend-inc')).click();
    await driver.waitUntil(async () => /HTTP 0/.test(await driver.execute(() => document.querySelector('#backend-result')?.textContent ?? '')), { timeout: 30000 });
    // Local UI still works.
    await (await driver.$('#counter-inc')).click();
    await waitText(driver, '#count', String(countBefore + 1));
  }

  await shot(driver, 'final');
  await writeFile(`${ARTIFACTS}/acceptance-${OS}.json`, JSON.stringify({
    platform: OS,
    device,
    userAgent: await driver.execute(() => navigator.userAgent),
    reloadedRoute: urlReload,
    backendResponse: backend1,
    backendUnavailable: Boolean(process.env.CADDY_PID),
  }, null, 2) + '\n');
  console.log(`NATIVE-AcCEPTANCE-${OS}: ALL ASSERTIONS PASSED`);
} catch (e) {
  failed = true;
  await writeFile(`${ARTIFACTS}/failure-${OS}.txt`, String(e?.stack ?? e), 'utf8').catch(() => {});
  if (driver) {
    await shot(driver, 'failure').catch(() => {});
    // Self-describing failures: dump the live DOM state we were asserting on.
    try {
      const ctx = await driver.getContext().catch(() => null);
      const dump = await driver.execute(() => ({
        href: location.href,
        logo: document.getElementById('logo')?.outerHTML ?? null,
        count: document.querySelector('#count')?.textContent ?? null,
        backendOrigin: document.querySelector('#backend-origin')?.textContent ?? null,
        backendResult: document.querySelector('#backend-result')?.textContent ?? null,
        deviceResult: document.querySelector('#device-result')?.textContent ?? null,
      })).catch((e2) => ({ evalFailed: String(e2) }));
      await writeFile(`${ARTIFACTS}/failure-context-${OS}.json`, JSON.stringify({ ctx, dump }, null, 2), 'utf8');
    } catch {}
  }
  console.error(`NATIVE-Acceptance-${OS} FAILED:`, e?.message ?? e);
  process.exitCode = 1;
} finally {
  if (driver) await driver.deleteSession().catch(() => {});
  appium.kill('SIGTERM');
  await new Promise((r) => { appium.on('exit', r); setTimeout(r, 5000); });
}
