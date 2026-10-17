// CloudFront standard logs, OTel and converted files: real DuckDB-Wasm metrics and drill-down.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { launchExtension, waitReady, settled } from './ext-context.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'ddv-cloudfront-analysis-'));
const logPath = 'E2EXAMPLE12345.2026-09-22-12.example.gz';
const records = [];
const add = (method, path, latency, status = 200, result = 'Hit', host = 'cdn.example', day = '2026-09-22') => {
  const [stem, query = '-'] = path.split('?');
  records.push(
    [
      day,
      '12:00:00',
      'NRT57-P2',
      392,
      '203.0.113.1',
      method,
      'd111.cloudfront.net',
      stem,
      status,
      '-',
      'test-agent',
      query,
      '-',
      result,
      `rid-${records.length}`,
      host,
      'https',
      23,
      latency,
      '-',
      'TLSv1.3',
      'TLS_AES_128_GCM_SHA256',
      path === '/disconnect' ? 'Hit' : result,
      'HTTP/2.0',
      '-',
      '-',
      443,
      0.001,
      result,
      'text/html',
      78,
      '-',
      '-',
    ].join('\t'),
  );
};
add('GET', '/asset?v=1', 0.01);
add('GET', '/asset?v=2', 0.02, 200, 'RefreshHit');
add('GET', '/slow?v=1', 1, 200, 'Miss');
add('GET', '/slow?v=2', 2, 404, 'Error');
add('GET', '/slow?v=3', 3, 500, 'Error');
add('GET', '/slow?v=4', 4);
add('POST', '/slow', 0.1, 200, 'Miss');
add('GET', '/slow', 0.05, 200, 'Hit', 'other.example');
add('GET', '/slow?failed=1', -1, 503, 'Error');
add('GET', '/missing', '-', '-', '-');
add('HEAD', '/zero', 0, 204);
add('GET', '/invalid', 'Infinity', 200, 'Miss');
add('GET', '/invalid', 'NaN');
add('GET', "/o'hare?q=1", 5, 200, 'RefreshHit');
add('GET', '/worst', 10, 502, 'Error');
add('PUT', '/write', 0.03, 200, 'Miss');
add('GET', '/redirect', 0.04, 301, 'Redirect');
add('GET', '/unknown', 0.06, 200, '-');
add('GET', '/disconnect', 0.07, 200, 'Error');
add('OPTIONS', '/options', 0.08, 200, 'Miss');
add('GET', '/outside', 999, 503, 'Error', 'cdn.example', '2026-09-21');
add('GET', '/outside', 999, 503, 'Error', 'cdn.example', '2026-09-23');
writeFileSync(
  join(fixtures, logPath),
  gzipSync('#Version: 1.0\n#Fields: standard-33-fields\n' + records.join('\n') + '\n'),
);
// Original AWS field names and string timings, as found in converted JSON/Parquet exports.
writeFileSync(
  join(fixtures, 'aws-fields.jsonl'),
  [
    { 'time-taken': '2', 'x-edge-result-type': 'Miss' },
    { 'time-taken': '10', 'x-edge-result-type': 'Hit' },
    { 'time-taken': '-', 'x-edge-result-type': '-' },
    { 'time-taken': '-1', 'x-edge-result-type': 'FutureResult' },
    { 'time-taken': 'NaN', 'x-edge-result-type': 'Error' },
  ]
    .map((record) =>
      JSON.stringify({
        timestamp: '2026-09-22T12:00:00Z',
        'sc-status': '200',
        'cs-method': 'GET',
        'cs-uri-stem': "/o'hare",
        'x-host-header': '-',
        'cs(Host)': 'fallback.cloudfront.net',
        'cs-protocol': 'https',
        ...record,
      }),
    )
    .join('\n') + '\n',
);

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
  page.on('pageerror', (error) => errors.push(error.message));
  await waitReady(page);
  await settled(page);
  const baseSearch = { query: '', filters: [], range: { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' } };
  const cfg = {
    kind: 'url',
    name: 'CloudFront fixtures',
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
      `${app.appUrl}?cf=${++navigation}#/${target}?s=${Buffer.from(JSON.stringify({ search: baseSearch })).toString('base64url')}`,
    );
    await waitReady(page);
    await settled(page);
  };
  const search = async (query = '', range = baseSearch.range, filters = []) => {
    const state = { search: { query, range, filters } };
    await page.goto(
      `${app.appUrl}?cf=${navigation}#/discover?s=${Buffer.from(JSON.stringify(state)).toString('base64url')}`,
    );
    await settled(page);
  };
  const metric = (id) => page.locator(`.analysis-metric[data-metric="${id}"] .analysis-value`);
  const urlRow = (method, url) =>
    page
      .locator('.analysis-urls tbody tr')
      .filter({ has: page.getByText(url, { exact: true }) })
      .filter({ has: page.locator('td:first-child', { hasText: method }) });
  const hits = () => page.locator('.hits .n').textContent();
  const assertMetrics = async () => {
    assert.equal(await metric('client-errors').textContent(), '5.00%');
    assert.equal(await metric('errors').textContent(), '15.00%');
    assert.equal(await metric('cache').textContent(), '70.00%');
    assert.equal(await metric('p95').textContent(), '6.25 s');
    const panel = await page.locator('.analysis-template').innerText();
    assert.match(panel, /7 hits \/ 10 eligible · 10 excluded/);
    assert.match(panel, /Includes 2 RefreshHit/);
    assert.match(panel, /16 measurements · 4 unavailable/);
    const cells = await urlRow('GET', 'https://cdn.example/slow').locator('td').allTextContents();
    assert.deepEqual(cells.slice(2, 7), ['5', '4', '1', '2', '3.85 s']);
    assert.equal(await page.locator('.analysis-urls tbody tr').count(), 10);
    assert.match(await page.locator('.analysis-urls tbody tr').first().innerText(), /\/worst/);
    assert.equal(await urlRow('POST', 'https://cdn.example/slow').count(), 1);
    assert.equal(await urlRow('GET', 'https://other.example/slow').count(), 1);
    assert.equal(await urlRow('GET', 'https://cdn.example/outside').count(), 0);
  };
  await open(cfg, 'source');
  await page.locator('.source-page button.connect').click();
  await settled(page);
  assert.match(page.url(), /#\/discover/);
  assert.equal(await page.locator('.analysis-template').getAttribute('aria-label'), 'CloudFront analysis template');
  await assertMetrics();
  assert.equal(await page.evaluate(() => localStorage.getItem('ddv.savedVis')), null);
  console.log('ok CloudFront: automatic template, error rates, cache denominator, p95 and top ten URLs');

  for (const [button, count] of [
    ['View 4xx logs', '1'],
    ['View 5xx logs', '3'],
    ['View cache hit logs', '7'],
    ['View cache miss logs', '3'],
    ['View logs at or above p95', '1'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await settled(page);
    assert.equal(await hits(), count, button);
    assert.equal(await page.locator('table.docs > tbody > tr').count(), Number(count), button);
    await search();
  }
  await urlRow('GET', 'https://cdn.example/slow').getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '5');
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /time_taken: 4/);
  await search();
  await urlRow('GET', "https://cdn.example/o'hare").getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '1');
  // Existing query and field filters constrain both the metrics and their drill-down.
  await search('sc_status:>=200', baseSearch.range, [{ id: 'get', field: 'cs_method', op: 'is', value: 'GET' }]);
  await page.getByRole('button', { name: 'View cache hit logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '6');
  assert.equal(await page.locator('.qinput input').inputValue(), 'sc_status:>=200');
  await search('sc_status:404');
  assert.equal(await metric('client-errors').textContent(), '100.00%');
  assert.equal(await metric('errors').textContent(), '0.00%');
  assert.equal(await metric('cache').textContent(), '—');
  assert.equal(await page.getByRole('button', { name: 'View cache hit logs', exact: true }).isDisabled(), true);
  await search('sc_status:503');
  assert.equal(await metric('p95').textContent(), '—');
  assert.equal(await page.locator('.analysis-urls').count(), 0);
  await search('time_taken:0');
  assert.equal(await metric('p95').textContent(), '0 ms');
  assert.equal(await metric('cache').textContent(), '100.00%');
  await search('NOT sc_status:*');
  assert.equal(await metric('client-errors').textContent(), '—');
  assert.equal(await metric('errors').textContent(), '—');
  await search('cs_uri_stem:/disconnect');
  assert.equal(await metric('cache').textContent(), '—'); // final Error wins over response Hit
  await search('cs_method:POST');
  assert.equal(await metric('cache').textContent(), '—');
  await search('', { from: '2026-09-22T00:00:00Z', to: '2026-09-22T10:00:00Z' });
  assert.match(await page.locator('.analysis-template').innerText(), /No requests match/);
  console.log('ok CloudFront: exact drills, method/host separation, existing filters, unknowns and excluded outcomes');

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

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.export-menu select').selectOption('parquet');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.export-menu').getByRole('button', { name: 'Download', exact: true }).click();
  await (await downloadPromise).saveAs(join(fixtures, 'converted.parquet'));
  await open({ ...cfg, urls: `http://localhost:${port}/converted.parquet`, format: 'parquet' });
  await assertMetrics();
  await open({ ...cfg, naming: 'otel' });
  await assertMetrics();
  await page.getByRole('button', { name: 'View cache miss logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '3');
  await page.reload();
  await waitReady(page);
  await settled(page);
  assert.equal(await hits(), '3');
  assert.equal(await metric('cache').textContent(), '0.00%');
  await open({ ...cfg, urls: `http://localhost:${port}/aws-fields.jsonl`, format: 'json' });
  assert.equal(await metric('cache').textContent(), '50.00%');
  assert.equal(await metric('p95').textContent(), '9.6 s');
  await urlRow('GET', "https://fallback.cloudfront.net/o'hare")
    .getByRole('button', { name: 'View logs', exact: true })
    .click();
  await settled(page);
  assert.equal(await hits(), '5');
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /time-taken: 10/);
  await open({ ...cfg, timeField: '' });
  assert.match(await page.locator('.analysis-template').innerText(), /analyzing all matching records/);
  console.log(
    'ok CloudFront: collapse/refresh, Parquet, OTel, restore, AWS field names, numeric sorting and host fallback',
  );

  await open(cfg);
  // At a narrower window the template must stay within the available Discover column.
  await page.setViewportSize({ width: 1000, height: 900 });
  await settled(page);
  assert.equal(
    await page.locator('.analysis-template').evaluate((panel) => {
      const right = panel.getBoundingClientRect().right;
      return (
        panel.scrollWidth <= panel.clientWidth + 1 &&
        [...panel.querySelectorAll('.analysis-metric')].every((card) => card.getBoundingClientRect().right <= right)
      );
    }),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.DDV_CF_SCREENSHOT) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.lang-select').selectOption('ja');
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await settled(page);
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page.screenshot({ path: new URL('../release/e2e/cloudfront-analysis.png', import.meta.url).pathname });
  }
  await page.locator('.src-select').selectOption('demo');
  await settled(page);
  assert.equal(await page.locator('.analysis-template').count(), 0);
  assert.deepEqual(errors, []);
  console.log('ok CloudFront: responsive layout, source switch and no browser errors');
} catch (error) {
  if (page) {
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page
      .screenshot({ path: new URL('../release/e2e/cloudfront-analysis-failure.png', import.meta.url).pathname })
      .catch(() => undefined);
    console.log((await page.locator('.analysis-template').allTextContents()).join('\n'));
  }
  throw error;
} finally {
  await context?.close();
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
