import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { extensionManifest, outputDir, parseBrowserTarget } from './build/manifest.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const browserTarget = parseBrowserTarget(process.env.DDV_BROWSER);

/** Extra host permissions for local testing, e.g. DDV_EXTRA_HOSTS="http://localhost/*" */
const extraHosts = (process.env.DDV_EXTRA_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Browser-specific MV3 manifest, generated so the version stays in sync with package.json. */
const manifest = extensionManifest(browserTarget, pkg.version, extraHosts);

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
    outDir: outputDir(browserTarget),
    target: 'es2022',
    // .map files next to the bundles for readable stack traces from bug reports; pack.mjs leaves them out of the store zip
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: { main: 'index.html', background: 'src/background.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
