// Full application flow against the real CLI and a real template npm ci:
// init creates the app from a bundle, sync replaces the payload with a second
// bundle (content actually changes), native edits and plugin exports survive,
// repeated syncs do not accumulate, and cap-sync failures propagate exactly.
//
// The Capacitor CLI itself is stubbed for the failure/success propagation
// checks: real cap add/sync runs in the hosted native CI jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, writeFile as write } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = new URL('../bin/ob-capacitor.mjs', import.meta.url).pathname;
const SIBLING = resolve(CLI, '..', '..');

const BOOTSTRAP_HTML = () => `<!DOCTYPE html><html lang="en"><head><base href="/"><meta name="obelisk-frontend-mode" content="client"><link rel="preload" as="script" href="/ghcjs/all.js"></head><body><script type="text/javascript" src="/ghcjs/all.js" defer="defer"></script></body></html>`;

async function makeBundle(dir, { version = 'v1' } = {}) {
  const web = join(dir, 'www');
  await mkdir(join(web, 'ghcjs'), { recursive: true });
  await mkdir(join(web, 'static'), { recursive: true });
  await writeFile(join(web, 'ghcjs', 'all.js'), `// compiler output ${version}\n`);
  await writeFile(join(web, 'index.html'), BOOTSTRAP_HTML());
  await writeFile(join(web, 'static', `app-${version}.css`), `/* ${version} */\n`);
  await writeFile(join(web, 'static', 'app.css'), `/* ${version} */\n`);
  await writeFile(join(dir, 'obelisk-web-bundle.json'), JSON.stringify({ format: 'obelisk-web-bundle', version: 1, target: 'js', webDir: 'www' }));
  return dir;
}

function run(args, opts = {}) {
  return exec(process.execPath, [CLI, ...args], opts);
}

// Replace the app's installed Capacitor CLI with a stub recording its
// arguments; mode 'fail' exits 42.
async function stubCap(app, mode = 'ok') {
  // The CLI resolves the app's @capacitor/cli entry directly, so that is the
  // file to stub (node_modules/.bin/cap is never consulted).
  const cliJs = join(app, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
  await rm(cliJs, { force: true });
  // The CLI runs the resolved entry with the running node, so the stub is JS.
  const script = mode === 'fail'
    ? '#!/usr/bin/env node\nconsole.error("cap: simulated native sync failure");\nprocess.exit(42);\n'
    : '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.CAP_INVOCATIONS_LOG, process.argv.slice(2).join(" ") + "\\n");\n';
  await write(cliJs, script, { mode: 0o755 });
  const log = join(app, 'cap-invocations.log');
  return log;
}

test('init creates an app; two syncs swap payloads and preserve application-owned files', { timeout: 300000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-app-'));
  const b1 = await makeBundle(join(work, 'b1'), { version: 'v1' });
  const app = join(work, 'counter-app');
  await run(['init', app, '--app-id', 'com.example.counter', '--app-name', 'Counter', '--bundle', b1]);

  // Structure: marker, config, staged web tree, installed CLI
  const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  assert.equal(pkg.obeliskCapacitor.owner, 'obelisk-capacitor');
  const cfg = JSON.parse(await readFile(join(app, 'capacitor.config.json'), 'utf8'));
  assert.equal(cfg.appId, 'com.example.counter');
  assert.equal(cfg.appName, 'Counter');
  assert.equal(cfg.webDir, 'www');
  assert.match(await readFile(join(app, 'www', 'index.html'), 'utf8'), /client-hash/);
  assert.match(await readFile(join(app, 'www', 'static', 'app.css'), 'utf8'), /v1/);
  assert.match(await readFile(join(app, 'www', 'ghcjs', 'all.js'), 'utf8'), /v1/);
  assert.match(await readFile(join(app, 'www', 'obelisk-capacitor.js'), 'utf8'), /ObeliskCapacitor/);
  assert.ok((await readdir(join(app, 'node_modules', '@capacitor'))).length > 0, 'npm ci installed capacitor packages');

  // Application-owned native project + a deliberate native edit.
  await mkdir(join(app, 'android'), { recursive: true });
  await writeFile(join(app, 'android', 'build.gradle'), '// deliberate native edit\n');
  // Application-added plugin export.
  await writeFile(join(app, 'native.mjs'), (await readFile(join(app, 'native.mjs'), 'utf8')) + 'export const Extra = { ping: () => "pong" };\n');

  const capLog = await stubCap(app, 'ok');
  const b2 = await makeBundle(join(work, 'b2'), { version: 'v2' });
  await run(['sync', '--project', app, '--bundle', b2, '--platform', 'android'], { env: { ...process.env, CAP_INVOCATIONS_LOG: capLog } });
  // Behavior with the second bundle's content, not just growth:
  assert.match(await readFile(join(app, 'www', 'static', 'app.css'), 'utf8'), /v2/);
  assert.match(await readFile(join(app, 'www', 'ghcjs', 'all.js'), 'utf8'), /v2/);
  assert.equal(await readFile(join(app, 'android', 'build.gradle'), 'utf8'), '// deliberate native edit\n');
  assert.match(await readFile(join(app, 'native.mjs'), 'utf8'), /Extra/);
  assert.match(await readFile(capLog, 'utf8'), /sync android/);

  // Second sync from the same bundle: no accumulation of script tags.
  const html1 = await readFile(join(app, 'www', 'index.html'), 'utf8');
  await run(['sync', '--project', app, '--bundle', b2, '--platform', 'android'], { env: { ...process.env, CAP_INVOCATIONS_LOG: capLog } });
  const html2 = await readFile(join(app, 'www', 'index.html'), 'utf8');
  assert.equal(
    (html2.match(/obelisk-capacitor\.js/g) ?? []).length,
    (html1.match(/obelisk-capacitor\.js/g) ?? []).length
  );
  assert.equal((html2.match(/client-hash/g) ?? []).length, 1);
});

test('cap sync failure propagates its exit status and the previous payload is not silently kept', { timeout: 120000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-app2-'));
  const b1 = await makeBundle(join(work, 'b1'), { version: 'v1' });
  const app = join(work, 'counter-app');
  await run(['init', app, '--app-id', 'com.example.counter', '--app-name', 'Counter', '--bundle', b1]);
  await mkdir(join(app, 'android'), { recursive: true });
  await stubCap(app, 'fail');
  const b2 = await makeBundle(join(work, 'b2'), { version: 'v2' });
  const res = await run(['sync', '--project', app, '--bundle', b2, '--platform', 'android']).catch((e) => e);
  assert.equal(res.code, 42, `exit status of cap forwarded (got ${JSON.stringify(res.code)}: ${res.stderr})`);
  assert.match(res.stderr, /cap sync android failed/);
  // The web payload is already the new one; the failure is visible, not hidden.
  assert.match(await readFile(join(app, 'www', 'static', 'app.css'), 'utf8'), /v2/);
});

test('init cleans up its temporary directory when staging fails', { timeout: 300000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'ob-app3-'));
  // Valid bundle, but a broken native.mjs in the template copy cannot happen;
  // break staging by making the bundle HTML invalid instead after validation?
  // Simplest: a bundle whose manifest is fine but index.html has the wrong mode.
  const b = await makeBundle(join(work, 'b'));
  await writeFile(join(b, 'www', 'index.html'), BOOTSTRAP_HTML().replace('content="client"', 'content="bogus"'));
  const dest = join(work, 'app');
  const before = (await readdir(work)).sort();
  await assert.rejects(() => run(['init', dest, '--app-id', 'x.y', '--app-name', 'X', '--bundle', b]), (e) => /bootstrap HTML/.test(e.stderr));
  const after = (await readdir(work)).sort();
  assert.deepEqual(after, before, 'no leftover temp dirs from failed init');
});
