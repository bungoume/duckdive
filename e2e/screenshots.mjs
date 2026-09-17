// Chrome Web Store screenshots (1280×800) of the extension on the built-in demo dataset.
//   pnpm run build && pnpm run screenshots        → release/screenshots/*.png
import { mkdirSync } from 'node:fs';
import { launchExtension, waitReady } from './ext-context.mjs';

const out = process.env.OUT ?? new URL('../release/screenshots', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const { context, page, appUrl } = await launchExtension();
await page.setViewportSize({ width: 1280, height: 800 });

const settled = async () => {
  await page.waitForFunction(() => !document.querySelector('.loading-bar'), null, { timeout: 120000 });
  await page.waitForTimeout(600);
};
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: 1280, height: 800 } });
  console.log(`wrote ${out}/${name}.png`);
};

try {
  await page.goto(appUrl);
  await waitReady(page);
  await page.waitForSelector('.hits .n', { timeout: 120000 });
  await settled();

  // 1. Discover with a query and a couple of selected columns.
  await page.fill('.qinput input', 'level:(error OR warn) AND http.method:GET');
  await page.press('.qinput input', 'Enter');
  await settled();
  for (const f of ['http.method', 'http.status', 'message']) {
    const item = page.locator('.sidebar .field-item', { has: page.locator(`.name[title^="${f} "]`) }).first();
    if (await item.count()) await item.hover();
    const act = item.locator('button.act');
    if ((await act.count()) && (await act.textContent()) === 'add') await act.click();
  }
  await settled();
  await shot('01-discover');

  // 2. Visualize: date histogram broken down by a field.
  await page.fill('.qinput input', '');
  await page.press('.qinput input', 'Enter');
  await settled();
  await page.click('.header nav button:has-text("Visualize")');
  await page.waitForSelector('.visualize');
  await settled();
  await page.selectOption('.cfg-section:has-text("Break down by") select', 'http.status');
  await page.waitForTimeout(2000);
  await settled();
  await shot('02-visualize');

  // 3. Data source page.
  await page.click('.header nav button:has-text("Data source")');
  await page.waitForSelector('.source-page');
  await page.waitForTimeout(400);
  await shot('03-data-source');
} finally {
  await context.close();
}
