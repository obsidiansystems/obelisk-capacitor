// Record a green native CI run into compatibility.json.
//   node scripts/record-compatibility.mjs <run-url> <evidence-dir>
// The evidence dir is actions/download-artifact's output: ios-evidence/ and
// android-evidence/ carrying versions-*.txt captured on the runners.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [runUrl, evidenceDir] = process.argv.slice(2);
if (!runUrl || !evidenceDir) {
  console.error('usage: record-compatibility.mjs <run-url> <evidence-dir>');
  process.exit(2);
}

const read = async (p) => readFile(p, 'utf8').then((s) => s.trim()).catch(() => null);
const firstLine = async (p) => {
  const s = await read(p);
  return s ? s.split('\n')[0].trim() : null;
};

const repoRoot = new URL('..', import.meta.url).pathname;
const obeliskThunk = await read(join(repoRoot, 'examples/counter/deps/obelisk/thunk.nix'));
const obeliskRev = obeliskThunk?.match(/rev = "([0-9a-f]{40})"/)?.[1] ?? 'unknown';
const template = JSON.parse(await readFile(join(repoRoot, 'templates/app/package.json'), 'utf8'));

const summarize = async (sub, name) => {
  const versions = await read(join(evidenceDir, sub, `versions-${name}.txt`));
  return versions ? versions.split('\n').map((l) => l.trim()).filter(Boolean) : [];
};

const iosVersions = await summarize('ios-evidence', 'ios');
const androidVersions = await summarize('android-evidence', 'android');
const bundleSha = (await firstLine(join(evidenceDir, 'ios-evidence/all.js.sha256')))
  ?? (await firstLine(join(evidenceDir, 'android-evidence/all.js.sha256')))
  ?? 'unavailable';

const path = join(repoRoot, 'compatibility.json');
const doc = JSON.parse(await readFile(path, 'utf8'));

const row = (platform, versions) => ({
  what: `Native acceptance - ${platform} (hosted CI, real WebView)`,
  obelisk: `obsidiansystems/obelisk@${obeliskRev}`,
  'frontend-target': 'js',
  capacitor: template.dependencies['@capacitor/core'],
  'capacitor-plugins': {
    '@capacitor/app': template.dependencies['@capacitor/app'],
    '@capacitor/device': template.dependencies['@capacitor/device'],
  },
  device: versions[0] ?? 'see run',
  'bundle-sha256': bundleSha,
  evidence: {
    where: runUrl,
    summary: versions.join(' | ') || 'see artifacts',
  },
});

doc.tested.push(row('iOS Simulator (XCUITest)', iosVersions));
doc.tested.push(row('Android Emulator (UiAutomator2)', androidVersions));
doc['native-ci'] = {
  workflow: '.github/workflows/mobile.yml',
  'last-green-run': runUrl,
  ios: { recorded: true },
  android: { recorded: true },
};

await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`recorded ${runUrl}`);
