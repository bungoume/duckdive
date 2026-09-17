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
  // onInstalled opens the app tab: wait for it and reuse it, because a second one would start a
  // second DuckDB and the cache would hand this tab a read-only copy. On a slow machine a fixed
  // wait ran out and the tab opened late, behind the one the test had made for itself.
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    page = context.pages().find((p) => p.url().startsWith(appUrl));
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  for (const p of context.pages()) if (p !== page) await p.close().catch(() => undefined);
  if (!page) page = await context.newPage();
  return { context, page, extId, appUrl, userDataDir };
}

/** Wait until DuckDB is ready inside the app page. */
export async function waitReady(page, timeout = 120000) {
  await page.waitForFunction(() => window.__ddv && window.__ddv.query, null, { timeout });
}

/**
 * Wait until the app has finished whatever the last action started. The app is busy while a page
 * shows its loading bar, a query runs inside DuckDB or a connect is in progress (the latter two
 * are exposed on window.__ddv by the e2e build). A click or Enter starts its query on the next
 * render, so the app is first given a moment to become busy; an action that starts nothing (a
 * compile error, a no-op) just passes after that grace period. A range or filter change also
 * re-resolves the file list after a 250 ms debounce, so a short idle period must be confirmed
 * before returning. Functions, not strings: the extension page's CSP forbids evaluating source.
 */
export async function settled(page, timeout = 120000) {
  const busy = () => !!document.querySelector('.loading-bar') || (window.__ddv?.queriesRunning?.() ?? 0) > 0 || !!window.__ddv?.attaching;
  const idle = () => !document.querySelector('.loading-bar') && (window.__ddv?.queriesRunning?.() ?? 0) === 0 && !window.__ddv?.attaching;
  const t0 = Date.now();
  await page.waitForFunction(busy, null, { timeout: 1500 }).catch(() => undefined);
  for (;;) {
    await page.waitForFunction(idle, null, { timeout: Math.max(1, timeout - (Date.now() - t0)) });
    const resumed = await page.waitForFunction(busy, null, { timeout: 600 }).then(
      () => true,
      () => false,
    );
    if (!resumed) return;
  }
}
