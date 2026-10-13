#!/usr/bin/env node
// Run from the repository root through examples/counter/android.nix.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const usage = `Usage: counter-android [--headless]

Run from the repository root:
  NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1 nix-shell examples/counter/android.nix --run counter-android

Build the counter, start its HTTPS backend and a fresh Android emulator,
and install and launch the debug app. Ctrl+C stops the processes and removes
its temporary workspace. --headless runs without an emulator window.`;

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
if (args.some((arg) => arg !== '--headless')) {
  console.error(usage);
  process.exit(2);
}

const root = process.cwd();
const shutdown = new AbortController();
const active = new Set();
const services = [];
let work;
let env = process.env;

function terminate(job, signal) {
  // Each child owns a process group, including Gradle's single-use JVM.
  if (!job.child.pid) return;
  try { process.kill(-job.child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

shutdown.signal.addEventListener('abort', () => {
  for (const job of active) terminate(job, 'SIGTERM');
});
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    process.exitCode = code;
    shutdown.abort();
  });
}

function start(command, argv, { cwd = root, env: childEnv = env, log, capture = false, input } = {}) {
  shutdown.signal.throwIfAborted();
  const fd = log ? openSync(log, 'w', 0o600) : undefined;
  const child = spawn(command, argv, {
    cwd, env: childEnv, detached: true,
    stdio: [input === undefined ? 'ignore' : 'pipe',
      fd ?? (capture ? 'pipe' : 'inherit'), fd ?? (capture ? 'pipe' : 'inherit')],
  });
  if (fd !== undefined) closeSync(fd);
  const job = { child, command, log, ended: false, stdout: '', stderr: '' };
  active.add(job);
  child.stdout?.on('data', (bytes) => { job.stdout += bytes; });
  child.stderr?.on('data', (bytes) => { job.stderr += bytes; });
  child.on('error', (error) => { job.error = error; });
  job.done = new Promise((resolve) => child.once('close', (code, signal) => {
    Object.assign(job, { ended: true, code, signal });
    active.delete(job);
    resolve(job);
  }));
  if (input !== undefined) {
    child.stdin.on('error', (error) => { job.error = error; });
    child.stdin.end(input);
  }
  return job;
}

function checkServices() {
  for (const job of services) {
    if (job.ended) throw new Error(`${job.command} stopped (${job.error?.message ?? job.signal ?? job.code})`);
  }
}

async function run(command, argv, { allowFailure = false, ...options } = {}) {
  checkServices();
  const job = await start(command, argv, options).done;
  shutdown.signal.throwIfAborted();
  if (job.error || (!allowFailure && job.code !== 0)) {
    throw new Error(`${command} failed (${job.error?.message ?? job.signal ?? job.code})\n${job.stderr}`);
  }
  checkServices();
  return job;
}

function service(command, argv, log) {
  const job = start(command, argv, { cwd: work, log: join(work, log) });
  services.push(job);
  return job;
}

async function waitFor(description, ready, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    checkServices();
    if (await ready()) return;
    await delay(1000, undefined, { signal: shutdown.signal });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function portFree(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function main() {
  for (const name of ['ANDROID_HOME', 'JAVA_HOME', 'COUNTER_ANDROID_AAPT2', 'COUNTER_ANDROID_SYSTEM_IMAGE']) {
    if (!env[name]) throw new Error(`Missing ${name}. Run through examples/counter/android.nix.`);
  }
  await access(join(root, 'examples/counter/default.nix'));
  await access('/dev/kvm', constants.R_OK | constants.W_OK).catch(() => {
    throw new Error('The emulator requires read/write access to /dev/kvm. Enable KVM and grant your user access first.');
  });
  if (!args.includes('--headless') && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new Error('No graphical display. Use counter-android --headless.');
  }
  for (const port of [8000, 8443]) {
    if (!await portFree(port)) throw new Error(`Port ${port} is in use. Stop its owner before starting the counter.`);
  }
  let port;
  for (let candidate = 5554; candidate <= 5584; candidate += 2) {
    if (await portFree(candidate) && await portFree(candidate + 1)) { port = candidate; break; }
  }
  if (!port) throw new Error('No free emulator port pair in 5554-5585.');
  const serial = `emulator-${port}`;

  work = await mkdtemp(join(tmpdir(), 'obelisk-counter-android-'));
  const app = join(work, 'app');
  const bundle = join(work, 'bundle');
  const backend = join(work, 'backend');
  env = { ...process.env,
    ANDROID_AVD_HOME: join(work, 'avd'),
    TMPDIR: work,
    ANDROID_USER_HOME: join(work, 'android-user'),
    ANDROID_EMULATOR_HOME: join(work, 'android-user'),
  };
  await mkdir(env.ANDROID_AVD_HOME);
  await mkdir(env.ANDROID_USER_HOME);
  console.log(`Workspace: ${work}`);

  // Native sync, generated certificates and Gradle output stay outside the checkout.
  const source = join(root, 'examples/counter/app');
  const excluded = new Set(['ios', 'node_modules', 'www', 'build', '.gradle', '.git', 'local.properties']);
  await cp(source, app, { recursive: true,
    filter: (path) => !relative(source, path).split('/').some((part) => excluded.has(part)),
  });
  await run('npm', ['ci', '--no-audit', '--no-fund']);
  await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: app });
  // Obelisk skips cross-compiled frontend outputs during shell evaluation.
  // These are production builds, even though this runner entered via nix-shell.
  const buildEnv = { ...env, IN_NIX_SHELL: '' };
  await run('nix-build', ['examples/counter/default.nix', '-A', 'nixpkgs.webBundle.js', '-o', bundle], { env: buildEnv });
  await run('nix-build', ['examples/counter/native-backend.nix', '--argstr', 'bundle', bundle, '-o', backend], { env: buildEnv });

  const ca = join(work, 'ca.pem');
  const key = join(work, 'ca.key');
  const cert = join(work, 'server.pem');
  const serverKey = join(work, 'server.key');
  const csr = join(work, 'server.csr');
  const extensions = join(work, 'server.ext');
  await writeFile(extensions, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=obelisk-capacitor local test CA', '-keyout', key, '-out', ca]);
  await run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-keyout', serverKey, '-out', csr]);
  await run('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', key, '-CAcreateserial',
    '-days', '1', '-out', cert, '-extfile', extensions]);
  await cp(ca, join(app, 'android/app/src/debug/res/raw/test_ca.pem'));

  await run(process.execPath, ['bin/ob-capacitor.mjs', 'sync', '--project', app, '--bundle', bundle, '--platform', 'android']);
  await run('./gradlew', ['assembleDebug', '--no-daemon',
    `-Pandroid.aapt2FromMavenOverride=${env.COUNTER_ANDROID_AAPT2}`], { cwd: join(app, 'android') });

  service(join(backend, 'bin/backend'), ['--port=8000', '--address=127.0.0.1', '--no-access-log', '--no-error-log'], 'backend.log');
  const caddyfile = join(work, 'Caddyfile');
  await writeFile(caddyfile, `{
  auto_https off
  admin off
}
https://localhost:8443 {
  bind 127.0.0.1
  tls "${cert}" "${serverKey}"
  reverse_proxy 127.0.0.1:8000
}
`);
  service('caddy', ['run', '--config', caddyfile], 'caddy.log');
  await waitFor('the HTTPS backend', async () => {
    const result = await run('curl', ['--silent', '--show-error', '--fail', '--max-time', '2',
      '--cacert', ca, '--output', '/dev/null', '--write-out', '%{http_code}',
      '-X', 'OPTIONS', '-H', 'Origin: https://localhost', 'https://localhost:8443/api/increment'],
    { capture: true, allowFailure: true });
    return result.code === 0 && result.stdout === '204';
  }, 30_000);

  await run('avdmanager', ['create', 'avd', '-n', 'obelisk-counter', '-k', env.COUNTER_ANDROID_SYSTEM_IMAGE,
    '-d', 'pixel_6'], { input: 'no\n' });
  const emulatorArgs = ['-avd', 'obelisk-counter', '-port', String(port),
    '-no-snapshot', '-no-audio', '-no-boot-anim', '-no-metrics', '-accel', 'on', '-gpu', 'swiftshader_indirect'];
  const headless = args.includes('--headless');
  if (!headless && !env.DISPLAY && env.WAYLAND_DISPLAY) {
    // The emulator uses X11. Own a rootless server instead of changing the desktop.
    let display;
    for (let n = 100; n < 200; n += 1) {
      if (!await exists(`/tmp/.X11-unix/X${n}`) && !await exists(`/tmp/.X${n}-lock`)) {
        display = `:${n}`;
        break;
      }
    }
    if (!display) throw new Error('No free X11 display in :100-:199.');
    env.DISPLAY = display;
    env.XAUTHORITY = join(work, 'Xauthority');
    await writeFile(env.XAUTHORITY, '', { mode: 0o600 });
    await run('xauth', ['-f', env.XAUTHORITY, 'add', display, '.', randomBytes(16).toString('hex')]);
    service('xwayland-satellite', [display, '-auth', env.XAUTHORITY, '-nolisten', 'tcp'], 'xwayland.log');
    await waitFor('Xwayland', async () =>
      (await run('xdpyinfo', [], { capture: true, allowFailure: true })).code === 0, 15_000);
  }
  const emulator = service('emulator', [...emulatorArgs, ...(headless ? ['-no-window'] : [])], 'emulator.log');
  await waitFor('Android to boot', async () => {
    const result = await run('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
      { capture: true, allowFailure: true });
    return result.code === 0 && result.stdout.trim() === '1';
  }, 180_000);
  await run('adb', ['-s', serial, 'reverse', 'tcp:8443', 'tcp:8443']);
  const apk = join(app, 'android/app/build/outputs/apk/debug/app-debug.apk');
  await run('adb', ['-s', serial, 'install', '-r', apk]);
  await run('adb', ['-s', serial, 'shell', 'wm', 'dismiss-keyguard']);
  await run('adb', ['-s', serial, 'shell', 'am', 'start', '-W', '-n', 'com.obsidiansystems.counter/.MainActivity']);
  console.log(`Counter running on ${serial}\nBackend: https://localhost:8443\nAPK: ${apk}\nLogs: ${work}/*.log\nPress Ctrl+C to stop and remove the workspace.`);
  while (!emulator.ended || emulator.code !== 0) {
    checkServices();
    await delay(1000, undefined, { signal: shutdown.signal });
  }
}

try {
  await main();
} catch (error) {
  if (!shutdown.signal.aborted) {
    process.exitCode = 1;
    console.error(`counter-android: ${error.message}`);
    for (const job of services) {
      const log = await readFile(job.log, 'utf8').catch(() => '');
      if (log) console.error(`\n${job.log}:\n${log.split('\n').slice(-40).join('\n')}`);
    }
  }
} finally {
  const remaining = [...active];
  shutdown.abort();
  await Promise.all(remaining.map(async (job) => {
    await Promise.race([job.done, delay(5000, undefined, { ref: false })]);
    if (!job.ended) { terminate(job, 'SIGKILL'); await job.done; }
  }));
  if (work) await rm(work, { recursive: true, force: true });
}
