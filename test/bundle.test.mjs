// Unit tests for the pure bundle logic: validation, tree copying, HTML
// transformation, plugin bundling and staging safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BundleError,
  BUNDLE_MANIFEST,
  copyTreeRegular,
  readBundle,
  stageWebTree,
  transformBootstrapHtml,
  bundlePluginEntry,
  PLUGIN_BUNDLE,
} from '../src/bundle.mjs';

const BOOTSTRAP_HTML = (mode = 'client') => `<!DOCTYPE html><html lang="en"><head><base href="/"><meta name="obelisk-frontend-mode" content="${mode}"><link rel="preload" as="script" href="/ghcjs/all.js"></head><body><script type="text/javascript" src="/ghcjs/all.js" defer="defer"></script></body></html>`;

async function makeBundle(dir, { target = 'js', version = 1, entry = true, html } = {}) {
  const web = join(dir, 'www');
  await mkdir(join(web, 'ghcjs'), { recursive: true });
  await mkdir(join(web, 'static'), { recursive: true });
  if (entry) await writeFile(join(web, 'ghcjs', 'all.js'), '// compiler output\n');
  await writeFile(join(web, 'index.html'), html ?? BOOTSTRAP_HTML());
  await writeFile(join(web, 'static', 'main.css'), 'body { color: red }\n');
  await writeFile(join(dir, BUNDLE_MANIFEST), JSON.stringify({ format: 'obelisk-web-bundle', version, target, webDir: 'www' }));
  return dir;
}

test('readBundle accepts a valid js bundle', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ob-test-'));
  await makeBundle(d);
  const b = await readBundle(d);
  assert.equal(b.manifest.target, 'js');
});

test('readBundle rejects unknown format', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ob-test-'));
  await makeBundle(d);
  await writeFile(join(d, BUNDLE_MANIFEST), JSON.stringify({ format: 'something-else', version: 1, target: 'js', webDir: 'www' }));
  await assert.rejects(() => readBundle(d), BundleError);
});

test('readBundle rejects unknown version', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ob-test-'));
  await makeBundle(d, { version: 2 });
  await assert.rejects(() => readBundle(d), /version/);
});

test('readBundle rejects wasm with an actionable rebuild instruction', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ob-test-'));
  await makeBundle(d, { target: 'wasm' });
  await assert.rejects(() => readBundle(d), (e) => e instanceof BundleError && /webBundle\.js/.test(e.message) && /wasm/.test(e.message));
});

test('readBundle rejects missing payload pieces', async () => {
  for (const missing of ['ghcjs/all.js', 'index.html', 'static']) {
    const d = await mkdtemp(join(tmpdir(), 'ob-test-'));
    await makeBundle(d);
    const victim = join(d, 'www', missing);
    await rm(victim, { recursive: true, force: true });
    await assert.rejects(() => readBundle(d), BundleError, `missing ${missing}`);
  }
});

test('copyTreeRegular dereferences symlinks and skips .assets metadata', async () => {
  const src = await mkdtemp(join(tmpdir(), 'ob-src-'));
  await mkdir(join(src, 'css'), { recursive: true });
  await writeFile(join(src, 'css', 'real.css'), 'x');
  await mkdir(join(src, 'css', 'evil.assets'), { recursive: true });
  await writeFile(join(src, 'css', 'evil.assets', 'hashed.gz'), 'compressed');
  await symlink('real.css', join(src, 'css', 'alias.css'));
  const dest = await mkdtemp(join(tmpdir(), 'ob-dst-'));
  const n = await copyTreeRegular(src, dest);
  assert.equal(n, 2);
  assert.equal(await readFile(join(dest, 'css', 'alias.css'), 'utf8'), 'x');
  const st = await lstat(join(dest, 'css', 'alias.css'));
  assert.equal(st.isFile(), true);
  await assert.rejects(() => readdir(join(dest, 'css', 'evil.assets')));
});

test('copyTreeRegular rejects symlinks escaping the tree', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'ob-out-'));
  await writeFile(join(outside, 'secret'), 's');
  const src = await mkdtemp(join(tmpdir(), 'ob-src-'));
  await symlink(join(outside, 'secret'), join(src, 'leak'));
  const dest = await mkdtemp(join(tmpdir(), 'ob-dst-'));
  await assert.rejects(() => copyTreeRegular(src, dest), /escapes/);
});

test('transformBootstrapHtml switches client to client-hash and inserts the plugin script', () => {
  const out = transformBootstrapHtml(BOOTSTRAP_HTML());
  assert.match(out, /content="client-hash"/);
  assert.doesNotMatch(out, /content="client"/);
  assert.match(out, new RegExp(`<script src="/${PLUGIN_BUNDLE}"></script>`));
  // inserted in head, before the body's deferred entry
  assert.ok(out.indexOf(`src="/${PLUGIN_BUNDLE}"`) < out.indexOf('src="/ghcjs/all.js"'));
  assert.ok(out.indexOf(`src="/${PLUGIN_BUNDLE}"`) < out.indexOf('</head>'));
});

test('transformBootstrapHtml rejects incompatible structures', () => {
  assert.throws(() => transformBootstrapHtml('<html><head></head><body></body></html>'), BundleError); // no meta
  assert.throws(() => transformBootstrapHtml(BOOTSTRAP_HTML('hydrate')), BundleError); // wrong content
  assert.throws(() => transformBootstrapHtml(BOOTSTRAP_HTML().replace('src="/ghcjs/all.js"', 'src="/other.js"')), BundleError); // no entry
  assert.throws(() => transformBootstrapHtml('not html at all'), BundleError);
});

test('transformBootstrapHtml never accumulates plugin tags across syncs from pristine bundles', () => {
  const once = transformBootstrapHtml(BOOTSTRAP_HTML());
  const twice = transformBootstrapHtml(BOOTSTRAP_HTML()); // sync always restarts from the bundle's artifact
  assert.equal((once.match(new RegExp(PLUGIN_BUNDLE, 'g')) ?? []).length, (twice.match(new RegExp(PLUGIN_BUNDLE, 'g')) ?? []).length);
  const staged = transformBootstrapHtml(once.replace(/content="client-hash"/, 'content="client"'));
  assert.equal((staged.match(new RegExp(`src="/${PLUGIN_BUNDLE}"`, 'g')) ?? []).length, 1);
});

test('bundlePluginEntry bundles native.mjs as an IIFE exposing ObeliskCapacitor', async () => {
  const app = await mkdtemp(join(tmpdir(), 'ob-app-'));
  await writeFile(join(app, 'native.mjs'), 'export const hello = () => "hi";\n');
  const out = join(app, 'out.js');
  await bundlePluginEntry(app, out);
  const code = await readFile(out, 'utf8');
  assert.match(code, /ObeliskCapacitor/);
  await assert.rejects(() => bundlePluginEntry(join(app, 'missing'), out), BundleError);
});

test('stageWebTree produces a self-contained www with transformed html, ghcjs, static and plugin bundle', async () => {
  const bundleDir = await mkdtemp(join(tmpdir(), 'ob-b-'));
  await makeBundle(bundleDir);
  const bundle = await readBundle(bundleDir);
  const app = await mkdtemp(join(tmpdir(), 'ob-app-'));
  await writeFile(join(app, 'native.mjs'), 'export const x = 1;\n');
  const { staging, newWww } = await stageWebTree(app, bundle);
  try {
    assert.match(await readFile(join(newWww, 'index.html'), 'utf8'), /client-hash/);
    assert.equal(await readFile(join(newWww, 'ghcjs', 'all.js'), 'utf8'), '// compiler output\n');
    assert.equal(await readFile(join(newWww, 'static', 'main.css'), 'utf8'), 'body { color: red }\n');
    const st = await lstat(join(newWww, PLUGIN_BUNDLE));
    assert.equal(st.isFile(), true);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test('stageWebTree failure removes only its own staging directory', async () => {
  const bundleDir = await mkdtemp(join(tmpdir(), 'ob-b-'));
  await makeBundle(bundleDir, { html: BOOTSTRAP_HTML('bogus') }); // transform will reject
  const app = await mkdtemp(join(tmpdir(), 'ob-app-'));
  await writeFile(join(app, 'native.mjs'), 'export const x = 1;\n');
  const bundle = await readBundle(bundleDir);
  await assert.rejects(() => stageWebTree(app, bundle), BundleError);
  // Counting all tmp entries races with unrelated churn; assert our prefix
  // leaves nothing behind instead.
  const leftover = (await readdir(tmpdir())).filter((e) => e.startsWith('ob-capacitor-stage-'));
  assert.deepEqual(leftover, []);
});
