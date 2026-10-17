// Native ALB/gzip, OpenTelemetry, converted Parquet, and template drill-down in DuckDB-Wasm.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { launchExtension, waitReady, settled } from './ext-context.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'ddv-alb-analysis-'));
const logPath = 'elasticloadbalancing/123_elasticloadbalancing_test_app.example.log.gz';
mkdirSync(join(fixtures, 'elasticloadbalancing'));
const records = [];
const add = (method, url, latency, status = 200, time = '2026-09-22T12:00:00.000Z') => {
  records.push(
    `http ${time} app/example/abc 203.0.113.1:1234 10.0.0.1:80 0.001 ${latency} 0.002 ${status} ${status} 100 200 "${method} ${url} HTTP/1.1" "test-agent" - - arn:aws:elasticloadbalancing:test:123:targetgroup/test/abc "Root=1-abc" "api.example" "-" 1 ${time} "forward" "-" "-" "10.0.0.1:80" "${status}" "-" "-" TID_test`,
  );
};
add('GET', 'https://api.example/fast?a=1', 0.01);
add('GET', 'https://api.example/fast?a=2', 0.02);
add('GET', 'https://api.example/slow?a=1', 1);
add('GET', 'https://api.example/slow?a=2', 2, 500);
add('GET', 'https://api.example/slow?a=3#part', 3);
add('GET', 'https://api.example/slow?a=4', 4, 503);
add('POST', 'https://api.example/slow', 0.1);
add('GET', 'https://other.example/slow', 0.05);
add('GET', 'https://api.example/slow?failed=1', -1, 504);
add('GET', 'https://api.example/missing', '-', '-');
add('GET', 'https://api.example/zero', 0);
add('GET', 'https://api.example/invalid', 'Infinity');
add('GET', 'https://api.example/invalid', 'NaN');
add('GET', "https://api.example/o'hare?a=1", 5);
add('GET', 'https://api.example/worst', 10, 502);
add('GET', 'https://api.example/outside', 999, 503, '2026-09-21T12:00:00.000Z');
add('GET', 'https://api.example/outside', 999, 503, '2026-09-23T12:00:00.000Z');
writeFileSync(join(fixtures, logPath), gzipSync(records.join('\n') + '\n'));
const server = spawn(process.execPath, [new URL('./range-server.mjs', import.meta.url).pathname, fixtures, '0'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let context;
let page;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      const m = /localhost:(\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Fixture server exited: ${code}`)));
  });
  const app = await launchExtension();
  context = app.context;
  page = app.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await waitReady(page);
  await settled(page);
  const baseSearch = { query: '', filters: [], range: { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' } };
  const cfg = {
    kind: 'url',
    name: 'ALB fixtures',
    urls: `http://localhost:${port}/${logPath}`,
    format: 'auto',
    naming: 'native',
    timeField: null,
    authMode: 'none',
  };
  let navigation = 0;
  const open = async (config = cfg, target = 'discover') => {
    await page.evaluate((config) => localStorage.setItem('ddv.source', JSON.stringify(config)), config);
    await page.goto(
      `${app.appUrl}?alb=${++navigation}#/${target}?s=${Buffer.from(JSON.stringify({ search: baseSearch })).toString('base64url')}`,
    );
    await waitReady(page);
    await settled(page);
  };
  const search = async (query = '', range = baseSearch.range) => {
    const state = { search: { ...baseSearch, query, range } };
    await page.goto(
      `${app.appUrl}?alb=${navigation}#/discover?s=${Buffer.from(JSON.stringify(state)).toString('base64url')}`,
    );
    await settled(page);
  };
  const metric = (id) => page.locator(`.analysis-metric[data-metric="${id}"] .analysis-value`);
  const urlRow = (method, url) =>
    page
      .locator('.analysis-urls tbody tr')
      .filter({ has: page.getByText(url, { exact: true }) })
      .filter({ has: page.locator('td:first-child', { hasText: method }) });
  const assertMetrics = async () => {
    assert.equal(await metric('errors').textContent(), '26.67%');
    assert.equal(await metric('p95').textContent(), '7.5 s');
    assert.match(await page.locator('.analysis-template').textContent(), /11 measurements · 4 unavailable/);
    const cells = await urlRow('GET', 'https://api.example/slow').locator('td').allTextContents();
    assert.deepEqual(cells.slice(2, 6), ['5', '4', '3', '3.85 s']);
    assert.equal(await urlRow('POST', 'https://api.example/slow').count(), 1);
    assert.equal(await urlRow('GET', 'https://other.example/slow').count(), 1);
    assert.equal(await urlRow('GET', 'https://api.example/outside').count(), 0);
  };
  // Explicit Connect from Data source opens the built-in template without saving charts.
  await open(cfg, 'source');
  await page.locator('.source-page button.connect').click();
  await settled(page);
  assert.match(page.url(), /#\/discover/);
  await assertMetrics();
  assert.equal(await page.evaluate(() => localStorage.getItem('ddv.savedVis')), null);
  console.log('ok ALB: automatic opening, error denominator, target p95, invalid timings, endpoint groups');

  await page.getByRole('button', { name: 'View 5xx logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('.hits .n').textContent(), '4');
  assert.equal(await page.locator('table.docs > tbody > tr').count(), 4);
  await search();
  await page.getByRole('button', { name: 'View logs at or above p95', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('.hits .n').textContent(), '1');
  assert.match(await page.locator('table.docs').innerText(), /\/worst/);
  await search();
  await urlRow('GET', 'https://api.example/slow').getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('.hits .n').textContent(), '5');
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /target_processing_time: 4/);
  await search();
  await urlRow('GET', "https://api.example/o'hare").getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('.hits .n').textContent(), '1');
  await search('elb_status_code:504');
  assert.equal(await metric('errors').textContent(), '100.00%');
  assert.equal(await metric('p95').textContent(), '—');
  assert.equal(await page.locator('.analysis-urls').count(), 0);
  await search('target_processing_time:0');
  assert.equal(await metric('p95').textContent(), '0 ms');
  await search('NOT elb_status_code:*');
  assert.equal(await metric('errors').textContent(), '—');
  await search('elb_status_code:599');
  assert.equal(await metric('errors').textContent(), '—');
  assert.equal(await metric('p95').textContent(), '—');
  await search('', { from: '2026-09-22T00:00:00Z', to: '2026-09-22T10:00:00Z' });
  assert.match(await page.locator('.analysis-template').innerText(), /No requests match/);
  console.log('ok ALB: exact drill-down, descending latency, zero/missing data, filters and time range');

  await search();
  await page.getByRole('button', { name: 'Hide analysis', exact: true }).click();
  await settled(page);
  await page.evaluate(() => window.__ddv.getQueryLog().splice(0));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  assert.equal(await page.evaluate(() => window.__ddv.getQueryLog().some((q) => q.sql.includes('url_p95'))), false);
  await page.getByRole('button', { name: 'Show analysis', exact: true }).click();
  await settled(page);
  await assertMetrics();
  await page.evaluate(() => window.__ddv.getQueryLog().splice(0));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  assert.equal(
    await page.evaluate(() => window.__ddv.getQueryLog().filter((q) => q.sql.includes('url_p95')).length),
    1,
  );

  // Actual converted Parquet, exported through the same reader the app ships.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.export-menu select').selectOption('parquet');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.export-menu').getByRole('button', { name: 'Download', exact: true }).click();
  await (await downloadPromise).saveAs(join(fixtures, 'converted.parquet'));
  await open({ ...cfg, urls: `http://localhost:${port}/converted.parquet`, format: 'parquet' });
  await assertMetrics();
  // Converted JSON may retain timings as strings; 10 must sort before 2, not lexically.
  writeFileSync(
    join(fixtures, 'string-timings.jsonl'),
    ['2', '10', '-', '-1', 'NaN']
      .map((duration) =>
        JSON.stringify({
          time: '2026-09-22T12:00:00Z',
          elb_status_code: '200',
          target_processing_time: duration,
          request: 'GET https://api.example/strings HTTP/1.1',
        }),
      )
      .join('\n') + '\n',
  );
  await open({ ...cfg, urls: `http://localhost:${port}/string-timings.jsonl`, format: 'json' });
  assert.equal(await metric('p95').textContent(), '9.6 s');
  await urlRow('GET', 'https://api.example/strings').getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('.hits .n').textContent(), '5');
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /target_processing_time: 10/);
  await open({ ...cfg, naming: 'otel' });
  await assertMetrics();
  await urlRow('GET', 'https://api.example/slow').getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('.hits .n').textContent(), '5');
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /aws.alb.target_processing_time: 4/);
  await page.reload();
  await waitReady(page);
  await settled(page);
  assert.equal(await page.locator('.hits .n').textContent(), '5');
  assert.equal(await page.locator('.analysis-template').count(), 1);
  await open({ ...cfg, timeField: '' });
  assert.match(await page.locator('.analysis-template').innerText(), /analyzing all matching records/);
  console.log(
    'ok ALB: collapse and refresh, converted Parquet / string timings, OpenTelemetry, restore and no-time-field behavior',
  );

  await open(cfg);
  if (process.env.DDV_ALB_SCREENSHOT) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.lang-select').selectOption('ja');
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await settled(page);
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page.screenshot({ path: new URL('../release/e2e/alb-analysis.png', import.meta.url).pathname });
  }
  await page.locator('.src-select').selectOption('demo');
  await settled(page);
  assert.equal(await page.locator('.analysis-template').count(), 0);
  assert.deepEqual(errors, []);
  console.log('ok ALB: switching away clears the template, no browser errors');
} catch (error) {
  if (page) {
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page
      .screenshot({ path: new URL('../release/e2e/alb-analysis-failure.png', import.meta.url).pathname })
      .catch(() => undefined);
    console.log(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await context?.close();
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
