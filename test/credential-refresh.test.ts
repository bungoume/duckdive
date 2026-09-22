import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE } from '../src/sources';
import type { AttachedSource } from '../src/datasource';
import type { AwsCredentials } from '../src/auth';

const mocks = vi.hoisted(() => ({ effect: null as (() => (() => void) | undefined) | null, load: vi.fn(), get: vi.fn(), apply: vi.fn(), setError: vi.fn() }));
vi.mock('preact/hooks', () => ({ useEffect: (fn: typeof mocks.effect) => (mocks.effect = fn), useState: () => [null, mocks.setError] }));
vi.mock('../src/auth', async (original) => ({ ...(await original<object>()), loadCredentials: mocks.load, getCredentials: mocks.get }));
vi.mock('../src/datasource', () => ({ applyS3: mocks.apply }));

import { useCredentialRefresh } from '../src/hooks/useCredentialRefresh';
import { storeCredentials } from '../src/auth';

const credentials: AwsCredentials = { accessKeyId: 'refreshed', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date(0).toISOString() };
const generation = { current: 0 };
const onCreds = vi.fn();
let cleanup: (() => void) | undefined;

function TestRefresh() {
  useCredentialRefresh({ ...DEFAULT_SOURCE, kind: 'url', authMode: 'oidc' }, {} as AttachedSource, onCreds, generation, false);
  cleanup = mocks.effect!();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  generation.current = 0;
  mocks.load.mockResolvedValue(credentials);
  mocks.apply.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
});

describe('credential refresh lifecycle', () => {
  it.each(['cleanup', 'new connection', 'sign-out'])('discards a completed refresh after %s', async (reason) => {
    let finish!: (c: AwsCredentials) => void;
    mocks.get.mockImplementation(() => new Promise<AwsCredentials>((resolve) => (finish = resolve)));
    TestRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    if (reason === 'cleanup') cleanup?.();
    else if (reason === 'sign-out') await storeCredentials(null);
    else generation.current++;
    expect(mocks.get.mock.calls[0][3]()).toBe(false); // auth must not persist this obsolete session either
    finish(credentials);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(onCreds).not.toHaveBeenCalled();
  });

  it('invalidates credentials queued for application when signing out', async () => {
    let applyGuard!: () => boolean;
    let finish!: () => void;
    mocks.get.mockResolvedValue(credentials);
    mocks.apply.mockImplementation((_source, _creds, guard) => {
      applyGuard = guard;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    TestRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    await storeCredentials(null);
    expect(applyGuard()).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(onCreds).not.toHaveBeenCalled();
  });

  it('runs at most one refresh at a time and publishes credentials after applying them', async () => {
    let finish!: (c: AwsCredentials) => void;
    mocks.get.mockImplementation(() => new Promise<AwsCredentials>((resolve) => (finish = resolve)));
    mocks.apply.mockImplementation(async () => expect(onCreds).not.toHaveBeenCalled());
    TestRefresh();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocks.get).toHaveBeenCalledOnce();
    finish(credentials);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(onCreds).toHaveBeenCalledWith(credentials);
  });
});
