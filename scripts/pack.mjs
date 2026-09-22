// Package each browser build as a store-ready zip at release/duckdive-<browser>-<version>.zip.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const targets = ['chrome', 'firefox', 'edge'];
const storeHosts = ['https://*.amazonaws.com/*'];

mkdirSync(`${root}release`, { recursive: true });

/** Refuse debug builds or a manifest meant for a different browser. */
function verifyBuild(stage, manifest, target) {
  const hosts = manifest.host_permissions ?? [];
  if (hosts.length !== storeHosts.length || hosts.some((host, i) => host !== storeHosts[i])) {
    throw new Error(
      `${target} asks for host permissions ${JSON.stringify(hosts)}; a store build asks for ${JSON.stringify(storeHosts)}`,
    );
  }
  for (const file of readdirSync(join(stage, 'assets'))) {
    if (file.endsWith('.js') && readFileSync(join(stage, 'assets', file), 'utf8').includes('__ddv'))
      throw new Error(`${target} assets/${file} still carries the __ddv test hooks`);
  }

  if (target === 'firefox') {
    if (!manifest.background?.scripts?.includes('background.js') || manifest.background.service_worker)
      throw new Error('Firefox must use background.scripts, not background.service_worker');
    if (!manifest.browser_specific_settings?.gecko?.id) throw new Error('Firefox must declare a Gecko add-on ID');
    if (manifest.key || manifest.minimum_chrome_version)
      throw new Error('Firefox contains Chromium-only manifest fields');
  } else {
    if (manifest.background?.service_worker !== 'background.js' || manifest.background.scripts)
      throw new Error(`${target} must use background.service_worker`);
    if (target === 'chrome' && !manifest.key) throw new Error('The unpacked Chrome build must carry its public key');
    if (target === 'edge' && manifest.key) throw new Error("The Edge build must not carry Chrome's public key");
  }
}

/** The localized description stays within the strictest store limit used by these packages. */
function verifyLocales(stage) {
  for (const lang of readdirSync(join(stage, '_locales'))) {
    const messages = JSON.parse(readFileSync(join(stage, '_locales', lang, 'messages.json'), 'utf8'));
    const description = messages.appDesc?.message ?? '';
    if (description.length > 132)
      throw new Error(`_locales/${lang} appDesc is ${description.length} characters; the package limit is 132`);
  }
}

for (const target of targets) {
  const source = join(root, 'dist', target);
  if (!existsSync(join(source, 'manifest.json'))) throw new Error(`${target} build not found; run \`pnpm run build\``);

  const zip = join(root, 'release', `${pkg.name}-${target}-${pkg.version}.zip`);
  rmSync(zip, { force: true });
  const stage = mkdtempSync(join(tmpdir(), `ddv-pack-${target}-`));
  try {
    cpSync(source, stage, { recursive: true, filter: (path) => !path.endsWith('.map') });
    const manifestPath = join(stage, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    verifyBuild(stage, manifest, target);
    verifyLocales(stage);
    // Store signing determines the installed Chrome ID; `key` is only for stable unpacked builds.
    if (target === 'chrome') delete manifest.key;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: stage, stdio: 'inherit' });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(`wrote ${zip}`);
}
