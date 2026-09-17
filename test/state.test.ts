import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE, rememberSource, sourceKey, stripSecrets, loadSourceHistory } from '../src/sources';
import { describeFilter } from '../src/sql';
import { DEFAULT_DISCOVER, DEFAULT_SEARCH, DEFAULT_VIS, loadSavedSearches, loadSavedVis, readUrlState, storeSavedSearches, storeSavedVis, syncUrlStateFromLocation, writeUrlState } from '../src/state';
import { trustSql } from '../src/trust';
import { historyLog } from './setup';

const setHash = (page: string, state: unknown) => {
  location.hash = `#/${page}?s=${Buffer.from(JSON.stringify(state)).toString('base64url')}`;
};

describe('readUrlState', () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = '';
  });

  it('falls back to defaults', () => {
    const u = readUrlState();
    expect(u.page).toBe('discover');
    expect(u.search.range).toEqual({ from: 'now-6h', to: 'now' });
    location.hash = '#/settings';
    expect(readUrlState().page).toBe('settings');
    location.hash = '#/nope?s=%%%';
    expect(readUrlState().page).toBe('discover');
  });

  it('restores ordinary filters and drops malformed ones', () => {
    setHash('visualize', { search: { query: 'x', filters: [{ id: 'a', field: 'host', op: 'is', value: '1' }, { field: 'host' }, 'junk', null] } });
    const u = readUrlState();
    expect(u.page).toBe('visualize');
    expect(u.search.query).toBe('x');
    expect(u.search.filters).toEqual([{ id: 'a', field: 'host', op: 'is', value: '1' }]);
  });

  it('quarantines custom SQL that was not written in this browser', () => {
    setHash('discover', { search: { filters: [{ id: 'q', field: '', op: 'query', sql: `current_setting('s3_secret_access_key') = ''` }] } });
    const f = readUrlState().search.filters[0];
    expect(f.disabled).toBe(true);
    expect(f.untrusted).toBe(true);
    trustSql(`current_setting('s3_secret_access_key') = ''`);
    const g = readUrlState().search.filters[0];
    expect(g.disabled).toBeUndefined();
    expect(g.untrusted).toBeUndefined();
  });

  it('a quarantined filter cannot keep a label that hides its SQL', () => {
    const sql = `current_setting('s3_secret_access_key') = ''`;
    setHash('discover', { search: { filters: [{ id: 'q', field: '', op: 'query', sql, label: 'status: 500' }] } });
    const f = readUrlState().search.filters[0];
    expect(f.untrusted).toBe(true);
    expect(f.label).toBe(sql);
    expect(describeFilter(f)).toContain('s3_secret_access_key');
  });

  it('quarantines the custom SQL of a saved visualization too (localStorage is restorable)', () => {
    const sql = `current_setting('s3_secret_access_key') = ''`;
    storeSavedVis([{ id: 'v', title: 'v', savedAt: '', vis: DEFAULT_VIS, search: { ...DEFAULT_SEARCH, filters: [{ id: 'q', field: '', op: 'query', sql, label: 'errors' }] } }]);
    const f = loadSavedVis()[0].search.filters[0];
    expect(f.untrusted).toBe(true);
    expect(f.disabled).toBe(true);
    expect(f.label).toBe(sql);
    trustSql(sql);
    expect(loadSavedVis()[0].search.filters[0].untrusted).toBeUndefined();
  });

  it('keeps the label of a filter this browser already trusts', () => {
    const sql = `"status" > 500`;
    trustSql(sql);
    setHash('discover', { search: { filters: [{ id: 'q', field: '', op: 'query', sql, label: 'slow' }] } });
    expect(readUrlState().search.filters[0].label).toBe('slow');
  });
});

describe('sources', () => {
  beforeEach(() => localStorage.clear());
  const cfg = { ...DEFAULT_SOURCE, kind: 'url' as const, urls: 's3://b/x\n# comment\n', s3: { ...DEFAULT_SOURCE.s3, accessKeyId: 'AKIA', secretAccessKey: 'shh', sessionToken: 'tok' } };

  it('identifies a source by its destination, not by its name or keys', () => {
    expect(sourceKey({ ...cfg, name: 'a' })).toBe(sourceKey({ ...cfg, name: 'b', s3: { ...cfg.s3, accessKeyId: 'other' } }));
    expect(sourceKey({ ...cfg, urls: 's3://b/y' })).not.toBe(sourceKey(cfg));
    expect(sourceKey({ ...cfg, kind: 'local' })).toBeNull();
    expect(sourceKey({ ...cfg, kind: 'demo' })).toBe('demo');
  });

  it('keeps secrets out of the history and caps it', () => {
    expect(stripSecrets(cfg).s3).toMatchObject({ accessKeyId: 'AKIA', secretAccessKey: '', sessionToken: '' });
    for (let i = 0; i < 25; i++) rememberSource({ ...cfg, urls: `s3://b/${i}` });
    const list = loadSourceHistory();
    expect(list).toHaveLength(20);
    expect(list[0].config.urls).toBe('s3://b/24');
    expect(list.every((e) => e.config.s3.secretAccessKey === '' && e.config.s3.accessKeyId === 'AKIA')).toBe(true);
    rememberSource({ ...cfg, urls: 's3://b/3', name: 'renamed' });
    expect(loadSourceHistory()[0].config.name).toBe('renamed');
    expect(loadSourceHistory().filter((e) => e.config.urls === 's3://b/3')).toHaveLength(1);
  });
});

describe('malformed URL state', () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = '';
  });

  it('falls back field by field instead of throwing', () => {
    setHash('visualize', {
      search: { query: 42, range: { from: 'now-1h' } },
      discover: { columns: 'nope', sort: [{ field: 'a', dir: 'sideways' }, { field: 'b', dir: 'asc' }, 'junk'], interval: 7 },
      vis: { chart: 'pie', x: { kind: 'bogus', size: -3 }, metrics: 'none', breakdown: { size: 'x', other: 'maybe' }, title: ['t'] },
    });
    const u = readUrlState();
    expect(u.search.query).toBe('');
    expect(u.search.range).toEqual({ from: 'now-6h', to: 'now' });
    expect(u.discover).toEqual({ columns: [], sort: [{ field: 'b', dir: 'asc' }], interval: 'auto', breakdown: null });
    expect(u.vis.chart).toBe('bar');
    expect(u.vis.x).toMatchObject({ kind: 'date_histogram', size: 10 });
    expect(u.vis.metrics).toEqual([{ id: 'm0', agg: 'count', field: null }]);
    expect(u.vis.breakdown).toEqual({ field: null, size: 5, other: true });
    expect(u.vis.title).toBe('');
  });

  it('drops filters without a valid shape and normalises the rest', () => {
    setHash('discover', {
      search: {
        filters: [
          { id: 'a', field: 'host', op: 'teleport' },
          { id: 'b', field: 7, op: 'is' },
          { id: 'c', field: 'host', op: 'is_one_of', values: ['x', 3, 'y'], negate: 'yes' },
        ],
      },
    });
    expect(readUrlState().search.filters).toEqual([{ id: 'c', field: 'host', op: 'is_one_of', values: ['x', 'y'] }]);
  });

  it('accepts a complete state unchanged', () => {
    const vis = {
      chart: 'line',
      x: { kind: 'terms', field: 'host', interval: 'auto', size: 7, orderBy: 'alpha', orderDir: 'asc' },
      metrics: [{ id: 'm0', agg: 'avg', field: 'lat', label: 'L' }],
      breakdown: { field: 'g', size: 3, other: false },
      title: 'T',
    };
    setHash('visualize', { search: { query: 'q', range: { from: 'now-1d', to: 'now' }, filters: [] }, discover: { columns: ['a'], sort: [{ field: 'a', dir: 'desc' }], interval: '1h' }, vis });
    const u = readUrlState();
    expect(u.vis).toEqual(vis);
    expect(u.discover).toEqual({ columns: ['a'], sort: [{ field: 'a', dir: 'desc' }], interval: '1h', breakdown: null });
    expect(u.search.range).toEqual({ from: 'now-1d', to: 'now' });
  });
});

describe('writeUrlState', () => {
  it('replaces the entry for view changes and pushes one for search changes; a round trip restores the state', () => {
    historyLog.length = 0;
    location.hash = '';
    const base = { page: 'discover' as const, search: DEFAULT_SEARCH, discover: DEFAULT_DISCOVER, vis: DEFAULT_VIS };
    writeUrlState(base);
    expect(historyLog.at(-1)?.kind).toBe('replace');
    writeUrlState({ ...base, page: 'visualize' });
    expect(historyLog.at(-1)?.kind).toBe('replace');
    expect(location.hash.startsWith('#/visualize?s=')).toBe(true);
    const searched = { ...base, page: 'visualize' as const, search: { ...DEFAULT_SEARCH, query: 'status:500' } };
    writeUrlState(searched);
    expect(historyLog.at(-1)?.kind).toBe('push');
    const n = historyLog.length;
    writeUrlState(searched);
    expect(historyLog.length).toBe(n); // unchanged URL: nothing written
    const { state, full } = syncUrlStateFromLocation();
    expect(full).toBe(true);
    expect(state).toEqual(searched);
  });
});

describe('saved searches and visualizations', () => {
  it('round-trip through localStorage with their shapes checked', () => {
    storeSavedSearches([
      {
        id: 's1',
        title: 'errors',
        savedAt: '2026-09-17T00:00:00Z',
        search: { query: 'level:error', range: { from: 'now-1d', to: 'now' }, filters: [] },
        discover: { columns: ['host'], sort: [], interval: '1h', breakdown: null },
      },
    ]);
    expect(loadSavedSearches()).toEqual([
      {
        id: 's1',
        title: 'errors',
        savedAt: '2026-09-17T00:00:00Z',
        search: { query: 'level:error', range: { from: 'now-1d', to: 'now' }, filters: [] },
        discover: { columns: ['host'], sort: [], interval: '1h', breakdown: null },
      },
    ]);
    localStorage.setItem('ddv.savedSearches', JSON.stringify([{ id: 1, discover: { columns: 'x' } }, 'junk']));
    expect(loadSavedSearches()).toEqual([
      { id: 'search0', title: '', savedAt: '', search: { query: '', range: { from: 'now-6h', to: 'now' }, filters: [] }, discover: { columns: [], sort: [], interval: 'auto', breakdown: null } },
    ]);
    storeSavedVis([
      {
        id: 'v1',
        title: 'a',
        savedAt: '',
        vis: {
          chart: 'line',
          x: { kind: 'none', field: null, interval: 'auto', size: 5, orderBy: 'metric', orderDir: 'desc' },
          metrics: [{ id: 'm0', agg: 'count', field: null }],
          breakdown: { field: null, size: 5, other: true },
          title: 'a',
        },
        search: { query: '', range: { from: 'now-6h', to: 'now' }, filters: [] },
        pinned: true,
      },
    ]);
    expect(loadSavedVis()[0].pinned).toBe(true);
  });
});
