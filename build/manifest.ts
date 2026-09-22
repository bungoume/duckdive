export const BROWSER_TARGETS = ['chrome', 'firefox', 'edge'] as const;
export type BrowserTarget = (typeof BROWSER_TARGETS)[number];

// Public key of the Chrome Web Store item. Keeping it in unpacked Chrome builds gives them the
// production extension ID and therefore the same OIDC redirect URL. Other stores assign their own
// IDs, and scripts/pack.mjs removes this before uploading to the Chrome Web Store as well.
const CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArgh8WQbJmwPI8reODpywYBayQ/Z1Bxs3eJsiBOqQR8Kx2s9VdD29Az/3J4d4xaEy+J/Yh3+lYMguCaQmuMJpcqnOYeAtUBV2MX+kUnFb41kCDcma2JVggcFOEpS+0PIN7fmvXDfohHZa4APBAmDAtMKRgA+hOpkpNl6fTMTLl4jEU6hnV/+csswNSJ5g32XP3JSJHuGnVaMbTtIVYjrgWeE6A4aJ7pXKdDNvbyIvnIun6zMrjqJDOjhgJYOGUKXqutm0ZDt0DG+zuQAQz2Ewp1QM7noRQ/jkZwEL2G6/l91Hs6hANFyM1rBnCd6SP8QZEDbdwz31NAM14LQ5oUhxxQIDAQAB'; // gitleaks:allow - a public key, not a secret

export function parseBrowserTarget(value: string | undefined): BrowserTarget {
  const target = value || 'chrome';
  if ((BROWSER_TARGETS as readonly string[]).includes(target)) return target as BrowserTarget;
  throw new Error(`DDV_BROWSER must be one of ${BROWSER_TARGETS.join(', ')}; got ${JSON.stringify(target)}`);
}

export function outputDir(target: BrowserTarget): string {
  return `dist/${target}`;
}

export function extensionManifest(target: BrowserTarget, version: string, extraHosts: string[] = []) {
  const common = {
    manifest_version: 3,
    name: '__MSG_appName__',
    version,
    description: '__MSG_appDesc__',
    default_locale: 'en',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    permissions: ['storage', 'identity', 'unlimitedStorage'],
    host_permissions: ['https://*.amazonaws.com/*', ...extraHosts],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  };

  if (target === 'firefox') {
    return {
      ...common,
      // Firefox MV3 uses an event page; background.service_worker is not supported.
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: {
          id: 'duckdive@bungoume',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    };
  }

  return {
    ...common,
    minimum_chrome_version: '116',
    background: { service_worker: 'background.js', type: 'module' },
    // Microsoft Edge assigns a separate store ID, so its build must not inherit Chrome's key.
    ...(target === 'chrome' ? { key: CHROME_KEY } : {}),
  };
}
