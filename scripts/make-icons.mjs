// Render assets/logo.svg into the extension icons (public/icons, committed) and the
// Chrome Web Store images (release/store). Uses the Chromium that Playwright installs
// for the e2e tests, so this is a dev-time step: `npm run icons`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const svg = readFileSync(`${root}assets/logo.svg`, 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
mkdirSync(`${root}public/icons`, { recursive: true });
mkdirSync(`${root}release/store`, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
try {
  // Extension icons: transparent background, exact pixel sizes.
  for (const s of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${s}px;height:${s}px}</style><img src="${dataUrl}">`);
    writeFileSync(`${root}public/icons/icon-${s}.png`, await page.screenshot({ omitBackground: true }));
  }
  // Store listing icon (128×128, same image) and the small promo tile (440×280).
  writeFileSync(`${root}release/store/icon-128.png`, readFileSync(`${root}public/icons/icon-128.png`));
  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(`<style>
    html,body{margin:0}
    body{width:440px;height:280px;display:flex;align-items:center;justify-content:center;gap:26px;background:linear-gradient(135deg,#0f2a5c,#1b4fb0);font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#fff}
    img{width:120px;height:120px;filter:drop-shadow(0 6px 16px rgba(0,0,0,.35))}
    h1{margin:0;font-size:44px;font-weight:700;letter-spacing:-0.5px}
    p{margin:6px 0 0;font-size:15px;opacity:.85}
  </style><img src="${dataUrl}"><div><h1>Duckdive</h1><p>Search &amp; visualize S3 logs<br>in your browser</p></div>`);
  writeFileSync(`${root}release/store/promo-tile-440x280.png`, await page.screenshot());
  // Marquee promo tile (1400×560): optional, only shown when the store features the extension.
  await page.setViewportSize({ width: 1400, height: 560 });
  await page.setContent(`<style>
    html,body{margin:0}
    body{width:1400px;height:560px;display:flex;align-items:center;justify-content:center;gap:72px;background:linear-gradient(135deg,#0f2a5c,#1b4fb0);font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#fff}
    img{width:280px;height:280px;filter:drop-shadow(0 12px 32px rgba(0,0,0,.35))}
    h1{margin:0;font-size:96px;font-weight:700;letter-spacing:-1.5px}
    p{margin:14px 0 0;font-size:34px;opacity:.88;line-height:1.3}
    small{display:block;margin-top:22px;font-size:22px;opacity:.7}
  </style><img src="${dataUrl}"><div><h1>Duckdive</h1><p>Search &amp; visualize S3 logs<br>in your browser</p><small>Lucene search · charts · DuckDB-Wasm · no server</small></div>`);
  writeFileSync(`${root}release/store/promo-marquee-1400x560.png`, await page.screenshot());
} finally {
  await browser.close();
}
console.log('icons written to public/icons, store images to release/store');
