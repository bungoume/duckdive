// Smoke test of the extension UI (Discover / Visualize) on the demo dataset.
//   pnpm run build && node e2e/smoke.mjs
import { launchExtension, settled } from './ext-context.mjs';

const out = process.env.OUT ?? '.';
const { context, page, appUrl } = await launchExtension();
const base = appUrl;
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

let failed = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `${out}/fail-${name}.png` });
  }
};

await step('load', async () => {
  await page.goto(base);
  await page.waitForSelector('.hits .n', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('.hits .n')?.textContent?.includes('…'), null, { timeout: 120000 });
});
await step('discover-initial', async () => {
  const hits = await page.textContent('.hits .n');
  const rows = await page.locator('table.docs tbody tr').count();
  const bars = await page.locator('.chart-panel svg rect').count();
  console.log(`     hits=${hits} rows=${rows} bars=${bars}`);
  if (!rows) throw new Error('no rows');
  await page.screenshot({ path: `${out}/01-discover.png` });
});
await step('search-query', async () => {
  await page.fill('.qinput input', 'http.status:>=500 AND geo.country:JP AND NOT host.name:web-1');
  await page.press('.qinput input', 'Enter');
  await settled(page);
  const hits = await page.textContent('.hits .n');
  const err = await page.locator('.qerror').count();
  console.log(`     hits=${hits} errors=${err}`);
  if (err) throw new Error('query error: ' + (await page.textContent('.qerror')));
  await page.screenshot({ path: `${out}/02-search.png` });
});
await step('free-text', async () => {
  await page.fill('.qinput input', '"connection failure" OR extra.ab_test:variant-a');
  await page.press('.qinput input', 'Enter');
  await settled(page);
  const hits = await page.textContent('.hits .n');
  const err = await page.locator('.qerror').count();
  console.log(`     hits=${hits} errors=${err}`);
  if (err) throw new Error('query error: ' + (await page.textContent('.qerror')));
});
await step('search-matrix', async () => {
  const cases = [
    'error',
    'error timeout',
    'http.status:503',
    'http.status:(500 OR 503)',
    'http.method:GET AND NOT geo.country:JP',
    'host.name:web-*',
    'http.bytes:[1000 TO 5000]',
    'http.bytes:{1000 TO 5000}',
    'http.latency_ms:>800',
    'http.latency_ms:>=800 AND http.latency_ms:<2000',
    'extra.user_id:*',
    'extra.premium:true',
    '-extra.ab_test:control',
    'tags:alert',
    'message:"route not found"',
    '@timestamp:>="2026-01-01"',
    '(level:error OR level:warn) AND geo.country:(JP OR US)',
    'user_agent:curl*',
    'host.name:web-?',
    'message:/route.*found/',
    'error AND !timeout',
    '+level:error -geo.country:JP',
    '"route not found"~2',
    '_exists_:extra.user_id',
  ];
  const bad = ['http.status:', 'level:(error', 'nosuchfield:1', '"unterminated', 'AND level:error', '()'];
  for (const q of cases) {
    await page.fill('.qinput input', q);
    await page.press('.qinput input', 'Enter');
    await settled(page);
    const err = await page.locator('.qerror').count();
    const hits = await page.textContent('.hits .n');
    console.log(`     ${err ? 'ERR ' : 'ok  '} ${q.padEnd(56)} hits=${hits}`);
    if (err) throw new Error(`${q}: ${await page.textContent('.qerror')}`);
  }
  for (const q of bad) {
    await page.fill('.qinput input', q);
    await page.press('.qinput input', 'Enter');
    await settled(page);
    const err = await page.locator('.qerror').count();
    console.log(`     ${err ? 'ok  ' : 'MISS'} (expect error) ${q.padEnd(40)} ${err ? (await page.textContent('.qerror')).slice(0, 60) : ''}`);
    if (!err) throw new Error(`expected error for ${q}`);
  }
  await page.fill('.qinput input', '"connection failure" OR extra.ab_test:variant-a');
  await page.press('.qinput input', 'Enter');
  await settled(page);
});
await step('expand-doc', async () => {
  await page.click('table.docs tbody tr:first-child td.expand button');
  await page.waitForSelector('.doc-detail');
  await page.click('.doc-detail .tabs button:nth-child(2)');
  const json = await page.textContent('.doc-detail pre');
  console.log(`     json length=${json.length}`);
  await page.screenshot({ path: `${out}/03-doc.png` });
  await page.click('.doc-detail .tabs button:nth-child(1)');
  // add filter "+" on the level row
  const row = page.locator('table.kv tr', { hasText: 'level' }).first();
  await row.hover();
  await row.locator('td.a button').first().click();
  await settled(page);
  const pills = await page.locator('.pill').count();
  console.log(`     pills=${pills} hits=${await page.textContent('.hits .n')}`);
  if (!pills) throw new Error('no filter pill');
});
await step('field-sidebar', async () => {
  await page.click('.field-item:has-text("http.method")');
  await page.waitForSelector('.topval', { timeout: 10000 });
  const n = await page.locator('.topval').count();
  console.log(`     topvalues=${n}`);
  await page.screenshot({ path: `${out}/04-field.png` });
  await page.click('.field-item:has-text("http.method") .act');
  await settled(page);
  const th = await page.locator('table.docs th').allTextContents();
  console.log(`     columns=${th.join('|')}`);
});
await step('brush', async () => {
  const dbg = await page.evaluate(() => {
    const svg = document.querySelector('.chart-panel svg');
    const sc = svg && svg.scale ? svg.scale('x') : null;
    return { hasScale: !!sc, hasInvert: !!(sc && sc.invert), tag: svg && svg.parentElement.className };
  });
  console.log('     ' + JSON.stringify(dbg));
  const box = await page.locator('.chart-panel .chart-box').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await settled(page);
  const label = await page.textContent('.timepicker .btn');
  console.log(`     range=${label}`);
});
await step('visualize', async () => {
  await page.click('.header nav button:has-text("Visualize")');
  await page.waitForSelector('.visualize');
  await settled(page);
  const paths = await page.locator('.vis-panel svg path').count();
  const cerr = await page.locator('.chart-error').count();
  console.log(`     svg paths=${paths} chartErrors=${cerr}` + (cerr ? ' ' + (await page.textContent('.chart-error')) : ''));
  await page.screenshot({ path: `${out}/05-visualize.png` });
  // breakdown by http.status
  await page.selectOption('.cfg-section:has-text("Break down by") select', 'http.status');
  await settled(page);
  await page.screenshot({ path: `${out}/06-visualize-breakdown.png` });
  // hover shows key / value; click filters by the breakdown value under the cursor
  const cbox = await page.locator('.vis-panel .chart-box').boundingBox();
  // find a spot inside a band: scan a few heights in the middle of the plot
  let tip = '';
  for (const f of [0.85, 0.8, 0.75, 0.7, 0.6, 0.5]) {
    await page.mouse.move(cbox.x + cbox.width * 0.5, cbox.y + cbox.height * f);
    await settled(page);
    tip = await page
      .locator('.chart-tip')
      .textContent()
      .catch(() => '');
    if (/click to filter/.test(tip)) break;
  }
  console.log(`     tooltip: ${tip.replace(/\s+/g, ' ').slice(0, 100)}`);
  if (!/click to filter/.test(tip)) throw new Error('no tooltip with filter hint: ' + tip);
  await page.mouse.down();
  await page.mouse.up();
  await settled(page);
  const pills = await page.locator('.filterbar .pill').allTextContents();
  console.log(`     pills after click: ${pills.join(' | ')}`);
  if (!pills.some((t) => /http\.status: \d+/.test(t))) throw new Error('click did not add a breakdown filter');
  await page.click('.filterbar .pill button[title="Remove"]');
  await settled(page);
  // no tooltip over empty space (top-left corner of the plot area, above every band)
  await page.mouse.move(cbox.x + cbox.width * 0.5, cbox.y + 30);
  await settled(page);
  if (await page.locator('.chart-tip').count()) throw new Error('tooltip shown over empty space');
  // Back restores the previous search state (filters / time range)
  const rangeBefore = await page.textContent('.timepicker .btn');
  await page.click('.timepicker .btn');
  await page.click('.quick-grid button:has-text("Last 24 hours")');
  await settled(page);
  const rangeAfter = await page.textContent('.timepicker .btn');
  await page.goBack();
  await settled(page);
  const rangeBack = await page.textContent('.timepicker .btn');
  console.log(`     history: ${rangeBefore.trim()} -> ${rangeAfter.trim()} -> back: ${rangeBack.trim()}`);
  if (rangeAfter === rangeBefore || rangeBack !== rangeBefore) throw new Error('Back did not restore the previous time range');
  // add avg latency metric
  await page.click('.cfg-section:has-text("Vertical axis") .head button');
  await settled(page);
  const metricSections = page.locator('.cfg-section:has-text("Vertical axis") .cfg-section');
  const last = metricSections.last();
  await last.locator('select').first().selectOption('avg');
  await last.locator('select').nth(1).selectOption('http.latency_ms');
  await settled(page);
  // switch to table
  await page.click('.chart-types button[title="Table"]');
  await settled(page);
  const rows = await page.locator('table.data tbody tr').count();
  const heads = await page.locator('table.data th').allTextContents();
  console.log(`     table rows=${rows} heads=${heads.join('|')}`);
  await page.screenshot({ path: `${out}/07-table.png` });
  // top values x
  await page.click('.chart-types button[title="Bar"]');
  await page.selectOption('.cfg-section:has-text("Horizontal axis") .field-row:has-text("Function") select', 'terms');
  await settled(page);
  await page.selectOption('.cfg-section:has-text("Horizontal axis") .field-row:has-text("Field") select', 'http.path');
  await settled(page);
  const bars = await page.locator('.vis-panel svg rect').count();
  console.log(`     terms bars=${bars}`);
  await settled(page);
  await page.screenshot({ path: `${out}/08-terms-bar.png` });
  await page.click('.chart-types button[title="Metric"]');
  await settled(page);
  await page.screenshot({ path: `${out}/09-metric.png` });
  const sqlErr = await page.locator('.qerror').count();
  if (sqlErr) throw new Error(await page.textContent('.qerror'));
});
await step('source-page', async () => {
  await page.click('.header nav button:has-text("Data source")');
  await page.waitForSelector('.source-page');
  await page.screenshot({ path: `${out}/10-source.png` });
});

console.log('\nconsole errors/warnings:');
for (const e of errors.filter((x) => !x.includes('Improper nesting')).slice(0, 20)) console.log('  ' + e.slice(0, 400));
await context.close();
if (failed) console.log(`\n${failed} step(s) failed`);
process.exit(failed ? 1 : 0);
