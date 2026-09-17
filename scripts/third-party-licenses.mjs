// Collect the LICENSE texts of every production dependency (the code that ends up in dist/)
// into public/THIRD_PARTY_LICENSES.txt so the packaged extension carries the required notices.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mitText = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const root = new URL('..', import.meta.url).pathname;
const paths = execSync('pnpm ls --prod --depth Infinity --parseable', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  .split('\n')
  .map((s) => s.trim())
  .filter((p) => p && p !== root.replace(/\/$/, '') && p.includes('node_modules'));

const seen = new Map();
for (const dir of paths) {
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) continue;
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  const licFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = licFile ? readFileSync(join(dir, licFile), 'utf8').trim() : null;
  const license = pkg.license ?? (typeof pkg.licenses === 'object' ? JSON.stringify(pkg.licenses) : 'UNKNOWN');
  const holder = typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? pkg.name);
  seen.set(key, { name: pkg.name, version: pkg.version, license, homepage: pkg.homepage ?? '', text: text ?? (license === 'MIT' ? mitText(holder) : null) });
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = [
  'Duckdive bundles the following third-party packages. Their license texts are reproduced below.',
  '',
  ...entries.map((e) => `- ${e.name}@${e.version} (${e.license})${e.homepage ? ` ${e.homepage}` : ''}`),
  '',
  ...entries.flatMap((e) => ['='.repeat(78), `${e.name}@${e.version} — ${e.license}`, '='.repeat(78), e.text ?? '(license text not included in the package; see the package homepage)', '']),
].join('\n');
mkdirSync(`${root}public`, { recursive: true });
writeFileSync(`${root}public/THIRD_PARTY_LICENSES.txt`, out);
const missing = entries.filter((e) => !e.text).map((e) => e.name);
console.log(`third-party licenses: ${entries.length} packages → public/THIRD_PARTY_LICENSES.txt${missing.length ? ` (no license file: ${missing.join(', ')})` : ''}`);
