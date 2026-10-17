// VPC Flow Logs: actual gzip/Parquet/OTel readers, eligible record counts and exact drill-downs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { launchExtension, waitReady, settled } from './ext-context.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'ddv-vpc-analysis-'));
mkdirSync(join(fixtures, 'vpcflowlogs'));
const logPath = 'vpcflowlogs/123_vpcflowlogs_test.log.gz';
const records = [];
const time = Date.parse('2026-09-22T12:00:00Z') / 1000;
const add = (source, destination, port, protocol, action, bytes, packets, status = 'OK', start = time) => {
  records.push(
    [
      2,
      '123456789012',
      `eni-${records.length}`,
      source,
      destination,
      50000,
      port,
      protocol,
      packets,
      bytes,
      start,
      start + 60,
      action,
      status,
    ].join(' '),
  );
};
add('10.0.0.1', '10.0.1.1', 443, 6, 'ACCEPT', 1000, 10);
add('10.0.0.1', '10.0.1.1', 443, 6, 'REJECT', 2000, 20);
add('10.0.0.1', '10.0.1.2', 443, 17, 'ACCEPT', 4000, 40);
add('10.0.0.2', '10.0.1.1', 53, 17, 'ACCEPT', 8000, 80);
add('2001:db8::1', '2001:db8::2', 22, 6, 'REJECT', 16000, 160);
add('10.0.0.2', '10.0.1.2', 443, 6, 'ACCEPT', 0, 0);
add('10.0.0.3', '10.0.1.2', 443, 6, 'REJECT', '-', '-');
add('10.0.0.3', '10.0.1.2', 443, 6, 'ACCEPT', -1, -1);
add('10.0.0.3', '10.0.1.2', 443, 6, 'ACCEPT', 'NaN', 'Infinity');
add('-', '-', '-', 1, 'ACCEPT', 300, 3);
add('10.0.0.4', '10.0.1.3', 0, 6, 'ACCEPT', 100, 1);
add('-', '-', '-', '-', '-', '-', '-', 'NODATA');
add('10.0.0.1', '10.0.1.1', 443, 6, 'REJECT', 999999, 999999, 'SKIPDATA');
add('10.0.0.1', '10.0.1.1', 443, 6, 'UNKNOWN', 999999, 999999);
add('10.0.0.1', '10.0.1.1', 443, 6, 'ACCEPT', 999999, 999999, '-');
add('10.0.0.1', '10.0.1.1', 443, 6, 'REJECT', 999999, 999999, 'OTHER');
add('outside', 'outside', 443, 6, 'REJECT', 999999, 999999, 'OK', time - 86400);
add('outside', 'outside', 443, 6, 'REJECT', 999999, 999999, 'OK', time + 86400);
writeFileSync(
  join(fixtures, logPath),
  gzipSync(
    'version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes start end action log-status\n' +
      records.join('\n') +
      '\n',
  ),
);
writeFileSync(
  join(fixtures, 'custom.jsonl'),
  [
    { action: 'ACCEPT', bytes: '9' },
    { action: 'REJECT', bytes: '100' },
    { action: 'REJECT', bytes: 'Infinity' },
    { action: 'REJECT', bytes: '1.5' },
    { action: 'UNKNOWN', bytes: '99999' },
  ]
    .map((row) =>
      JSON.stringify({
        start: time,
        interface_id: 'eni-custom',
        srcaddr: "odd'address",
        dstaddr: '10.0.1.1',
        dstport: '65536',
        protocol: '999',
        ...row,
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
    name: 'VPC Flow fixtures',
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
      `${app.appUrl}?vpc=${++navigation}#/${target}?s=${Buffer.from(JSON.stringify({ search: baseSearch })).toString('base64url')}`,
    );
    await waitReady(page);
    await settled(page);
  };
  const search = async (query = '', range = baseSearch.range, filters = []) => {
    await page.goto(
      `${app.appUrl}?vpc=${navigation}#/discover?s=${Buffer.from(JSON.stringify({ search: { query, range, filters } })).toString('base64url')}`,
    );
    await settled(page);
  };
  const metric = (id) => page.locator(`.analysis-metric[data-metric="${id}"] .analysis-value`);
  const row = (kind, label) =>
    page
      .locator(`[data-ranking="${kind}"] tbody tr`)
      .filter({ has: page.locator('td:first-child', { hasText: label }) });
  const hits = () => page.locator('.hits .n').textContent();
  const drill = async (kind, label, count, rejected = false) => {
    const target = row(kind, label);
    await target.getByRole('button', { name: rejected ? /View REJECT logs:/ : 'View logs', exact: !rejected }).click();
    await settled(page);
    assert.equal(await hits(), String(count), `${kind}: ${label}`);
    assert.equal(await page.locator('table.docs > tbody > tr').count(), count);
  };
  const assertMetrics = async () => {
    assert.equal(await metric('reject').textContent(), '27.27%');
    assert.equal(await metric('bytes').textContent(), '30.7 KB');
    const panel = await page.locator('.analysis-template').innerText();
    assert.match(panel, /3 REJECT \/ 11 ACCEPT \+ REJECT records/);
    assert.match(panel, /8 records with bytes · 3 unavailable/);
    assert.match(panel, /Packets: 314/);
    assert.match(panel, /5 excluded records · NODATA 1 · SKIPDATA 1/);
    assert.match(panel, /SKIPDATA indicates missing/);
    assert.deepEqual((await row('source', '10.0.0.1').locator('td').allTextContents()).slice(1, 4), [
      '6.8 KB',
      '2',
      '1',
    ]);
    assert.deepEqual((await row('destination', '10.0.1.2').locator('td').allTextContents()).slice(1, 4), [
      '3.9 KB',
      '4',
      '1',
    ]);
    assert.deepEqual((await row('port', 'TCP (6) / 443').locator('td').allTextContents()).slice(1, 6), [
      '2.9 KB',
      '30',
      '4',
      '2',
      '33.33%',
    ]);
    assert.equal(await row('source', '10.0.0.3').locator('td').nth(1).textContent(), '—');
    assert.match(await page.locator('[data-ranking="source"] tbody tr').first().innerText(), /2001:db8::1/);
    assert.match(await page.locator('[data-ranking="destination"] tbody tr').first().innerText(), /2001:db8::2/);
    assert.equal(await row('port', 'UDP (17) / 443').count(), 1);
    assert.equal(await row('port', 'ICMP (1) / —').count(), 1);
    assert.equal(await row('port', 'TCP (6) / 0').count(), 1);
    assert.equal(await row('source', 'outside').count(), 0);
  };
  await open(cfg, 'source');
  await page.locator('.source-page button.connect').click();
  await settled(page);
  assert.match(page.url(), /#\/discover/);
  assert.equal(await page.locator('.analysis-template').getAttribute('aria-label'), 'VPC Flow Logs analysis template');
  await assertMetrics();
  assert.equal(await page.evaluate(() => localStorage.getItem('ddv.savedVis')), null);
  console.log('ok VPC: automatic template, REJECT denominator, byte and packet sums, independent rankings');

  await page.getByRole('button', { name: 'View REJECT logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '3');
  await search();
  await page.getByRole('button', { name: 'View traffic logs', exact: true }).click();
  await settled(page);
  assert.equal(await hits(), '11');
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /srcaddr: 2001:db8::1/);
  await search();
  await drill('source', '10.0.0.1', 3);
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /dstaddr: 10.0.1.2/);
  await search();
  await drill('destination', '10.0.1.2', 5);
  await search();
  await drill('port', 'TCP (6) / 443', 6);
  await search();
  await drill('port', 'TCP (6) / 443', 2, true);
  await search();
  await drill('port', 'UDP (17) / 443', 1);
  await search();
  await drill('port', 'ICMP (1) / —', 1);
  await search();
  await drill('port', 'TCP (6) / 0', 1);
  await search('action:ACCEPT', baseSearch.range, [{ id: 'source', field: 'srcaddr', op: 'is', value: '10.0.0.1' }]);
  await drill('source', '10.0.0.1', 2);
  assert.equal(await page.locator('.qinput input').inputValue(), 'action:ACCEPT');
  await search('bytes:0');
  assert.equal(await metric('bytes').textContent(), '0 B');
  assert.equal(await metric('reject').textContent(), '0.00%');
  await search('srcaddr:"10.0.0.3"');
  assert.equal(await metric('bytes').textContent(), '—');
  assert.equal(await metric('reject').textContent(), '33.33%');
  await search('action:UNKNOWN');
  assert.equal(await metric('reject').textContent(), '—');
  assert.equal(await page.getByRole('button', { name: 'View REJECT logs', exact: true }).isDisabled(), true);
  await search('', { from: '2026-09-22T00:00:00Z', to: '2026-09-22T10:00:00Z' });
  assert.equal(await metric('reject').textContent(), '—');
  assert.equal(await page.locator('.flow-table').count(), 0);
  console.log('ok VPC: exact source/destination/protocol drills, rejected subsets, missing counters, zero and filters');

  await search();
  await page.getByRole('button', { name: 'Hide analysis', exact: true }).click();
  await settled(page);
  await page.evaluate(() => window.__ddv.getQueryLog().splice(0));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  assert.equal(
    await page.evaluate(() => window.__ddv.getQueryLog().some((q) => q.sql.includes('flow_rankings'))),
    false,
  );
  await page.getByRole('button', { name: 'Show analysis', exact: true }).click();
  await settled(page);
  await assertMetrics();
  await page.evaluate(() => window.__ddv.getQueryLog().splice(0));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  assert.equal(
    await page.evaluate(() => window.__ddv.getQueryLog().filter((q) => q.sql.includes('flow_rankings')).length),
    1,
  );
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.export-menu select').selectOption('parquet');
  const download = page.waitForEvent('download');
  await page.locator('.export-menu').getByRole('button', { name: 'Download', exact: true }).click();
  await (await download).saveAs(join(fixtures, 'converted.parquet'));
  await open({ ...cfg, urls: `http://localhost:${port}/converted.parquet`, format: 'parquet' });
  await assertMetrics();
  await open({ ...cfg, naming: 'otel' });
  await assertMetrics();
  await drill('port', 'TCP (6) / 443', 6);
  await page.reload();
  await waitReady(page);
  await settled(page);
  assert.equal(await hits(), '6');
  assert.equal(await metric('reject').textContent(), '33.33%');
  await open({ ...cfg, urls: `http://localhost:${port}/custom.jsonl`, format: 'json' });
  assert.equal(await metric('reject').textContent(), '75.00%');
  assert.equal(await metric('bytes').textContent(), '109 B');
  assert.match(await page.locator('.analysis-template').innerText(), /No log-status field/);
  await drill('source', "odd'address", 4);
  assert.match(await page.locator('table.docs > tbody > tr').first().innerText(), /bytes: 100 B/);
  await search();
  await drill('port', '— / —', 4);
  await open({ ...cfg, timeField: '' });
  assert.match(await page.locator('.analysis-template').innerText(), /analyzing all matching records/);
  console.log('ok VPC: collapse/refresh, Parquet, OTel, restore, custom fields, numeric sorting and invalid ports');

  await open(cfg);
  await page.setViewportSize({ width: 1000, height: 900 });
  await settled(page);
  assert.equal(
    await page.locator('.analysis-template').evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  if (process.env.DDV_VPC_SCREENSHOT) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.lang-select').selectOption('ja');
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await settled(page);
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page.screenshot({ path: new URL('../release/e2e/vpc-flow-analysis.png', import.meta.url).pathname });
  }
  await page.locator('.src-select').selectOption('demo');
  await settled(page);
  assert.equal(await page.locator('.analysis-template').count(), 0);
  assert.deepEqual(errors, []);
  console.log('ok VPC: responsive layout, source switch and no browser errors');
} catch (error) {
  if (page) {
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page
      .screenshot({ path: new URL('../release/e2e/vpc-flow-analysis-failure.png', import.meta.url).pathname })
      .catch(() => undefined);
    console.log((await page.locator('.analysis-template').allTextContents()).join('\n'));
  }
  throw error;
} finally {
  await context?.close();
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
