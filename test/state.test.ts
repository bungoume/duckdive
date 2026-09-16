import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE, readUrlState, rememberSource, sourceKey, stripSecrets, loadSourceHistory } from '../src/state';
import { trustSql } from '../src/trust';

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
