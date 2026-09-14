import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; description?: string };

/** Extra host permissions for local testing, e.g. DDV_EXTRA_HOSTS="http://localhost/*" */
const extraHosts = (process.env.DDV_EXTRA_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** MV3 manifest, generated at build time so the version stays in sync with package.json. */
const manifest = {
  manifest_version: 3,
  name: 'Duckdive',
  version: pkg.version,
  // The Chrome Web Store caps this at 132 characters.
  description: 'Search and visualize log files from S3, HTTPS URLs or local disk, in the browser. Nothing leaves your machine.',
  minimum_chrome_version: '116',
  // Public key of the Chrome Web Store item, so unpacked (dev) builds get the same extension ID
  // (kohchgcbcmdcoondpjoiaccfkhadkpki) and the OIDC redirect URL https://kohchgcbcmdcoondpjoiaccfkhadkpki.chromiumapp.org/
  // as the store build. scripts/pack.mjs strips it from the uploaded zip (the store rejects "key").
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArgh8WQbJmwPI8reODpywYBayQ/Z1Bxs3eJsiBOqQR8Kx2s9VdD29Az/3J4d4xaEy+J/Yh3+lYMguCaQmuMJpcqnOYeAtUBV2MX+kUnFb41kCDcma2JVggcFOEpS+0PIN7fmvXDfohHZa4APBAmDAtMKRgA+hOpkpNl6fTMTLl4jEU6hnV/+csswNSJ5g32XP3JSJHuGnVaMbTtIVYjrgWeE6A4aJ7pXKdDNvbyIvnIun6zMrjqJDOjhgJYOGUKXqutm0ZDt0DG+zuQAQz2Ewp1QM7noRQ/jkZwEL2G6/l91Hs6hANFyM1rBnCd6SP8QZEDbdwz31NAM14LQ5oUhxxQIDAQAB',
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_title: 'Open Duckdive', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['storage', 'identity', 'unlimitedStorage'],
  // AWS endpoints (S3 in every region, STS) are granted up front; anything else
  // (MinIO, R2, CloudFront, localhost) is requested at runtime from the Data source page.
  host_permissions: ['https://*.amazonaws.com/*', ...extraHosts],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
};

function manifestPlugin(): Plugin {
  return {
    name: 'ddv-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
    },
  };
}

export default defineConfig({
  plugins: [preact(), manifestPlugin()],
  base: '/',
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  // The DuckDB cache worker must be a classic worker so it can importScripts() the duckdb-wasm worker bundle.
  worker: { format: 'iife' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: { main: 'index.html', background: 'src/background.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
