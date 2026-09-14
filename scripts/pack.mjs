// Zip dist/ into release/<name>-<version>.zip for the Chrome Web Store.
// The store rejects a manifest that contains "key" (it manages the signing key itself),
// so the zip gets a copy of the manifest without it; dist/ keeps the key for "Load unpacked".
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
if (!existsSync(`${root}dist/manifest.json`)) {
  console.error('dist/manifest.json not found – run `npm run build` first');
  process.exit(1);
}
mkdirSync(`${root}release`, { recursive: true });
const zip = `${root}release/${pkg.name}-${pkg.version}.zip`;
rmSync(zip, { force: true });

const stage = mkdtempSync(join(tmpdir(), 'ddv-pack-'));
try {
  cpSync(`${root}dist`, stage, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
  delete manifest.key;
  if ((manifest.description ?? '').length > 132) {
    console.error(`manifest.description is ${manifest.description.length} characters; the store allows 132`);
    process.exit(1);
  }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  execSync(`cd "${stage}" && zip -qr -X "${zip}" .`, { stdio: 'inherit' });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`wrote ${zip} (manifest without "key")`);
