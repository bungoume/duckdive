import { beforeEach, describe, expect, it } from 'vitest';
import { isTrustedSql, trustSql } from '../src/trust';

describe('trusted SQL list', () => {
  beforeEach(() => localStorage.clear());

  it('remembers exact strings, most recent first, without duplicates', () => {
    expect(isTrustedSql('a = 1')).toBe(false);
    trustSql('a = 1');
    trustSql('b = 2');
    trustSql('a = 1');
    expect(isTrustedSql('a = 1')).toBe(true);
    expect(isTrustedSql('a = 1 ')).toBe(false);
    expect(JSON.parse(localStorage.getItem('ddv.trustedSql')!)).toEqual(['a = 1', 'b = 2']);
  });

  it('keeps at most 200 entries and survives a corrupt store', () => {
    for (let i = 0; i < 250; i++) trustSql(`x = ${i}`);
    expect(isTrustedSql('x = 249')).toBe(true);
    expect(isTrustedSql('x = 0')).toBe(false);
    localStorage.setItem('ddv.trustedSql', '{not json');
    expect(isTrustedSql('x = 249')).toBe(false);
    trustSql('fresh');
    expect(isTrustedSql('fresh')).toBe(true);
  });
});
