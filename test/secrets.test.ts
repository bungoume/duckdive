import { beforeEach, describe, expect, it } from 'vitest';
import { forgetSecrets, storeSecrets, withSecrets } from '../src/secrets';
import { DEFAULT_SOURCE, sourceKey } from '../src/state';

const cfg = { ...DEFAULT_SOURCE, kind: 'url' as const, urls: 's3://b/x', authMode: 'static' as const, s3: { ...DEFAULT_SOURCE.s3, accessKeyId: 'AKIA', secretAccessKey: 'shh', sessionToken: 'tok' } };
const bare = { ...cfg, s3: { ...cfg.s3, secretAccessKey: '', sessionToken: '' } };

describe('session-only secrets', () => {
  beforeEach(() => sessionStorage.clear());

  it('fills a stripped configuration back in for the same source and key ID', async () => {
    await storeSecrets(cfg);
    expect((await withSecrets(bare)).s3).toEqual(cfg.s3);
    expect((await withSecrets({ ...bare, s3: { ...bare.s3, accessKeyId: 'OTHER' } })).s3.secretAccessKey).toBe('');
    expect((await withSecrets({ ...bare, urls: 's3://b/y' })).s3.secretAccessKey).toBe('');
  });

  it('leaves a configuration that has its own secret alone', async () => {
    await storeSecrets(cfg);
    const own = { ...cfg, s3: { ...cfg.s3, secretAccessKey: 'mine' } };
    expect((await withSecrets(own)).s3.secretAccessKey).toBe('mine');
  });

  it('stores nothing for OIDC or public sources and forgets by source identity', async () => {
    await storeSecrets({ ...cfg, authMode: 'oidc' });
    expect((await withSecrets({ ...bare, authMode: 'oidc' })).s3.secretAccessKey).toBe('');
    await storeSecrets(cfg);
    await forgetSecrets(sourceKey(cfg)!);
    expect((await withSecrets(bare)).s3.secretAccessKey).toBe('');
  });
});
