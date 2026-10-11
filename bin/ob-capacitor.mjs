#!/usr/bin/env node
// ob-capacitor: scaffold and sync Capacitor applications around the portable
// obelisk web bundle.
//
//   ob-capacitor init DIR --app-id ID --app-name NAME --bundle BUNDLE
//   ob-capacitor sync --project DIR --bundle BUNDLE --platform ios|android
//
// init needs Node and npm, not Xcode or the Android SDK. Native projects are
// added with the generated application's own Capacitor CLI (cap add ios /
// cap add android) and are application-owned from then on.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import url from 'node:url';

const here = dirname(url.fileURLToPath(import.meta.url));
const siblingRoot = resolve(here, '..');
const cliVersion = JSON.parse(await readFile(join(siblingRoot, 'package.json'), 'utf8')).version;

const {
  APP_WWW_DIR, BundleError, ownershipMarker, hasOwnershipMarker,
  readAppPackage, readBundle, readCapacitorConfig, stageWebTree,
  assertNoSymlinkDir, swapDirectory,
} = await import(join(siblingRoot, 'src', 'bundle.mjs'));

const USAGE = `usage:
  ob-capacitor init DIR --app-id ID --app-name NAME --bundle BUNDLE
  ob-capacitor sync --project DIR --bundle BUNDLE --platform ios|android`;

function die(msg, code = 1) {
  process.stderr.write(`ob-capacitor: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!(key in spec)) die(`unknown option --${key}\n${USAGE}`, 2);
      const arity = spec[key];
      const values = [];
      for (let k = 0; k < arity; k += 1) {
        if (i + 1 + k >= argv.length || argv[i + 1 + k].startsWith('--')) {
          die(`option --${key} expects ${arity} value(s)`, 2);
        }
        values.push(argv[i + 1 + k]);
      }
      out[key] = arity === 1 ? values[0] : values;
      i += 1 + arity;
    } else {
      out._.push(a);
      i += 1;
    }
  }
  for (const [key, arity] of Object.entries(spec)) {
    if (arity > 0 && out[key] === undefined) die(`missing required option --${key}\n${USAGE}`, 2);
  }
  return out;
}

// Run a command with an argument array, inheriting stdio so failures surface
// verbatim. No shell, no npx-style "download another CLI".
function run(cmd, args, { cwd, env = process.env, allowFailure = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (res.error) die(`cannot run ${cmd}: ${res.error.message}`, 127);
  if (res.status !== 0 && !allowFailure) {
    die(`command failed (${res.status}): ${cmd} ${args.join(' ')}`, res.status ?? 1);
  }
  return res.status ?? 0;
}

async function runAsync(cmd, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    child.on('error', (e) => rejectP(new BundleError(`cannot run ${cmd}: ${e.message}`)));
    child.on('close', (code) => (code === 0
      ? resolveP()
      : rejectP(Object.assign(new BundleError(`${cmd} ${args.join(' ')} exited with ${code}`), { exitCode: code }))));
  });
}

async function npmCli(dir) {
  const req = createRequire(join(dir, 'package.json'));
  try {
    const capPath = req.resolve('@capacitor/cli/bin/capacitor');
    return { cap: [process.execPath, capPath] };
  } catch (e) {
    die(`app ${dir} has no locally installed Capacitor CLI/npm; run its "npm ci" first: ${e.message}`);
  }
}

async function cmdInit([dir], opts) {
  const appDir = resolve(dir);
  const bundleDir = resolve(opts.bundle);
  // Validate the bundle first; a bad bundle must create nothing.
  const bundle = await readBundle(bundleDir);
  const parent = dirname(appDir);
  const existing = await lstat(appDir).catch(() => null);
  if (existing) die(`init: destination ${appDir} already exists; refusing to overwrite it`);

  const work = await mkdtemp(join(tmpdir(), 'ob-capacitor-init-'));
  const stagingApp = join(work, 'app');
  try {
    await mkdir(parent, { recursive: true });
    await cp(join(siblingRoot, 'templates', 'app'), stagingApp, { recursive: true, dereference: true });

    // Application identity: fixed private package name, user-supplied
    // appId/appName in the Capacitor config, ownership marker with our version.
    const pkgPath = join(stagingApp, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.obeliskCapacitor = ownershipMarker(cliVersion);
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const cfgPath = join(stagingApp, 'capacitor.config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    cfg.appId = opts['app-id'];
    cfg.appName = opts['app-name'];
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    // Project-local npm ci (offline-friendly: the lockfile pins everything).
    // npm itself is the ambient one from PATH; Capacitor is installed by ci.
    await runAsync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: stagingApp });

    // Stage the complete app from the validated bundle.
    const { staging, newWww } = await stageWebTree(stagingApp, bundle, { cliVersion });
    await rm(join(stagingApp, APP_WWW_DIR), { recursive: true, force: true });
    await rename(newWww, join(stagingApp, APP_WWW_DIR));
    await rm(staging, { recursive: true, force: true });

    // Publish only on success: an atomic rename inside one filesystem.
    await rename(stagingApp, appDir);
    process.stdout.write(`initialized ${appDir} (appId ${opts['app-id']})\n`);
    process.stdout.write(`next: cd ${appDir} && npx cap add android${process.platform === 'darwin' ? ' && npx cap add ios' : ' # and on macOS: npx cap add ios'}\n`);
  } catch (e) {
    await rm(work, { recursive: true, force: true });
    throw e;
  }
}


async function cmdSync(_pos, opts) {
  const appDir = resolve(opts.project);
  const bundleDir = resolve(opts.bundle);
  const platform = opts.platform;
  if (platform !== 'ios' && platform !== 'android') {
    die(`sync: --platform must be ios or android (found ${JSON.stringify(platform)})`, 2);
  }
  await assertNoSymlinkDir(appDir, 'sync: project');

  const pkg = await readAppPackage(appDir);
  if (!hasOwnershipMarker(pkg)) {
    die(`sync: ${appDir} carries no obeliskCapacitor ownership marker; ob-capacitor only syncs applications it initialized`);
  }
  const cfg = await readCapacitorConfig(appDir);
  const nativeDir = join(appDir, platform);
  const nativeSt = await lstat(nativeDir).catch(() => null);
  if (!nativeSt?.isDirectory()) {
    die(`sync: no ${platform}/ native project in ${appDir}; run "npx cap add ${platform}" in the application first`);
  }
  if (nativeSt.isSymbolicLink()) die(`sync: ${nativeDir} is a symlink; refusing to touch it`);

  // Validate and stage everything before replacing the owned www.
  const bundle = await readBundle(bundleDir);
  const wwwDir = join(appDir, APP_WWW_DIR);
  const wwwSt = await lstat(wwwDir).catch(() => null);
  if (wwwSt && wwwSt.isSymbolicLink()) die(`sync: ${wwwDir} is a symlink; refusing to touch it`);
  const { staging, newWww } = await stageWebTree(appDir, bundle, { cliVersion });

  let backup = null;
  try {
    if (wwwSt) {
      backup = await swapDirectory(wwwDir, newWww, { backupName: `${APP_WWW_DIR}.ob-capacitor-bak` });
    } else {
      await rename(newWww, wwwDir);
    }
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }

  try {
    const { cap } = await npmCli(appDir);
    await runAsync(cap[0], [...cap.slice(1), 'sync', platform], { cwd: appDir });
  } catch (e) {
    // The web payload is already the new one; cap sync failure is a real
    // failure and is reported as such (never pretend a partial sync worked).
    await rm(staging, { recursive: true, force: true });
    if (backup) await rm(backup, { recursive: true, force: true });
    die(`cap sync ${platform} failed; the web payload was replaced but native synchronization did not run through. Fix the error and re-run sync.\n${e.message}`, e.exitCode ?? 1);
  }
  await rm(staging, { recursive: true, force: true });
  if (backup) await rm(backup, { recursive: true, force: true });
  process.stdout.write(`synced ${cfg.appName} (${cfg.appId}) for ${platform} from ${bundleDir}\n`);
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  try {
    switch (sub) {
      case 'init': {
        const opts = parseArgs(rest, { 'app-id': 1, 'app-name': 1, bundle: 1 });
        if (opts._.length !== 1) die(`init: exactly one DIR argument expected\n${USAGE}`, 2);
        await cmdInit(opts._, opts);
        break;
      }
      case 'sync': {
        const opts = parseArgs(rest, { project: 1, bundle: 1, platform: 1 });
        await cmdSync(opts._, opts);
        break;
      }
      default:
        die(USAGE, 2);
    }
  } catch (e) {
    if (e instanceof BundleError) die(e.message);
    throw e;
  }
}

await main();
