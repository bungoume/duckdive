import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachOptions, AttachedSource } from '../src/datasource';
import { DEFAULT_SOURCE, loadSource } from '../src/sources';
import { DEFAULT_DISCOVER, DEFAULT_SEARCH, DEFAULT_VIS } from '../src/state';

const hook = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
// Drive connect's async transitions independently of the mount/auto-refresh effects.
vi.mock('preact/hooks', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = hook.cursor++;
    if (!(i in hook.slots)) hook.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hook.slots[i], (v: T | ((prev: T) => T)) => (hook.slots[i] = typeof v === 'function' ? (v as (prev: T) => T)(hook.slots[i] as T) : v)];
  },
  useRef: <T>(initial: T) => {
    const i = hook.cursor++;
    return (hook.slots[i] ??= { current: initial });
  },
  useEffect: () => undefined,
}));
const attach = vi.hoisted(() => vi.fn());
vi.mock('../src/datasource', async (original) => ({ ...(await original<object>()), attachSource: attach }));
vi.mock('../src/duck', () => ({ cancelAllQueries: async () => undefined }));
vi.mock('../src/secrets', () => ({ withSecrets: async (cfg: unknown) => cfg, storeSecrets: async () => undefined }));
vi.mock('../src/permissions', () => ({ ensureHostPermissions: async () => ({ ok: true }), originPattern: () => null }));

import { useConnect } from '../src/hooks/useConnect';

const url = { page: 'discover' as const, search: DEFAULT_SEARCH, discover: DEFAULT_DISCOVER, vis: DEFAULT_VIS };
const sourceA = { ...DEFAULT_SOURCE, name: 'A' };
const sourceB = { ...DEFAULT_SOURCE, kind: 'url' as const, name: 'B', urls: 'https://logs.example.com/B.parquet', authMode: 'none' as const };
const attachedA: AttachedSource = { fields: [], files: ['A'], fileSizes: [], captures: [], timeField: null, rowCount: 1, description: 'A', rangeDependent: false, totalBytes: null, warning: null };
const attachedB = { ...attachedA, files: ['B'], description: 'B' };

function TestConnection() {
  hook.cursor = 0;
  return useConnect(url, () => undefined, { current: false });
}

beforeEach(async () => {
  hook.slots = [];
  localStorage.clear();
  attach.mockReset().mockResolvedValue(attachedA);
  await TestConnection().connect(sourceA);
});

describe('switching sources', () => {
  it('keeps the old source identity and data after a listing failure, with the new form editable', async () => {
    attach.mockRejectedValueOnce(new Error('Listing failed'));
    await TestConnection().switchSource(sourceB);
    const state = TestConnection();
    expect(state.source.name).toBe('A');
    expect(state.attached).toEqual(attachedA);
    expect(state.formSource.name).toBe('B');
    expect(state.attachError).toBe('Listing failed');
    expect(loadSource().name).toBe('A');
  });

  it('does not expose the old schema after a DB mutation fails', async () => {
    attach.mockImplementationOnce(async (_cfg, _files, _creds, _range, _filters, opts: AttachOptions) => {
      opts.onProgress?.('Creating view', 'db');
      throw new Error('Schema failed');
    });
    await TestConnection().switchSource(sourceB);
    expect(TestConnection().attached).toBeNull();
    expect(TestConnection().source.name).toBe('A');
    expect(TestConnection().formSource.name).toBe('B');
  });

  it('commits the new source and its data together after a successful retry', async () => {
    attach.mockRejectedValueOnce(new Error('Listing failed'));
    await TestConnection().switchSource(sourceB);
    attach.mockResolvedValueOnce(attachedB);
    await TestConnection().connect(TestConnection().formSource);
    expect(TestConnection().source.name).toBe('B');
    expect(TestConnection().formSource.name).toBe('B');
    expect(TestConnection().attached).toEqual(attachedB);
    expect(loadSource().name).toBe('B');
  });
});
