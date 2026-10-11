// Subprocess behavior of the CLI: argument handling, destination refusal,
// bundle validation before any side effect, sync ownership and safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = new URL('../bin/ob-capacitor.mjs', import.meta.url).pathname;
const SIBLING = resolve(CLI, '..', '..');

const BOOTSTRAP_HTML = (mode = 'client') => `<!DOCTYPE html><html lang="en"><head><base href="/"><meta name="obelisk-frontend-mode" content="${mode}"><link rel="preload" as="script" href="/ghcjs/all.js"></head><body><script type="text/javascript" src="/ghcjs/all.js" defer="defer"></script></body></html>`;

async function makeBundle(dir, { target = 'js', html } = {}) {
  const web = join(dir, 'www');
  await mkdir(join(web, 'ghcjs'), { recursive: true });
  await mkdir(join(web, 'static'), { recursive: true });
  await writeFile(join(web, 'ghcjs', 'all.js'), `// ${target}\n`);
  await writeFile(join(web, 'index.html'), html ?? BOOTSTRAP_HTML());
  await writeFile(join(web, 'static', 'app.css'), '/* v1 */\n');
  await writeFile(join(dir, 'obelisk-web-bundle.json'), JSON.stringify({ format: 'obelisk-web-bundle', version: 1, target, webDir: 'www' }));
  return dir;
}

function run(args, opts = {}) {
  return exec(process.execPath, [CLI, ...args], opts);
}

test('usage errors exit nonzero with the usage text', async () => {
  for (const args of [[], ['frobnicate'], ['init'], ['sync', '--project', '/tmp/x']]) {
    await assert.rejects(() => run(args), (e) => e.code !== 0 && /usage:/.test(e.stderr));
  }
});

test('init validates the bundle first and creates nothing for bad input', async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-cli-'));
  const bundle = await makeBundle(join(work, 'b'), { target: 'wasm' });
  const dest = join(work, 'app');
  await assert.rejects(() => run(['init', dest, '--app-id', 'com.example.app', '--app-name', 'Example', '--bundle', bundle]), (e) => /webBundle\.js/.test(e.stderr));
  const entries = await readdir(work);
  assert.deepEqual(entries.filter((e) => e !== 'b'), [], 'no destination or temp dirs left behind');
});

test('init refuses an existing destination', async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-cli-'));
  const bundle = await makeBundle(join(work, 'b'));
  const dest = join(work, 'app');
  await mkdir(dest);
  await writeFile(join(dest, 'precious'), 'keep me');
  await assert.rejects(() => run(['init', dest, '--app-id', 'com.example.app', '--app-name', 'Example', '--bundle', bundle]), (e) => /already exists/.test(e.stderr));
  assert.equal(await readFile(join(dest, 'precious'), 'utf8'), 'keep me');
});

test('sync requires the ownership marker', async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-cli-'));
  const bundle = await makeBundle(join(work, 'b'));
  const app = join(work, 'app');
  await mkdir(join(app, 'ios'), { recursive: true });
  await mkdir(join(app, 'android'), { recursive: true });
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'not-ours', private: true }));
  await assert.rejects(() => run(['sync', '--project', app, '--bundle', bundle, '--platform', 'ios']), (e) => /ownership marker/.test(e.stderr));
});

test('sync rejects symlinked project and www destinations without touching them', async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-cli-'));
  const bundle = await makeBundle(join(work, 'b'));
  const real = join(work, 'real');
  await mkdir(join(real, 'ios'), { recursive: true });
  await writeFile(join(real, 'package.json'), JSON.stringify({ name: 'x', private: true, obeliskCapacitor: { owner: 'obelisk-capacitor', version: '0.1.0' } }));
  const link = join(work, 'app-link');
  await symlink(real, link);
  await assert.rejects(() => run(['sync', '--project', link, '--bundle', bundle, '--platform', 'ios']), (e) => /symlink/.test(e.stderr));

  // www as a symlink: rejected before replacement
  const app2 = join(work, 'app2');
  await mkdir(join(app2, 'ios'), { recursive: true });
  await mkdir(join(work, 'target-www'), { recursive: true });
  await writeFile(join(app2, 'package.json'), JSON.stringify({ name: 'x', private: true, obeliskCapacitor: { owner: 'obelisk-capacitor', version: '0.1.0' } }));
  await writeFile(join(app2, 'capacitor.config.json'), JSON.stringify({ appId: 'a', appName: 'A', webDir: 'www' }));
  await symlink(join(work, 'target-www'), join(app2, 'www'));
  await assert.rejects(() => run(['sync', '--project', app2, '--bundle', bundle, '--platform', 'ios']), (e) => /symlink/.test(e.stderr));
  assert.equal((await lstat(join(app2, 'www'))).isSymbolicLink(), true, 'www symlink preserved');
});

test('sync rejects incompatible bundles without damaging the previous payload', async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-cli-'));
  const good = await makeBundle(join(work, 'good'));
  const wasm = await makeBundle(join(work, 'wasm'), { target: 'wasm' });
  const app = join(work, 'app');
  await mkdir(join(app, 'ios'), { recursive: true });
  await mkdir(join(app, 'www'), { recursive: true });
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'x', private: true, obeliskCapacitor: { owner: 'obelisk-capacitor', version: '0.1.0' } }));
  await writeFile(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'a', appName: 'A', webDir: 'www' }));
  await writeFile(join(app, 'www', 'previous.txt'), 'previous payload');

  await assert.rejects(() => run(['sync', '--project', app, '--bundle', wasm, '--platform', 'ios']), (e) => /webBundle\.js/.test(e.stderr));
  assert.equal(await readFile(join(app, 'www', 'previous.txt'), 'utf8'), 'previous payload');
});

test('sync requires the named native project and webDir=www', async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-cli-'));
  const bundle = await makeBundle(join(work, 'b'));
  const app = join(work, 'app');
  await mkdir(join(app, 'android'), { recursive: true });
  await mkdir(join(app, 'www'), { recursive: true });
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'x', private: true, obeliskCapacitor: { owner: 'obelisk-capacitor', version: '0.1.0' } }));
  await writeFile(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'a', appName: 'A', webDir: 'www' }));
  await assert.rejects(() => run(['sync', '--project', app, '--bundle', bundle, '--platform', 'ios']), (e) => /no ios\/ native project/.test(e.stderr));

  await mkdir(join(app, 'ios'));
  await writeFile(join(app, 'capacitor.config.json'), JSON.stringify({ appId: 'a', appName: 'A', webDir: 'dist' }));
  await assert.rejects(() => run(['sync', '--project', app, '--bundle', bundle, '--platform', 'ios']), (e) => /webDir/.test(e.stderr));
});
