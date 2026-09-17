// Zip dist/ into release/<name>-<version>.zip for the Chrome Web Store.
// The store rejects a manifest that contains "key" (it manages the signing key itself),
// so the zip gets a copy of the manifest without it; dist/ keeps the key for "Load unpacked".
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
if (!existsSync(`${root}dist/manifest.json`)) {
  console.error('dist/manifest.json not found – run `pnpm run build` first');
  process.exit(1);
}
mkdirSync(`${root}release`, { recursive: true });
const zip = `${root}release/${pkg.name}-${pkg.version}.zip`;
rmSync(zip, { force: true });

/** The host permissions a store build asks for at install time (vite.config.ts, without DDV_EXTRA_HOSTS). */
const STORE_HOSTS = ['https://*.amazonaws.com/*'];

/**
 * `pnpm test` ends with build:e2e, which grants http://localhost/* and publishes the test hooks on
 * window.__ddv. Zipping that dist/ would upload a build that reaches a local server and exposes
 * its internals to any page, so the staged copy is checked before it is zipped.
 */
function refuseTestBuild(stage, manifest) {
  const hosts = manifest.host_permissions ?? [];
  if (hosts.length !== STORE_HOSTS.length || hosts.some((h, i) => h !== STORE_HOSTS[i])) {
    console.error(`dist/ asks for host permissions ${JSON.stringify(hosts)}; a store build asks for ${JSON.stringify(STORE_HOSTS)}. Run \`pnpm run build\`.`);
    process.exit(1);
  }
  for (const f of readdirSync(join(stage, 'assets'))) {
    if (f.endsWith('.js') && readFileSync(join(stage, 'assets', f), 'utf8').includes('__ddv')) {
      console.error(`assets/${f} still carries the __ddv test hooks. Run \`pnpm run build\`.`);
      process.exit(1);
    }
  }
}

const stage = mkdtempSync(join(tmpdir(), 'ddv-pack-'));
try {
  cpSync(`${root}dist`, stage, { recursive: true, filter: (src) => !src.endsWith('.map') });
  const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
  refuseTestBuild(stage, manifest);
  delete manifest.key;
  // The description comes from _locales/<lang>/messages.json; the store caps every locale at 132 characters.
  for (const lang of readdirSync(join(stage, '_locales'))) {
    const msgs = JSON.parse(readFileSync(join(stage, '_locales', lang, 'messages.json'), 'utf8'));
    const desc = msgs.appDesc?.message ?? '';
    if (desc.length > 132) {
      console.error(`_locales/${lang} appDesc is ${desc.length} characters; the store allows 132`);
      process.exit(1);
    }
  }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  execSync(`cd "${stage}" && zip -qr -X "${zip}" .`, { stdio: 'inherit' });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`wrote ${zip} (manifest without "key")`);
