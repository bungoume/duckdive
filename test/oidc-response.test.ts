import { describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({
  getRedirectURL: () => 'https://test.chromiumapp.org/',
  launchWebAuthFlow: vi.fn<(options: { url: string; interactive: boolean }) => Promise<string>>(),
}));
vi.mock('../src/webext', () => ({ webext: { runtime: { id: 'test' }, identity } }));

import { DEFAULT_OIDC, loginOidc } from '../src/auth';

function respond(claims: (nonce: string) => unknown) {
  identity.launchWebAuthFlow.mockImplementation(async ({ url }) => {
    const params = new URL(url).searchParams;
    const payload = Buffer.from(JSON.stringify(claims(params.get('nonce')!))).toString('base64url');
    return `https://test.chromiumapp.org/#state=${params.get('state')}&id_token=e30.${payload}.signature`;
  });
}

describe('OIDC response claims', () => {
  it('accepts a claims object with the nonce from this login', async () => {
    respond((nonce) => ({ nonce, sub: 'user' }));
    await expect(loginOidc({ ...DEFAULT_OIDC, clientId: 'test' }, true)).resolves.toMatch(/^e30\./);
  });

  it.each([null, [], 42, 'text', {}, { nonce: 42 }, { nonce: 'wrong' }].map((raw) => ({ raw })))(
    'rejects malformed claims or a wrong nonce (case %#)',
    async ({ raw }) => {
      respond(() => raw);
      await expect(loginOidc({ ...DEFAULT_OIDC, clientId: 'test' }, true)).rejects.toThrow('OIDC nonce mismatch');
    },
  );
});
