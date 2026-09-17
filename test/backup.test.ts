import { beforeEach, describe, expect, it } from 'vitest';
import { makeBackup, parseBackup, restoreBackup } from '../src/backup';

describe('backup', () => {
  beforeEach(() => localStorage.clear());

  it('collects the ddv.* entries and reads them back', () => {
    localStorage.setItem('ddv.settings', '{"a":1}');
    localStorage.setItem('ddv.lang', 'ja');
    localStorage.setItem('other', 'x');
    const b = makeBackup(new Date('2026-09-17T00:00:00Z'));
    expect(b).toEqual({ app: 'duckdive', version: 1, exportedAt: '2026-09-17T00:00:00.000Z', items: { 'ddv.settings': '{"a":1}', 'ddv.lang': 'ja' } });
    localStorage.clear();
    expect(restoreBackup(parseBackup(JSON.stringify(b)))).toBe(2);
    expect(localStorage.getItem('ddv.lang')).toBe('ja');
  });

  it('refuses what is not a backup and skips foreign keys', () => {
    expect(() => parseBackup('nope')).toThrow(/JSON/);
    expect(() => parseBackup('{"app":"x"}')).toThrow(/backup/);
    expect(parseBackup('{"app":"duckdive","items":{"ddv.x":"1","evil":"2","ddv.y":3}}')).toEqual({ 'ddv.x': '1' });
  });
});
