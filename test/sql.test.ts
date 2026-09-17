import { beforeEach, describe, expect, it } from 'vitest';
import type { Field } from '../src/fields';
import { resetSettings, updateSettings } from '../src/settings';
import { autoInterval, bucketExpr, bucketOffsetMinutes, bucketStarts, buildWhere, filterToSQL, intervalByKey, lit, nextBucketStart, niceStep, tsLit } from '../src/sql';

const f = (name: string, kind: Field['kind']): Field => ({ name, expr: `"${name}"`, kind, duckType: kind.toUpperCase(), column: name, searchable: kind === 'string' });
const fields = [f('status', 'number'), f('host', 'string'), f('ts', 'date')];

describe('literals', () => {
  it('escapes strings and renders UTC timestamps', () => {
    expect(lit("it's")).toBe("'it''s'");
    expect(tsLit(new Date('2026-09-16T01:02:03.456Z'))).toBe("TIMESTAMP '2026-09-16 01:02:03.456'");
  });
});

describe('filterToSQL', () => {
  it('renders the operators', () => {
    expect(filterToSQL({ id: '1', field: 'host', op: 'is', value: 'a' }, fields)).toBe(`("host" = 'a')`);
    expect(filterToSQL({ id: '1', field: 'host', op: 'is' }, fields)).toBe(`("host" IS NULL)`);
    expect(filterToSQL({ id: '1', field: 'status', op: 'is_one_of', values: ['1', '2'] }, fields)).toBe(`("status" IN (1, 2))`);
    expect(filterToSQL({ id: '1', field: 'host', op: 'exists' }, fields)).toBe(`("host" IS NOT NULL)`);
    expect(filterToSQL({ id: '1', field: 'status', op: 'between', from: '1', to: '5' }, fields)).toBe(`("status" >= 1 AND "status" < 5)`);
    expect(filterToSQL({ id: '1', field: 'host', op: 'is', value: 'a', negate: true }, fields)).toBe(`NOT coalesce(("host" = 'a'), FALSE)`);
    expect(filterToSQL({ id: '1', field: '', op: 'query', sql: '1 = 1' }, fields)).toBe(`(1 = 1)`);
  });

  it('keeps the rows without the field when a filter negates', () => {
    // three-valued logic: a plain NOT / NOT IN would drop every row that has no host at all
    expect(filterToSQL({ id: '1', field: 'host', op: 'is_not', value: 'a' }, fields)).toBe(`(NOT coalesce("host" = 'a', FALSE))`);
    expect(filterToSQL({ id: '1', field: 'status', op: 'is_not_one_of', values: ['1', '2'] }, fields)).toBe(`(NOT coalesce("status" IN (1, 2), FALSE))`);
    expect(filterToSQL({ id: '1', field: 'host', op: 'is_not' }, fields)).toBe(`("host" IS NOT NULL)`);
  });

  it('skips disabled filters and unknown fields', () => {
    expect(filterToSQL({ id: '1', field: 'host', op: 'is', value: 'a', disabled: true }, fields)).toBeNull();
    expect(filterToSQL({ id: '1', field: 'nope', op: 'is', value: 'a' }, fields)).toBeNull();
  });

  it('never compares a number field with a word', () => {
    expect(filterToSQL({ id: '1', field: 'status', op: 'is', value: 'abc' }, fields)).toBe('(FALSE)');
    expect(filterToSQL({ id: '1', field: 'status', op: 'is_not', value: 'abc' }, fields)).toBe('(TRUE)');
    expect(filterToSQL({ id: '1', field: 'status', op: 'is_one_of', values: ['x', '5'] }, fields)).toBe(`("status" IN (5))`);
    expect(filterToSQL({ id: '1', field: 'status', op: 'is_one_of', values: ['x'] }, fields)).toBe('(FALSE)');
    expect(filterToSQL({ id: '1', field: 'status', op: 'between', from: 'x', to: '5' }, fields)).toBe(`("status" < 5)`);
  });
});

describe('buildWhere', () => {
  beforeEach(() => {
    resetSettings();
    updateSettings({ timeZone: 'UTC' });
  });

  it('combines the time range, the query and the filters', () => {
    const w = buildWhere({
      timeExpr: '"ts"',
      range: { from: '2026-09-16T00:00:00Z', to: '2026-09-16T01:00:00Z' },
      querySql: '("status" = 500)',
      filters: [{ id: '1', field: 'host', op: 'is', value: 'a' }],
      fields,
    });
    expect(w.sql).toBe(`"ts" >= TIMESTAMP '2026-09-16 00:00:00.000' AND "ts" <= TIMESTAMP '2026-09-16 01:00:00.000' AND (("status" = 500)) AND ("host" = 'a')`);
    expect(w.from?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });

  it('is TRUE without any condition', () => {
    expect(buildWhere({ timeExpr: null, range: { from: 'now-1h', to: 'now' }, querySql: 'TRUE', filters: [], fields }).sql).toBe('TRUE');
  });
});

describe('buckets', () => {
  beforeEach(() => {
    resetSettings();
    updateSettings({ timeZone: 'Asia/Tokyo', dayOfWeek: 1 });
  });

  it('picks about the wanted number of buckets', () => {
    expect(autoInterval(new Date('2026-09-16T00:00:00Z'), new Date('2026-09-16T01:00:00Z')).key).toBe('1m');
    expect(autoInterval(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-16T00:00:00Z')).key).toBe('3h');
  });

  it('aligns buckets with the display zone and the configured first weekday', () => {
    expect(bucketOffsetMinutes(new Date('2026-09-16T00:00:00Z'))).toBe(540);
    const day = bucketExpr('"ts"', intervalByKey('1d')!, 540);
    expect(day).toBe(`epoch_ms(time_bucket(INTERVAL '1 day', ("ts") + to_minutes(540)) - to_minutes(540))::DOUBLE`);
    expect(bucketExpr('"ts"', intervalByKey('1h')!, 0)).toBe(`epoch_ms(time_bucket(INTERVAL '1 hour', ("ts")))::DOUBLE`);
    expect(bucketExpr('"ts"', intervalByKey('1w')!, 0)).toContain(`TIMESTAMP '2000-01-03 00:00:00'`);
    updateSettings({ dayOfWeek: 0 });
    expect(bucketExpr('"ts"', intervalByKey('1w')!, 0)).toContain(`TIMESTAMP '2000-01-09 00:00:00'`);
  });

  it('steps fixed buckets by their length and calendar buckets by the calendar', () => {
    const t0 = Date.UTC(2026, 0, 1) - 540 * 60000; // 2026-01-01 00:00 JST
    expect(nextBucketStart(t0, intervalByKey('1h')!, 540)).toBe(t0 + 3600000);
    expect(nextBucketStart(t0, intervalByKey('1M')!, 540)).toBe(Date.UTC(2026, 1, 1) - 540 * 60000);
    expect(nextBucketStart(t0, intervalByKey('1y')!, 540)).toBe(Date.UTC(2027, 0, 1) - 540 * 60000);
    const months = bucketStarts(t0, Date.UTC(2026, 3, 1) - 540 * 60000, intervalByKey('1M')!, 540);
    expect(months.map((t) => new Date(t + 540 * 60000).toISOString().slice(0, 10))).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    expect(bucketStarts(0, 10 * 60000, intervalByKey('1m')!, 0, 3)).toHaveLength(3);
  });
});

describe('niceStep', () => {
  it('rounds a raw width to 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(0.37)).toBe(0.2);
    expect(niceStep(3)).toBe(2);
    expect(niceStep(7)).toBe(5);
    expect(niceStep(12)).toBe(10);
    expect(niceStep(2400)).toBe(2000);
    expect(niceStep(0)).toBe(1);
    expect(niceStep(NaN)).toBe(1);
  });
});
