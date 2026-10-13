// Record explicitly verified native platforms, never skipped/failed jobs.
//   node scripts/record-compatibility.mjs <run-url> <evidence-dir> android [ios]
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [runUrl, evidenceDir, ...platforms] = process.argv.slice(2);
const labels = { android: 'Android Emulator (UiAutomator2)', ios: 'iOS Simulator (XCUITest)' };
if (!runUrl || !evidenceDir || !platforms.length || platforms.some((p) => !Object.hasOwn(labels, p))) {
  console.error('usage: record-compatibility.mjs <run-url> <evidence-dir> android|ios [...]');
  process.exit(2);
}

const read = async (p) => (await readFile(p, 'utf8')).trim();
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const obeliskThunk = await read(join(repoRoot, 'examples/counter/deps/obelisk/thunk.nix'));
const obeliskRev = obeliskThunk.match(/rev = "([0-9a-f]{40})"/)[1];
const template = JSON.parse(await read(join(repoRoot, 'templates/app/package.json')));
const path = join(repoRoot, 'compatibility.json');
const doc = JSON.parse(await read(path));

for (const platform of new Set(platforms)) {
  const evidence = join(evidenceDir, `${platform}-evidence`);
  // This file is emitted only after the complete native suite passes.
  const acceptance = JSON.parse(await read(join(evidence, `acceptance-${platform}.json`)));
  assert.equal(acceptance.platform, platform);
  assert.equal(acceptance.backendUnavailable, true, 'backend-unavailable acceptance must run');
  const versions = await read(join(evidence, `versions-${platform}.txt`));
  const bundleSha = (await read(join(evidence, 'all.js.sha256'))).split(/\s+/)[0];
  assert.match(bundleSha, /^[a-f0-9]{64}$/, 'bundle SHA-256 must be recorded');
  const compilerVersion = await read(join(evidence, 'compiler-version.txt'));

  doc.tested.push({
    what: `Native acceptance - ${labels[platform]} (hosted CI, real WebView)`,
    obelisk: `obsidiansystems/obelisk@${obeliskRev}`,
    'frontend-target': 'js',
    compiler: { driver: 'nixpkgs', backend: 'javascript', version: compilerVersion },
    capacitor: template.dependencies['@capacitor/core'],
    'capacitor-plugins': {
      '@capacitor/app': template.dependencies['@capacitor/app'],
      '@capacitor/device': template.dependencies['@capacitor/device'],
    },
    device: acceptance.device,
    webview: acceptance.userAgent,
    'bundle-sha256': bundleSha,
    evidence: { where: runUrl, summary: versions, acceptance },
  });
  doc['native-ci'][platform] = {
    required: doc['native-ci'][platform].required,
    recorded: true,
    'last-green-run': runUrl,
  };
}
if (platforms.includes('android')) doc['native-ci']['last-required-green-run'] = runUrl;

await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`recorded ${platforms.join(', ')}: ${runUrl}`);
