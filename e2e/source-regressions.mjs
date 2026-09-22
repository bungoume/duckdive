// Real-browser source persistence and shared-selection regressions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchExtension, waitReady, settled } from './ext-context.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'ddv-sources-'));
for (const [tenant, n] of [
  ['acme', 1],
  ['beta', 2],
]) {
  const dir = join(fixtures, 'logs', tenant);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'data.csv'), `ts,value\n2026-09-22T12:00:00Z,${n}\n`);
}
const server = spawn(process.execPath, [new URL('./range-server.mjs', import.meta.url).pathname, fixtures, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
let context;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const m = /localhost:(\d+)/.exec(String(d));
      if (m) resolve(+m[1]);
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Fixture server exited: ${code}`)));
  });
  const app = await launchExtension();
  context = app.context;
  const { page, appUrl } = app;
  await page.goto(appUrl);
  await waitReady(page);
  await settled(page);
  await page.getByRole('button', { name: 'Data source', exact: true }).click();
  const timeField = page.locator('select:has(option[value="@timestamp"])');
  await timeField.selectOption('');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ddv.source')).timeField), '');
  await page.locator('.source-page button.connect').click();
  await settled(page);
  assert.equal(await timeField.inputValue(), '');
  await page.reload();
  await waitReady(page);
  await settled(page);
  assert.equal(await timeField.inputValue(), '');
  assert.equal(await page.evaluate(() => window.__ddv.attached.timeField), null);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ddv.sources'))[0].config.timeField), '');
  await timeField.selectOption('@timestamp');
  await page.reload();
  await waitReady(page);
  await settled(page);
  assert.equal(await timeField.inputValue(), '@timestamp');
  console.log('ok   explicit time field choice survives reconnect and reload');

  const known = {
    kind: 'url',
    name: 'acme',
    urls: 's3://logs/{tenant}/data.csv',
    format: 'csv',
    naming: 'native',
    authMode: 'none',
    timeField: 'ts',
    s3: { endpoint: `http://localhost:${port}`, region: 'us-east-1', urlStyle: 'path', accessKeyId: '', secretAccessKey: '', sessionToken: '' },
    tokenValues: { tenant: ['acme'] },
    maxFiles: 0,
  };
  const shared = { ...known, name: 'beta', tokenValues: { tenant: ['beta'] } };
  await page.evaluate((cfg) => {
    localStorage.setItem('ddv.source', JSON.stringify(cfg));
    localStorage.setItem('ddv.sources', JSON.stringify([{ config: cfg, lastUsed: '2026-09-22' }]));
  }, known);
  const state = { search: { query: '', range: { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' }, filters: [] } };
  await page.goto(`${appUrl}?test=shared#/discover?s=${Buffer.from(JSON.stringify(state)).toString('base64url')}&src=${Buffer.from(JSON.stringify(shared)).toString('base64url')}`);
  await waitReady(page);
  await settled(page);
  const actual = await page.evaluate(async () => ({ rows: (await window.__ddv.query('SELECT value FROM src')).rows, saved: JSON.parse(localStorage.getItem('ddv.source')) }));
  assert.deepEqual(actual.rows, [{ value: 2 }]);
  assert.deepEqual(actual.saved.tokenValues, { tenant: ['beta'] });
  assert.equal(actual.saved.name, 'beta');
  console.log('ok   known shared source keeps the shared selection');
} finally {
  await context?.close();
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
