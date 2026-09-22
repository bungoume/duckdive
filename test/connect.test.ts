import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachOptions, AttachedSource } from '../src/datasource';
import { DEFAULT_SOURCE, loadSource, type SourceConfig } from '../src/sources';
import { DEFAULT_DISCOVER, DEFAULT_SEARCH, DEFAULT_VIS, type UrlState } from '../src/state';
import { storeSavedVis } from '../src/savedViews';

const attach = vi.hoisted(() => vi.fn());
vi.mock('../src/datasource', async (original) => ({ ...(await original<object>()), attachSource: attach }));
vi.mock('../src/duck', () => ({ cancelAllQueries: async () => undefined }));
const secrets = vi.hoisted(() => vi.fn());
vi.mock('../src/secrets', () => ({ withSecrets: secrets, storeSecrets: async () => undefined }));
vi.mock('../src/permissions', () => ({ ensureHostPermissions: async () => ({ ok: true }), originPattern: () => null }));

import { createConnection, valueFiltersFor } from '../src/connection';
import { fileWindow, needsComparison } from '../src/comparison';
import { loadSavedVis } from '../src/savedViews';

const url = { page: 'discover' as const, search: DEFAULT_SEARCH, discover: DEFAULT_DISCOVER, vis: DEFAULT_VIS };
const sourceA = { ...DEFAULT_SOURCE, name: 'A' };
const sourceB = { ...DEFAULT_SOURCE, kind: 'url' as const, name: 'B', urls: 'https://logs.example.com/B.parquet', authMode: 'none' as const };
const attachedA: AttachedSource = { fields: [], files: ['A'], fileSizes: [], captures: [], timeField: null, rowCount: 1, description: 'A', rangeDependent: false, totalBytes: null, warning: null };
const attachedB = { ...attachedA, files: ['B'], description: 'B' };

let connection: ReturnType<typeof createConnection>;
const request = (config: SourceConfig = sourceB, state: UrlState = url) => ({
  window: fileWindow(state.search.range, needsComparison(state, loadSavedVis())),
  valueFilters: valueFiltersFor(config, state),
});
function TestConnection(state: UrlState = url) {
  const snapshot = connection.get();
  return {
    ...snapshot,
    formSource: snapshot.pendingSource ?? snapshot.source,
    attachError: snapshot.phase.status === 'failed' ? snapshot.phase.error : null,
    connect: (config: typeof sourceA) => connection.connect(config, request(config, state)),
    switchSource: (config: typeof sourceA) => connection.select(config, request(config, state)),
    onTimeField: connection.onTimeField,
  };
}

beforeEach(async () => {
  localStorage.clear();
  secrets.mockReset().mockImplementation(async (config) => config);
  attach.mockReset().mockResolvedValue(attachedA);
  connection = createConnection(
    sourceA,
    () => undefined,
    () => false,
  );
  await TestConnection().connect(sourceA);
});

describe('switching sources', () => {
  it.each(['visualize', 'dashboard'] as const)('attaches the previous period for a comparison on %s', async (page) => {
    const state = { ...url, page, search: { ...url.search, range: { from: '2026-09-22T00:00:00Z', to: '2026-09-23T00:00:00Z' } }, vis: { ...DEFAULT_VIS, compare: true } };
    storeSavedVis([{ id: 'comparison', title: '', savedAt: '', search: state.search, vis: state.vis, pinned: true }]);
    await TestConnection(state).connect(sourceB);
    expect(attach.mock.lastCall?.[3]).toEqual({ from: new Date('2026-09-21T00:00:00Z'), to: new Date('2026-09-23T00:00:00Z') });
  });

  it('remembers an explicit choice of no time field in both the source and history', async () => {
    TestConnection().onTimeField(null);
    expect(loadSource().timeField).toEqual({ mode: 'none' });
    expect(TestConnection().history[0].config.timeField).toEqual({ mode: 'none' });
    await TestConnection().connect(TestConnection().source);
    expect(loadSource().timeField).toEqual({ mode: 'none' });
  });

  it('does not list or attach a URL source with an invalid restored range', async () => {
    attach.mockClear();
    await TestConnection({ ...url, search: { ...url.search, range: { from: 'now--1m', to: 'now' } } }).connect(sourceB);
    expect(attach).not.toHaveBeenCalled();
    expect(TestConnection().attachError).toContain('Invalid time range');
    expect(TestConnection().attached).toEqual(attachedA);
  });

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

describe('connection lifecycle', () => {
  it('ignores a superseded secret load before it can attach', async () => {
    let finish!: (config: typeof sourceA) => void;
    secrets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = connection.select(sourceB, request());
    await connection.connect(sourceA, request(sourceA));
    finish(sourceB);
    await first;
    expect(connection.get().source.name).toBe('A');
    expect(attach.mock.calls.map(([config]) => config.name)).toEqual(['A', 'A']);
  });

  it.each(['cancel', 'replace', 'dispose'] as const)('settles a pending confirmation on %s', async (action) => {
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    attach.mockImplementationOnce(async (_cfg, _files, _creds, _range, _filters, opts: AttachOptions) => {
      const answer = opts.confirmLarge!({ files: 2000, bytes: null, threshold: 1000 });
      waiting();
      expect(await answer).toBe(false);
      return attachedB;
    });
    const first = connection.connect(sourceB, request());
    await reached;
    expect(connection.get().phase.status).toBe('confirming');
    if (action === 'cancel') connection.cancel();
    else if (action === 'dispose') connection.dispose();
    else await connection.connect(sourceA, request(sourceA));
    await first;
    expect(connection.get().source.name).toBe('A');
    expect(connection.get().attached).toEqual(attachedA);
  });

  it('does not let an old result replace a newer connection', async () => {
    let finish!: (value: AttachedSource) => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const first = connection.connect(sourceB, request());
    await reached;
    await connection.connect(sourceA, request(sourceA));
    finish(attachedB);
    await first;
    expect(connection.get().source.name).toBe('A');
    expect(connection.get().phase.status).toBe('idle');
  });
});
