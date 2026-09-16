import { describe, expect, it } from 'vitest';
import { findField, isTimeCandidate, kindOf, parseStructType, quoteIdent, timeExprFor, type Field } from '../src/fields';

describe('kindOf', () => {
  it('maps DuckDB types to field kinds', () => {
    expect(kindOf('VARCHAR')).toBe('string');
    expect(kindOf('BIGINT')).toBe('number');
    expect(kindOf('DECIMAL(18,3)')).toBe('number');
    expect(kindOf('TIMESTAMP WITH TIME ZONE')).toBe('date');
    expect(kindOf('DATE')).toBe('date');
    expect(kindOf('BOOLEAN')).toBe('boolean');
    expect(kindOf('STRUCT(a INTEGER)')).toBe('object');
    expect(kindOf('MAP(VARCHAR, INTEGER)')).toBe('object');
    expect(kindOf('VARCHAR[]')).toBe('list');
    expect(kindOf('JSON')).toBe('json');
    expect(kindOf('BLOB')).toBe('unknown');
  });
});

describe('parseStructType', () => {
  it('splits members, keeping nested parentheses and quoted names intact', () => {
    expect(parseStructType('STRUCT(a INTEGER, "b c" VARCHAR, d STRUCT(e DOUBLE, f MAP(VARCHAR, INTEGER)), "q""x" BOOLEAN)')).toEqual([
      ['a', 'INTEGER'],
      ['b c', 'VARCHAR'],
      ['d', 'STRUCT(e DOUBLE, f MAP(VARCHAR, INTEGER))'],
      ['q"x', 'BOOLEAN'],
    ]);
    expect(parseStructType('INTEGER')).toBeNull();
  });
});

describe('field helpers', () => {
  const f = (name: string, kind: Field['kind'], duckType: string): Field => ({ name, expr: quoteIdent(name), kind, duckType, column: name, searchable: false });
  const fields = [f('Host', 'string', 'VARCHAR'), f('start', 'number', 'BIGINT'), f('created_at', 'string', 'VARCHAR'), f('ts', 'date', 'TIMESTAMP')];

  it('quotes identifiers', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('finds fields exactly, then case-insensitively', () => {
    expect(findField(fields, 'Host')?.name).toBe('Host');
    expect(findField(fields, 'host')?.name).toBe('Host');
    expect(findField(fields, 'nope')).toBeUndefined();
  });

  it('recognises time candidates by type or name', () => {
    expect(isTimeCandidate(fields[3])).toBe(true);
    expect(isTimeCandidate(fields[1])).toBe(true); // start (flow logs)
    expect(isTimeCandidate(fields[2])).toBe(true); // created_at
    expect(isTimeCandidate(fields[0])).toBe(false);
  });

  it('builds a naive-UTC timestamp expression per kind', () => {
    expect(timeExprFor(fields[3])).toBe('("ts")::TIMESTAMP');
    expect(timeExprFor(fields[1])).toContain('epoch_ms');
    expect(timeExprFor(fields[2])).toContain('try_strptime');
  });
});
