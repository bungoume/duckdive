// Smoke test of the extension UI (Discover / Visualize) on the demo dataset.
//   pnpm run build && node e2e/smoke.mjs
import { readFileSync } from 'node:fs';
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
/** the Parquet file made by the export step; the local-source step reads it back */
let exportedParquet = null;
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
await step('summary-filter', async () => {
  // hovering a value of a collapsed row reveals +/−: "+" filters by it
  const first = page.locator('table.docs tbody tr').first().locator('.source-summary .sv').first();
  await first.hover();
  const key = (await first.locator('.k').textContent()).trim();
  await first.locator('.pm button').first().click();
  await settled(page);
  const pills = await page.locator('.filterbar .pill').allTextContents();
  console.log(`     ${key} -> pill ${pills[0]?.trim()}`);
  if (!pills.length || !pills[0].startsWith(key.replace(/:$/, ''))) throw new Error('summary value did not filter');
  await page.click('.filterbar .pill button[title="Remove"]');
  await settled(page);
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
await step('completion', async () => {
  // field names are suggested for the token at the caret; Tab inserts "name:"; an empty box lists recent queries
  await page.fill('.qinput input', '');
  await page.type('.qinput input', 'http.la');
  await page.waitForSelector('.qinput .suggest .item');
  const items = await page.locator('.qinput .suggest .item').allTextContents();
  await page.keyboard.press('Tab');
  const text = await page.inputValue('.qinput input');
  console.log(`     suggested=${items.join('|')} after Tab="${text}"`);
  if (text !== 'http.latency_ms:') throw new Error('completion did not insert the field');
  await page.type('.qinput input', '>800');
  await page.keyboard.press('Enter');
  await settled(page);
  if (await page.locator('.qerror').count()) throw new Error(await page.textContent('.qerror'));
  await page.fill('.qinput input', '');
  await page.click('.qinput input');
  await page.waitForSelector('.qinput .suggest .item');
  const hist = await page.locator('.qinput .suggest .item').allTextContents();
  console.log(`     history=${hist.map((h) => h.trim()).join('|')}`);
  if (!hist.some((h) => h.includes('http.latency_ms:>800'))) throw new Error('history misses the last query');
  await page.keyboard.press('Escape');
  // date math in a range of the time field
  await page.fill('.qinput input', '@timestamp:>now-1h');
  await page.press('.qinput input', 'Enter');
  await settled(page);
  const hits = await page.textContent('.hits .n');
  console.log(`     @timestamp:>now-1h hits=${hits}`);
  if (await page.locator('.qerror').count()) throw new Error(await page.textContent('.qerror'));
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
  const copyBtn = await page.locator('.doc-detail .json-view .copy').count();
  console.log(`     json length=${json.length} copy button=${copyBtn}`);
  await page.screenshot({ path: `${out}/03-doc.png` });
  // the Context tab shows neighbours in time and grows on request
  await page.click('.doc-detail .tabs button:has-text("Context")');
  await page.waitForSelector('.context-view table', { timeout: 30000 });
  const ctx1 = await page.locator('.context-view tbody tr').count();
  // the first row is the newest of the range: only "more before" can grow the list
  await page.locator('.context-view button').first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.context-view tbody tr').length > n, ctx1, { timeout: 30000 });
  const ctx2 = await page.locator('.context-view tbody tr').count();
  const same = await page.locator('.context-view tr.same').count();
  console.log(`     context rows ${ctx1} -> ${ctx2}, same time=${same}`);
  if (ctx1 < 6 || ctx2 <= ctx1 || !same) throw new Error('context view');
  await page.click('.doc-detail .tabs button:nth-child(1)');
  // add filter "+" on the level row
  const row = page.locator('table.kv tr', { hasText: 'level' }).first();
  await row.hover();
  await row.locator('td.a button').first().click();
  await settled(page);
  const pills = await page.locator('.pill').count();
  console.log(`     pills=${pills} hits=${await page.textContent('.hits .n')}`);
  if (!pills) throw new Error('no filter pill');
  // the first document's level is whatever the random demo data produced ("error" leaves few
  // rows for the chart steps below): drop the filter again once it has been seen to work
  await page.click('.filterbar .pill button[title="Remove"]');
  await settled(page);
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
  // a number field shows a summary and a ten-bar distribution above its top values
  await page.click('.field-item:has-text("http.latency_ms")');
  await page.waitForSelector('.stat-grid', { timeout: 10000 });
  const bars = await page.locator('.dist div').count();
  const statText = (await page.textContent('.stat-grid')).replace(/\s+/g, ' ').trim();
  console.log(`     stats: ${statText.slice(0, 80)} · bars=${bars}`);
  if (bars !== 10 || !/percentile/.test(statText)) throw new Error('no number statistics');
  await page.keyboard.press('Escape');
});
await step('histogram-breakdown', async () => {
  // split the histogram by level: stacked bars with a legend, the hit count unchanged
  const before = await page.textContent('.hits .n');
  await page.selectOption('.chart-head select[title="Break down by"]', 'level');
  await settled(page);
  const rects = await page.locator('.chart-panel .chart-box svg rect').count();
  const legend = await page.locator('.chart-panel .chart-box svg').count();
  console.log(`     hits=${before} -> ${await page.textContent('.hits .n')} rects=${rects} svgs=${legend}`);
  if (!rects || legend < 2) throw new Error('no stacked histogram');
  if ((await page.textContent('.hits .n')) !== before) throw new Error('hit count changed with the break-down');
  await page.screenshot({ path: `${out}/13-histogram-breakdown.png` });
  await page.selectOption('.chart-head select[title="Break down by"]', '');
  await settled(page);
});
await step('patterns', async () => {
  // the message field grouped by template; "+" keeps one pattern through a custom SQL filter
  await page.click('.hits button:has-text("Patterns")');
  await page.waitForSelector('.patterns-table tbody tr', { timeout: 30000 });
  const rows = await page.locator('.patterns-table tbody tr').allTextContents();
  const before = await page.textContent('.hits .n');
  console.log(`     patterns=${rows.length}: ${rows[0].replace(/\s+/g, ' ').slice(0, 90)}`);
  const row = page.locator('.patterns-table tbody tr', { hasText: '-> <n>' }).first();
  if (!(await row.count())) throw new Error('no masked pattern');
  await row.locator('button').click();
  await settled(page);
  const pills = await page.locator('.filterbar .pill').allTextContents();
  const after = await page.textContent('.hits .n');
  console.log(`     pill=${pills[0]?.slice(0, 40)} hits ${before} -> ${after}`);
  if (!pills.length || after === before) throw new Error('pattern filter did not apply');
  await page.click('.filterbar .pill button[title="Remove"]');
  await settled(page);
  await page.click('.hits button:has-text("Patterns")');
});
await step('saved-search', async () => {
  // save the current query with its column, load it back after changing the query
  await page.click('.hits button:has-text("Saved searches")');
  await page.fill('.popover input', 'smoke search');
  await page.click('.popover .btn.primary');
  const items = await page.locator('.popover .saved-list .item .t').allTextContents();
  console.log(`     saved: ${items.join('|')}`);
  if (!items.includes('smoke search')) throw new Error('search not saved');
  await page.keyboard.press('Escape');
  await page.fill('.qinput input', 'level:error');
  await page.press('.qinput input', 'Enter');
  await settled(page);
  await page.click('.hits button:has-text("Saved searches")');
  await page.click('.popover .saved-list .item .t:has-text("smoke search")');
  await settled(page);
  const q = await page.inputValue('.qinput input');
  const th = await page.locator('table.docs th').allTextContents();
  console.log(`     loaded: query=${q} columns=${th.join('|')}`);
  if (!q.includes('connection failure') || !th.some((h) => h.includes('http.method'))) throw new Error('saved search not restored');
});
await step('export', async () => {
  // the table has the http.method column from the previous step: CSV carries Time + that column
  const download = async (format, rows) => {
    await page.click('.hits button:has-text("Export")');
    await page.selectOption('.export-menu select', format);
    await page.fill('.export-menu input[type="number"]', String(rows));
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.export-menu .btn.primary')]);
    return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
  };
  const csv = await download('csv', 50);
  const lines = csv.bytes.toString('utf8').trim().split('\n');
  console.log(`     ${csv.name}: ${lines.length} lines, header=${lines[0]}`);
  if (lines.length !== 51 || lines[0] !== '@timestamp,http.method') throw new Error('unexpected CSV: ' + lines[0]);
  const pq = await download('parquet', 20);
  console.log(`     ${pq.name}: ${pq.bytes.length} bytes, magic=${pq.bytes.subarray(0, 4)}`);
  if (pq.bytes.subarray(0, 4).toString() !== 'PAR1') throw new Error('not a Parquet file');
  exportedParquet = pq.bytes;
  const jl = await download('jsonl', 3);
  const docs = jl.bytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  console.log(`     ${jl.name}: ${docs.length} docs, keys=${Object.keys(docs[0]).join(',')}`);
  if (docs.length !== 3 || !('http.method' in docs[0])) throw new Error('unexpected JSON Lines');
});
await step('auto-refresh', async () => {
  // every 10 s: the relative range is resolved again on its own (the hit bar shows the new bounds), then it is switched off
  const before = await page.textContent('.hits .meta');
  await page.selectOption('.querybar .auto-refresh', '10000');
  await page.waitForFunction((prev) => document.querySelector('.hits .meta')?.textContent !== prev, before, { timeout: 20000 });
  await settled(page);
  await page.selectOption('.querybar .auto-refresh', '0');
  console.log(`     refreshed: ${before.trim()} -> ${(await page.textContent('.hits .meta')).trim()}`);
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
  // options: 100 % stacking with a breakdown, log axis, the previous period as dashed lines, a percentile and a rate metric
  await page.click('.chart-types button[title="Bar"]');
  await settled(page);
  await page.selectOption('.cfg-section:has-text("Horizontal axis") .field-row:has-text("Function") select', 'date_histogram');
  await settled(page);
  await page.selectOption('.cfg-section:has-text("Break down by") select', 'http.method');
  await settled(page);
  await page.check('.cfg-section:has-text("Options") label:has-text("100 %") input');
  await settled(page);
  await page.check('.cfg-section:has-text("Options") label:has-text("Logarithmic") input');
  await settled(page);
  await page.check('.cfg-section:has-text("Options") label:has-text("previous period") input');
  await settled(page);
  // Plot puts constant styles on the mark's group: the previous period is a dashed group of paths
  const dashed = await page.locator('.vis-panel svg g[stroke-dasharray] path').count();
  const note = await page.locator('.legend-note', { hasText: 'Dashed' }).count();
  const optErr = (await page.locator('.chart-error').count()) + (await page.locator('.qerror').count());
  console.log(`     options: dashed paths=${dashed} note=${note} errors=${optErr}`);
  if (!dashed || !note || optErr)
    throw new Error(
      'compare / percent / log options: ' +
        ((await page
          .locator('.qerror')
          .textContent()
          .catch(() => '')) ?? ''),
    );
  await page.screenshot({ path: `${out}/14-visualize-options.png` });
  const sections = page.locator('.cfg-section:has-text("Vertical axis") .cfg-section');
  await sections.first().locator('select').first().selectOption('percentile');
  await sections.first().locator('select').nth(1).selectOption('http.latency_ms');
  await page.fill('.config .percentile', '75');
  await settled(page);
  const pctLabel = await sections.first().locator('.lbl').textContent();
  console.log(`     percentile metric: ${pctLabel.trim().slice(0, 40)}`);
  if (!/p75/.test(pctLabel)) throw new Error('percentile metric label');
  await sections.first().locator('select').first().selectOption('rate');
  await settled(page);
  if (await page.locator('.qerror').count()) throw new Error('rate metric: ' + (await page.textContent('.qerror')));
  // the chart as an SVG file
  const [svg] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.vis-panel button[title*="SVG"]')]);
  const svgText = readFileSync(await svg.path(), 'utf8');
  console.log(`     ${svg.suggestedFilename()}: ${svgText.length} chars`);
  if (!svgText.startsWith('<svg')) throw new Error('not an SVG file');
  for (const l of ['100 %', 'Logarithmic', 'previous period']) await page.uncheck(`.cfg-section:has-text("Options") label:has-text("${l}") input`);
  await sections.first().locator('select').first().selectOption('count');
  await page.selectOption('.cfg-section:has-text("Break down by") select', '');
  await page.selectOption('.cfg-section:has-text("Horizontal axis") .field-row:has-text("Function") select', 'terms');
  await page.selectOption('.cfg-section:has-text("Horizontal axis") .field-row:has-text("Field") select', 'http.path');
  await settled(page);
  // save the bar chart for the dashboard step
  await page.fill('.vis-panel input[placeholder]', 'paths by status');
  await page.click('.vis-panel button:has-text("Save")');
  const saved = await page.locator('.saved-list .item .t').allTextContents();
  console.log(`     saved visualizations: ${saved.join('|')}`);
  if (!saved.includes('paths by status')) throw new Error('visualization not saved');
});
await step('dashboard', async () => {
  await page.click('.header nav button:has-text("Dashboard")');
  await page.waitForSelector('.dashboard');
  await page.click('.dashboard button:has-text("Add visualization")');
  await page.click('.popover .menu button:has-text("paths by status")');
  await settled(page);
  const tiles = await page.locator('.tile').count();
  const bars = await page.locator('.tile svg rect').count();
  console.log(`     tiles=${tiles} bars=${bars}`);
  if (tiles !== 1 || !bars) throw new Error('tile without a chart');
  await page.screenshot({ path: `${out}/12-dashboard.png` });
  // a click on a bar filters the page
  const box = await page.locator('.tile .chart-box').boundingBox();
  let added = false;
  for (const f of [0.85, 0.75, 0.6]) {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * f);
    await settled(page);
    if (!(await page.locator('.chart-tip').count())) continue;
    await page.mouse.down();
    await page.mouse.up();
    await settled(page);
    added = (await page.locator('.filterbar .pill').count()) > 0;
    break;
  }
  console.log(`     click added a filter: ${added}`);
  if (!added) throw new Error('click on a tile did not filter');
  await page.click('.filterbar .pill button[title="Remove"]');
  await settled(page);
  await page.click('.tile button[title="Remove from dashboard"]');
  if (await page.locator('.tile').count()) throw new Error('tile not removed');
});
await step('sql-page', async () => {
  await page.click('.header nav button:has-text("SQL")');
  await page.waitForSelector('.sql-page');
  await page.fill('.sql-text', 'SELECT level, count(*) AS n FROM src GROUP BY 1 ORDER BY 2 DESC');
  await page.press('.sql-text', 'Control+Enter');
  await settled(page);
  const heads = await page.locator('.sql-result th').allTextContents();
  const rows = await page.locator('.sql-result tbody tr').count();
  console.log(`     heads=${heads.join('|')} rows=${rows}`);
  if (heads.join('|') !== 'level|n' || !rows) throw new Error('no result table');
  // the current search becomes a statement
  await page.click('.sql-page button:has-text("Current search")');
  const text = await page.inputValue('.sql-text');
  if (!/WHERE .*"@timestamp"/s.test(text)) throw new Error('current search not inserted: ' + text.slice(0, 80));
  // an error is shown, not thrown
  await page.fill('.sql-text', 'SELECT nope FROM src');
  await page.click('.sql-page button:has-text("Run")');
  await settled(page);
  const err = await page.locator('.sql-result .alert.error').count();
  console.log(`     error shown=${err}`);
  if (!err) throw new Error('no error for a bad statement');
  // the history keeps the good statement
  await page.click('.sql-page button:has-text("History")');
  const hist = await page.locator('.sql-history button').allTextContents();
  console.log(`     history=${hist.length}: ${hist[0]?.slice(0, 40)}`);
  if (!hist.some((h) => h.startsWith('SELECT level'))) throw new Error('history without the statement');
  await page.keyboard.press('Escape');
});
await step('source-page', async () => {
  await page.click('.header nav button:has-text("Data source")');
  await page.waitForSelector('.source-page');
  await page.screenshot({ path: `${out}/10-source.png` });
});
await step('local-source', async () => {
  // A Parquet file written into OPFS stands in for a picked file: its handle can be stored and
  // reopened without a permission prompt, which the pickers themselves cannot be driven to do.
  await page.click('.kinds button:has-text("Local files")');
  await page.waitForSelector('.dropzone');
  await page.evaluate(async (bytes) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle('smoke-export.parquet', { create: true });
    const w = await h.createWritable();
    await w.write(new Uint8Array(bytes));
    await w.close();
    await window.__ddv.setLocalHandles([h]);
  }, Array.from(exportedParquet));
  await page.waitForSelector('.local-selected');
  console.log(`     selected: ${(await page.textContent('.local-selected')).trim()}`);
  await page.click('.source-page button.connect');
  await settled(page);
  const status = (await page.textContent('.header .status')).trim();
  console.log(`     status: ${status}`);
  if (!/smoke-export\.parquet · 20 rows/.test(status)) throw new Error('local source not connected: ' + status);
  // it is remembered: switch to the demo data and back through the history
  await page.selectOption('.src-select', 'demo');
  await settled(page);
  const row = page.locator('.source-history tr', { hasText: 'smoke-export.parquet' });
  if (!(await row.count())) throw new Error('local source missing from the history');
  await row.locator('button:has-text("Connect")').click();
  await settled(page);
  const again = (await page.textContent('.header .status')).trim();
  console.log(`     reopened: ${again}`);
  if (!/smoke-export\.parquet · 20 rows/.test(again)) throw new Error('local source not reopened: ' + again);
});

await step('share-link', async () => {
  // still on the local source: its files cannot travel, so the link carries no source
  await page.click('.header .share');
  // (made on the Data source page: point it at Discover so the reload lands on the hit count)
  const l1 = (await page.evaluate(() => window.__ddv.shareLink())).replace('#/source?', '#/discover?');
  if (/[?&]src=/.test(l1)) throw new Error('local files in a link');
  console.log(`     button: ${(await page.textContent('.header .share')).trim()} · link ${l1.length} chars, no source`);
  const withSrc = (link, src) => link + '&src=' + Buffer.from(JSON.stringify(src)).toString('base64url');
  // a hash-only navigation would not reload the app: leave the page first
  const open = async (link) => {
    await page.goto('about:blank');
    await page.goto(link);
  };
  // a source already in the history (the demo data) is connected straight away
  await open(withSrc(l1, { kind: 'demo' }));
  await page.waitForSelector('.hits .n', { timeout: 120000 });
  await settled(page);
  const status = (await page.textContent('.header .status')).trim();
  console.log(`     demo link: ${status}`);
  if (!/demo-logs · 120,000 rows/.test(status)) throw new Error('known source not connected from the link: ' + status);
  const l2 = await page.evaluate(() => window.__ddv.shareLink());
  if (!/[?&]src=/.test(l2)) throw new Error('link carries no source');
  // an unknown source is offered with its destination, and can be ignored
  await open(withSrc(l1, { kind: 'url', urls: 'http://localhost:5299/logs.parquet', authMode: 'none' }));
  await page.waitForSelector('.link-source', { timeout: 120000 });
  const banner = (await page.textContent('.link-source')).trim().replace(/\s+/g, ' ');
  console.log(`     banner: ${banner.slice(0, 140)}`);
  if (!banner.includes('localhost:5299')) throw new Error('banner without the destination');
  await page.screenshot({ path: `${out}/11-link-source.png` });
  await page.click('.link-source button:has-text("Ignore")');
  if (await page.locator('.link-source').count()) throw new Error('banner still shown');
});

await step('shortcuts', async () => {
  // "/" focuses the search box from the page; "]" moves the time range forward by its length
  await page.click('.hits');
  await page.keyboard.press('/');
  const focused = await page.evaluate(() => document.activeElement?.closest('.qinput') !== null);
  await page.keyboard.press('Escape');
  await page.click('.hits');
  const before = (await page.textContent('.timepicker .btn')).trim();
  await page.keyboard.press(']');
  await settled(page);
  const after = (await page.textContent('.timepicker .btn')).trim();
  console.log(`     focused=${focused} range: ${before} -> ${after}`);
  if (!focused || before === after) throw new Error('shortcuts');
});
await step('theme', async () => {
  await page.click('.header nav button:has-text("Settings")');
  await page.waitForSelector('.theme-select');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.selectOption('.theme-select', 'dark');
  const dark = await bg();
  const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.screenshot({ path: `${out}/15-dark.png` });
  await page.selectOption('.theme-select', 'system');
  console.log(`     body background light=${light} dark=${dark} data-theme=${attr}`);
  if (light === dark || attr !== 'dark') throw new Error('dark theme not applied');
});
await step('backup', async () => {
  // the backup file holds the ddv.* entries; restoring it reloads the app
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.backup button:has-text("Download backup")')]);
  const path = await dl.path();
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  const keys = Object.keys(backup.items);
  console.log(`     ${dl.suggestedFilename()}: ${keys.length} entries (${keys.slice(0, 4).join(', ')} …)`);
  if (backup.app !== 'duckdive' || !keys.includes('ddv.settings') || !keys.includes('ddv.savedVis')) throw new Error('backup lacks entries');
  await page.setInputFiles('.backup-file', path);
  await page.waitForSelector('.alert.ok', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.backup .alert.ok'), null, { timeout: 30000 }); // the reload
  await page.waitForSelector('.theme-select', { timeout: 120000 });
  console.log('     restored and reloaded');
});

console.log('\nconsole errors/warnings:');
for (const e of errors.filter((x) => !x.includes('Improper nesting')).slice(0, 20)) console.log('  ' + e.slice(0, 400));
await context.close();
if (failed) console.log(`\n${failed} step(s) failed`);
process.exit(failed ? 1 : 0);
