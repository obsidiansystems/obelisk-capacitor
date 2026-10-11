// Version checks, portable-tree validation, staging, HTML transformation and
// plugin bundling for the obelisk web bundle. Everything here is pure Node
// plus esbuild/parse5; process spawning lives in bin/ob-capacitor.mjs.
import { access, constants, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';
import { parse, serialize } from 'parse5';

export const BUNDLE_MANIFEST = 'obelisk-web-bundle.json';
export const BUNDLE_FORMAT = 'obelisk-web-bundle';
export const BUNDLE_VERSION = 1;
export const WEB_DIR = 'www';
export const APP_WWW_DIR = 'www'; // Capacitor webDir; must stay "www"
export const PLUGIN_BUNDLE = 'obelisk-capacitor.js';
export const PLUGIN_GLOBAL = 'ObeliskCapacitor';
export const MODE_META_NAME = 'obelisk-frontend-mode';
export const ENTRY_SCRIPT = '/ghcjs/all.js';

export class BundleError extends Error {}

const fail = (msg) => { throw new BundleError(msg); };

// ---- Bundle reading and validation -----------------------------------------

// Read and validate the obelisk-web-bundle manifest and its required payload.
// Rejects unknown formats/versions, targets other than js, and missing
// required files/directories. The source bundle is never modified anywhere.
export async function readBundle(bundleDir) {
  const manifestPath = join(bundleDir, BUNDLE_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    fail(`bundle: cannot read ${BUNDLE_MANIFEST} in ${bundleDir}: ${e.message}`);
  }
  if (manifest.format !== BUNDLE_FORMAT) {
    fail(`bundle: unknown format ${JSON.stringify(manifest.format)}; expected "${BUNDLE_FORMAT}". Is this an obelisk web bundle?`);
  }
  if (manifest.version !== BUNDLE_VERSION) {
    fail(`bundle: unsupported bundle version ${JSON.stringify(manifest.version)}; this obelisk-capacitor supports version ${BUNDLE_VERSION}. Upgrade or downgrade obelisk-capacitor to match your Obelisk pin.`);
  }
  if (manifest.target !== 'js') {
    fail(
      `bundle: target "${manifest.target}" is not supported by obelisk-capacitor; only "js" is. ` +
      `Rebuild the JavaScript artifact from your Obelisk application, e.g.: ` +
      `nix-build default.nix -A nixpkgs.webBundle.js -o result-mobile ` +
      `(or -A haskell-nix.webBundle.js for the haskell-nix driver), and pass that bundle. ` +
      `ob-capacitor does not rebuild your frontend or switch compilers, and it will not ship two runtimes.`
    );
  }
  if (manifest.webDir !== WEB_DIR) {
    fail(`bundle: unexpected webDir ${JSON.stringify(manifest.webDir)}; expected "${WEB_DIR}".`);
  }
  const webDir = join(bundleDir, WEB_DIR);
  await assertDirectory(webDir, `${WEB_DIR}/`);
  await assertFile(join(webDir, 'index.html'), `${WEB_DIR}/index.html`);
  await assertDirectory(join(webDir, 'ghcjs'), `${WEB_DIR}/ghcjs/`);
  await assertFile(join(webDir, 'ghcjs', 'all.js'), `${WEB_DIR}/ghcjs/all.js`);
  await assertDirectory(join(webDir, 'static'), `${WEB_DIR}/static/`);
  return { dir: bundleDir, manifest, webDir };
}

async function assertDirectory(p, what) {
  const st = await lstat(p).catch(() => null);
  if (!st?.isDirectory()) fail(`bundle: missing required directory ${what}`);
}

async function assertFile(p, what) {
  const st = await lstat(p).catch(() => null);
  if (!st?.isFile()) fail(`bundle: missing required file ${what}`);
}

// Copy a directory tree as regular files, dereferencing symlinks. Returns the
// count of files copied. Symlinks that escape the tree or cannot be
// dereferenced fail the copy: the staged payload must be self-contained.
export async function copyTreeRegular(src, dest, { strip = [] } = {}) {
  let count = 0;
  await mkdir(dest, { recursive: true });
  const root = await realpath(src);
  const walk = async (abs, rel) => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const relEntry = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === '.assets' || entry.name.endsWith('.assets')) continue; // never copy asset metadata
      const absEntry = join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(absEntry, relEntry);
      } else if (entry.isFile()) {
        const out = join(dest, relEntry);
        await mkdir(dirname(out), { recursive: true });
        await copyFile(absEntry, out);
        count += 1;
      } else {
        // Symlink or other special file: dereference once.
        const st = await lstat(absEntry);
        if (st.isSymbolicLink()) {
          const target = await realpath(absEntry).catch(() => null);
          if (!target || !target.startsWith(root)) {
            fail(`bundle: symlink ${relEntry} escapes the source tree; refusing to stage it`);
          }
          const tst = await lstat(target);
          if (tst.isDirectory()) {
            await walk(target, relEntry);
          } else {
            const out = join(dest, relEntry);
            await mkdir(dirname(out), { recursive: true });
            await copyFile(target, out);
            count += 1;
          }
        } else {
          fail(`bundle: unsupported file type at ${relEntry}`);
        }
      }
    }
  };
  await walk(src, '');
  return count;
}

// ---- Bootstrap HTML transformation -----------------------------------------

// Transform the bundle's client-bootstrap HTML for Capacitor's hash-routed,
// file-served origin:
//   * require the version-1 structure: the obelisk-frontend-mode metadata with
//     content "client", and the deferred /ghcjs/all.js entry in the body;
//   * switch the mode to client-hash;
//   * insert a synchronous <script src="/obelisk-capacitor.js"> in the head,
//     before the deferred entry loads.
// Anything unexpected is an error: the HTML is generated by the obelisk web
// bundle exporter, so a mismatch means an incompatible Obelisk pin.
export function transformBootstrapHtml(html) {
  const doc = parse(html);
  const htmlEl = doc.childNodes?.find((n) => n.tagName === 'html');
  if (!htmlEl) fail('bootstrap HTML: no <html> element');
  const head = htmlEl.childNodes?.find((n) => n.tagName === 'head');
  const body = htmlEl.childNodes?.find((n) => n.tagName === 'body');
  if (!head || !body) fail('bootstrap HTML: no <head>/<body>');

  const metaNodes = (head.childNodes ?? []).filter(
    (n) => n.tagName === 'meta'
      && attr(n, 'name') === MODE_META_NAME
  );
  if (metaNodes.length !== 1) {
    fail(`bootstrap HTML: expected exactly one <meta name="${MODE_META_NAME}"> in <head> (found ${metaNodes.length}); the bundle must come from an Obelisk revision that emits the client bootstrap HTML`);
  }
  const meta = metaNodes[0];
  if (attr(meta, 'content') !== 'client') {
    fail(`bootstrap HTML: ${MODE_META_NAME} content must be "client" (found ${JSON.stringify(attr(meta, 'content'))})`);
  }
  setAttr(meta, 'content', 'client-hash');

  const entryScripts = (body.childNodes ?? []).filter(
    (n) => n.tagName === 'script' && attr(n, 'src') === ENTRY_SCRIPT
  );
  if (entryScripts.length !== 1) {
    fail(`bootstrap HTML: expected exactly one <script src="${ENTRY_SCRIPT}"> in <body> (found ${entryScripts.length})`);
  }
  if (attr(entryScripts[0], 'defer') === undefined) {
    fail(`bootstrap HTML: the ${ENTRY_SCRIPT} entry must be deferred`);
  }

  // Remove any earlier plugin bundle insertion so repeated syncs, each
  // starting from the pristine core artifact, cannot accumulate tags.
  for (const n of (head.childNodes ?? [])) {
    if (n.tagName === 'script' && attr(n, 'src') === `/${PLUGIN_BUNDLE}`) {
      removeChild(head, n);
    }
  }
  const pluginScript = {
    nodeName: '#text', value: '\n    ',
  };
  const scriptNode = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [{ name: 'src', value: `/${PLUGIN_BUNDLE}` }],
    childNodes: [],
  };
  insertIntoHead(head, scriptNode);

  return serialize(doc);
}

function insertIntoHead(head, node) {
  head.childNodes = head.childNodes ?? [];
  // After the last existing element child keeps ordering stable before the
  // deferred entry loads (the entry lives in <body>, so head order suffices).
  head.childNodes.push({ nodeName: '#text', value: '\n    ' }, node, { nodeName: '#text', value: '\n  ' });
}

function removeChild(parent, node) {
  parent.childNodes = (parent.childNodes ?? []).filter((n) => n !== node);
}

function attr(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function setAttr(node, name, value) {
  const a = node.attrs?.find((x) => x.name === name);
  if (a) a.value = value;
  else node.attrs.push({ name, value });
}

// ---- Plugin entry bundling --------------------------------------------------

// Bundle the application-owned native.mjs entry (default template exports
// Capacitor, App and Device) as a browser IIFE exposing
// globalThis.ObeliskCapacitor. Never touches the compiler's all.js.
export async function bundlePluginEntry(appDir, outFile) {
  const entry = join(appDir, 'native.mjs');
  await assertFile(entry, 'native.mjs (application plugin entry)');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    globalName: PLUGIN_GLOBAL,
    outfile: outFile,
    legalComments: 'none',
    logLevel: 'silent',
    minify: true,
  });
  if (result.errors.length > 0) {
    fail(`plugin bundling failed: ${result.errors.map((e) => e.text).join('; ')}`);
  }
  return outFile;
}

// ---- Application identity ---------------------------------------------------

export async function readAppPackage(appDir) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
  } catch (e) {
    fail(`app: cannot read package.json in ${appDir}: ${e.message}`);
  }
  return pkg;
}

// The obeliskCapacitor ownership marker: written by init, required by sync.
export function ownershipMarker(cliVersion) {
  return { owner: 'obelisk-capacitor', version: cliVersion };
}

export function hasOwnershipMarker(pkg) {
  return pkg?.obeliskCapacitor?.owner === 'obelisk-capacitor';
}

export async function readCapacitorConfig(appDir) {
  let raw;
  try {
    raw = await readFile(join(appDir, 'capacitor.config.json'), 'utf8');
  } catch {
    fail(`app: ${appDir} has no capacitor.config.json (it must carry a JSON Capacitor config with webDir "www")`);
  }
  const cfg = JSON.parse(raw);
  if (cfg.webDir !== APP_WWW_DIR) {
    fail(`app: capacitor.config.json webDir must be "${APP_WWW_DIR}" (found ${JSON.stringify(cfg.webDir)})`);
  }
  return cfg;
}

// Reject symlinked destinations before touching anything: a symlinked www or
// project directory would stage the payload somewhere unexpected.
export async function assertNoSymlinkDir(p, what) {
  const st = await lstat(p).catch(() => null);
  if (!st) fail(`${what}: ${p} does not exist`);
  if (st.isSymbolicLink()) fail(`${what}: ${p} is a symlink; refusing to touch it`);
  if (!st.isDirectory()) fail(`${what}: ${p} is not a directory`);
}

// ---- Staging ----------------------------------------------------------------

// Build the replacement web tree for an application from a validated bundle:
// a private staging directory receives ghcjs/ and static/ copies, the
// transformed bootstrap HTML, and the bundled plugin entry. Nothing is moved
// into place until the whole tree exists; a throw leaves the caller's app
// untouched and removes only the invocation-owned staging directory.
export async function stageWebTree(appDir, bundle, { cliVersion, keep = false } = {}) {
  const staging = await mkdtemp(join(tmpdir(), 'ob-capacitor-stage-'));
  try {
    const newWww = join(staging, APP_WWW_DIR);
    await mkdir(newWww, { recursive: true });
    await copyTreeRegular(join(bundle.webDir, 'ghcjs'), join(newWww, 'ghcjs'));
    await copyTreeRegular(join(bundle.webDir, 'static'), join(newWww, 'static'));
    const html = await readFile(join(bundle.webDir, 'index.html'), 'utf8');
    const transformed = transformBootstrapHtml(html);
    await writeFile(join(newWww, 'index.html'), transformed);
    await bundlePluginEntry(appDir, join(newWww, PLUGIN_BUNDLE));
    // Sanity: the staged tree must be symlink-free and self-contained.
    await assertTreeHasNoSymlinks(newWww);
    return { staging, newWww };
  } catch (e) {
    if (!keep) await rm(staging, { recursive: true, force: true });
    throw e;
  }
}

async function assertTreeHasNoSymlinks(dir) {
  const walk = async (abs, rel) => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const a = join(abs, entry.name);
      const st = await lstat(a);
      if (st.isSymbolicLink()) fail(`staged payload contains a symlink at ${r}`);
      if (st.isDirectory()) await walk(a, r);
    }
  };
  await walk(dir, '');
}

// Atomically-ish swap the application's www for the staged tree. The previous
// payload is preserved until the swap succeeds, and restored if the rename
// back fails. oldDir and newDir must be on the same filesystem (both under
// tmpdir siblings of the app, or the app itself).
export async function swapDirectory(oldDir, newDir, { backupName = `${oldDir}.ob-capacitor-bak` } = {}) {
  const parent = dirname(oldDir);
  const backup = backupName.startsWith('/') ? backupName : join(parent, requireBasename(backupName));
  await rm(backup, { recursive: true, force: true });
  await rename(oldDir, backup);
  try {
    await rename(newDir, oldDir);
  } catch (e) {
    await rename(backup, oldDir);
    fail(`www replacement failed and was rolled back: ${e.message}`);
  }
  return backup;
}

function requireBasename(p) {
  const parts = p.split('/');
  if (parts.length !== 1) fail(`swapDirectory: backup path must be relative to the parent: ${p}`);
  return p;
}

export { access, constants };
