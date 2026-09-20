import { describe, expect, it } from 'vitest';
import { extensionManifest, outputDir, parseBrowserTarget } from '../build/manifest';

describe('browser manifests', () => {
  it('builds Chrome with its stable unpacked ID', () => {
    const manifest = extensionManifest('chrome', '1.2.3');
    expect(manifest).toMatchObject({
      version: '1.2.3',
      minimum_chrome_version: '116',
      background: { service_worker: 'background.js', type: 'module' },
    });
    expect('key' in manifest).toBe(true);
    expect('browser_specific_settings' in manifest).toBe(false);
  });

  it('builds Firefox with a signed-add-on identity and event page', () => {
    const manifest = extensionManifest('firefox', '1.2.3');
    expect(manifest).toMatchObject({
      version: '1.2.3',
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: {
          id: 'duckdive@bungoume',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    });
    expect('key' in manifest).toBe(false);
    expect('minimum_chrome_version' in manifest).toBe(false);
  });

  it('builds Edge as Chromium without Chrome store identity', () => {
    const manifest = extensionManifest('edge', '1.2.3', ['http://localhost/*']);
    expect(manifest).toMatchObject({
      minimum_chrome_version: '116',
      background: { service_worker: 'background.js', type: 'module' },
      host_permissions: ['https://*.amazonaws.com/*', 'http://localhost/*'],
    });
    expect('key' in manifest).toBe(false);
  });

  it('uses one output layout and rejects unknown targets', () => {
    expect(outputDir('chrome')).toBe('dist/chrome');
    expect(outputDir('firefox')).toBe('dist/firefox');
    expect(outputDir('edge')).toBe('dist/edge');
    expect(parseBrowserTarget(undefined)).toBe('chrome');
    expect(() => parseBrowserTarget('safari')).toThrow('DDV_BROWSER');
  });
});
