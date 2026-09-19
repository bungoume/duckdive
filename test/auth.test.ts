import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_OIDC, getCredentials, loadCredentials, storeCredentials, type AwsCredentials } from '../src/auth';

const credentials: AwsCredentials = {
  accessKeyId: 'ROLE_A',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  expiration: '2999-01-01T00:00:00.000Z',
};

describe('credential cache', () => {
  beforeEach(() => sessionStorage.clear());

  it('returns credentials only for the identity provider and role that obtained them', async () => {
    const a = { ...DEFAULT_OIDC, clientId: 'client-a', roleArn: 'arn:aws:iam::1:role/a' };
    const b = { ...a, roleArn: 'arn:aws:iam::1:role/b' };
    await storeCredentials(credentials, a);
    await expect(getCredentials(a, false)).resolves.toEqual(credentials);
    await expect(loadCredentials(b)).resolves.toBeNull();
    await expect(getCredentials(b, false)).rejects.toThrow('chrome.identity');
  });

  it('does not reuse an unscoped entry written by an older build', async () => {
    await storeCredentials(credentials);
    await expect(loadCredentials(DEFAULT_OIDC)).resolves.toBeNull();
    await expect(loadCredentials()).resolves.toEqual(credentials);
  });
});
