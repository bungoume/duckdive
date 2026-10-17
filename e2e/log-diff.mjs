// Real DuckDB-Wasm queries, date-partition coverage, and exact drill-down membership.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchExtension, settled } from './ext-context.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'ddv-log-diff-'));
const records = { 21: [], 22: [], 23: [] };
const add = (day, message, url, level = 'error', count = 1, time = '12:00:00') => {
  for (let i = 0; i < count; i++) records[day].push([`2026-09-${day}T${time}Z`, message, url, level]);
};
add(21, 'existing error 10', '/existing', 'error', 2);
add(22, 'existing error 99', '/existing', 'error', 5);
add(22, "user's timeout 42", '/new', 'error', 3);
add(21, 'old failure', '/gone', 'error', 4);
add(21, 'boundary error', '/boundary', 'error', 1);
add(22, 'boundary error', '/boundary', 'error', 1, '00:00:00');
add(23, 'end error', '/end', 'error', 1, '00:00:00');
add(23, 'outside error', '/outside', 'error', 1, '00:00:01');
add(21, 'rare error', '/rare', 'error', 1);
add(22, 'rare error', '/rare', 'error', 2);
add(22, 'literal error <n>', '/literal');
add(22, 'literal error 123', '/literal');
// More than 50 groups in the baseline, including many larger than the rare group.
for (let i = 0; i < 60; i++) {
  const suffix = String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26));
  add(21, `background error ${suffix}`, `/background/${suffix}`, 'error', 2);
}
add(21, 'ok', 'https://a.example/hot?item=1', 'info', 2);
add(22, 'ok', 'https://a.example/hot?item=2#part', 'info', 4);
add(22, 'ok', 'GET https://b.example/hot?item=3 HTTP/1.1', 'info', 4);
add(22, 'informational timeout', '/success', 'info', 2);
add(22, '', '/empty', 'error');
for (const [day, rows] of Object.entries(records)) {
  const dir = join(fixtures, `2026/09/${day}`);
  mkdirSync(dir, { recursive: true });
  const csv = (v) => `"${String(v).replaceAll('"', '""')}"`;
  writeFileSync(
    join(dir, 'logs.csv'),
    'ts,message,url,level\n' + rows.map((r) => r.map(csv).join(',')).join('\n') + '\n',
  );
}
const server = spawn(process.execPath, [new URL('./range-server.mjs', import.meta.url).pathname, fixtures, '0'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let context;
let page;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (data) => {
      const match = /localhost:(\d+)/.exec(String(data));
      if (match) resolve(Number(match[1]));
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`range server exited: ${code}`)));
  });
  const app = await launchExtension();
  context = app.context;
  page = app.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((port) => {
    localStorage.setItem(
      'ddv.source',
      JSON.stringify({
        kind: 'url',
        name: 'Difference fixtures',
        urls: `http://localhost:${port}/{yyyy}/{MM}/{dd}/logs.csv`,
        authMode: 'none',
        format: 'csv',
        timeField: 'ts',
      }),
    );
  }, port);
  const search = { query: '', range: { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' }, filters: [] };
  const open = async (diff = undefined, selectedSearch = search) => {
    const state = { search: selectedSearch, discover: { diff } };
    await page.goto(`${app.appUrl}?log-diff=1#/discover?s=${Buffer.from(JSON.stringify(state)).toString('base64url')}`);
    await settled(page);
  };
  const tableRows = () => page.locator('.diff-table tbody tr');
  const row = (value) => tableRows().filter({ has: page.locator('.diff-value > .mono', { hasText: value }) });
  const counts = async (value) => {
    const cells = await row(value).locator('td').allTextContents();
    return { previous: Number(cells[2]), current: Number(cells[3]), badge: cells[0], growth: cells[5] };
  };
  const diff = { mode: 'patterns', field: 'message', errorsOnly: true, newOnly: false };
  await open();
  await page.getByRole('button', { name: 'Difference analysis', exact: true }).click();
  await settled(page);
  assert.equal(await page.evaluate(() => window.__ddv.attached.files.length), 3);
  assert.deepEqual(await counts('existing error <n>'), {
    previous: 2,
    current: 5,
    badge: 'Increased',
    growth: '+150.0%',
  });
  assert.deepEqual(await counts("user's timeout <n>"), { previous: 0, current: 3, badge: 'New', growth: '—' });
  assert.deepEqual(await counts('rare error'), { previous: 1, current: 2, badge: 'Increased', growth: '+100.0%' });
  assert.equal(await row('boundary error').count(), 0); // Shared boundary is counted only once.
  assert.equal(await row('outside error').count(), 0);
  assert.equal(await row('end error').count(), 1); // Matches Discover's inclusive end.
  assert.equal(await row('informational timeout').count(), 0); // Explicit severity takes precedence.
  assert.equal(await row('old failure').count(), 0);
  await page.getByLabel('New only', { exact: true }).check();
  await settled(page);
  assert.equal(await row('rare error').count(), 0);
  assert.equal(await row("user's timeout <n>").count(), 1);
  // Literal placeholders and apostrophes must have the same membership in the table and drill-down.
  await row('literal error <n>').getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('.diff-panel').count(), 0);
  assert.equal(await page.locator('table.docs > tbody > tr').count(), 2);
  assert.equal(await page.locator('.hits .n').textContent(), '2');
  await open(diff);
  await row("user's timeout <n>").getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('table.docs > tbody > tr').count(), 3);
  assert.equal(await page.locator('.hits .n').textContent(), '3');
  await open(diff);
  await page.getByLabel('Compare by', { exact: true }).selectOption('urls');
  await settled(page);
  assert.deepEqual(await counts('/hot'), { previous: 2, current: 8, badge: 'Increased', growth: '+300.0%' });
  await row('/hot').getByRole('button', { name: 'View logs', exact: true }).click();
  await settled(page);
  assert.equal(await page.locator('table.docs > tbody > tr').count(), 8);
  assert.equal(await page.locator('.hits .n').textContent(), '8');
  // Existing search conditions apply to both sides, and a missing baseline is explicitly explained.
  await open(diff, { ...search, query: 'message:"user\'s timeout"' });
  assert.equal(await tableRows().count(), 1);
  assert.match(await page.locator('.diff-panel .alert.warn').innerText(), /No matching logs in the previous period/);
  await open(diff, { ...search, query: 'message:"boundary error"' });
  assert.equal(await tableRows().count(), 0);
  assert.match(await page.locator('.diff-panel').innerText(), /No new or increasing values/);
  await open({ ...diff, mode: 'urls', field: 'url', errorsOnly: false });
  const saved = await page.evaluate(() =>
    JSON.parse(atob(location.hash.split('s=')[1].replaceAll('-', '+').replaceAll('_', '/'))),
  );
  assert.equal(saved.discover.diff.mode, 'urls');
  await page.reload();
  await settled(page);
  assert.equal(await page.getByLabel('Compare by', { exact: true }).inputValue(), 'urls');
  assert.equal((await counts('/hot')).current, 8);
  if (process.env.DDV_DIFF_SCREENSHOT) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.lang-select').selectOption('ja');
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await settled(page);
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page.screenshot({ path: new URL('../release/e2e/log-diff.png', import.meta.url).pathname });
  }
  assert.deepEqual(errors, []);
  console.log(
    'ok difference analysis: partitions, new/increased groups, full baseline, boundaries, errors, URLs, drill-down, restore',
  );
} catch (error) {
  if (page) {
    mkdirSync(new URL('../release/e2e/', import.meta.url), { recursive: true });
    await page
      .screenshot({ path: new URL('../release/e2e/log-diff-failure.png', import.meta.url).pathname })
      .catch(() => undefined);
    console.log(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await context?.close();
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
