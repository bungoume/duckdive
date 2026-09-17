import { describe, expect, it } from 'vitest';
import type { Field } from '../src/fields';
import { SearchQueryError, parseQuery, searchToSql } from '../src/search';

const f = (name: string, kind: Field['kind'], duckType = kind.toUpperCase()): Field => ({ name, expr: `"${name}"`, kind, duckType, column: name, searchable: kind === 'string' });
const fields: Field[] = [f('status', 'number', 'INTEGER'), f('message', 'string', 'VARCHAR'), f('host', 'string', 'VARCHAR'), f('ts', 'date', 'TIMESTAMP'), f('ok', 'boolean', 'BOOLEAN')];

describe('parseQuery', () => {
  it('returns null for an empty query', () => {
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('   ')).toBeNull();
  });

  it('ORs adjacent clauses and honours AND / NOT / parentheses', () => {
    expect(parseQuery('a b')).toEqual({
      t: 'or',
      a: [
        { t: 'text', value: 'a', phrase: false, prox: false },
        { t: 'text', value: 'b', phrase: false, prox: false },
      ],
    });
    const n = parseQuery('a AND (b OR c)');
    expect(n?.t).toBe('and');
    expect(parseQuery('NOT a')).toEqual({ t: 'not', a: { t: 'text', value: 'a', phrase: false, prox: false } });
    expect(parseQuery('-a')?.t).toBe('not');
  });

  it('a required clause makes the optional ones irrelevant, as in Lucene', () => {
    expect(parseQuery('+status:500 message:x')).toEqual({ t: 'term', field: 'status', value: '500', phrase: false, prox: false });
  });

  it('parses field syntax: ranges, brackets, exists, regex, lists', () => {
    expect(parseQuery('status:>=500')).toEqual({ t: 'range', field: 'status', op: '>=', value: '500' });
    expect(parseQuery('status:[100 TO 200}')).toEqual({ t: 'between', field: 'status', lo: '100', hi: '200', incLo: true, incHi: false });
    expect(parseQuery('status:[* TO 5]')).toMatchObject({ t: 'between', lo: null, hi: '5' });
    expect(parseQuery('host:*')).toEqual({ t: 'exists', field: 'host' });
    expect(parseQuery('_exists_:host')).toEqual({ t: 'exists', field: 'host' });
    expect(parseQuery('message:/re.*x/')).toEqual({ t: 'regex', field: 'message', value: 're.*x' });
    expect(parseQuery('status:(500 OR 503)')?.t).toBe('or');
    expect(parseQuery('message:"a b"~2')).toMatchObject({ t: 'term', phrase: true, prox: true });
  });

  it('accepts and ignores boosts and fuzziness; a slash inside a value is not a regex', () => {
    expect(parseQuery('term^3')).toEqual({ t: 'text', value: 'term', phrase: false, prox: false });
    expect(parseQuery('path:/api/*')).toMatchObject({ t: 'term', field: 'path', value: '/api/*' });
  });

  it('rejects malformed queries with a SearchQueryError', () => {
    for (const q of ['status:', 'level:(error', '"unterminated', 'AND x', '()', 'a ^ b']) expect(() => parseQuery(q), q).toThrow(SearchQueryError);
  });
});

describe('searchToSql', () => {
  it('compiles an empty query to TRUE', () => {
    expect(searchToSql('', fields)).toBe('TRUE');
  });

  it('compares numbers, booleans and dates by value', () => {
    expect(searchToSql('status:500', fields)).toBe('("status" = 500)');
    expect(searchToSql('status:>=500', fields)).toBe('("status" >= 500)');
    expect(searchToSql('status:[100 TO 200}', fields)).toBe('("status" >= 100 AND "status" < 200)');
    expect(searchToSql('ok:true', fields)).toBe('("ok" = TRUE)');
    expect(searchToSql('ts:>="2026-01-01"', fields)).toBe(`("ts" >= TRY_CAST('2026-01-01' AS TIMESTAMP))`);
  });

  it('matches strings token-wise, phrases with ILIKE and wildcards with a regex', () => {
    expect(searchToSql('message:error', fields)).toBe(`(regexp_matches("message", '(^|[^A-Za-z0-9_])error([^A-Za-z0-9_]|$)', 'i'))`);
    expect(searchToSql('message:"read timeout"', fields)).toBe(`("message" ILIKE '%read timeout%' ESCAPE '\\')`);
    expect(searchToSql('host:web-*', fields)).toContain(`web-[^\\s]*`);
    expect(searchToSql('message:/a.b/', fields)).toBe(`regexp_matches("message", 'a.b')`);
  });

  it('spreads free text over the searchable fields and combines with AND / OR / NOT', () => {
    const sql = searchToSql('timeout AND NOT status:200', fields);
    expect(sql).toMatch(/^\(\(regexp_matches\("message".* OR regexp_matches\("host".*\) AND NOT \("status" = 200\)\)$/);
  });

  it('escapes quotes in literals', () => {
    expect(searchToSql(`message:"it's"`, fields)).toContain(`'%it''s%'`);
  });

  it('fails on unknown fields and on non-numeric comparisons with a number field', () => {
    expect(() => searchToSql('nosuch:1', fields)).toThrow(/Unknown field/);
    expect(() => searchToSql('status:>abc', fields)).toThrow(/not a number/);
  });
});

describe('date math in ranges', () => {
  const fields = [f('ts', 'date')];
  it('resolves now-based bounds to timestamp literals, rounding an inclusive upper bound up', () => {
    expect(searchToSql('ts:>now-1h', fields)).toMatch(/^\("ts" > TIMESTAMP '\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}'\)$/);
    const sql = searchToSql('ts:[now/d TO now/d]', fields);
    expect(sql).toMatch(/"ts" >= TIMESTAMP '\d{4}-\d\d-\d\d \d\d:00:00\.000' AND "ts" <= TIMESTAMP '\d{4}-\d\d-\d\d \d\d:59:59\.999'/);
    expect(searchToSql('ts:>="2026-01-01"', fields)).toBe(`("ts" >= TRY_CAST('2026-01-01' AS TIMESTAMP))`);
    expect(() => searchToSql('ts:>now-1x', fields)).toThrow(/not a date expression/);
  });
});
