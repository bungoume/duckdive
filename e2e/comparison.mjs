// Date-partition comparison regression, using CSV fixtures (no DuckDB CLI required).
// Build with pnpm run build:e2e, then node e2e/comparison.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchExtension, settled } from './ext-context.mjs';

const fixtures = mkdtempSync(join(tmpdir(), 'ddv-comparison-'));
for (const day of [21, 22, 23]) {
  const dir = join(fixtures, `2026/09/${day}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'logs.csv'), `ts,value\n2026-09-${day}T12:00:00Z,${day}\n`);
}
const server = spawn(process.execPath, [new URL('./range-server.mjs', import.meta.url).pathname, fixtures, '0'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let context;
try {
  // range-server's startup line includes the actual port when 0 asks for an unused one.
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (data) => {
      const m = /localhost:(\d+)/.exec(String(data));
      if (m) resolve(Number(m[1]));
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`range server exited: ${code}`)));
  });
  const app = await launchExtension();
  context = app.context;
  const { page, appUrl } = app;
  const state = {
    search: { query: '', range: { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' }, filters: [] },
    vis: { chart: 'line', x: { kind: 'date_histogram', interval: '1h' }, compare: false },
  };
  await page.addInitScript(
    ({ port, state }) => {
      localStorage.setItem(
        'ddv.source',
        JSON.stringify({
          kind: 'url',
          name: 'daily CSV',
          urls: `http://localhost:${port}/{yyyy}/{MM}/{dd}/logs.csv`,
          authMode: 'none',
          format: 'csv',
          timeField: 'ts',
        }),
      );
      localStorage.setItem(
        'ddv.savedVis',
        JSON.stringify([
          {
            id: 'previous-day',
            title: 'Previous day',
            savedAt: '',
            search: state.search,
            vis: { ...state.vis, compare: true },
            pinned: false,
          },
        ]),
      );
    },
    { port, state },
  );
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(m.text());
  });
  await page.goto(`${appUrl}?comparison=1#/visualize?s=${Buffer.from(JSON.stringify(state)).toString('base64url')}`);
  const files = async (n) => {
    console.log(`waiting for ${n} files`);
    await page.waitForFunction(
      (n) => window.__ddv?.attached?.files.length === n && !window.__ddv.attaching && !window.__ddv.resolvePending,
      n,
      { timeout: 30000 },
    );
    await settled(page);
    console.log(`ok ${n} files`);
  };
  await files(2);
  await page.getByLabel('Compare with the previous period').check();
  await files(3);
  const previous = await page.evaluate(() =>
    window.__ddv.query("SELECT value FROM src WHERE ts < TIMESTAMP '2026-09-22'"),
  );
  assert.equal(previous.rows[0]?.value, 21);
  await page.getByLabel('Compare with the previous period').uncheck();
  await files(2);
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Add visualization', exact: true }).click();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await files(3);
  assert.equal(await page.locator('.tile .legend-note').count(), 1);
  await page.locator('.tile button[aria-label="Remove from dashboard"]').click();
  await files(2);
  console.log('ok comparison: toggle, pinned tile, prior-period rows, removal');
} catch (error) {
  if (context) console.log(await context.pages()[0]?.locator('body').innerText());
  throw error;
} finally {
  await context?.close();
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
