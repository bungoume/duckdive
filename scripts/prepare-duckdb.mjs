// Copy the duckdb-wasm runtime (worker + wasm) into public/duckdb so the extension
// ships it without any CDN dependency. Runs before every build (pnpm "prebuild").
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../node_modules/@duckdb/duckdb-wasm/dist/', import.meta.url).pathname;
const out = new URL('../public/duckdb/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of ['duckdb-eh.wasm', 'duckdb-browser-eh.worker.js']) copyFileSync(join(dist, f), join(out, f));
console.log('copied duckdb-wasm runtime to public/duckdb');
