// Launch Chromium with the built extension (dist/) loaded and open the app page.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchExtension({ dist = new URL('../dist', import.meta.url).pathname, headless = true } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'ddv-ext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  // The UI follows Chrome's language; the tests assert English text, so pin the choice the
  // app reads at startup (DDV_LANG=ja etc. switches it, e.g. for screenshots).
  const lang = process.env.DDV_LANG || 'en';
  await context.addInitScript((l) => {
    try {
      localStorage.setItem('ddv.lang', l);
    } catch {
      /* ignore */
    }
  }, lang);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  const appUrl = `chrome-extension://${extId}/index.html`;
  // onInstalled opens the app tab; wait briefly for it and reuse it so only one DuckDB runs.
  await new Promise((r) => setTimeout(r, 800));
  let page = context.pages().find((p) => p.url().startsWith(appUrl));
  for (const p of context.pages()) if (p !== page) await p.close().catch(() => undefined);
  if (!page) page = await context.newPage();
  return { context, page, extId, appUrl, userDataDir };
}

/** Wait until DuckDB is ready inside the app page. */
export async function waitReady(page, timeout = 120000) {
  await page.waitForFunction(() => window.__ddv && window.__ddv.query, null, { timeout });
}
