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

  it('holds a restored source to the rule a link is held to, and leaves the rest of it alone', () => {
    const hostile = {
      kind: 'url',
      urls: 's3://b/*',
      authMode: 'oidc',
      localId: 'abc',
      s3: { accessKeyId: 'AKIAOWN' },
      oidc: { clientId: 'c', roleArn: 'arn:aws:iam::1:role/r', stsEndpoint: 'https://a1b2c3.execute-api.us-east-1.amazonaws.com/p' },
    };
    const file = (items: Record<string, string>) => JSON.stringify({ app: 'duckdive', version: 1, items });
    const one = JSON.parse(parseBackup(file({ 'ddv.source': JSON.stringify(hostile) }))['ddv.source']);
    expect(one.oidc.stsEndpoint).toBe('');
    // only the two endpoints are touched: the key ID and the file handles are this browser's own
    expect(one.s3.accessKeyId).toBe('AKIAOWN');
    expect(one.localId).toBe('abc');
    expect(one.oidc.roleArn).toBe('arn:aws:iam::1:role/r');

    const history = [{ key: 'k', lastUsed: '2026-01-01T00:00:00.000Z', config: hostile }];
    const back = JSON.parse(parseBackup(file({ 'ddv.sources': JSON.stringify(history) }))['ddv.sources']);
    expect(back[0].config.oidc.stsEndpoint).toBe('');
    expect(back[0].lastUsed).toBe('2026-01-01T00:00:00.000Z');

    // AWS's own STS survives, and an entry that is not JSON is left out
    const ok = { ...hostile, oidc: { ...hostile.oidc, stsEndpoint: 'https://sts.us-east-1.amazonaws.com/' } };
    expect(JSON.parse(parseBackup(file({ 'ddv.source': JSON.stringify(ok) }))['ddv.source']).oidc.stsEndpoint).toBe('https://sts.us-east-1.amazonaws.com/');
    expect(parseBackup(file({ 'ddv.source': 'not json', 'ddv.lang': 'ja' }))).toEqual({ 'ddv.lang': 'ja' });
  });

  it('never carries the list of custom SQL this browser has reviewed', () => {
    localStorage.setItem('ddv.trustedSql', '["DROP TABLE x"]');
    localStorage.setItem('ddv.lang', 'ja');
    expect(makeBackup().items).toEqual({ 'ddv.lang': 'ja' });
    // nor does a hand-made file get to put one back
    expect(parseBackup('{"app":"duckdive","items":{"ddv.trustedSql":"[\\"evil\\"]","ddv.lang":"en"}}')).toEqual({ 'ddv.lang': 'en' });
  });
});
